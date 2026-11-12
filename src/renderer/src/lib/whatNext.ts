// src/renderer/src/lib/whatNext.ts
// The "What next?" picker (Phase 6). Pure and deterministic: everything comes
// from the inputs and ctx.now (no Date.now(), no randomness, no model call).
// Exclusions, scores, weights, bonuses, penalties, override, tie-breaks and
// explain wording follow PHASE67_PLAN_REV2.md "Picker".
import { localDateKey } from '../../../common/schedule'
import { type EnergyChip, type RankInput, type SkipEvent } from '../../../common/whatNext'
import { parseLocalDate } from './dates'
import { MOOD_TO_DIFFICULTY, type QueueMood } from './queue'

export interface PickContext {
  now: Date
  chip: EnergyChip
  mood: QueueMood
  eligibleKeys: ReadonlySet<string>
  skipsToday: readonly SkipEvent[]
  lastDone?: { key: string; itemId: string; taskId: string; title: string; at: string }
  todayPlanKeys?: ReadonlySet<string>
}

/**
 * `urgent` means the step is in the override window (confirmed, task-level,
 * −7 ≤ d ≤ 1), whatever the chip. Under Anything, Deadline and Light those go
 * first; under Something different they are only offered as `urgentAside`.
 */
export interface ScoredPick {
  input: RankInput
  score: number
  urgent: boolean
  reason: string
}
export type EmptyReason =
  | 'no-steps'
  | 'no-deadlines'
  | 'nothing-different'
  | 'no-light'
  | 'all-skipped'
  | 'mood'
export interface PickResult {
  pick: ScoredPick | null
  rest: ScoredPick[]
  urgentAside: ScoredPick | null
  empty: EmptyReason | null
}

const DAY_MS = 86_400_000
const LAST_DONE_WINDOW_MS = 45 * 60_000
const TIRED_URGENT_WINDOW_MS = 2 * 3_600_000
const EPS = 1e-9

type Weights = { U: number; F: number; K: number; E: number }
const WEIGHTS: Record<EnergyChip, Weights> = {
  anything: { U: 40, F: 20, K: 15, E: 15 },
  deadline: { U: 70, F: 5, K: 10, E: 10 },
  different: { U: 5, F: 25, K: 35, E: 25 },
  light: { U: 20, F: 10, K: 5, E: 55 }
}

function localMidnight(d: Date): Date {
  const m = new Date(d)
  m.setHours(0, 0, 0, 0)
  return m
}

/** Whole local calendar days from today to `date` (negative once passed). */
export function dueDays(date: string | null, now: Date): number | null {
  if (!date) return null
  const due = parseLocalDate(date)
  if (!due) return null
  return Math.round((due.getTime() - localMidnight(now).getTime()) / DAY_MS)
}

/** Whole local calendar days since an ISO timestamp (0 = today). */
function daysSince(iso: string, now: Date): number {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 0
  const then = localMidnight(new Date(t))
  return Math.max(0, Math.round((localMidnight(now).getTime() - then.getTime()) / DAY_MS))
}

const minutesOf = (i: RankInput): number => i.step.minutes ?? 15
const itemNameOf = (i: RankInput): string => i.step.itemName ?? i.step.projectId
const dOf = (i: RankInput, now: Date): number | null => dueDays(i.due?.date ?? null, now)

function isUrgent(i: RankInput, now: Date): boolean {
  if (!i.due || i.due.confidence !== 'confirmed' || i.due.source !== 'task') return false
  const d = dOf(i, now)
  return d !== null && d >= -7 && d <= 1
}

function passesLight(i: RankInput): boolean {
  return i.step.difficulty === 'easy' || (i.step.difficulty === 'medium' && minutesOf(i) <= 10)
}

function sameStep(e: SkipEvent, i: RankInput): boolean {
  return (
    e.itemId === i.step.projectId && e.taskId === i.step.taskId && e.subtaskId === i.step.subtaskId
  )
}

function tokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean)
  )
}

function jaccard(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let both = 0
  for (const t of ta) if (tb.has(t)) both++
  return both / (ta.size + tb.size - both)
}

// --- score parts ------------------------------------------------------------

