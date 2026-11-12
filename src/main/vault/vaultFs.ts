// src/main/vault/vaultFs.ts
// THE ONLY MODULE THAT WRITES TO THE VAULT. Pure Node (no electron import).
//
// Every call takes a vault-relative path that must sit under `FocusForge/`
// (APP_VAULT_DIR) and must pass `guard.canWrite` (writes) or `guard.check`
// (reads) for its absolute form, or it throws VaultWriteDenied before any fs
// call. A rename checks both ends. Nothing is ever deleted, except this
// module's own temp files in `FocusForge/.tmp.nosync/`. Reads and listings go
// through the guard. Denied paths are never logged or put in error messages.
import nodeFs from 'fs'
import path from 'path'
import type { AtomicFs } from '../store/atomic'
import { writeFileAtomic } from '../store/atomic'
import type { PathGuard, StatsLike, WalkEntry } from '../sources/guard'
import { APP_VAULT_DIR } from '../sources/rules'

/** iCloud doesn't sync `.nosync`, Obsidian ignores dot-folders, and it's on the vault's volume. */
export const VAULT_TEMP_DIR = `${APP_VAULT_DIR}/.tmp.nosync`

/** Notes bigger than this are never read in full or rewritten. */
export const MAX_NOTE_BYTES = 1024 * 1024

export class VaultWriteDenied extends Error {
  readonly code = 'vault-write-denied'
  constructor(op: string) {
    // No path in the message: the guard rule is that denied paths aren't logged.
    super(`Vault ${op} refused: outside FocusForge/`)
    this.name = 'VaultWriteDenied'
  }
}

/** The fs calls VaultFs makes for writes. Injected in tests to trace every path. */
export interface VaultWriteFs extends AtomicFs {
  lstat(p: string): Promise<StatsLike>
}

export const nodeVaultWriteFs: VaultWriteFs = {
  lstat: (p) => nodeFs.promises.lstat(p),
  mkdir: (p, opts) => nodeFs.promises.mkdir(p, opts),
  open: (p, flags) => nodeFs.promises.open(p, flags),
  rename: (a, b) => nodeFs.promises.rename(a, b),
  unlink: (p) => nodeFs.promises.unlink(p)
}

/** The guard surface VaultFs needs. */
export type VaultGuard = Pick<
  PathGuard,
  'canWrite' | 'check' | 'roots' | 'statReadable' | 'readTextPrefix' | 'listDir'
>

export interface NoteStat {
  mtimeMs: number
  size: number
}

export type VaultReadResult =
  | { text: string; stat: NoteStat }
  | { missing: true; stub: boolean }
  | { tooLarge: true }

/**
 * Normalised vault-relative path under FocusForge/, or null. Rejects
 * absolute paths, `..`, NUL, backslashes and (unless `allowDot`) any segment
 * starting with a dot, so app writes never land in a dot-folder.
 */
export function appRel(rel: unknown, opts: { allowRoot?: boolean } = {}): string | null {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || rel.includes('\\')) return null
  if (rel.startsWith('/') || path.isAbsolute(rel)) return null
  const segs = rel.normalize('NFC').split('/')
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return null
  if (segs[0] !== APP_VAULT_DIR) return null
  if (segs.length === 1 && !opts.allowRoot) return null
  return segs.join('/')
}

export class VaultFs {
  private readonly root: string
  private readonly enabled: boolean

  constructor(
    private readonly guard: VaultGuard,
    vaultRoot: string,
    private readonly fsImpl: VaultWriteFs = nodeVaultWriteFs
  ) {
    this.root = path.resolve(vaultRoot)
    // Only the guard's readable vault is ever written; anything else is refused outright.
    this.enabled = guard.roots().vault === this.root
  }

  private abs(rel: string): string {
    return path.join(this.root, ...rel.split('/'))
  }

  /** Absolute path for a write, or throws before any fs call. */
  private writable(rel: unknown, op: string, opts: { allowRoot?: boolean } = {}): string {
    const clean = appRel(rel, opts)
    if (!this.enabled || clean === null) throw new VaultWriteDenied(op)
    const abs = this.abs(clean)
    if (!this.guard.canWrite(abs)) throw new VaultWriteDenied(op)
    return abs
  }

  private readable(rel: unknown, op: string): string {
    const clean = appRel(rel, { allowRoot: true })
    if (!this.enabled || clean === null) throw new VaultWriteDenied(op)
    const abs = this.abs(clean)
    if (!this.guard.check(abs).ok) throw new VaultWriteDenied(op)
    return abs
  }

