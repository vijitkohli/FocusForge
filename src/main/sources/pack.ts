// src/main/sources/pack.ts
// Builds an item's context pack: walk its sources through the guard, rank
// and budget the files, read excerpts (reusing unchanged ones from the last
// pack), add `git log`, and fingerprint the result. No electron import; the
// guard and IO helpers are injected.
//
// Privacy rules enforced here:
// - every stat/read goes through the guard (walk, statReadable, readTextPrefix,
//   readHeadTail, docText -> readBytes; git -> check + hasMarker);
// - labels are relative (`<folder>/<rel>` or `vault:<vault-rel>`), never absolute;
// - the vault root (or anything above a root) is never walked: `too-broad`;
// - `<vault>/FocusForge/` (the app's own notes) is skipped, except exactly the
//   virtual `<vault>/FocusForge/**.md#My notes` refs Phase 4 hands in;
// - a missing section never falls back to the whole note;
// - excerpts are redacted before they are cached or sent.
import { createHash } from 'crypto'
import path from 'path'
import {
  DEFAULT_PACK_BUDGET,
  PACK_VERSION,
  type ContextPack,
  type PackBudget,
  type PackFile,
  type PackFileKind,
  type PackGit,
  type PackIndexEntry,
  type PackSourceStatus
} from '../../common/readers'
import { localDay } from '../../common/digest'
import { splitSourceRef } from '../../common/sourceRef'
import type { PathGuard } from './guard'
import { APP_VAULT_DIR, foldName } from './rules'
import {
  escapeFenceLines,
  extractSection,
  foldHeading,
  headTail,
  isConflictCopy,
  looksBinary,
  notebookToText,
  redactSecrets
} from './excerpt'
import {
  allocateBudget,
  classifyFile,
  MAX_PDF_BYTES,
  rankCandidates,
  type Candidate,
  type Tier
} from './select'
import type { GitLogFn } from './git'
import type { DocTextFn } from './doctext'
import { packFingerprint, renderGitText } from './packPrompt'

export interface BuildPackDeps {
  git: GitLogFn
  docText: DocTextFn
  now?: () => Date
}

export interface BuildPackOptions {
  budget?: Partial<PackBudget>
  signal?: AbortSignal
  /** Whole-build time limit (default 20 s). */
  deadlineMs?: number
  /**
   * Refs added at build time and never stored in the registry: Phase 4's
   * `<vault>/FocusForge/…md#My notes` sections. Anything else is ignored.
   */
  virtualRefs?: string[]
}

const MY_NOTES = 'my notes'
export const LIFE_PLACEHOLDER = '(closed folder)'
const SECTION_READ_BYTES = 2 * 1024 * 1024
const NOTEBOOK_READ_BYTES = 8 * 1024 * 1024
const WALK = { maxDepth: 8, maxEntries: 20_000, walkMs: 8_000 }
const MAX_INDEX_ENTRIES = 500
const READ_CONCURRENCY = 4

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')

/** Path of `p` relative to `root` with '/' separators, or null when not under it. */
function relUnder(p: string, root: string, fold: (x: string) => string): string | null {
  const fp = fold(p)
  const fr = fold(root)
  if (fp === fr) return ''
  const prefix = fr.endsWith(path.sep) ? fr : fr + path.sep
  if (!fp.startsWith(prefix)) return null
  // Slice the original-case path by the folded root's length (same length after folding).
  return path.resolve(p).normalize('NFC').slice(prefix.length).split(path.sep).join('/')
}

interface Ctx {
  guard: PathGuard
  vault: string | null
  roots: string[]
  fold: (p: string) => string
}

/** `vault:Learning/Thesis Hub/Thesis.md` or `<parent folder>/<file>`. Never absolute. */
function fileLabel(ctx: Ctx, abs: string): string {
  if (ctx.vault) {
    const rel = relUnder(abs, ctx.vault, ctx.fold)
    if (rel) return `vault:${rel}`
  }
  return `${path.basename(path.dirname(abs))}/${path.basename(abs)}`
}

function isUnderAppDir(ctx: Ctx, abs: string): boolean {
  if (!ctx.vault) return false
  const rel = relUnder(abs, ctx.vault, ctx.fold)
  if (rel === null || rel === '') return false
  return foldName(rel.split('/')[0]) === foldName(APP_VAULT_DIR)
}

