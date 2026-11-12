import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ItemNextStep } from '../../../common/nextSteps'
import { localDateKey } from '../../../common/schedule'
import type { WorkstreamKind } from '../../../common/types'
import {
  ITEM,
  daysAgoIso,
  fixtureNow,
  fixtureSignals,
  fixtureSteps
} from '../../../common/whatNext.fixtures'
import {
  toRankable,
  type DueConfidence,
  type EnergyChip,
  type RankInput,
  type SkipEvent,
  type SkipReason
} from '../../../common/whatNext'
import { MOOD_TO_DIFFICULTY, queueKey, type QueueMood } from './queue'
import { dueDays, explain, pickNext, rankCandidates, type PickContext } from './whatNext'

const NOW = fixtureNow() // 2026-11-11 15:00 local
const TODAY = localDateKey(NOW)
const CHIPS: EnergyChip[] = ['anything', 'deadline', 'different', 'light']

afterEach(() => {
  vi.useRealTimers()
})

const at = (hour: number, minute = 0): Date => new Date(2026, 10, 11, hour, minute, 0, 0)
const dateIn = (d: number): string => localDateKey(new Date(2026, 10, 11 + d))

/** Eligible keys the way queueStore builds them: mood filter (session skips are separate). */
function eligible(inputs: readonly RankInput[], mood: QueueMood = 'all'): Set<string> {
  const wanted = mood === 'all' ? null : MOOD_TO_DIFFICULTY[mood]
  return new Set(inputs.filter((i) => !wanted || i.step.difficulty === wanted).map((i) => i.key))
}

function ctx(inputs: readonly RankInput[], over: Partial<PickContext> = {}): PickContext {
  const mood = over.mood ?? 'all'
  return {
    now: NOW,
    chip: 'anything',
    mood,
    eligibleKeys: eligible(inputs, mood),
    skipsToday: [],
    ...over
  }
}

const fixtures = (ownerScenario = false): RankInput[] =>
  toRankable(fixtureSteps({ ownerScenario }), fixtureSignals(), NOW)

function find(inputs: readonly RankInput[], projectId: string, taskId: string): RankInput {
  const i = inputs.find((x) => x.step.projectId === projectId && x.step.taskId === taskId)
  if (!i) throw new Error(`missing ${projectId}/${taskId}`)
  return i
}

interface MkOptions {
  name?: string
  kind?: WorkstreamKind
  taskId?: string
  subtaskId?: string
  title?: string
  d?: number | null
  conf?: DueConfidence
  source?: 'task' | 'item'
  when?: string
  what?: string
  touched?: number | null // days ago; 0 = today
  minutes?: number
  difficulty?: ItemNextStep['difficulty']
  loose?: boolean
  scheduled?: string
}

function mk(projectId: string, o: MkOptions = {}): RankInput {
  const taskId = o.taskId ?? 't'
  const subtaskId = o.subtaskId ?? 's'
  const step: ItemNextStep = {
    projectId,
    itemName: o.name ?? projectId,
    itemKind: o.kind ?? 'deadline',
    category: 'Learning',
    taskId,
    taskTitle: taskId,
    subtaskId,
    title: o.title ?? `${projectId} ${taskId} ${subtaskId}`,
    minutes: o.minutes ?? 15,
    difficulty: o.difficulty ?? 'medium',
    deadlineKind: 'hard',
    needsPlan: false
  }
  if (o.scheduled) step.scheduledDate = o.scheduled
  if (o.loose) step.taskAuto = 'loose-ends'
  let due: RankInput['due'] = null
  if (o.d !== undefined && (o.d !== null || o.when)) {
    due = {
      date: o.d === null ? null : dateIn(o.d),
      confidence: o.conf ?? 'confirmed',
      source: o.source ?? 'task'
    }
    if (o.when) due.when = o.when
    if (o.what) due.what = o.what
  }
  const touched = o.touched === undefined ? 3 : o.touched
  return {
    key: queueKey({ projectId, taskId, subtaskId }),
    step,
    due,
    lastTouchedAt: touched === null ? null : daysAgoIso(touched),
    touchedToday: touched === 0,
    isLooseEnd: o.loose ?? false
  }
}

