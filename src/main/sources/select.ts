// src/main/sources/select.ts
// Which files go into an item's context pack, in what order, and how many
// characters each may use. Pure: works on walk results (names, sizes,
// mtimes), never on the filesystem.
import path from 'path'
import type { PackBudget, PackFileKind } from '../../common/readers'

export type Tier = 0 | 1 | 2 | 3 | 4 | 5

export interface Classified {
  kind: PackFileKind
  tier: Tier
}

const TEXT_EXT = new Set(['.md', '.markdown', '.txt'])
export const BRIEF_NAME = /(spec|brief|rubric|outline|assignment|marking|criteria)/i
const AGENT_NAMES = /^(claude|agents|gemini|status|recap|todo|decisions|project_summary)\.md$/i
const AGENT_PREFIX = /^(handoff|plan)[^/]*\.md$/i

/** Depth limit for brief PDFs (0 = at the source root). */
export const BRIEF_MAX_DEPTH = 3
export const MAX_BRIEF_PDFS = 6
export const MAX_DOCX = 3
export const DOC_CHARS = 15_000
export const VAULT_FILE_CHARS = 15_000
export const MAX_PDF_BYTES = 15 * 1024 * 1024

/**
 * Tier and kind of a file inside a folder source, from its source-relative
 * path. null means "index only" (no content).
 */
export function classifyFile(
  rel: string,
  o: { inVault: boolean; depth: number }
): Classified | null {
  const name = path.basename(rel)
  const ext = path.extname(name).toLowerCase()
  if (o.depth === 0 && name.toLowerCase() === 'context.md') return { kind: 'context', tier: 0 }
  if (o.inVault && (ext === '.md' || ext === '.markdown')) return { kind: 'vault', tier: 1 }
  if (TEXT_EXT.has(ext)) {
    if (/^readme\.md$/i.test(name)) {
      return o.depth <= 1 ? { kind: 'agent', tier: 2 } : { kind: 'doc', tier: 5 }
    }
    if (o.depth <= 2 && (AGENT_NAMES.test(name) || AGENT_PREFIX.test(name))) {
      return { kind: 'agent', tier: 2 }
    }
    return { kind: 'doc', tier: 5 }
  }
  if (ext === '.ipynb') return { kind: 'notebook', tier: 5 }
  if (ext === '.pdf') {
    return BRIEF_NAME.test(name) && o.depth <= BRIEF_MAX_DEPTH ? { kind: 'brief', tier: 4 } : null
  }
  if (ext === '.docx') {
    return BRIEF_NAME.test(name) ? { kind: 'brief', tier: 4 } : { kind: 'docx', tier: 5 }
  }
  return null
}

export interface Candidate {
  key: string
  kind: PackFileKind
  tier: Tier
  /** Estimated characters (bytes for text files; a doc's cap for PDF/docx). */
  size: number
  mtimeMs: number
  depth: number
  changed: boolean
  /** File extension, lowercase ('.pdf', '.docx', ...). */
  ext: string
}

const RECENT_MS = 14 * 86_400_000

/**
 * Within each tier: changed first, then newest, then shallower. Tier 5 files
 * modified in the last 14 days rank ahead of older ones.
 */
export function rankCandidates<T extends Candidate>(list: T[], nowMs: number): T[] {
  const recent = (c: T): number => (c.tier === 5 && nowMs - c.mtimeMs <= RECENT_MS ? 1 : 0)
  return [...list].sort(
    (a, b) =>
      a.tier - b.tier ||
      Number(b.changed) - Number(a.changed) ||
      recent(b) - recent(a) ||
      b.mtimeMs - a.mtimeMs ||
      a.depth - b.depth ||
      a.key.localeCompare(b.key)
  )
}

export interface Allocation {
  key: string
  /** Character cap for this file's excerpt. */
  chars: number
}

/**
 * Greedy, in tier order, honouring the reserved slices for vault notes, git
 * and briefs. Unused reserve flows down to the other tiers. Returns the files
 * that get content (in rank order) and the keys that don't.
 */
export function allocateBudget<T extends Candidate>(
  ranked: T[],
  budget: PackBudget,
  gitChars: number
): { take: (Allocation & { item: T })[]; skip: T[] } {
  const take: (Allocation & { item: T })[] = []
  const skip: T[] = []
  const gitUsed = Math.min(budget.gitChars, Math.max(0, gitChars))

  // Up-front reserve for vault and brief tiers, limited to what they need.
  const need = (t: Tier, per: number): number =>
    ranked.filter((c) => c.tier === t).reduce((s, c) => s + Math.min(per, c.size), 0)
  const vaultReserve = Math.min(budget.vaultChars, need(1, VAULT_FILE_CHARS))
  const briefReserve = Math.min(budget.briefChars, need(4, DOC_CHARS))
  let pool = Math.max(0, budget.maxChars - gitUsed - vaultReserve - briefReserve)
  let vaultLeft = vaultReserve
  let briefLeft = briefReserve
  let pdfs = 0
  let docx = 0

  for (const c of ranked) {
    // Ranked in tier order: once past a reserved tier, its leftover reserve
    // flows down to the shared pool.
    if (c.tier > 1 && vaultLeft > 0) {
      pool += vaultLeft
      vaultLeft = 0
    }
    if (c.tier > 4 && briefLeft > 0) {
      pool += briefLeft
      briefLeft = 0
    }
    if (take.length >= budget.maxFiles) {
      skip.push(c)
      continue
    }
    if (c.ext === '.pdf' && pdfs >= MAX_BRIEF_PDFS) {
      skip.push(c)
      continue
    }
    if (c.ext === '.docx' && docx >= MAX_DOCX) {
      skip.push(c)
      continue
    }
    let cap = Math.min(budget.perFileChars, Math.max(1, c.size))
    let chars = 0
    if (c.tier === 1) {
      cap = Math.min(cap, VAULT_FILE_CHARS)
      chars = Math.min(cap, vaultLeft)
      vaultLeft -= chars
    } else if (c.tier === 4) {
      cap = Math.min(cap, DOC_CHARS)
      chars = Math.min(cap, briefLeft)
      briefLeft -= chars
    } else {
      if (c.kind === 'docx') cap = Math.min(cap, DOC_CHARS)
      chars = Math.min(cap, pool)
      pool -= chars
    }
    // A file cut to under 1K characters is better listed in the index than
    // shown as a stub.
    if (chars <= 0 || (chars < cap && chars < Math.min(1000, cap))) {
      if (c.tier === 1) vaultLeft += chars
      else if (c.tier === 4) briefLeft += chars
      else pool += chars
      skip.push(c)
      continue
    }
    if (c.ext === '.pdf') pdfs++
    if (c.ext === '.docx') docx++
    take.push({ key: c.key, chars, item: c })
  }
  return { take, skip }
}