/** Exactly `<vault>/FocusForge/**.md#My notes`. */
export function isMyNotesRef(
  ref: string,
  vault: string | null,
  fold: (p: string) => string
): boolean {
  const { path: p, heading } = splitSourceRef(ref)
  if (!vault || !heading || foldHeading(heading) !== MY_NOTES) return false
  if (!/\.md$/i.test(p) || !path.isAbsolute(p)) return false
  const rel = relUnder(p, vault, fold)
  if (!rel) return false
  const segs = rel.split('/')
  return segs.length >= 2 && foldName(segs[0]) === foldName(APP_VAULT_DIR) && !segs.includes('..')
}

/** A folder that is a root (vault/source) or above one is too broad to read as one item. */
function isTooBroadFolder(ctx: Ctx, abs: string): boolean {
  const f = ctx.fold(abs)
  const all = [...(ctx.vault ? [ctx.vault] : []), ...ctx.roots].map(ctx.fold)
  return all.some((r) => r === f || r.startsWith(f.endsWith(path.sep) ? f : f + path.sep))
}

interface Cand extends Candidate {
  abs: string
  label: string
  section?: { heading: string; toEnd: boolean }
  sourceIdx: number
  /** Bytes on disk (the note's size for a section). */
  statSize: number
}

interface IndexOnly {
  label: string
  mtimeMs: number
  size: number
  note?: PackIndexEntry['note']
}