function skip(i: RankInput, reason: SkipReason, when: Date = at(14), date = TODAY): SkipEvent {
  return {
    at: when.toISOString(),
    date,
    hour: when.getHours(),
    itemId: i.step.projectId,
    taskId: i.step.taskId,
    subtaskId: i.step.subtaskId as string,
    reason,
    chip: 'anything',
    mood: 'all',
    itemKind: i.step.itemKind,
    category: i.step.category,
    difficulty: i.step.difficulty,
    minutes: i.step.minutes ?? 15,
    dueDays: null,
    dueConfidence: null,
    isLooseEnd: i.isLooseEnd,
    rank: 0
  }
}

const keys = (list: { input: RankInput }[]): string[] => list.map((p) => p.input.key)
const order = (inputs: RankInput[], over: Partial<PickContext> = {}): string[] =>
  keys(rankCandidates(inputs, ctx(inputs, over)))
const scoreOf = (inputs: RankInput[], key: string, over: Partial<PickContext> = {}): number => {
  const found = rankCandidates(inputs, ctx(inputs, over)).find((p) => p.input.key === key)
  if (!found) throw new Error(`not ranked: ${key}`)
  return found.score
}

describe('urgency and override', () => {
  it('due tomorrow beats a stale passion step under Anything', () => {
    const urgent = mk('a', { d: 1, touched: 1, minutes: 25, difficulty: 'hard' })
    const passion = mk('b', { kind: 'passion', touched: 30, minutes: 5, difficulty: 'easy' })
    const r = pickNext([passion, urgent], ctx([passion, urgent]))
    expect(r.pick?.input.key).toBe(urgent.key)
    expect(r.pick?.urgent).toBe(true)
    expect(r.urgentAside).toBeNull()
  })

  it('due today and date passed 3 days ago both go first, earliest first', () => {
    const today = mk('a', { d: 0 })
    const passed = mk('b', { d: -3 })
    const other = mk('c', { kind: 'passion', touched: null, minutes: 5, difficulty: 'easy' })
    expect(order([other, today, passed])).toEqual([passed.key, today.key, other.key])
  })

  it('date passed 30 days ago does not override (stale data stays normal)', () => {
    const stale = mk('a', { d: -30, touched: 7 })
    const soon = mk('b', { d: 5, touched: 7 })
    const r = pickNext([stale, soon], ctx([stale, soon]))
    expect(r.pick?.input.key).toBe(soon.key)
    expect(r.rest[0].urgent).toBe(false)
    // The fixture's 99-day-old lab never goes first either.
    const f = fixtures()
    expect(find(f, ITEM.old, 'lab').due?.date).toBe('2026-08-04')
    expect(pickNext(f, ctx(f)).pick?.input.step.projectId).toBe(ITEM.comp9321)
    expect(rankCandidates(f, ctx(f)).find((p) => p.input.step.projectId === ITEM.old)?.urgent).toBe(
      false
    )
  })

  it('urgent step is not forced first under Something different and is returned as urgentAside', () => {
    const f = fixtures(true)
    const r = pickNext(f, ctx(f, { chip: 'different' }))
    expect(r.pick?.input.step.itemKind).toBe('passion')
    expect(r.urgentAside?.input.step.projectId).toBe(ITEM.comp9321)
    expect(r.urgentAside?.urgent).toBe(true)
    expect(r.urgentAside?.reason).toBe('COMP9321 · due tomorrow · last touched 3 days ago')
  })

  it('urgent override under Light only when the step passes the Light filter', () => {
    const urgentMedium = mk('a', { d: 0, minutes: 15, difficulty: 'medium' })
    const quick = mk('b', { kind: 'passion', minutes: 5, difficulty: 'easy', touched: 9 })
    let r = pickNext([urgentMedium, quick], ctx([urgentMedium, quick], { chip: 'light' }))
    expect(r.pick?.input.key).toBe(quick.key)
    expect(keys(r.rest)).not.toContain(urgentMedium.key)
    expect(r.urgentAside?.input.key).toBe(urgentMedium.key)

    const urgentEasy = mk('c', { d: 1, minutes: 15, difficulty: 'easy', touched: 0 })
    r = pickNext([quick, urgentEasy], ctx([quick, urgentEasy], { chip: 'light' }))
    expect(r.pick?.input.key).toBe(urgentEasy.key)
    expect(r.urgentAside).toBeNull()
  })

  it('tired of an urgent item hides it for 2 hours, then it returns', () => {
    const f = fixtures()
    const a3 = find(f, ITEM.comp9321, 'a3')
    const skips = [skip(a3, 'tired', at(14))]
    expect(keys(rankCandidates(f, ctx(f, { now: at(15, 59), skipsToday: skips })))).not.toContain(
      a3.key
    )
    const later = pickNext(f, ctx(f, { now: at(16, 0), skipsToday: skips }))
    expect(later.pick?.input.key).toBe(a3.key)
  })

  it('tentative dates never trigger the override', () => {
    const tentative = mk('a', { d: 0, conf: 'tentative', touched: 0 })
    const better = mk('b', { d: 5, touched: 7 })
    const r = pickNext([tentative, better], ctx([tentative, better]))
    expect(r.pick?.input.key).toBe(better.key)
    expect(r.rest[0].urgent).toBe(false)
  })

  it('item-level dates never trigger the override', () => {
    const itemDue = mk('a', { d: 0, source: 'item', what: 'Exam', touched: 0 })
    const better = mk('b', { d: 5, touched: 7 })
    const r = pickNext([itemDue, better], ctx([itemDue, better]))
    expect(r.pick?.input.key).toBe(better.key)
    expect(r.rest[0].urgent).toBe(false)
  })

  it('a Loose ends task with an artificial hard deadline is not urgent', () => {
    const f = fixtures()
    const loose = rankCandidates(f, ctx(f)).find((p) => p.input.isLooseEnd)
    expect(loose?.urgent).toBe(false)
    expect(loose?.input.due?.source).toBe('item')
  })

  it('an undated tentative due with a when gets a small urgency (0.15)', () => {
    const when = mk('a', { d: null, conf: 'tentative', when: 'Week 11 (TBC)' })
    const none = mk('b')
    expect(scoreOf([when, none], when.key) - scoreOf([when, none], none.key)).toBeCloseTo(40 * 0.15)
  })

  it('tentative and item-level urgency are scaled by 0.6 and 0.5', () => {
    const plain = mk('a', { d: 5 })
    const tentative = mk('b', { d: 5, conf: 'tentative' })
    const item = mk('c', { d: 5, source: 'item' })
    const all = [plain, tentative, item]
    const u = 40 * (1 - 4 / 20)
    expect(scoreOf(all, plain.key) - scoreOf(all, tentative.key)).toBeCloseTo(u * 0.4)
    expect(scoreOf(all, plain.key) - scoreOf(all, item.key)).toBeCloseTo(u * 0.5)
  })

  it('urgentAside is null under Anything and Deadline', () => {
    const f = fixtures(true)
    for (const chip of ['anything', 'deadline'] as const) {
      const r = pickNext(f, ctx(f, { chip }))
      expect(r.urgentAside).toBeNull()
      expect(r.pick?.input.step.projectId).toBe(ITEM.comp9321)
    }
  })
})

