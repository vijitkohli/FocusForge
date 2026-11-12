// src/common/whatNext.ts
// "What next?" (Phase 6) data shapes and the thin adapter from Phase 5's
// `ItemNextStep` to what the picker ranks. Pure; shared by main and renderer.
// See PHASE67_PLAN_REV2.md "Data shapes".
import type { ItemNextStep } from './nextSteps'
import { localDateKey } from './schedule'
import type { WorkstreamKind } from './types'
import { CATEGORIES, WORKSTREAM_KINDS, type ItemCategory } from './workstreams'

export type EnergyChip = 'anything' | 'deadline' | 'different' | 'light'
export type SkipReason = 'none' | 'not-now' | 'tired' | 'too-big'
export type DueConfidence = 'confirmed' | 'tentative'

export const ENERGY_CHIPS: readonly EnergyChip[] = ['anything', 'deadline', 'different', 'light']
export const SKIP_REASONS: readonly SkipReason[] = ['none', 'not-now', 'tired', 'too-big']

export interface RankInput {
  key: string // queueKey([projectId, taskId, subtaskId])
  step: ItemNextStep
  /**
   * `what` is only set for item-level dues (from the digest), so `explain` can
   * say "Proposal v5 due in 9 days" for a loose end or goal step.
   */
  due: {
    date: string | null
    when?: string
    what?: string
    confidence: DueConfidence
    source: 'task' | 'item'
  } | null
  lastTouchedAt: string | null // max(step.lastTouchedAt, local lastStartedAt)
  touchedToday: boolean
  isLooseEnd: boolean
}

export interface ItemDueSignal {
  itemId: string
  nextDue: { what: string; date: string | null; when?: string; confidence: DueConfidence } | null
  // earliest confirmed dated; else earliest tentative dated; else first undated tentative
}

export interface WhatNextSignals {
  date: string
  dues: ItemDueSignal[]
  starts: Record<string, string> // itemId → ISO of the last Start in the app today
  skipsToday: SkipEvent[]
}

export interface SkipEvent {
  // persisted; NO titles
  at: string
  date: string
  hour: number
  itemId: string
  taskId: string
  subtaskId: string
  reason: SkipReason
  undone?: boolean
  chip: EnergyChip
  mood: 'all' | 'lazy' | 'normal' | 'motivated'
  itemKind: WorkstreamKind
  category: ItemCategory
  difficulty: 'easy' | 'medium' | 'hard'
  minutes: number
  dueDays: number | null
  dueConfidence: DueConfidence | null
  isLooseEnd: boolean
  rank: number
}

/** Sidebar dot. Never carries a key or a URL. */
export type ProxyDotStatus = 'up' | 'down' | 'unknown' | 'not-used'
export interface ProxyHealthView {
  status: ProxyDotStatus
  checkedAt: string | null
}

/** Hidden unless a configured model uses CLIProxyAPI, and until the first check lands. */
export function toProxyView(
  configured: boolean,
  current: { up: boolean | null; checkedAt: string | null }
): ProxyHealthView {
  if (!configured) return { status: 'not-used', checkedAt: null }
  if (current.up === null) return { status: 'unknown', checkedAt: current.checkedAt }
  return { status: current.up ? 'up' : 'down', checkedAt: current.checkedAt }
}

/**
 * The digest fields `nextDueOf` reads. Phase 3's `ItemDigest` (src/common/digest.ts)
 * is not in this tree yet; on merge, swap this for `ItemDigest`, which is a
 * structural superset (contract 3: `dueDates[] { what, date|null, when?, confidence, … }`).
 */