/** Builds the context pack for one item. Never throws for source problems; they become statuses. */
export async function buildPack(
  guard: PathGuard,
  item: { id: string; sources: string[] },
  previous: ContextPack | null,
  deps: BuildPackDeps,
  opts: BuildPackOptions = {}
): Promise<ContextPack> {
  const now = deps.now ?? (() => new Date())
  const started = Date.now()
  const deadline = started + (opts.deadlineMs ?? 20_000)
  const budget: PackBudget = { ...DEFAULT_PACK_BUDGET, ...opts.budget }
  const roots = guard.roots()
  const vd = roots.vault ? guard.check(roots.vault) : null
  const ctx: Ctx = {
    guard,
    vault: vd?.ok ? vd.real : roots.vault,
    roots: [...roots.source, ...(roots.vault ? [roots.vault] : [])],
    fold: (p) => guard.fold(p)
  }
  const stop = (): boolean => Boolean(opts.signal?.aborted) || Date.now() > deadline

  const sources: PackSourceStatus[] = []
  const cands: Cand[] = []
  const indexOnly: IndexOnly[] = []
  const gitDirs: { dir: string; sourceIdx: number }[] = []
  const seenKeys = new Set<string>()
  let truncated = false
  let notDownloaded = 0
  let conflicts = 0
  let activity = 0

  const prevByLabel = new Map((previous?.files ?? []).map((f) => [f.label, f]))
  const prevNotes = new Map(
    (previous?.index ?? []).filter((e) => e.note).map((e) => [e.label, e.note])
  )
  const changedVsPrevious = (label: string, mtimeMs: number, size: number): boolean => {
    const p = prevByLabel.get(label)
    if (p) return p.mtimeMs !== mtimeMs || p.size !== size
    const s = previous?.seen[label]
    if (s) return s.mtimeMs !== mtimeMs || s.size !== size
    return true
  }

  const virtual = (opts.virtualRefs ?? []).filter((r) => {
    const d = guard.checkSource(r)
    const { heading } = splitSourceRef(r)
    return d.ok && isMyNotesRef(heading ? `${d.real}#${heading}` : d.real, ctx.vault, ctx.fold)
  })
  const refs = [
    ...item.sources.map((r) => ({ ref: r, virtual: false })),
    ...virtual.map((r) => ({ ref: r, virtual: true }))
  ]

  for (const { ref, virtual: isVirtual } of refs) {
    const idx = sources.length
    const status: PackSourceStatus = {
      ref,
      state: 'ok',
      files: 0,
      ...(isVirtual ? { virtual: true } : {})
    }
    sources.push(status)
    const { path: p, heading } = splitSourceRef(ref)
    const d = guard.check(p)
    if (!d.ok) {
      status.state = d.reason === 'unreadable' ? 'missing' : 'denied'
      status.reason = d.reason
      // Not even a Life name is kept in a state file.
      if (d.reason === 'life') status.ref = LIFE_PLACEHOLDER
      continue
    }
    const real = d.real
    if (isUnderAppDir(ctx, real) && !isVirtual) {
      status.state = 'denied'
      status.reason = 'app-folder'
      continue
    }
    const st = await guard.statReadable(p)
    if (!st) {
      status.state = 'missing'
      continue
    }
    if (st.isDirectory()) {
      if (heading) {
        status.state = 'missing'
        continue
      }
      if (isTooBroadFolder(ctx, p) || isTooBroadFolder(ctx, real)) {
        status.state = 'too-broad'
        continue
      }
      const inVault = ctx.vault !== null && relUnder(real, ctx.vault, ctx.fold) !== null
      const folderName = path.basename(d.real)
      const walkDeadline = Math.min(deadline, Date.now() + WALK.walkMs)
      const entries: {
        path: string
        name: string
        rel: string
        depth: number
        mtimeMs: number
        size: number
        stub: boolean
      }[] = []
      const it = guard.walk(p, {
        maxDepth: WALK.maxDepth,
        maxEntries: WALK.maxEntries,
        deadline: walkDeadline,
        signal: opts.signal,
        filesOnly: true
      })
      let res = await it.next()
      while (!res.done) {
        const e = res.value
        const relReal = relUnder(e.path, d.real, ctx.fold)
        if (relReal !== null) {
          entries.push({
            path: e.path,
            name: e.name,
            rel: relReal,
            depth: relReal.split('/').length - 1,
            mtimeMs: e.mtimeMs,
            size: e.size,
            stub: Boolean(e.icloudStub)
          })
        }
        res = await it.next()
      }
      if (res.value?.truncated) truncated = true
      // Siblings per directory, for conflict-copy detection (vault only).
      const byDir = new Map<string, Set<string>>()
      if (inVault) {
        for (const e of entries) {
          const dir = path.dirname(e.path)
          if (!byDir.has(dir)) byDir.set(dir, new Set())
          byDir.get(dir)!.add(path.basename(e.path))
        }
      }
      if (await guard.hasMarker(p, '.git')) gitDirs.push({ dir: p, sourceIdx: idx })
      for (const e of entries) {
        if (inVault && isUnderAppDir(ctx, e.path)) continue
        const label = inVault ? fileLabel(ctx, e.path) : `${folderName}/${e.rel}`
        const key = ctx.fold(e.path)
        if (seenKeys.has(key)) continue
        seenKeys.add(key)
        activity = Math.max(activity, e.mtimeMs)
        if (e.stub) {
          notDownloaded++
          indexOnly.push({
            label: inVault
              ? fileLabel(ctx, path.join(path.dirname(e.path), e.name))
              : `${folderName}/${path.posix.join(path.posix.dirname(e.rel), e.name)}`,
            mtimeMs: e.mtimeMs,
            size: e.size,
            note: 'not-downloaded'
          })
          continue
        }
        if (
          inVault &&
          isConflictCopy(path.basename(e.path), byDir.get(path.dirname(e.path)) ?? [])
        ) {
          conflicts++
          continue
        }
        const cls = classifyFile(e.rel, { inVault, depth: e.depth })
        if (!cls) {
          indexOnly.push({ label, mtimeMs: e.mtimeMs, size: e.size })
          continue
        }
        const ext = path.extname(e.name).toLowerCase()
        if (ext === '.pdf' && e.size > MAX_PDF_BYTES) {
          indexOnly.push({ label, mtimeMs: e.mtimeMs, size: e.size, note: 'too-large' })
          continue
        }
        status.files++
        cands.push({
          key,
          abs: e.path,
          label,
          kind: cls.kind,
          tier: cls.tier,
          size: ext === '.pdf' || ext === '.docx' ? 15_000 : e.size,
          mtimeMs: e.mtimeMs,
          depth: e.depth,
          statSize: e.size,
          changed: changedVsPrevious(label, e.mtimeMs, e.size),
          ext,
          sourceIdx: idx
        })
      }
      if (status.files === 0) status.state = 'empty'
      continue
    }
    // A single note or a section of one.
    if (!st.isFile()) {
      status.state = 'missing'
      continue
    }
    const key = ctx.fold(real) + (heading ? `#${foldHeading(heading)}` : '')
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    activity = Math.max(activity, st.mtimeMs)
    const inVault = ctx.vault !== null && relUnder(real, ctx.vault, ctx.fold) !== null
    const name = path.basename(real)
    const ext = path.extname(name).toLowerCase()
    let kind: PackFileKind
    let tier: Tier
    if (heading || (inVault && (ext === '.md' || ext === '.markdown'))) {
      kind = 'vault'
      tier = 1
    } else {
      const cls = classifyFile(name, { inVault, depth: 0 })
      if (!cls) {
        status.state = 'empty'
        continue
      }
      kind = cls.kind
      tier = cls.tier
    }
    const label = fileLabel(ctx, real) + (heading ? `#${heading.trim()}` : '')
    status.files = 1
    cands.push({
      key,
      abs: real,
      label,
      kind,
      tier,
      size: heading
        ? Math.min(st.size, 15_000)
        : ext === '.pdf' || ext === '.docx'
          ? 15_000
          : st.size,
      mtimeMs: st.mtimeMs,
      depth: 0,
      statSize: st.size,
      changed: changedVsPrevious(label, st.mtimeMs, st.size),
      ext,
      sourceIdx: idx,
      ...(heading ? { section: { heading, toEnd: isVirtual } } : {})
    })
  }

  // ---- git
  const git: PackGit[] = []
  for (const g of gitDirs) {
    if (stop()) {
      truncated = true
      break
    }
    const commits = await deps.git(guard, g.dir, { limit: budget.gitCommits })
    if (!commits) {
      if (sources[g.sourceIdx].state === 'ok' || sources[g.sourceIdx].state === 'empty') {
        sources[g.sourceIdx].state = sources[g.sourceIdx].files > 0 ? 'ok' : 'git-unavailable'
      }
      continue
    }
    const raw = renderGitText(commits)
    const text = escapeFenceLines(redactSecrets(headTail(raw, budget.gitChars).text).text)
    const label = `git:${path.basename(g.dir)}`
    git.push({ id: `G${git.length + 1}`, label, head: commits[0]?.hash ?? '', commits, text })
    if (sources[g.sourceIdx].state === 'empty') sources[g.sourceIdx].state = 'ok'
    const newest = commits[0] ? Date.parse(commits[0].date) : NaN
    if (Number.isFinite(newest)) activity = Math.max(activity, newest)
  }
  const gitChars = git.reduce((s, g) => s + g.text.length, 0)

  // ---- rank, budget, read
  const ranked = rankCandidates(cands, now().getTime())
  const { take, skip } = allocateBudget(ranked, budget, gitChars)
  for (const c of skip) indexOnly.push({ label: c.label, mtimeMs: c.mtimeMs, size: c.statSize })

  let bytesLeft = budget.maxReadBytesPerBuild
  const results: (PackFile | null)[] = new Array(take.length).fill(null)
  let next = 0
  const readOne = async (i: number): Promise<void> => {
    const { item: c, chars: cap } = take[i]
    if (stop()) {
      truncated = true
      indexOnly.push({ label: c.label, mtimeMs: c.mtimeMs, size: c.statSize })
      return
    }
    // Known binary / too-large files stay in the index without another read.
    const prevNote = prevNotes.get(c.label)
    if ((prevNote === 'binary' || prevNote === 'too-large') && !c.changed) {
      indexOnly.push({ label: c.label, mtimeMs: c.mtimeMs, size: c.statSize, note: prevNote })
      return
    }
    const prev = prevByLabel.get(c.label)
    if (
      prev &&
      prev.ref === (c.section ? `${c.abs}#${c.section.heading}` : c.abs) &&
      prev.mtimeMs === c.mtimeMs &&
      prev.size === c.statSize
    ) {
      if (!prev.truncated || prev.chars <= cap) {
        const text = prev.chars > cap ? escapeFenceLines(headTail(prev.text, cap).text) : prev.text
        results[i] = {
          ...prev,
          kind: c.kind,
          chars: text.length,
          text,
          truncated: prev.truncated || text.length < prev.chars,
          changed: false
        }
        return
      }
    }
    const got = await readText(guard, deps, c, budget, bytesLeft)
    if (got === 'budget') {
      truncated = true
      indexOnly.push({ label: c.label, mtimeMs: c.mtimeMs, size: c.statSize })
      return
    }
    if (got === null || 'note' in got) {
      if (got && 'note' in got)
        indexOnly.push({ label: c.label, mtimeMs: c.mtimeMs, size: c.statSize, note: got.note })
      else if (c.section) sources[c.sourceIdx].state = 'section-missing'
      else indexOnly.push({ label: c.label, mtimeMs: c.mtimeMs, size: c.statSize })
      if (c.section) sources[c.sourceIdx].files = 0
      return
    }
    bytesLeft -= got.bytesRead
    const red = redactSecrets(got.text)
    const cut = headTail(red.text, cap)
    const text = escapeFenceLines(cut.text)
    results[i] = {
      id: '',
      label: c.label,
      ref: c.section ? `${c.abs}#${c.section.heading}` : c.abs,
      kind: c.kind,
      mtimeMs: c.mtimeMs,
      size: got.size,
      hash: got.hash,
      chars: text.length,
      truncated: cut.truncated || got.truncated,
      redactions: red.count,
      changed: !prev || prev.hash !== got.hash,
      text
    }
  }
  const worker = async (): Promise<void> => {
    while (next < take.length) {
      const i = next++
      await readOne(i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, take.length) }, worker))

  const files = results
    .filter((f): f is PackFile => f !== null)
    .map((f, i) => ({ ...f, id: `F${i + 1}` }))
  const seen: ContextPack['seen'] = {}
  for (const e of indexOnly) seen[e.label] = { mtimeMs: e.mtimeMs, size: e.size }
  const index = indexOnly
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.label.localeCompare(b.label))
    .slice(0, MAX_INDEX_ENTRIES)
    .map((e) => ({
      label: e.label,
      date: localDay(e.mtimeMs),
      ...(e.note ? { note: e.note } : {})
    }))

  const fingerprint = packFingerprint({ files, git })
  return {
    version: PACK_VERSION,
    itemId: item.id,
    builtAt: now().toISOString(),
    budget,
    totalChars: files.reduce((s, f) => s + f.chars, 0) + gitChars,
    truncated,
    sources,
    files,
    git,
    index,
    seen,
    activityAt: activity > 0 ? new Date(activity).toISOString() : null,
    notDownloaded,
    conflicts,
    fingerprint
  }
}