describe('chips', () => {
  it('Deadline keeps only steps with a task-level due date', () => {
    const f = fixtures()
    const ranked = rankCandidates(f, ctx(f, { chip: 'deadline' }))
    expect(ranked.length).toBeGreaterThan(0)
    for (const p of ranked) {
      expect(p.input.due?.date).toBeTruthy()
      expect(p.input.due?.source).toBe('task')
    }
    const ids = ranked.map((p) => `${p.input.step.projectId}/${p.input.step.taskId}`)
    expect(ids).not.toContain('thesis/presentation') // tentative, no date
    expect(ids).not.toContain('thesis/loose') // item-level
    expect(ids).not.toContain('personalwebsite/goal')
  })

  it('Deadline keeps tentative task dates', () => {
    const tentative = mk('a', { d: 10, conf: 'tentative' })
    expect(order([tentative], { chip: 'deadline' })).toEqual([tentative.key])
  })

  it('Deadline is empty with no-deadlines when nothing has a due date', () => {
    const f = fixtures().filter((i) => i.step.itemKind === 'passion')
    const r = pickNext(f, ctx(f, { chip: 'deadline' }))
    expect(r.pick).toBeNull()
    expect(r.empty).toBe('no-deadlines')
  })

  it('Something different excludes items touched today, skipped today and the item just finished', () => {
    const touched = mk('a', { kind: 'passion', touched: 0 })
    const skipped = mk('b', { kind: 'passion', taskId: 't1' })
    const skippedOther = mk('b', { kind: 'passion', taskId: 't2' })
    const finished = mk('c', { kind: 'passion' })
    const fresh = mk('d', { kind: 'ongoing' })
    const all = [touched, skipped, skippedOther, finished, fresh]
    const lastDone = {
      key: 'x',
      itemId: 'c',
      taskId: 'zz',
      title: 'unrelated',
      at: at(9).toISOString()
    }
    expect(
      order(all, { chip: 'different', skipsToday: [skip(skipped, 'too-big')], lastDone })
    ).toEqual([fresh.key])
    const none = pickNext([touched], ctx([touched], { chip: 'different' }))
    expect(none.empty).toBe('nothing-different')
  })

  it('Something different counts source activity today as touched', () => {
    const f = fixtures(true) // thesis and psyc touched today through their folders
    const ids = rankCandidates(f, ctx(f, { chip: 'different' })).map((p) => p.input.step.projectId)
    expect(ids).not.toContain(ITEM.thesis)
    expect(ids).not.toContain(ITEM.psyc1023)
  })

  it('Something different prefers passion over ongoing over deadline', () => {
    const passion = mk('a', { kind: 'passion' })
    const ongoing = mk('b', { kind: 'ongoing' })
    const deadline = mk('c', { kind: 'deadline' })
    expect(order([deadline, ongoing, passion], { chip: 'different' })).toEqual([
      passion.key,
      ongoing.key,
      deadline.key
    ])
  })

  it('Light keeps easy steps and medium steps of 10 min or less', () => {
    const easy = mk('a', { difficulty: 'easy', minutes: 30 })
    const shortMedium = mk('b', { difficulty: 'medium', minutes: 10 })
    const longMedium = mk('c', { difficulty: 'medium', minutes: 11 })
    const hard = mk('d', { difficulty: 'hard', minutes: 5 })
    expect(new Set(order([easy, shortMedium, longMedium, hard], { chip: 'light' }))).toEqual(
      new Set([easy.key, shortMedium.key])
    )
  })

  it('Light with no fit returns no-light', () => {
    const hard = mk('a', { difficulty: 'hard', minutes: 5 })
    expect(pickNext([hard], ctx([hard], { chip: 'light' })).empty).toBe('no-light')
  })

  it('mood filter applies inside every chip (lazy→easy, normal→medium, motivated→hard)', () => {
    const f = fixtures()
    for (const chip of CHIPS) {
      for (const mood of ['lazy', 'normal', 'motivated'] as const) {
        const ranked = rankCandidates(f, ctx(f, { chip, mood }))
        for (const p of ranked) expect(p.input.step.difficulty).toBe(MOOD_TO_DIFFICULTY[mood])
      }
    }
  })
})

