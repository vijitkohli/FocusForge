// src/main/sources/guard.ts
// The single choke point for every read of the owner's folders and vault.
// Pure Node (no electron import) so it runs in unit tests and on CI.
//
// REVIEW RULE: no other module may call `fs` on a source-root or vault path.
// Readers (discovery now; pack/watch in later phases) go through a PathGuard:
// `check()` / `checkSource()` for named paths, `walk()` / `listDir()` for
// listings, and `readTextPrefix()` for the few permitted content reads. The
// guard never logs a denied path; callers log the reason only.
//
// Accepted limits:
// - Hard links can't be detected.
// - Homoglyph names (e.g. 'Lífe') aren't treated as Life.
// - macOS realpath may not canonicalise case, so comparisons fold case
//   (configurable) and the Life rule always folds case.
// - check() is a point-in-time decision; a symlink swapped in afterwards is
//   only caught by the next check (readTextPrefix opens with O_NOFOLLOW).

import nodeFs from 'fs'
import os from 'os'
import path from 'path'
import {
  LIFE_ALLOWLIST,
  foldName,
  isLifeDirName,
  isNoiseDir,
  isSecretName,
  isVaultConfigName,
  unwrapICloudStub,
  NOISE_DIRS
} from './rules'
import { splitSourceRef } from '../../common/sourceRef'

export type DenyReason =
  | 'not-absolute'
  | 'outside-roots'
  | 'life'
  | 'secret'
  | 'noise'
  | 'vault-config'
  | 'symlink'
  | 'unreadable'

export type GuardDecision = { ok: true; real: string } | { ok: false; reason: DenyReason }

/** Most to least specific. Life always wins, so a log never says more than "life". */
const PRECEDENCE: DenyReason[] = [
  'life',
  'secret',
  'vault-config',
  'noise',
  'symlink',
  'outside-roots',
  'unreadable',
  'not-absolute'
]

export interface StatsLike {
  mtimeMs: number
  size: number
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

export interface DirentLike {
  name: string
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

export interface FileHandleLike {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number }>
  stat(): Promise<StatsLike>
  close(): Promise<void>
}

/** The only fs surface the guard uses. Injected in tests to trace every touched path. */
export interface GuardFs {
  realpathSync(p: string): string
  lstatSync(p: string): StatsLike
  promises: {
    opendir(p: string): Promise<AsyncIterable<DirentLike>>
    lstat(p: string): Promise<StatsLike>
    open(p: string, flags: number): Promise<FileHandleLike>
  }
}

export const nodeGuardFs: GuardFs = {
  realpathSync: (p) => nodeFs.realpathSync.native(p),
  lstatSync: (p) => nodeFs.lstatSync(p),
  promises: {
    opendir: (p) => nodeFs.promises.opendir(p),
    lstat: (p) => nodeFs.promises.lstat(p),
    open: (p, flags) => nodeFs.promises.open(p, flags)
  }
}

export interface GuardConfig {
  /** Absolute, already ~-expanded. */
  sourceRoots: string[]
  /** Every known vault (configured + obsidian.json). Life is denied in all of them. */
  vaultRoots: string[]
  /** The one vault that is a readable root. */
  readableVault: string | null
  /** The only places Phase 2 may write (the FlowState data folder). */
  writableRoots?: string[]
  lifeAllowlist?: readonly string[]
  /** Default: darwin/win32. Tests pass it explicitly. Life matching always folds case. */
  caseInsensitive?: boolean
  fsImpl?: GuardFs
}

export interface WalkEntry {
  path: string
  /** Name used for checks: iCloud stubs are unwrapped (`.a.md.icloud` -> `a.md`). */
  name: string
  isDir: boolean
  depth: number
  mtimeMs: number
  size: number
  icloudStub?: boolean
}

export interface WalkOptions {
  maxDepth: number
  maxEntries: number
  /** Absolute Date.now() ms. */
  deadline?: number
  signal?: AbortSignal
  filesOnly?: boolean
}

export interface WalkStats {
  truncated: boolean
  reason?: 'entries' | 'deadline' | 'aborted'
  denied?: DenyReason
}

/** `~` / `~/x` -> absolute under `home`. Anything else is returned unchanged. */
export function expandHome(p: string, home = os.homedir()): string {
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2))
  return p
}

/** path.resolve -> NFC -> no trailing separator -> lowercase when `ci`. */
export function foldPath(p: string, ci: boolean): string {
  let s = path.resolve(p).normalize('NFC')
  if (s.length > 1 && s.endsWith(path.sep) && path.parse(s).root !== s) s = s.slice(0, -1)
  return ci ? s.toLowerCase() : s
}