export interface DigestDueDate {
  what: string
  date: string | null
  when?: string
  confidence: DueConfidence
}
export interface DigestDues {
  dueDates: readonly DigestDueDate[]
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

/** Same format as the renderer's `queueKey` (lib/queue.ts), so keys match `queue.all`. */
export function stepKey(projectId: string, taskId: string, subtaskId: string): string {
  return JSON.stringify([projectId, taskId, subtaskId])
}

function laterIso(a: string | null | undefined, b: string | null | undefined): string | null {
  const ta = a ? Date.parse(a) : NaN
  const tb = b ? Date.parse(b) : NaN
  if (Number.isNaN(ta)) return Number.isNaN(tb) ? null : (b as string)
  if (Number.isNaN(tb)) return a as string
  return tb > ta ? (b as string) : (a as string)
}

/** True when the ISO timestamp falls on `today` (a local YYYY-MM-DD key). */
export function isOnLocalDay(iso: string | null, today: string): boolean {
  if (!iso) return false
  const t = Date.parse(iso)
  return !Number.isNaN(t) && localDateKey(new Date(t)) === today
}

/** One rankable entry per planned next step. Drops `needsPlan` and step-less entries. */
export function toRankable(
  steps: readonly ItemNextStep[],
  signals: WhatNextSignals,
  now: Date
): RankInput[] {
  const today = localDateKey(now)
  const dues = new Map(signals.dues.map((d) => [d.itemId, d.nextDue]))
  const out: RankInput[] = []
  for (const step of steps) {
    if (step.needsPlan || step.subtaskId === null) continue
    // A Loose ends task's deadline is artificial (earliest due or +7 days), so it
    // never counts as the step's own due date, even if Phase 3 marked it 'hard'.
    const isLooseEnd = step.taskAuto === 'loose-ends' || step.origin === 'gap'
    let due: RankInput['due'] = null
    const deadline = step.deadline && DATE_KEY.test(step.deadline) ? step.deadline : null
    if (step.deadlineKind === 'hard' && !isLooseEnd) {
      if (deadline) due = { date: deadline, confidence: 'confirmed', source: 'task' }
    } else if (step.deadlineKind === 'tentative' && !isLooseEnd) {
      if (deadline || step.dueWhen) {
        due = { date: deadline, confidence: 'tentative', source: 'task' }
        if (step.dueWhen) due.when = step.dueWhen
      }
    } else {
      const next = dues.get(step.projectId) ?? null
      if (next) {
        due = { date: next.date, what: next.what, confidence: next.confidence, source: 'item' }
        if (next.when) due.when = next.when
      }
    }
    const lastTouchedAt = laterIso(step.lastTouchedAt, signals.starts[step.projectId])
    out.push({
      key: stepKey(step.projectId, step.taskId, step.subtaskId),
      step,
      due,
      lastTouchedAt,
      touchedToday: isOnLocalDay(lastTouchedAt, today),
      isLooseEnd
    })
  }
  return out
}

/**
 * The item's next due date from its digest: the earliest confirmed dated one
 * (today or later); else the earliest tentative dated one; else the first
 * undated one with a raw `when` ("Week 11 (TBC)"), which is always tentative.
 * Passed dates are ignored: this is the *next* due, and stale data stays out.
 */
export function nextDueOf(digest: DigestDues | null, today: string): ItemDueSignal['nextDue'] {
  if (!digest || !Array.isArray(digest.dueDates)) return null
  const dated = digest.dueDates
    .filter((d) => d.date !== null && DATE_KEY.test(d.date) && d.date >= today)
    .sort((a, b) => (a.date as string).localeCompare(b.date as string))
  const pick = (d: DigestDueDate, confidence: DueConfidence): ItemDueSignal['nextDue'] => {
    const out: NonNullable<ItemDueSignal['nextDue']> = { what: d.what, date: d.date, confidence }
    if (d.when) out.when = d.when
    return out
  }
  const confirmed = dated.find((d) => d.confidence === 'confirmed')
  if (confirmed) return pick(confirmed, 'confirmed')
  const tentative = dated.find((d) => d.confidence === 'tentative')
  if (tentative) return pick(tentative, 'tentative')
  const undated = digest.dueDates.find((d) => d.date === null && d.when && d.when.trim())
  return undated ? pick(undated, 'tentative') : null
}

// --- Skip events ------------------------------------------------------------

const MOODS = ['all', 'lazy', 'normal', 'motivated'] as const
const DIFFICULTIES = ['easy', 'medium', 'hard'] as const
const MAX_ID = 200

function oneOf<T extends string>(list: readonly T[], v: unknown): T | null {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null
}

function id(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID ? v : null
}

function int(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(max, Math.max(min, Math.round(v)))
}

/**
 * Validates a skip event from the renderer before it is stored. Whitelisted
 * keys only (titles and anything else are dropped), enums checked, numbers
 * clamped. Returns null when a required field is missing or invalid.
 */
export function sanitizeSkipEvent(raw: unknown): SkipEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const at =
    typeof r.at === 'string' && r.at.length <= 40 && !Number.isNaN(Date.parse(r.at)) ? r.at : null
  const date = typeof r.date === 'string' && DATE_KEY.test(r.date) ? r.date : null
  const hour = int(r.hour, 0, 23)
  const itemId = id(r.itemId)
  const taskId = id(r.taskId)
  const subtaskId = id(r.subtaskId)
  const reason = oneOf(SKIP_REASONS, r.reason)
  const chip = oneOf(ENERGY_CHIPS, r.chip)
  const mood = oneOf(MOODS, r.mood)
  const itemKind = oneOf(WORKSTREAM_KINDS, r.itemKind)
  const category = oneOf(CATEGORIES, r.category)
  const difficulty = oneOf(DIFFICULTIES, r.difficulty)
  const minutes = int(r.minutes, 0, 600)
  const rank = int(r.rank, 0, 999)
  if (
    at === null ||
    date === null ||
    hour === null ||
    itemId === null ||
    taskId === null ||
    subtaskId === null ||
    reason === null ||
    chip === null ||
    mood === null ||
    itemKind === null ||
    category === null ||
    difficulty === null ||
    minutes === null ||
    rank === null
  ) {
    return null
  }
  const event: SkipEvent = {
    at,
    date,
    hour,
    itemId,
    taskId,
    subtaskId,
    reason,
    chip,
    mood,
    itemKind,
    category,
    difficulty,
    minutes,
    dueDays: r.dueDays === null ? null : int(r.dueDays, -3650, 3650),
    dueConfidence: oneOf(['confirmed', 'tentative'] as const, r.dueConfidence),
    isLooseEnd: r.isLooseEnd === true,
    rank
  }
  if (r.undone === true) event.undone = true
  return event
}
