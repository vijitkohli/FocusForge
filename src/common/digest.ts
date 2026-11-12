// src/common/digest.ts
// The per-item digest (Phase 3 `digest` mode): one factual summary of an
// item, with every fact cited back to a pack block. Shared by main (writes
// it, Phase 4 renders it into the vault note, Phase 5 plans from it) and the
// renderer (Summary panel). Pure: no Node imports.
//
// Model output crosses a trust boundary, so `normalizeDigest` re-validates
// everything the engine already checked: citations must point at blocks that
// were in the payload, dates must be real dates, quotes must appear in the
// cited excerpt, and every list is clamped.
import type { WorkstreamKind } from './types'
import type { ContextPack } from './readers'

export const DIGEST_VERSION = 1
/** Bump when the digest prompt changes; a change forces a full digest. */
export const DIGEST_PROMPT_VERSION = 1

export type GapKind = 'unknown' | 'unconfirmed' | 'stale' | 'to-check' | 'missing'
export type DueKind = 'assignment' | 'exam' | 'presentation' | 'quiz' | 'lab' | 'report' | 'other'
export type DueConfidence = 'confirmed' | 'tentative'
export type OpenItemStatus = 'todo' | 'blocked' | 'waiting'

export const GAP_KINDS: readonly GapKind[] = [
  'unknown',
  'unconfirmed',
  'stale',
  'to-check',
  'missing'
]
export const DUE_KINDS: readonly DueKind[] = [
  'assignment',
  'exam',
  'presentation',
  'quiz',
  'lab',
  'report',
  'other'
]

/** Where a fact came from: a pack label (never an absolute path) and the block's local date. */
export interface DigestSource {
  label: string
  /** YYYY-MM-DD (local) of the cited file or newest commit. */
  date?: string
}

export interface DigestOpenItem {
  text: string
  status: OpenItemStatus
  sources: DigestSource[]
}

export interface DigestDueDate {
  what: string
  /** YYYY-MM-DD, or null when only a week or "TBC" is known. */
  date: string | null
  /** Raw wording, e.g. "Week 11 (TBC)". */
  when?: string
  confidence: DueConfidence
  /** Percentage of the final mark, when stated. */
  weight?: number | null
  kind?: DueKind
  sources: DigestSource[]
}

export interface DigestProgress {
  date: string
  text: string
  sources: DigestSource[]
}

export interface DigestCandidateTask {
  /** Stable across refreshes: a hash of the first source label and the normalised title. */
  id: string
  title: string
  minutes: number
  gapKind: GapKind
  why: string
  quote?: string
  sources: DigestSource[]
}

/** A rule that binds plans, e.g. "AI may not write or fix code (course policy)". */
export interface DigestConstraint {
  text: string
  sources: DigestSource[]
}

export interface ItemDigest {
  version: typeof DIGEST_VERSION
  itemId: string
  generatedAt: string
  model: string
  mode: 'full' | 'incremental'
  incrementalSinceFull: number
  packFingerprint: string
  promptVersion: number
  goal: string
  /** Markdown with `###` sections; citations already rendered as "(label, 10 Nov)". */
  currentState: string
  openItems: DigestOpenItem[]
  dueDates: DigestDueDate[]
  recentProgress: DigestProgress[]
  candidateTasks: DigestCandidateTask[]
  constraints: DigestConstraint[]
  suggestedKind: WorkstreamKind | null
  warnings: string[]
  /**
   * What the digest was built from: label -> content hash, git label -> head.
   * An incremental run sends only what changed since this basis.
   */
  basis?: { files: Record<string, string>; git: Record<string, string> }
}

/** The digest as sent back to the model as `previous` (sources as labels only). */
export interface DigestCore {
  goal: string
  currentState: string
  openItems: { text: string; status: OpenItemStatus; sources: string[] }[]
  dueDates: {
    what: string
    date: string | null
    when?: string
    confidence: DueConfidence
    weight?: number | null
    kind?: DueKind
    sources: string[]
  }[]
  recentProgress: { date: string; text: string; sources: string[] }[]
  candidateTasks: {
    id: string
    title: string
    minutes: number
    gapKind: GapKind
    why: string
    sources: string[]
  }[]
  constraints: { text: string; sources: string[] }[]
}