/** Path of `x` relative to `root` ('' when equal), or null when not under it. */
function relUnder(x: string, root: string): string | null {
  if (x === root) return ''
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return x.startsWith(prefix) ? x.slice(prefix.length) : null
}

function isFsRoot(p: string): boolean {
  return path.parse(p).root === p
}

interface RootForms {
  /** Compared with the configured case sensitivity. */
  cmp: string[]
  /** Always lowercased (Life and vault-config matching). */
  lower: string[]
}

export class PathGuard {
  private readonly ci: boolean
  private readonly fs: GuardFs
  private readonly source: RootForms[]
  private readonly readable: RootForms | null
  private readonly writable: RootForms[]
  private readonly vaultLower: string[]
  private readonly allow: Set<string>
  private readonly cfg: GuardConfig

  constructor(cfg: GuardConfig) {
    this.cfg = cfg
    this.ci = cfg.caseInsensitive ?? (process.platform === 'darwin' || process.platform === 'win32')
    this.fs = cfg.fsImpl ?? nodeGuardFs
    const usable = (p: string): boolean => path.isAbsolute(p) && !isFsRoot(path.resolve(p))
    this.source = cfg.sourceRoots.filter(usable).map((r) => this.forms(r))
    this.readable =
      cfg.readableVault && usable(cfg.readableVault) ? this.forms(cfg.readableVault) : null
    this.writable = (cfg.writableRoots ?? []).filter(usable).map((r) => this.forms(r))
    const vaults = [...cfg.vaultRoots, ...(cfg.readableVault ? [cfg.readableVault] : [])].filter(
      (p) => path.isAbsolute(p)
    )
    this.vaultLower = [...new Set(vaults.flatMap((v) => this.forms(v).lower))]
    this.allow = new Set(
      (cfg.lifeAllowlist ?? LIFE_ALLOWLIST).map((e) =>
        foldName(e.replace(/[\\/]+/g, path.sep).replace(/^[\\/]+/, ''))
      )
    )
  }

  /** Lexical and realpath'd forms of a root, folded both ways. */
  private forms(root: string): RootForms {
    const lex = path.resolve(root).normalize('NFC')
    const all = [lex]
    try {
      all.push(this.fs.realpathSync(lex).normalize('NFC'))
    } catch {
      // root may not exist yet
    }
    const uniq = [...new Set(all.map((p) => foldPath(p, false)))]
    return {
      cmp: [...new Set(uniq.map((p) => (this.ci ? p.toLowerCase() : p)))],
      lower: [...new Set(uniq.map((p) => p.toLowerCase()))]
    }
  }

  roots(): { source: string[]; vault: string | null } {
    return {
      source: this.cfg.sourceRoots.map((r) => path.resolve(r)),
      vault: this.cfg.readableVault ? path.resolve(this.cfg.readableVault) : null
    }
  }

  /** Stable comparison key for a path (cache keys, de-duping). */
  fold(p: string): string {
    return foldPath(p, this.ci)
  }

  /** Full check of an explicitly named path: lexical form and realpath form must both pass. */
  check(absPath: string): GuardDecision {
    if (typeof absPath !== 'string' || !path.isAbsolute(absPath) || absPath.includes('\0')) {
      return { ok: false, reason: 'not-absolute' }
    }
    const lex = foldPath(absPath, false)
    const lexReason = this.evaluate(lex)
    // Never touch the filesystem for a path that is lexically inside Life.
    if (lexReason === 'life') return { ok: false, reason: 'life' }
    const { real, error } = this.resolveReal(lex)
    const realReason = real ? this.evaluate(foldPath(real, false)) : null
    const reasons = [lexReason, realReason, error].filter((r): r is DenyReason => r !== null)
    if (reasons.length > 0) {
      reasons.sort((a, b) => PRECEDENCE.indexOf(a) - PRECEDENCE.indexOf(b))
      return { ok: false, reason: reasons[0] }
    }
    return { ok: true, real: real ?? lex }
  }

  /** check() on the path part of a source ref (`<path>.md#<heading>`). */
  checkSource(ref: string): GuardDecision {
    if (typeof ref !== 'string') return { ok: false, reason: 'not-absolute' }
    return this.check(splitSourceRef(ref).path)
  }

  isReadable(absPath: string): boolean {
    return this.check(absPath).ok
  }

  filterReadable(paths: string[]): string[] {
    return paths.filter((p) => this.isReadable(p))
  }