describe('staleness and variety', () => {
  it('staleness raises an item untouched for 7+ days', () => {
    const recent = mk('a', { kind: 'passion', touched: 1 })
    const stale = mk('b', { kind: 'passion', touched: 8 })
    expect(order([recent, stale])[0]).toBe(stale.key)
    expect(scoreOf([recent, stale], stale.key) - scoreOf([recent, stale], recent.key)).toBeCloseTo(
      20 * (1 - 1 / 7)
    )
  })

  it('never-touched items score as moderately stale', () => {
    const never = mk('a', { kind: 'passion', touched: null })
    const three = mk('b', { kind: 'passion', touched: 3 })
    const six = mk('c', { kind: 'passion', touched: 6 })
    expect(order([three, never, six])).toEqual([six.key, never.key, three.key])
  })

  it('same item as the last done step within 45 min is penalised', () => {
    const a = mk('a', { name: 'Alpha', taskId: 't1' })
    const b = mk('b', { name: 'Beta', taskId: 't1' })
    const done = (when: Date): PickContext['lastDone'] => ({
      key: 'k',
      itemId: 'a',
      taskId: 'other',
      title: 'something else entirely',
      at: when.toISOString()
    })
    expect(order([a, b], { lastDone: done(at(14, 30)) })).toEqual([b.key, a.key])
    expect(
      scoreOf([a, b], b.key) - scoreOf([a, b], a.key, { lastDone: done(at(14, 30)) })
    ).toBeCloseTo(20)
    expect(order([a, b], { lastDone: done(at(14, 0)) })).toEqual([a.key, b.key])
  })

  it('similar title to the last done step is penalised', () => {
    const similar = mk('a', { name: 'Alpha', title: 'Draft methods paragraph again' })
    const different = mk('b', { name: 'Beta', title: 'Collect the survey links' })
    const lastDone = {
      key: 'k',
      itemId: 'z',
      taskId: 'zz',
      title: 'Draft the methods paragraph',
      at: at(9).toISOString()
    }
    expect(order([similar, different], { lastDone })).toEqual([different.key, similar.key])
    const sameTask = mk('c', { name: 'Alpha', taskId: 'zz', title: 'Unrelated words here' })
    expect(order([sameTask, different], { lastDone })).toEqual([different.key, sameTask.key])
  })

  it('second step from the same item ranks after other items', () => {
    const a1 = mk('a', { kind: 'passion', touched: 9, taskId: 't1' })
    const a2 = mk('a', { kind: 'passion', touched: 9, taskId: 't2' })
    const b = mk('b', { kind: 'passion', touched: 4 })
    const ranked = rankCandidates([a1, a2, b], ctx([a1, a2, b]))
    expect(keys(ranked)).toEqual([a1.key, b.key, a2.key])
    expect(ranked[2].score).toBeCloseTo(ranked[0].score - 25)
  })

  it("steps in today's plan get the plan bonus", () => {
    const a = mk('a', { name: 'Alpha' })
    const b = mk('b', { name: 'Beta' })
    const plan = new Set([b.key])
    expect(order([a, b], { todayPlanKeys: plan })).toEqual([b.key, a.key])
    expect(scoreOf([a, b], b.key, { todayPlanKeys: plan }) - scoreOf([a, b], a.key)).toBeCloseTo(20)
  })

  it('scheduled today or earlier gets a flat +5', () => {
    const base = mk('a')
    const s = (d: number): number => scoreOf([mk('a', { scheduled: dateIn(d) })], mk('a').key)
    const plain = scoreOf([base], base.key)
    expect(s(0) - plain).toBeCloseTo(5)
    expect(s(-10) - plain).toBeCloseTo(5)
    expect(s(1) - plain).toBeCloseTo(0)
  })

  it('loose end steps get a small bonus, larger under Light', () => {
    const plain = mk('a', { difficulty: 'easy', minutes: 5 })
    const loose = mk('b', { difficulty: 'easy', minutes: 5, loose: true })
    const diff = (chip: EnergyChip): number =>
      scoreOf([plain, loose], loose.key, { chip }) - scoreOf([plain, loose], plain.key, { chip })
    expect(diff('anything')).toBeCloseTo(3)
    expect(diff('different')).toBeCloseTo(3)
    expect(diff('light')).toBeCloseTo(6)
  })
})