function urgency(i: RankInput, now: Date): number {
  if (!i.due) return 0
  const d = dOf(i, now)
  if (d === null) return i.due.confidence === 'tentative' && i.due.when ? 0.15 : 0
  const raw = d < -7 ? 0.3 : d <= 1 ? 1 : Math.max(0, 1 - (d - 1) / 20)
  return raw * (i.due.confidence === 'tentative' ? 0.6 : 1) * (i.due.source === 'item' ? 0.5 : 1)
}

function staleness(i: RankInput, now: Date): number {
  if (i.lastTouchedAt === null) return 0.6
  if (i.touchedToday) return 0
  return Math.min(1, daysSince(i.lastTouchedAt, now) / 7)
}

function kindFit(i: RankInput, chip: EnergyChip, now: Date): number {
  const kind = i.step.itemKind
  switch (chip) {
    case 'anything': {
      if (kind === 'passion') return 0.6
      if (kind === 'ongoing') return 0.4
      const d = dOf(i, now)
      return d !== null && d <= 21 ? 0.6 : 0.3
    }
    case 'deadline':
      return kind === 'deadline' ? 1 : kind === 'passion' ? 0.2 : 0.3
    case 'different':
      return kind === 'deadline' ? 0.2 : kind === 'passion' ? 1 : 0.6
    case 'light':
      return 0.5
  }
}

function energyFit(i: RankInput, chip: EnergyChip): number {
  const m = minutesOf(i)
  const base = m <= 5 ? 1 : m <= 15 ? 0.85 : m <= 25 ? 0.6 : 0.35
  const diff = i.step.difficulty
  let fit: number
  if (chip === 'deadline') fit = 1
  else if (chip === 'light') fit = diff === 'easy' ? 1 : diff === 'medium' ? 0.5 : 0
  else fit = diff === 'easy' ? 1 : diff === 'medium' ? 0.8 : 0.6
  return base * fit
}

function baseScore(i: RankInput, ctx: PickContext, todaySkips: readonly SkipEvent[]): number {
  const { now, chip } = ctx
  const w = WEIGHTS[chip]
  let score =
    w.U * urgency(i, now) +
    w.F * staleness(i, now) +
    w.K * kindFit(i, chip, now) +
    w.E * energyFit(i, chip)

  // Bonuses
  if (ctx.todayPlanKeys?.has(i.key)) score += 20
  const scheduled = i.step.scheduledDate
  if (scheduled && parseLocalDate(scheduled) && scheduled <= localDateKey(now)) score += 5
  if (i.isLooseEnd) score += chip === 'light' ? 6 : 3

  // Penalties
  const itemSkips = todaySkips.filter((e) => e.itemId === i.step.projectId).length
  score -= Math.min(36, 12 * itemSkips)
  const last = ctx.lastDone
  if (last) {
    const ago = now.getTime() - Date.parse(last.at)
    if (last.itemId === i.step.projectId && ago >= 0 && ago <= LAST_DONE_WINDOW_MS) score -= 20
    if (last.taskId === i.step.taskId || jaccard(last.title, i.step.title ?? '') >= 0.5) score -= 10
  }
  return score
}

// --- ordering ---------------------------------------------------------------

const confidenceRank = (i: RankInput): number =>
  !i.due ? 2 : i.due.confidence === 'confirmed' ? 0 : 1