  private tempDir(): string {
    const abs = this.abs(VAULT_TEMP_DIR)
    if (!this.guard.canWrite(abs)) throw new VaultWriteDenied('write')
    return abs
  }

  /** Text and stat of a note; `missing` (with `stub` for an iCloud placeholder) or `tooLarge`. */
  async read(rel: string): Promise<VaultReadResult> {
    const abs = this.readable(rel, 'read')
    for (let attempt = 0; ; attempt++) {
      const before = await this.guard.statReadable(abs)
      if (!before || !before.isFile()) {
        const stub = path.join(path.dirname(abs), `.${path.basename(abs)}.icloud`)
        return { missing: true, stub: (await this.guard.statReadable(stub)) !== null }
      }
      if (before.size > MAX_NOTE_BYTES) return { tooLarge: true }
      const got = await this.guard.readTextPrefix(abs, MAX_NOTE_BYTES + 1)
      if (!got) return { missing: true, stub: false }
      if (got.truncated) return { tooLarge: true }
      const after = await this.guard.statReadable(abs)
      const same = after && after.mtimeMs === before.mtimeMs && after.size === before.size
      // Changed mid-read (Obsidian saving): read again so text and stat agree.
      if (same || attempt >= 2) {
        const st = after ?? before
        return { text: got.text, stat: { mtimeMs: st.mtimeMs, size: st.size } }
      }
    }
  }

  /**
   * Atomic write that lands only if the file still matches `expect` (its stat
   * from the last read, or 'absent'), re-checked just before the rename.
   */
  async writeIfUnchanged(
    rel: string,
    text: string,
    expect: NoteStat | 'absent'
  ): Promise<'written' | 'changed'> {
    const abs = this.writable(rel, 'write')
    this.writable(path.posix.dirname(appRel(rel) as string), 'write', { allowRoot: true })
    const tempDir = this.tempDir()
    const result = await writeFileAtomic(abs, text, {
      tempDir,
      fsImpl: this.fsImpl,
      beforeRename: async () => {
        // A symlink swapped in since the first check is refused here.
        if (!this.guard.canWrite(abs)) return false
        return this.matches(abs, expect)
      }
    })
    return result === 'written' ? 'written' : 'changed'
  }

  private async matches(abs: string, expect: NoteStat | 'absent'): Promise<boolean> {
    let st: StatsLike
    try {
      st = await this.fsImpl.lstat(abs)
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' && expect === 'absent'
    }
    if (expect === 'absent' || !st.isFile() || st.isSymbolicLink()) return false
    return st.mtimeMs === expect.mtimeMs && st.size === expect.size
  }

  async ensureDir(rel: string): Promise<void> {
    const abs = this.writable(rel, 'mkdir', { allowRoot: true })
    await this.fsImpl.mkdir(abs, { recursive: true })
  }

  /** Moves a note or item folder inside FocusForge/. Never replaces an existing entry. */
  async rename(fromRel: string, toRel: string): Promise<void> {
    const from = this.writable(fromRel, 'rename')
    const to = this.writable(toRel, 'rename')
    this.writable(path.posix.dirname(appRel(toRel) as string), 'rename', { allowRoot: true })
    if (await this.exists(to)) {
      // Case-only renames on a case-insensitive volume see the source itself.
      const sameEntry = from.toLowerCase() === to.toLowerCase() && from !== to
      if (!sameEntry) throw new Error('Vault rename refused: the target already exists')
    }
    await this.fsImpl.mkdir(path.dirname(to), { recursive: true })
    await this.fsImpl.rename(from, to)
  }

  private async exists(abs: string): Promise<boolean> {
    try {
      await this.fsImpl.lstat(abs)
      return true
    } catch {
      return false
    }
  }

  /** Stat of a file or folder under FocusForge/ through the guard; null when missing. */
  async stat(rel: string): Promise<(NoteStat & { isDir: boolean }) | null> {
    const abs = this.readable(rel, 'stat')
    const st = await this.guard.statReadable(abs)
    return st ? { mtimeMs: st.mtimeMs, size: st.size, isDir: st.isDirectory() } : null
  }

  /** Absolute path of a note under FocusForge/ (for Open in Obsidian); null when refused. */
  absPath(rel: string): string | null {
    const clean = appRel(rel)
    if (!this.enabled || clean === null) return null
    const abs = this.abs(clean)
    return this.guard.check(abs).ok ? abs : null
  }

  /** One level of a folder under FocusForge/, through the guard (never follows symlinks). */
  async listDir(rel: string): Promise<WalkEntry[]> {
    const abs = this.readable(rel, 'list')
    return this.guard.listDir(abs)
  }
}