describe('skips', () => {
  it('a step skipped today with no reason or not now is excluded until tomorrow', () => {
    const a = mk('a', { taskId: 't1' })
    const b = mk('a', { taskId: 't2' })
    const c = mk('c')
    for (const reason of ['none', 'not-now'] as const) {
      const skips = [skip(a, reason, at(9))]
      expect(order([a, b, c], { now: at(23, 59), skipsToday: skips })).not.toContain(a.key)
      expect(order([a, b, c], { skipsToday: skips })).toContain(b.key)
    }
  })

  it('skips from yesterday are ignored', () => {
    const a = mk('a')
    const skips = [skip(a, 'none', at(9), '2026-11-10'), skip(a, 'tired', at(9), '2026-11-10')]
    expect(order([a], { skipsToday: skips })).toEqual([a.key])
    expect(scoreOf([a], a.key, { skipsToday: skips })).toBeCloseTo(scoreOf([a], a.key))
  })

  it('undone skips are ignored', () => {
    const a = mk('a')
    expect(order([a], { skipsToday: [{ ...skip(a, 'tired'), undone: true }] })).toEqual([a.key])
  })

  it('item skip count lowers the item without excluding it, capped at 36', () => {
    const steps = [1, 2, 3, 4, 5].map((n) => mk('a', { taskId: `t${n}` }))
    // Only the unskipped step is ranked, so the greedy same-item penalty stays out of it.
    const target = [steps[4]]
    const key = steps[4].key
    const base = scoreOf(target, key)
    const skips = (n: number): SkipEvent[] => steps.slice(0, n).map((s) => skip(s, 'none'))
    expect(scoreOf(target, key, { skipsToday: skips(1) })).toBeCloseTo(base - 12)
    expect(scoreOf(target, key, { skipsToday: skips(3) })).toBeCloseTo(base - 36)
    expect(scoreOf(target, key, { skipsToday: skips(4) })).toBeCloseTo(base - 36)
    expect(order(steps, { skipsToday: skips(4) })).toEqual([key])
  })

  it('tired of this excludes every step of that item today', () => {
    const f = fixtures()
    const proposal = find(f, ITEM.thesis, 'proposal')
    for (const chip of CHIPS) {
      for (const now of [at(15), at(20), at(23, 59)]) {
        const ids = rankCandidates(
          f,
          ctx(f, { chip, now, skipsToday: [skip(proposal, 'tired')] })
        ).map((p) => p.input.step.projectId)
        expect(ids).not.toContain(ITEM.thesis)
      }
    }
  })

  it('steps outside eligibleKeys (session skips, mood) never appear', () => {
    const f = fixtures()
    const keep = new Set([find(f, ITEM.website, 'goal').key, find(f, ITEM.focusforge, 'goal').key])
    for (const chip of CHIPS) {
      const r = pickNext(f, ctx(f, { chip, eligibleKeys: keep }))
      for (const p of [r.pick, ...r.rest, r.urgentAside]) {
        if (p) expect(keep.has(p.input.key)).toBe(true)
      }
    }
  })
})

