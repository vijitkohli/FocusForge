// src/main/sources/packPrompt.ts
// Context pack -> model input. One header format for every phase:
//   === FILE <id>: <label> (<kind>, modified YYYY-MM-DD) ===
//   …excerpt…
//   === END <id> ===
// then `=== GIT <id>: <label> ===` blocks and one `=== INDEX (files not shown) ===`.
// `label` is the pack's model-safe label: never an absolute path or the vault's
// folder name. File text is already header-escaped by the pack builder.
import { createHash } from 'crypto'
import type {
  ContextPack,
  GitCommit,
  PackFile,
  PackGit,
  PackIndexEntry
} from '../../common/readers'
import { DIGEST_PROMPT_VERSION, localDay } from '../../common/digest'
import { escapeFenceLines, headTail } from './excerpt'

export function fileHeader(f: Pick<PackFile, 'id' | 'label' | 'kind' | 'mtimeMs'>): string {
  return `=== FILE ${f.id}: ${f.label} (${f.kind}, modified ${localDay(f.mtimeMs)}) ===`
}

function fileBlock(f: PackFile, text = f.text): string {
  return `${fileHeader(f)}\n${text}\n=== END ${f.id} ===`
}

function gitBlock(g: Pick<PackGit, 'id' | 'label'>, text: string): string {
  return `=== GIT ${g.id}: ${g.label} ===\n${text}\n=== END ${g.id} ===`
}

/** `2026-11-10 abc1234 add guard study` + indented changed files. */
export function renderGitText(commits: GitCommit[]): string {
  return commits
    .map((c) => {
      const head = `${c.date.slice(0, 10)} ${c.hash} ${c.subject}`
      return c.files.length ? `${head}\n${c.files.map((f) => `    ${f}`).join('\n')}` : head
    })
    .join('\n')
}