export const DIGEST_LIMITS = {
  goal: 200,
  currentState: 14_000,
  openItems: 30,
  dueDates: 20,
  recentProgress: 20,
  candidateTasks: 8,
  constraints: 12,
  title: 100,
  quote: 160,
  text: 300
} as const

// ---------------------------------------------------------------- helpers

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Strict YYYY-MM-DD that is a real calendar date. */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1) return false
  const days = [
    31,
    y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ]
  return d <= days[m - 1]
}

/** Local YYYY-MM-DD of an epoch-ms time. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** "(research/status.md, 10 Nov)"; no Date parsing, so it can't shift a day. */
export function renderCitation(s: DigestSource): string {
  if (s.date && isIsoDate(s.date)) {
    const [, m, d] = s.date.split('-').map(Number)
    return `(${s.label}, ${d} ${MONTHS[m - 1]})`
  }
  return `(${s.label})`
}

/**
 * cyrb53: a small, fast, deterministic 53-bit string hash (pure JS, so the
 * renderer can use it too). Not cryptographic; used for stable ids only.
 */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/** 10 base36 characters derived from `s`. */
export function stableHash(s: string): string {
  const a = cyrb53(s, 1).toString(36).padStart(11, '0')
  const b = cyrb53(s, 2).toString(36).padStart(11, '0')
  return (a + b).slice(-10)
}