describe('empty states', () => {
  it('no steps gives no-steps', () => {
    expect(pickNext([], ctx([])).empty).toBe('no-steps')
  })

  it('nothing eligible because of the mood gives mood; otherwise all-skipped', () => {
    const easy = mk('a', { difficulty: 'easy' })
    expect(pickNext([easy], ctx([easy], { mood: 'motivated' })).empty).toBe('mood')
    expect(pickNext([easy], ctx([easy], { eligibleKeys: new Set() })).empty).toBe('all-skipped')
  })

  it('everything skipped today gives all-skipped', () => {
    const a = mk('a')
    const r = pickNext([a], ctx([a], { skipsToday: [skip(a, 'none')] }))
    expect(r.pick).toBeNull()
    expect(r.empty).toBe('all-skipped')
  })
})

describe('determinism', () => {
  it('same input gives the same order', () => {
    const f = fixtures()
    for (const chip of CHIPS) {
      const first = order(f, { chip })
      expect(order(f, { chip })).toEqual(first)
      expect(order(f.slice().reverse(), { chip })).toEqual(first)
    }
  })

  it('ties break by due date, then confirmed before tentative, then minutes, then oldest touch, then name, then key', () => {
    // Under Something different W.U is 5 and U is 0 beyond 21 days, so these all score the same.
    const base = { d: 30, touched: 8, minutes: 15, name: 'Beta' }
    const sooner = mk('a1', { ...base, d: 25 })
    const confirmed = mk('a2', base)
    const tentative = mk('a3', { ...base, conf: 'tentative' })
    const shorter = mk('a4', { ...base, d: 30, minutes: 10 })
    const older = mk('a5', { ...base, touched: 9 })
    const named = mk('a6', { ...base, name: 'Alpha' })
    const keyA = mk('a7', { ...base, minutes: 20, touched: 20, d: 40, subtaskId: 'a' })
    const keyB = mk('a8', { ...base, minutes: 20, touched: 20, d: 40, subtaskId: 'b' })
    // keyA/keyB tie on everything but key (name 'Beta', projectId differs → key differs).
    const all = [keyB, keyA, named, older, shorter, tentative, confirmed, sooner]
    const ranked = rankCandidates(all, ctx(all, { chip: 'different' }))
    const scores = new Set(ranked.map((p) => p.score.toFixed(6)))
    expect(scores.size).toBeLessThanOrEqual(2) // minutes 20 lowers E (0.6 base) for the key pair
    expect(keys(ranked).slice(0, 6)).toEqual([
      sooner.key,
      shorter.key,
      older.key,
      named.key,
      confirmed.key,
      tentative.key
    ])
    expect(keys(ranked).slice(6)).toEqual([keyA.key, keyB.key])
  })

  it('the result depends only on ctx.now, never the wall clock', () => {
    const f = fixtures(true)
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2030, 0, 1, 3, 0))
    const a = pickNext(f, ctx(f, { chip: 'different' }))
    vi.setSystemTime(new Date(2020, 5, 15, 22, 0))
    const b = pickNext(f, ctx(f, { chip: 'different' }))
    expect(b).toEqual(a)
  })

  it('paused and archived items never appear', () => {
    // getNextSteps returns active items only; queue.all (eligibleKeys) still holds
    // paused steps for Up next, but with no RankInput they can never be picked.
    const f = fixtures()
    const pausedKey = queueKey({ projectId: 'paused-item', taskId: 't', subtaskId: 's' })
    const keysWithPaused = new Set([...eligible(f), pausedKey])
    for (const chip of CHIPS) {
      const r = pickNext(f, ctx(f, { chip, eligibleKeys: keysWithPaused }))
      expect([r.pick, ...r.rest].map((p) => p?.input.key)).not.toContain(pausedKey)
    }
  })
})