/** The index as lines (newest first), capped at `maxChars`. */
export function renderIndex(index: PackIndexEntry[], maxChars: number): string {
  const lines: string[] = []
  let used = 0
  for (const e of index) {
    const line = `${e.label} · ${e.date}${e.note ? ` · ${e.note.replace('-', ' ')}` : ''}`
    if (used + line.length + 1 > maxChars) {
      lines.push(`… and ${index.length - lines.length} more`)
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  return escapeFenceLines(lines.join('\n'))
}

function indexBlock(index: PackIndexEntry[], maxChars: number): string {
  if (index.length === 0) return ''
  return `=== INDEX (files not shown) ===\n${renderIndex(index, maxChars)}\n=== END INDEX ===`
}

/**
 * The whole pack as planner input (Phase 5). Files in tier order, then git,
 * then the index; a file that no longer fits is cut (head + tail) or, if
 * less than 2K characters remain, listed in the index instead.
 */
export function packToPromptText(pack: ContextPack, o: { maxChars?: number } = {}): string {
  const max = o.maxChars ?? 120_000
  const gitText = pack.git.map((g) => gitBlock(g, g.text)).join('\n\n')
  const reserve = Math.min(gitText.length, Math.floor(max * 0.15)) + 2_000
  let left = max - reserve
  const parts: string[] = []
  const extraIndex: PackIndexEntry[] = []
  for (const f of pack.files) {
    const block = fileBlock(f)
    if (block.length + 2 <= left) {
      parts.push(block)
      left -= block.length + 2
      continue
    }
    const room = left - fileHeader(f).length - 30
    if (room >= 2_000) {
      const cut = headTail(f.text, room).text
      const b = fileBlock(f, cut)
      parts.push(b)
      left -= b.length + 2
    } else {
      extraIndex.push({ label: f.label, date: localDay(f.mtimeMs) })
    }
  }
  left += reserve
  if (gitText) {
    const g =
      gitText.length + 2 <= left ? gitText : headTail(gitText, Math.max(0, left - 2_000)).text
    parts.push(g)
    left -= g.length + 2
  }
  const idx = indexBlock([...extraIndex, ...pack.index], Math.max(0, Math.min(8_000, left - 60)))
  if (idx && idx.length <= left) parts.push(idx)
  return parts.join('\n\n')
}

export interface DigestInputFile {
  id: string
  label: string
  kind: PackFile['kind']
  date: string
  changed: boolean
  truncated: boolean
  text: string
}

export interface DigestInput {
  files: DigestInputFile[]
  git: { id: string; label: string; text: string }[]
  index: string
  /** Blocks that changed since the basis (all blocks in full mode). */
  changedIds: string[]
  /** Every block id in this input (citations are limited to these). */
  sentIds: string[]
  chars: number
}

/**
 * Digest payload blocks. Full mode sends everything. Incremental mode sends
 * the CONTEXT.md files (always), files whose hash differs from `basis`, git
 * commits newer than the basis head, and the index.
 */
export function packToDigestInput(
  pack: ContextPack,
  o: {
    mode: 'full' | 'incremental'
    maxChars?: number
    basis?: { files: Record<string, string>; git: Record<string, string> }
  }
): DigestInput {
  const max = o.maxChars ?? 120_000
  const basis = o.mode === 'incremental' ? o.basis : undefined
  const changed = (f: PackFile): boolean => !basis || basis.files[f.label] !== f.hash
  const files: DigestInputFile[] = []
  const changedIds: string[] = []
  let used = 0
  for (const f of pack.files) {
    const isChanged = changed(f)
    if (basis && !isChanged && f.kind !== 'context') continue
    if (used + f.text.length > max) continue
    used += f.text.length
    files.push({
      id: f.id,
      label: f.label,
      kind: f.kind,
      date: localDay(f.mtimeMs),
      changed: isChanged,
      truncated: f.truncated,
      text: f.text
    })
    if (isChanged) changedIds.push(f.id)
  }
  const git: DigestInput['git'] = []
  for (const g of pack.git) {
    let commits = g.commits
    const known = basis?.git[g.label]
    if (known) {
      const at = commits.findIndex((c) => c.hash === known)
      if (at !== -1) commits = commits.slice(0, at)
    }
    if (commits.length === 0) continue
    const text = known && commits !== g.commits ? renderGitText(commits) : g.text
    git.push({ id: g.id, label: g.label, text })
    changedIds.push(g.id)
    used += text.length
  }
  const index = renderIndex(pack.index, Math.min(pack.budget.indexChars, 8_000))
  return {
    files,
    git,
    index,
    changedIds,
    sentIds: [...files.map((f) => f.id), ...git.map((g) => g.id)],
    chars: used + index.length
  }
}

/** Block id -> label and local date, for citations. */
export function resolveCitation(
  pack: ContextPack,
  id: string
): { label: string; date: string | null } | null {
  const f = pack.files.find((x) => x.id === id)
  if (f) return { label: f.label, date: localDay(f.mtimeMs) }
  const g = pack.git.find((x) => x.id === id)
  if (g) return { label: g.label, date: g.commits[0]?.date.slice(0, 10) ?? null }
  return null
}

/** sha256 over sorted (label, hash) pairs, the git heads and the digest prompt version. */
export function packFingerprint(pack: Pick<ContextPack, 'files' | 'git'>): string {
  const h = createHash('sha256')
  h.update(`v${DIGEST_PROMPT_VERSION}\n`)
  for (const [label, hash] of pack.files
    .map((f) => [f.label, f.hash])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    h.update(`f\0${label}\0${hash}\n`)
  }
  for (const [label, head] of pack.git
    .map((g) => [g.label, g.head])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    h.update(`g\0${label}\0${head}\n`)
  }
  return h.digest('hex')
}

/** label -> hash and git label -> head: what a digest was built from. */
export function packBasis(pack: Pick<ContextPack, 'files' | 'git'>): {
  files: Record<string, string>
  git: Record<string, string>
} {
  return {
    files: Object.fromEntries(pack.files.map((f) => [f.label, f.hash])),
    git: Object.fromEntries(pack.git.map((g) => [g.label, g.head]))
  }
}