type ReadResult =
  | { text: string; hash: string; size: number; truncated: boolean; bytesRead: number }
  | { note: 'binary' | 'too-large' }
  | null
  | 'budget'

/** Reads one candidate's text through the guard (or doc text), before redaction and cutting. */
async function readText(
  guard: PathGuard,
  deps: BuildPackDeps,
  c: Cand,
  budget: PackBudget,
  bytesLeft: number
): Promise<ReadResult> {
  if (c.ext === '.pdf' || c.ext === '.docx') {
    if (bytesLeft < 1) return 'budget'
    const res = await deps.docText(c.abs, c.ext === '.pdf' ? 'pdf' : 'docx', {
      mtimeMs: c.mtimeMs,
      size: c.statSize
    })
    if (!res) return null
    return {
      text: res.text,
      hash: res.hash,
      size: c.statSize,
      truncated: false,
      bytesRead: res.bytesRead
    }
  }
  if (c.section) {
    if (bytesLeft < Math.min(c.statSize, SECTION_READ_BYTES)) return 'budget'
    const r = await guard.readTextPrefix(c.abs, SECTION_READ_BYTES)
    if (!r) return null
    const sec = extractSection(r.text, c.section.heading, { toEnd: c.section.toEnd })
    if (sec === null) return null
    return {
      text: sec,
      hash: sha256(sec),
      size: c.statSize,
      truncated: false,
      bytesRead: Buffer.byteLength(r.text)
    }
  }
  if (c.kind === 'notebook') {
    if (c.statSize > NOTEBOOK_READ_BYTES) return { note: 'too-large' }
    if (bytesLeft < c.statSize) return 'budget'
    const r = await guard.readTextPrefix(c.abs, NOTEBOOK_READ_BYTES)
    if (!r) return null
    if (r.truncated) return { note: 'too-large' }
    const text = notebookToText(r.text)
    if (text === null) return { note: 'too-large' }
    return {
      text,
      hash: sha256(r.text),
      size: c.statSize,
      truncated: false,
      bytesRead: Buffer.byteLength(r.text)
    }
  }
  const whole = c.statSize <= budget.perFileChars * 2
  const want = whole ? c.statSize : 96 * 1024
  if (bytesLeft < Math.min(want, 8192)) return 'budget'
  if (whole) {
    const r = await guard.readTextPrefix(c.abs, Math.max(c.statSize, 1))
    if (!r) return null
    if (looksBinary(r.text)) return { note: 'binary' }
    return {
      text: r.text,
      hash: sha256(r.text),
      size: c.statSize,
      truncated: r.truncated,
      bytesRead: Buffer.byteLength(r.text)
    }
  }
  const r = await guard.readHeadTail(c.abs, 64 * 1024, 32 * 1024)
  if (!r) return null
  if (looksBinary(r.text)) return { note: 'binary' }
  return {
    text: r.text,
    hash: sha256(r.text),
    size: r.size,
    truncated: r.truncated,
    bytesRead: Math.min(r.size, 96 * 1024)
  }
}