describe('owner table', () => {
  it('owner scenario 2026-11-11: tired of Thesis and PSYC1023 after working in their folders, Something different picks a passion project', () => {
    const f = fixtures(true)
    const r = pickNext(f, ctx(f, { chip: 'different' }))
    expect(r.pick?.input.step.projectId).toBe(ITEM.website)
    expect(r.pick?.reason).toBe('Personal website · a passion project · last touched 6 days ago')
    expect(r.rest[0].input.step.projectId).toBe(ITEM.focusforge)
    const ids = [r.pick, ...r.rest].map((p) => p?.input.step.projectId)
    expect(ids).not.toContain(ITEM.thesis)
    expect(ids).not.toContain(ITEM.psyc1023)
    expect(r.urgentAside?.input.step.projectId).toBe(ITEM.comp9321)
  })

  it('owner scenario scores: Personal website about 73, FocusForge about 59', () => {
    const f = fixtures(true)
    const ranked = rankCandidates(f, ctx(f, { chip: 'different' }))
    const score = (id: string): number => ranked.find((p) => p.input.step.projectId === id)!.score
    expect(Math.round(score(ITEM.website))).toBe(73)
    expect(Math.round(score(ITEM.focusforge))).toBe(59)
  })

  it('thin slice on a normal day: Anything picks the soonest real deadline', () => {
    const f = fixtures()
    const r = pickNext(f, ctx(f))
    expect(r.pick?.input.step.projectId).toBe(ITEM.comp9321)
    expect(r.pick?.urgent).toBe(true)
    expect(r.pick?.reason).toBe('COMP9321 · due tomorrow · last touched 3 days ago')
    expect(r.rest.some((p) => p.urgent)).toBe(false)
  })
})