/** Tie-break after score: d (null last), confirmed first, minutes, oldest touch (null first), name, key. */
function tieBreak(a: RankInput, b: RankInput, now: Date): number {
  const da = dOf(a, now)
  const db = dOf(b, now)
  if (da !== db) {
    if (da === null) return 1
    if (db === null) return -1
    return da - db
  }
  const c = confidenceRank(a) - confidenceRank(b)
  if (c !== 0) return c
  const m = minutesOf(a) - minutesOf(b)
  if (m !== 0) return m
  if (a.lastTouchedAt !== b.lastTouchedAt) {
    if (a.lastTouchedAt === null) return -1
    if (b.lastTouchedAt === null) return 1
    const t = Date.parse(a.lastTouchedAt) - Date.parse(b.lastTouchedAt)
    if (t !== 0) return t
  }
  const n = itemNameOf(a).localeCompare(itemNameOf(b), 'en')
  if (n !== 0) return n
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

interface Scored {
  input: RankInput
  score: number
  urgent: boolean
}

function byScore(a: Scored, b: Scored, now: Date): number {
  if (Math.abs(a.score - b.score) > EPS) return b.score - a.score
  return tieBreak(a.input, b.input, now)
}

/** Forced-first order: urgent steps by d, then score; everything else by score. */
function byOverride(a: Scored, b: Scored, now: Date): number {
  if (a.urgent !== b.urgent) return a.urgent ? -1 : 1
  if (a.urgent) {
    const d = (dOf(a.input, now) ?? 0) - (dOf(b.input, now) ?? 0)
    if (d !== 0) return d
  }
  return byScore(a, b, now)
}

/** Greedy build: each earlier pick from the same item costs −25. */
function order(items: Scored[], ctx: PickContext): ScoredPick[] {
  const forced = ctx.chip !== 'different'
  const cmp = forced ? byOverride : byScore
  const remaining = items.slice()
  const pickedPerItem = new Map<string, number>()
  const out: ScoredPick[] = []
  while (remaining.length > 0) {
    const adjusted = remaining.map((s) => ({
      ...s,
      score: s.score - 25 * (pickedPerItem.get(s.input.step.projectId) ?? 0)
    }))
    let best = 0
    for (let k = 1; k < adjusted.length; k++) {
      if (cmp(adjusted[k], adjusted[best], ctx.now) < 0) best = k
    }
    const chosen = adjusted[best]
    remaining.splice(best, 1)
    const item = chosen.input.step.projectId
    pickedPerItem.set(item, (pickedPerItem.get(item) ?? 0) + 1)
    out.push({ ...chosen, reason: explain(chosen.input, ctx) })
  }
  return out
}

// --- filters ----------------------------------------------------------------

interface Filtered {
  pool: RankInput[] // after eligibility and skip exclusions
  chipped: RankInput[] // after the chip filter
  todaySkips: SkipEvent[]
  empty: EmptyReason | null
}

function filter(inputs: readonly RankInput[], ctx: PickContext): Filtered {
  const { now, chip } = ctx
  const today = localDateKey(now)
  const todaySkips = ctx.skipsToday.filter((e) => e.date === today && !e.undone)
  if (inputs.length === 0) return { pool: [], chipped: [], todaySkips, empty: 'no-steps' }

  const eligible = inputs.filter((i) => ctx.eligibleKeys.has(i.key))
  if (eligible.length === 0) {
    const wanted = ctx.mood === 'all' ? null : MOOD_TO_DIFFICULTY[ctx.mood]
    const moodBlocks = wanted !== null && !inputs.some((i) => i.step.difficulty === wanted)
    return { pool: [], chipped: [], todaySkips, empty: moodBlocks ? 'mood' : 'all-skipped' }
  }

  const pool = eligible.filter((i) => {
    if (todaySkips.some((e) => sameStep(e, i) && (e.reason === 'none' || e.reason === 'not-now'))) {
      return false
    }
    const tired = todaySkips.filter((e) => e.itemId === i.step.projectId && e.reason === 'tired')
    if (tired.length === 0) return true
    // Tired of this: out for the day, or for 2 hours when a confirmed date is a day or less away.
    const d = i.due?.confidence === 'confirmed' ? dOf(i, now) : null
    if (d === null || d > 1 || d < -7) return false
    const latest = Math.max(...tired.map((e) => Date.parse(e.at)).filter((t) => !Number.isNaN(t)))
    return Number.isFinite(latest) && now.getTime() - latest >= TIRED_URGENT_WINDOW_MS
  })
  if (pool.length === 0) return { pool, chipped: [], todaySkips, empty: 'all-skipped' }

  let chipped = pool
  if (chip === 'deadline') {
    chipped = pool.filter((i) => i.due?.date != null && i.due.source === 'task')
  } else if (chip === 'different') {
    const skippedItems = new Set(todaySkips.map((e) => e.itemId))
    chipped = pool.filter(
      (i) =>
        !i.touchedToday &&
        !skippedItems.has(i.step.projectId) &&
        i.step.projectId !== ctx.lastDone?.itemId
    )
  } else if (chip === 'light') {
    chipped = pool.filter(passesLight)
  }
  const chipEmpty: Record<EnergyChip, EmptyReason | null> = {
    anything: 'all-skipped',
    deadline: 'no-deadlines',
    different: 'nothing-different',
    light: 'no-light'
  }
  return { pool, chipped, todaySkips, empty: chipped.length === 0 ? chipEmpty[chip] : null }
}

function scoreAll(
  list: readonly RankInput[],
  ctx: PickContext,
  todaySkips: readonly SkipEvent[]
): Scored[] {
  return list.map((input) => ({
    input,
    score: baseScore(input, ctx, todaySkips),
    urgent: isUrgent(input, ctx.now)
  }))
}

/** Every step that survives the exclusions and the chip filter, best first. */
export function rankCandidates(inputs: readonly RankInput[], ctx: PickContext): ScoredPick[] {
  const { chipped, todaySkips } = filter(inputs, ctx)
  return order(scoreAll(chipped, ctx, todaySkips), ctx)
}

export function pickNext(inputs: readonly RankInput[], ctx: PickContext): PickResult {
  const { pool, chipped, todaySkips, empty } = filter(inputs, ctx)
  const ranked = order(scoreAll(chipped, ctx, todaySkips), ctx)
  const pick = ranked[0] ?? null

  // Something different and Light never force an urgent step first; offer the
  // top urgent one (from the pool before the chip filter) as a quiet aside.
  let urgentAside: ScoredPick | null = null
  if ((ctx.chip === 'different' || ctx.chip === 'light') && !pick?.urgent) {
    const urgent = scoreAll(
      pool.filter((i) => isUrgent(i, ctx.now) && i.key !== pick?.input.key),
      ctx,
      todaySkips
    ).sort((a, b) => byOverride(a, b, ctx.now))[0]
    if (urgent) urgentAside = { ...urgent, reason: explain(urgent.input, ctx) }
  }
  return { pick, rest: ranked.slice(1), urgentAside, empty: pick ? null : empty }
}

// --- explain ----------------------------------------------------------------

function shortDate(key: string): string {
  const d = parseLocalDate(key)
  if (!d) return ''
  return `${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'short' })}`
}

function confirmedLabel(d: number): string | null {
  if (d === 0) return 'due today'
  if (d === 1) return 'due tomorrow'
  if (d >= 2 && d <= 60) return `due in ${d} days`
  if (d >= -7 && d <= -1) return `date passed ${-d} ${d === -1 ? 'day' : 'days'} ago`
  return null
}

function dueLabel(due: NonNullable<RankInput['due']>, now: Date): string | null {
  const d = dueDays(due.date, now)
  if (due.confidence === 'confirmed') return d === null ? null : confirmedLabel(d)
  if (due.when) return `due around ${due.when}`
  if (due.date && d !== null && d >= 0) return `due around ${shortDate(due.date)} (tentative)`
  return null
}

/**
 * One short, calm line: item name · due or kind · last touch. At most three
 * parts. Never says overdue, late, behind, should or must (tested).
 */
export function explain(i: RankInput, ctx: Pick<PickContext, 'now' | 'chip'>): string {
  const { now, chip } = ctx
  const parts: string[] = [itemNameOf(i)]

  let second: string | null = null
  if (i.due) {
    const label = dueLabel(i.due, now)
    if (label && i.due.source === 'item') second = i.due.what ? `${i.due.what} ${label}` : label
    else if (label) second = label
  }
  if (!second && i.isLooseEnd) second = 'a loose end'
  if (!second && i.step.itemKind === 'passion') second = 'a passion project'
  if (!second && i.step.itemKind === 'ongoing') second = 'ongoing'
  if (second) parts.push(second)

  if (i.lastTouchedAt === null) parts.push('not started yet')
  else if (i.touchedToday) {
    if (chip === 'anything' || chip === 'deadline') parts.push('touched today')
  } else {
    const t = daysSince(i.lastTouchedAt, now)
    if (t <= 0) {
      if (chip === 'anything' || chip === 'deadline') parts.push('touched today')
    } else parts.push(t === 1 ? 'last touched yesterday' : `last touched ${t} days ago`)
  }
  return parts.slice(0, 3).join(' · ')
}