/** Lowercase, NFC, "(5 min)" dropped, punctuation folded to single spaces. */
export function normalizeTaskText(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/\(\s*~?\d+\s*(?:-\s*\d+\s*)?(?:min|mins|minutes|m)\s*\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * Stable candidate-task id: 'g' + 10 base36 chars of hash(label | text). Short
 * and [a-z0-9] only, so Phase 4 can use it as a block id (`^ff-g-<id>`) as is.
 */
export function candidateId(title: string, firstLabel: string): string {
  return `g${stableHash(`${firstLabel}|${normalizeTaskText(title)}`)}`
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

function str(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const s = squash(v)
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}

// ---------------------------------------------------------------- normalise

export interface NormalizeMeta {
  itemId: string
  model: string
  generatedAt: string
  mode: 'full' | 'incremental'
  incrementalSinceFull: number
  previous: ItemDigest | null
  /** Ids that were actually sent (defaults to every block in the pack). */
  sentIds?: string[]
}

interface Cite {
  source: DigestSource
  /** Excerpt text for quote checks. */
  text: string
}

/** id and label -> source, for every block that was in the payload. */
function citationIndex(pack: ContextPack, sent?: string[]): Map<string, Cite> {
  const allow = sent ? new Set(sent) : null
  const map = new Map<string, Cite>()
  for (const f of pack.files) {
    if (allow && !allow.has(f.id)) continue
    const c = { source: { label: f.label, date: localDay(f.mtimeMs) }, text: f.text }
    map.set(f.id.toUpperCase(), c)
    map.set(`label:${f.label}`, c)
  }
  for (const g of pack.git) {
    if (allow && !allow.has(g.id)) continue
    const newest = g.commits[0]?.date
    const date = newest && isIsoDate(newest.slice(0, 10)) ? newest.slice(0, 10) : undefined
    const c = { source: { label: g.label, ...(date ? { date } : {}) }, text: g.text }
    map.set(g.id.toUpperCase(), c)
    map.set(`label:${g.label}`, c)
  }
  return map
}

/** Ids or labels -> unique sources; unknown ones are dropped. */
function resolveSources(raw: unknown, idx: Map<string, Cite>): Cite[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  const out: Cite[] = []
  const seen = new Set<string>()
  for (const r of list) {
    if (typeof r !== 'string') continue
    const t = r.trim().replace(/^\[|\]$/g, '')
    const c = idx.get(t.toUpperCase()) ?? idx.get(`label:${t}`)
    if (c && !seen.has(c.source.label)) {
      seen.add(c.source.label)
      out.push(c)
    }
  }
  return out
}

const INLINE_CITE = /\s?\[((?:[FG]\d+)(?:\s*[,;]\s*[FG]\d+)*)\]/gi

/** `[F3]` / `[F3, G1]` -> " (label, 10 Nov)"; unknown ids are removed. */
export function renderInlineCitations(text: string, pack: ContextPack, sent?: string[]): string {
  const idx = citationIndex(pack, sent)
  return text.replace(INLINE_CITE, (_m, ids: string) => {
    const seen = new Set<string>()
    const parts: string[] = []
    for (const id of ids.split(/[,;]/)) {
      const c = idx.get(id.trim().toUpperCase())
      if (c && !seen.has(c.source.label)) {
        seen.add(c.source.label)
        parts.push(renderCitation(c.source))
      }
    }
    return parts.length ? ' ' + parts.join(' ') : ''
  })
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const asList = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(asRecord) : [])

function coerceMinutes(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN
  if (!Number.isFinite(n)) return 10
  return Math.min(30, Math.max(2, Math.round(n)))
}

function coerceWeight(v: unknown): number | null {
  if (typeof v === 'boolean') return null
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v.replace('%', '')) : NaN
  return Number.isFinite(n) && n > 0 && n <= 100 ? Math.round(n * 10) / 10 : null
}

const foldQuote = (s: string): string => squash(s.normalize('NFC')).toLowerCase()

/**
 * Validates and cleans a raw digest from the engine against the pack it was
 * built from. Returns null when `goal` or `currentState` is unusable (the
 * caller keeps the previous digest).
 */
export function normalizeDigest(
  raw: unknown,
  pack: ContextPack,
  meta: NormalizeMeta
): { digest: ItemDigest | null; warnings: string[] } {
  const warnings: string[] = []
  const r = asRecord(raw)
  const idx = citationIndex(pack, meta.sentIds)
  const L = DIGEST_LIMITS

  const goal = str(r.goal, L.goal)
  const stateRaw = typeof r.currentState === 'string' ? r.currentState.trim() : ''
  if (!goal || !stateRaw) {
    return { digest: null, warnings: ['missing goal or currentState'] }
  }
  let currentState = renderInlineCitations(stateRaw, pack, meta.sentIds)
  if (currentState.length > L.currentState) {
    currentState = currentState.slice(0, L.currentState - 1).trimEnd() + '…'
    warnings.push('currentState clamped')
  }

  let dropped = 0
  const cited = <T>(
    list: Record<string, unknown>[],
    max: number,
    make: (e: Record<string, unknown>, c: Cite[]) => T | null
  ): T[] => {
    const out: T[] = []
    for (const e of list) {
      const c = resolveSources(e.sources, idx)
      if (c.length === 0) {
        dropped++
        continue
      }
      const v = make(e, c)
      if (v) out.push(v)
      if (out.length >= max) break
    }
    if (list.length > out.length + dropped && out.length >= max) warnings.push('list clamped')
    return out
  }
  const srcs = (c: Cite[]): DigestSource[] => c.map((x) => ({ ...x.source }))

  const openItems = cited(asList(r.openItems), L.openItems, (e, c) => {
    const text = str(e.text, L.text)
    if (!text) return null
    const status: OpenItemStatus =
      e.status === 'blocked' || e.status === 'waiting' ? e.status : 'todo'
    return { text, status, sources: srcs(c) }
  })

  const dueDates = cited(asList(r.dueDates), L.dueDates, (e, c) => {
    const what = str(e.what, L.text)
    if (!what) return null
    let date: string | null = isIsoDate(e.date) ? e.date : null
    let when = str(e.when, 80)
    let confidence: DueConfidence = e.confidence === 'confirmed' ? 'confirmed' : 'tentative'
    if (date === null) {
      if (typeof e.date === 'string' && e.date.trim() && !when) when = str(e.date, 80)
      if (typeof e.date === 'string' && e.date.trim())
        warnings.push('invalid due date kept as text')
      confidence = 'tentative'
      if (!when) when = 'date unknown'
    }
    const kind = DUE_KINDS.includes(e.kind as DueKind) ? (e.kind as DueKind) : undefined
    const weight = coerceWeight(e.weight)
    if (date && !isIsoDate(date)) date = null
    return {
      what,
      date,
      ...(when ? { when } : {}),
      confidence,
      ...(weight !== null ? { weight } : {}),
      ...(kind ? { kind } : {}),
      sources: srcs(c)
    }
  })

  const recentProgress = cited(asList(r.recentProgress), L.recentProgress, (e, c) => {
    const text = str(e.text, L.text)
    if (!text || !isIsoDate(e.date)) return null
    return { date: e.date, text, sources: srcs(c) }
  })

  const constraints = cited(asList(r.constraints), L.constraints, (e, c) => {
    const text = str(e.text, L.text)
    return text ? { text, sources: srcs(c) } : null
  })

  const prevIds = new Set((meta.previous?.candidateTasks ?? []).map((t) => t.id))
  const usedIds = new Set<string>()
  const candidateTasks = cited(asList(r.candidateTasks), L.candidateTasks, (e, c) => {
    const title = str(e.title, L.title)
    if (!title) return null
    let quote: string | undefined = str(e.quote, L.quote) || undefined
    if (quote) {
      const q = foldQuote(quote.replace(/…$/, ''))
      if (!c.some((x) => foldQuote(x.text).includes(q))) {
        warnings.push('quote not found in cited block')
        quote = undefined
      }
    }
    const carried = typeof e.id === 'string' && prevIds.has(e.id) ? e.id : null
    let id = carried ?? candidateId(title, c[0].source.label)
    if (usedIds.has(id)) id = candidateId(`${title}#${usedIds.size}`, c[0].source.label)
    usedIds.add(id)
    const gapKind = GAP_KINDS.includes(e.gapKind as GapKind) ? (e.gapKind as GapKind) : 'to-check'
    return {
      id,
      title,
      minutes: coerceMinutes(e.minutes),
      gapKind,
      why: str(e.why, L.text),
      ...(quote ? { quote } : {}),
      sources: srcs(c)
    }
  })

  if (dropped > 0)
    warnings.push(`${dropped} entr${dropped === 1 ? 'y' : 'ies'} without a valid citation dropped`)

  const sk = r.suggestedKind
  const suggestedKind: WorkstreamKind | null =
    sk === 'deadline' || sk === 'passion' || sk === 'ongoing' ? sk : null

  const unique = [...new Set(warnings)]
  return {
    digest: {
      version: DIGEST_VERSION,
      itemId: meta.itemId,
      generatedAt: meta.generatedAt,
      model: meta.model,
      mode: meta.mode,
      incrementalSinceFull: meta.incrementalSinceFull,
      packFingerprint: pack.fingerprint,
      promptVersion: DIGEST_PROMPT_VERSION,
      goal,
      currentState,
      openItems,
      dueDates,
      recentProgress,
      candidateTasks,
      constraints,
      suggestedKind,
      warnings: unique
    },
    warnings: unique
  }
}

/** The digest as `previous` for an incremental run: sources become labels. */
export function digestCore(d: ItemDigest): DigestCore {
  const labels = (s: DigestSource[]): string[] => s.map((x) => x.label)
  return {
    goal: d.goal,
    currentState: d.currentState,
    openItems: d.openItems.map((o) => ({
      text: o.text,
      status: o.status,
      sources: labels(o.sources)
    })),
    dueDates: d.dueDates.map((x) => ({ ...x, sources: labels(x.sources) })),
    recentProgress: d.recentProgress.map((p) => ({ ...p, sources: labels(p.sources) })),
    candidateTasks: d.candidateTasks.map((t) => ({
      id: t.id,
      title: t.title,
      minutes: t.minutes,
      gapKind: t.gapKind,
      why: t.why,
      sources: labels(t.sources)
    })),
    constraints: (d.constraints ?? []).map((c) => ({ text: c.text, sources: labels(c.sources) }))
  }
}

/** Light shape check for a digest read back from disk. */
export function isItemDigest(v: unknown): v is ItemDigest {
  const r = asRecord(v)
  return (
    r.version === DIGEST_VERSION &&
    typeof r.itemId === 'string' &&
    typeof r.goal === 'string' &&
    typeof r.currentState === 'string' &&
    Array.isArray(r.candidateTasks) &&
    Array.isArray(r.dueDates)
  )
}