describe('explain', () => {
  it('explain: Thesis · due in 9 days · last touched 3 days ago', () => {
    const f = fixtures()
    expect(explain(find(f, ITEM.thesis, 'proposal'), { now: NOW, chip: 'anything' })).toBe(
      'Thesis · due in 9 days · last touched 3 days ago'
    )
  })

  it('explain: due today, due tomorrow, date passed 1 and 2 days ago', () => {
    const e = (d: number): string =>
      explain(mk('X', { d, touched: 4 }), { now: NOW, chip: 'anything' })
    expect(e(0)).toBe('X · due today · last touched 4 days ago')
    expect(e(1)).toBe('X · due tomorrow · last touched 4 days ago')
    expect(e(-1)).toBe('X · date passed 1 day ago · last touched 4 days ago')
    expect(e(-2)).toBe('X · date passed 2 days ago · last touched 4 days ago')
    expect(e(-30)).toBe('X · last touched 4 days ago')
  })

  it('explain: passion with no due date', () => {
    const f = fixtures()
    expect(explain(find(f, ITEM.website, 'goal'), { now: NOW, chip: 'different' })).toBe(
      'Personal website · a passion project · last touched 6 days ago'
    )
    expect(explain(mk('Y', { kind: 'ongoing', touched: 2 }), { now: NOW, chip: 'anything' })).toBe(
      'Y · ongoing · last touched 2 days ago'
    )
  })

  it('explain: tentative dues say around, with the raw when or the date', () => {
    const f = fixtures()
    expect(explain(find(f, ITEM.thesis, 'presentation'), { now: NOW, chip: 'anything' })).toBe(
      'Thesis · due around Week 11 (TBC) · last touched 3 days ago'
    )
    expect(
      explain(mk('Z', { d: 14, conf: 'tentative', touched: 2 }), { now: NOW, chip: 'anything' })
    ).toBe('Z · due around 25 Nov (tentative) · last touched 2 days ago')
  })

  it('explain: a loose end cites the item due, or says a loose end', () => {
    const f = fixtures()
    expect(explain(find(f, ITEM.thesis, 'loose'), { now: NOW, chip: 'light' })).toBe(
      'Thesis · Proposal v5 due in 9 days · last touched 3 days ago'
    )
    expect(explain(mk('W', { loose: true, touched: 5 }), { now: NOW, chip: 'light' })).toBe(
      'W · a loose end · last touched 5 days ago'
    )
  })

  it('explain: touched today, yesterday, never', () => {
    const touchedToday = mk('T', { kind: 'passion', touched: 0 })
    expect(explain(touchedToday, { now: NOW, chip: 'anything' })).toBe(
      'T · a passion project · touched today'
    )
    expect(explain(touchedToday, { now: NOW, chip: 'deadline' })).toBe(
      'T · a passion project · touched today'
    )
    expect(explain(touchedToday, { now: NOW, chip: 'different' })).toBe('T · a passion project')
    expect(explain(touchedToday, { now: NOW, chip: 'light' })).toBe('T · a passion project')
    expect(explain(mk('T', { kind: 'passion', touched: 1 }), { now: NOW, chip: 'anything' })).toBe(
      'T · a passion project · last touched yesterday'
    )
    expect(
      explain(mk('T', { kind: 'passion', touched: null }), { now: NOW, chip: 'anything' })
    ).toBe('T · a passion project · not started yet')
  })

  it('explain: never uses overdue, late, behind, should or must', () => {
    const banned = /\b(overdue|late|behind|should|must)\b/i
    const lines: string[] = []
    for (const owner of [false, true]) {
      const f = fixtures(owner)
      for (const chip of CHIPS) {
        for (const i of f) lines.push(explain(i, { now: NOW, chip }))
        const r = pickNext(f, ctx(f, { chip }))
        for (const p of [r.pick, ...r.rest, r.urgentAside]) if (p) lines.push(p.reason)
      }
    }
    for (let d = -120; d <= 120; d += 1) {
      for (const conf of ['confirmed', 'tentative'] as const) {
        for (const source of ['task', 'item'] as const) {
          for (const touched of [null, 0, 1, 40]) {
            for (const chip of CHIPS) {
              lines.push(
                explain(mk('Item', { d, conf, source, touched, what: 'Report' }), {
                  now: NOW,
                  chip
                })
              )
            }
          }
        }
      }
    }
    expect(lines.length).toBeGreaterThan(1000)
    for (const line of lines) {
      expect(line).not.toMatch(banned)
      expect(line.split(' · ').length).toBeLessThanOrEqual(3)
    }
  })
})

describe('dueDays', () => {
  it('counts local calendar days, including across a daylight-saving change', () => {
    expect(dueDays(TODAY, NOW)).toBe(0)
    expect(dueDays('2026-11-12', at(23, 59))).toBe(1)
    expect(dueDays('2026-11-10', at(0, 1))).toBe(-1)
    // Sydney moves to daylight time on 2026-10-04.
    expect(dueDays('2026-10-05', new Date(2026, 9, 3, 12))).toBe(2)
    expect(dueDays('2027-04-05', new Date(2027, 3, 3, 12))).toBe(2)
  })

  it('is null for a missing or malformed date', () => {
    expect(dueDays(null, NOW)).toBeNull()
    expect(dueDays('', NOW)).toBeNull()
    expect(dueDays('2026-02-30', NOW)).toBeNull()
    expect(dueDays('next week', NOW)).toBeNull()
  })
})