  /** True only under a writable root, never under a source root or any vault, never Life. */
  canWrite(absPath: string): boolean {
    if (typeof absPath !== 'string' || !path.isAbsolute(absPath) || absPath.includes('\0')) {
      return false
    }
    const lex = foldPath(absPath, false)
    if (this.evaluate(lex) === 'life') return false
    const { real } = this.resolveReal(lex)
    const forms = [lex, ...(real ? [foldPath(real, false)] : [])]
    return forms.every((x) => {
      const cmp = this.ci ? x.toLowerCase() : x
      const lower = x.toLowerCase()
      if (this.evaluate(x) === 'life') return false
      if (!this.writable.some((w) => w.cmp.some((r) => relUnder(cmp, r) !== null))) return false
      if (this.source.some((s) => s.cmp.some((r) => relUnder(cmp, r) !== null))) return false
      if (this.vaultLower.some((v) => relUnder(lower, v) !== null)) return false
      return true
    })
  }

  /**
   * Resolves symlinks. On ENOENT/EACCES it realpaths the deepest resolvable
   * ancestor and re-appends the rest, so a link into Life is still caught.
   */
  private resolveReal(lex: string): { real: string | null; error: DenyReason | null } {
    let cur = lex
    const rest: string[] = []
    let error: DenyReason | null = null
    for (;;) {
      try {
        const r = this.fs.realpathSync(cur)
        return { real: rest.length ? path.join(r, ...rest) : r, error }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          try {
            // realpath failed but the entry exists: a dangling symlink
            if (this.fs.lstatSync(cur).isSymbolicLink()) error = error ?? 'symlink'
          } catch {
            // really missing
          }
        } else {
          error = error ?? 'unreadable'
        }
        const parent = path.dirname(cur)
        if (parent === cur) return { real: null, error: error ?? 'unreadable' }
        rest.unshift(path.basename(cur))
        cur = parent
      }
    }
  }

  private hasObsidianChild(dir: string): boolean {
    try {
      return this.fs.lstatSync(path.join(dir, '.obsidian')).isDirectory()
    } catch {
      return false
    }
  }

  /** Name-level rules for one absolute, NFC, original-case path. */
  private evaluate(p: string): DenyReason | null {
    const lower = p.toLowerCase()
    const cmp = this.ci ? lower : p

    // 1. Life, in every known vault (always case-folded).
    for (const v of this.vaultLower) {
      const rel = relUnder(lower, v)
      if (!rel) continue
      const segs = rel.split(path.sep)
      if (isLifeDirName(segs[0])) {
        const allowed = segs.length > 1 && this.allow.has(foldName(rel))
        if (!allowed) return 'life'
      }
    }
    // 1b. Life in a vault we only know about because it has a .obsidian child.
    const allSegs = p.split(path.sep)
    for (let i = 1; i < allSegs.length; i++) {
      if (!isLifeDirName(allSegs[i])) continue
      const parent = allSegs.slice(0, i).join(path.sep) || path.sep
      if (this.vaultLower.includes(parent.toLowerCase())) continue // handled above (allowlist)
      if (this.hasObsidianChild(parent)) return 'life'
    }

    // 2. Find the root it sits under (longest match wins).
    let rel: string | null = null
    let bestLen = -1
    const candidates = [...this.source, ...(this.readable ? [this.readable] : [])]
    for (const r of candidates) {
      for (const form of r.cmp) {
        const sub = relUnder(cmp, form)
        if (sub !== null && form.length > bestLen) {
          rel = sub
          bestLen = form.length
        }
      }
    }
    const relSegs = rel ? rel.split(path.sep) : []
    const base = path.basename(p)

    // 3. Secrets: any segment under the root (or the name itself when outside roots).
    if ((rel === null ? [base] : relSegs).some((s) => isSecretName(s))) return 'secret'

    // 4. Vault config: `.obsidian` / `.trash` at a vault's top level.
    for (const v of this.vaultLower) {
      const vr = relUnder(lower, v)
      if (vr && isVaultConfigName(vr.split(path.sep)[0])) return 'vault-config'
    }

    if (rel === null) return 'outside-roots'

    // 5. Noise: any parent segment; the final one when it's a noise dir name or a dot-dir.
    for (let i = 0; i < relSegs.length - 1; i++) {
      if (isNoiseDir(relSegs[i])) return 'noise'
    }
    const last = relSegs[relSegs.length - 1]
    if (last) {
      const folded = foldName(unwrapICloudStub(last))
      if (NOISE_DIRS.has(folded)) return 'noise'
      if (folded.startsWith('.') && last === unwrapICloudStub(last)) {
        try {
          if (this.fs.lstatSync(p).isDirectory()) return 'noise'
        } catch {
          // missing: name rules already passed
        }
      }
    }
    return null
  }

  private isKnownVault(dir: string): boolean {
    return this.vaultLower.includes(foldPath(dir, false).toLowerCase())
  }

  /**
   * Whether `dir` (which must pass check) has a direct `.git` or `.obsidian`
   * entry. A single lstat of that marker; its contents are never read.
   */
  async hasMarker(dir: string, marker: '.git' | '.obsidian'): Promise<boolean> {
    const d = this.check(dir)
    if (!d.ok) return false
    try {
      await this.fs.promises.lstat(path.join(d.real, marker))
      return true
    } catch {
      return false
    }
  }

  /** lstat of a readable path (mtime/size only). null when denied or missing. */
  async statReadable(absPath: string): Promise<StatsLike | null> {
    const d = this.check(absPath)
    if (!d.ok) return null
    try {
      const st = await this.fs.promises.lstat(d.real)
      return st.isSymbolicLink() ? null : st
    } catch {
      return null
    }
  }

  /**
   * Reads at most `maxBytes` of a readable regular file as UTF-8. The only
   * content read the guard offers; callers keep what they need and drop the rest.
   */
  async readTextPrefix(
    absPath: string,
    maxBytes: number
  ): Promise<{ text: string; truncated: boolean } | null> {
    const d = this.check(absPath)
    if (!d.ok) return null
    const flags = nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0)
    let handle: FileHandleLike | null = null
    try {
      handle = await this.fs.promises.open(d.real, flags)
      const st = await handle.stat()
      if (!st.isFile()) return null
      const len = Math.max(0, Math.min(maxBytes, st.size))
      const buf = Buffer.alloc(len)
      let off = 0
      while (off < len) {
        const { bytesRead } = await handle.read(buf, off, len - off, off)
        if (bytesRead === 0) break
        off += bytesRead
      }
      return { text: buf.subarray(0, off).toString('utf8'), truncated: st.size > off }
    } catch {
      return null
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  /** One level of `walk` (children only, never descends). */
  async listDir(dir: string, opts: Partial<WalkOptions> = {}): Promise<WalkEntry[]> {
    const out: WalkEntry[] = []
    for await (const e of this.walk(dir, { maxEntries: 10_000, ...opts, maxDepth: 0 })) {
      out.push(e)
    }
    return out
  }

  /**
   * Breadth-first guarded walk. Never follows symlinks, so every descendant's
   * real path is realRoot + relative and name-level checks are enough. Names
   * are filtered BEFORE any stat: a vault's Life folder is dropped from the
   * in-memory listing and never stat'd, opened or returned.
   */
  async *walk(root: string, opts: WalkOptions): AsyncGenerator<WalkEntry, WalkStats, undefined> {
    const d = this.check(root)
    if (!d.ok) return { truncated: false, denied: d.reason }
    const queue: { dir: string; depth: number }[] = [{ dir: d.real, depth: 0 }]
    let seen = 0
    const stop = (): WalkStats | null => {
      if (opts.signal?.aborted) return { truncated: true, reason: 'aborted' }
      if (opts.deadline !== undefined && Date.now() > opts.deadline) {
        return { truncated: true, reason: 'deadline' }
      }
      return null
    }

    while (queue.length > 0) {
      const { dir, depth } = queue.shift()!
      const early = stop()
      if (early) return early

      const dirents: DirentLike[] = []
      try {
        const handle = await this.fs.promises.opendir(dir)
        for await (const e of handle) dirents.push(e)
      } catch {
        continue // EACCES, ENOENT (iCloud eviction race): skip silently
      }
      const vaultHere =
        this.isKnownVault(dir) || dirents.some((e) => foldName(e.name) === '.obsidian')

      for (const e of dirents) {
        const name = unwrapICloudStub(e.name)
        const stub = name !== e.name
        if (vaultHere && (isLifeDirName(name) || isVaultConfigName(name))) continue
        if (e.isSymbolicLink()) continue
        const knownType = e.isDirectory() || e.isFile()
        const maybeDir = e.isDirectory() || !knownType
        const maybeFile = e.isFile() || !knownType
        if (maybeDir && (isNoiseDir(name) || isSecretName(name))) continue
        if (maybeFile && isSecretName(name)) continue

        if (seen >= opts.maxEntries) return { truncated: true, reason: 'entries' }
        const halt = stop()
        if (halt) return halt
        seen++

        const full = path.join(dir, e.name)
        let st: StatsLike
        try {
          st = await this.fs.promises.lstat(full)
        } catch {
          continue
        }
        if (st.isSymbolicLink()) continue
        const isDir = st.isDirectory()
        if (!opts.filesOnly || !isDir) {
          yield {
            path: full,
            name,
            isDir,
            depth,
            mtimeMs: st.mtimeMs,
            size: st.size,
            ...(stub ? { icloudStub: true } : {})
          }
        }
        if (isDir && depth < opts.maxDepth) queue.push({ dir: full, depth: depth + 1 })
      }
    }
    return { truncated: false }
  }
}
