import { describe, expect, it } from 'vitest'
import type { ItemNextStep } from './nextSteps'
import {
  FIXTURE_DIGESTS,
  FIXTURE_TODAY,
  ITEM,
  daysAgoIso,
  fixtureNow,
  fixtureSignals,
  fixtureSteps
} from './whatNext.fixtures'
import {
  nextDueOf,
  sanitizeSkipEvent,
  stepKey,
  toProxyView,
  toRankable,
  type SkipEvent
} from './whatNext'

const ranked = (o?: { ownerScenario?: boolean }): ReturnType<typeof toRankable> =>
  toRankable(fixtureSteps(o), fixtureSignals(), fixtureNow())
const byTask = (
  inputs: ReturnType<typeof toRankable>,
  projectId: string,
  taskId: string
): ReturnType<typeof toRankable>[number] => {
  const found = inputs.find((i) => i.step.projectId === projectId && i.step.taskId === taskId)
  if (!found) throw new Error(`no ${projectId}/${taskId}`)
  return found
}

describe('toRankable', () => {
  it('drops needsPlan entries and steps with no subtask', () => {
    const inputs = ranked()
    expect(inputs.some((i) => i.step.needsPlan)).toBe(false)
    expect(inputs.some((i) => i.step.taskId === 'a4')).toBe(false)
    expect(inputs).toHaveLength(fixtureSteps().length - 1)
  })

  it('builds the key in the same format as the renderer queueKey', () => {
    const i = byTask(ranked(), ITEM.comp9321, 'a3')
    expect(i.key).toBe(JSON.stringify(['comp9321', 'a3', 'a3-s1']))
    expect(stepKey('p', 't', 's')).toBe('["p","t","s"]')
  })

  it('a hard deadline becomes a confirmed task-level due', () => {
    expect(byTask(ranked(), ITEM.comp9321, 'a3').due).toEqual({
      date: '2026-11-12',
      confidence: 'confirmed',
      source: 'task'
    })
  })

  it('a tentative deadline with no date keeps the raw when', () => {
    expect(byTask(ranked(), ITEM.thesis, 'presentation').due).toEqual({
      date: null,
      when: 'Week 11 (TBC)',
      confidence: 'tentative',
      source: 'task'
    })
  })

  it("a goal task (deadlineKind none) ignores its horizon and uses the item's next due", () => {
    expect(byTask(ranked(), ITEM.website, 'goal').due).toBeNull()
    const steps: ItemNextStep[] = [
      { ...fixtureSteps().find((s) => s.projectId === ITEM.website)!, projectId: ITEM.thesis }
    ]
    const [i] = toRankable(steps, fixtureSignals(), fixtureNow())
    expect(i.due).toEqual({
      date: '2026-11-20',
      what: 'Proposal v5',
      confidence: 'confirmed',
      source: 'item'
    })
  })

  it('a Loose ends task ignores its artificial deadline even when marked hard', () => {
    const i = byTask(ranked(), ITEM.thesis, 'loose')
    expect(i.isLooseEnd).toBe(true)
    expect(i.due?.source).toBe('item')
    expect(i.due?.date).toBe('2026-11-20')
  })

  it('a step with deadlineKind none and no item due gets null', () => {
    expect(byTask(ranked(), ITEM.focusforge, 'goal').due).toBeNull()
  })

  it('lastTouchedAt is the later of the step and a local start', () => {
    const later = daysAgoIso(0, 9)
    const inputs = toRankable(
      fixtureSteps(),
      fixtureSignals({ starts: { [ITEM.website]: later, [ITEM.focusforge]: daysAgoIso(30) } }),
      fixtureNow()
    )
    expect(byTask(inputs, ITEM.website, 'goal').lastTouchedAt).toBe(later)
    expect(byTask(inputs, ITEM.website, 'goal').touchedToday).toBe(true)
    expect(byTask(inputs, ITEM.focusforge, 'goal').lastTouchedAt).toBe(daysAgoIso(2))
  })

  it('touchedToday uses the local date, so folder work earlier today counts', () => {
    const inputs = ranked({ ownerScenario: true })
    expect(byTask(inputs, ITEM.thesis, 'proposal').touchedToday).toBe(true)
    expect(byTask(inputs, ITEM.psyc1023, 'report').touchedToday).toBe(true)
    expect(byTask(inputs, ITEM.comp9321, 'a3').touchedToday).toBe(false)
    // 00:30 local today is still today in Sydney even though it is yesterday in UTC.
    const early = new Date(2026, 10, 11, 0, 30).toISOString()
    const [i] = toRankable(
      [{ ...fixtureSteps()[0], lastTouchedAt: early }],
      fixtureSignals(),
      fixtureNow()
    )
    expect(i.touchedToday).toBe(true)
  })

  it('missing lastTouchedAt stays null', () => {
    const [i] = toRankable(
      [{ ...fixtureSteps()[0], lastTouchedAt: undefined }],
      fixtureSignals(),
      fixtureNow()
    )
    expect(i.lastTouchedAt).toBeNull()
    expect(i.touchedToday).toBe(false)
  })
})

describe('nextDueOf', () => {
  it('prefers the earliest confirmed dated due', () => {
    expect(nextDueOf(FIXTURE_DIGESTS[ITEM.thesis], FIXTURE_TODAY)).toEqual({
      what: 'Proposal v5',
      date: '2026-11-20',
      confidence: 'confirmed'
    })
  })

  it('falls back to the earliest tentative dated due', () => {
    expect(nextDueOf(FIXTURE_DIGESTS[ITEM.psyc1023], FIXTURE_TODAY)?.confidence).toBe('tentative')
    expect(
      nextDueOf(
        {
          dueDates: [
            { what: 'B', date: '2026-12-01', confidence: 'tentative' },
            { what: 'A', date: '2026-11-25', confidence: 'tentative' }
          ]
        },
        FIXTURE_TODAY
      )?.what
    ).toBe('A')
  })

  it('keeps an undated tentative due such as Week 11 (TBC)', () => {
    expect(
      nextDueOf(
        {
          dueDates: [
            { what: 'Presentation', date: null, when: 'Week 11 (TBC)', confidence: 'tentative' }
          ]
        },
        FIXTURE_TODAY
      )
    ).toEqual({ what: 'Presentation', date: null, when: 'Week 11 (TBC)', confidence: 'tentative' })
  })

  it('ignores dates that have passed (stale data)', () => {
    expect(nextDueOf(FIXTURE_DIGESTS[ITEM.old], FIXTURE_TODAY)).toBeNull()
    expect(nextDueOf(FIXTURE_DIGESTS[ITEM.comp9321], FIXTURE_TODAY)?.what).toBe('Assignment 3')
  })

  it('a due today still counts', () => {
    expect(
      nextDueOf(
        { dueDates: [{ what: 'Quiz', date: FIXTURE_TODAY, confidence: 'confirmed' }] },
        FIXTURE_TODAY
      )?.date
    ).toBe(FIXTURE_TODAY)
  })

  it('returns null with no digest, no dues, or undated dues with no when', () => {
    expect(nextDueOf(null, FIXTURE_TODAY)).toBeNull()
    expect(nextDueOf({ dueDates: [] }, FIXTURE_TODAY)).toBeNull()
    expect(
      nextDueOf({ dueDates: [{ what: 'X', date: null, confidence: 'tentative' }] }, FIXTURE_TODAY)
    ).toBeNull()
  })
})

describe('sanitizeSkipEvent', () => {
  const valid: SkipEvent = {
    at: daysAgoIso(0, 14),
    date: FIXTURE_TODAY,
    hour: 14,
    itemId: ITEM.thesis,
    taskId: 'proposal',
    subtaskId: 'proposal-s1',
    reason: 'tired',
    chip: 'different',
    mood: 'all',
    itemKind: 'deadline',
    category: 'Learning',
    difficulty: 'medium',
    minutes: 15,
    dueDays: 9,
    dueConfidence: 'confirmed',
    isLooseEnd: false,
    rank: 0
  }

  it('drops unknown keys such as titles and clamps numbers', () => {
    const out = sanitizeSkipEvent({
      ...valid,
      title: 'Draft the methods paragraph',
      itemName: 'Thesis',
      hour: 31,
      minutes: -4,
      rank: 12.6,
      dueDays: 99999
    })
    expect(out).not.toBeNull()
    expect(Object.keys(out!)).not.toContain('title')
    expect(Object.keys(out!)).not.toContain('itemName')
    expect(JSON.stringify(out)).not.toContain('Draft')
    expect(out).toMatchObject({ hour: 23, minutes: 0, rank: 13, dueDays: 3650 })
  })

  it('keeps a valid event as is, with undone only when true', () => {
    expect(sanitizeSkipEvent(valid)).toEqual(valid)
    expect(sanitizeSkipEvent({ ...valid, undone: true })?.undone).toBe(true)
    expect(sanitizeSkipEvent({ ...valid, undone: 'yes' })).not.toHaveProperty('undone')
    expect(sanitizeSkipEvent({ ...valid, dueDays: null, dueConfidence: 'maybe' })).toMatchObject({
      dueDays: null,
      dueConfidence: null
    })
  })

  it('rejects bad enums, ids, dates and non-objects', () => {
    expect(sanitizeSkipEvent(null)).toBeNull()
    expect(sanitizeSkipEvent([valid])).toBeNull()
    expect(sanitizeSkipEvent({ ...valid, reason: 'bored' })).toBeNull()
    expect(sanitizeSkipEvent({ ...valid, chip: 'urgent' })).toBeNull()
    expect(sanitizeSkipEvent({ ...valid, category: 'Secret' })).toBeNull()
    expect(sanitizeSkipEvent({ ...valid, itemId: '' })).toBeNull()
    expect(sanitizeSkipEvent({ ...valid, taskId: 'x'.repeat(500) })).toBeNull()
    expect(sanitizeSkipEvent({ ...valid, date: '11/11/2026' })).toBeNull()
    expect(sanitizeSkipEvent({ ...valid, at: 'not a date' })).toBeNull()
    expect(sanitizeSkipEvent({ ...valid, minutes: 'ten' })).toBeNull()
  })
})

describe('toProxyView', () => {
  it('hides the dot until a cliproxy model is configured and a check has landed', () => {
    const checked = { up: true, checkedAt: '2026-11-12T00:00:00.000Z' }
    expect(toProxyView(false, checked)).toEqual({ status: 'not-used', checkedAt: null })
    expect(toProxyView(true, { up: null, checkedAt: null }).status).toBe('unknown')
    expect(toProxyView(true, checked).status).toBe('up')
    expect(toProxyView(true, { up: false, checkedAt: checked.checkedAt }).status).toBe('down')
  })
})

describe('fixtures', () => {
  it('cover the five slice items, a Loose ends task, a tentative undated due and stale data', () => {
    const steps = fixtureSteps()
    const items = new Set(steps.map((s) => s.projectId))
    for (const key of ['thesis', 'comp9321', 'psyc1023', 'personalwebsite', 'focusforge']) {
      expect(items.has(key)).toBe(true)
    }
    expect(steps.some((s) => s.taskAuto === 'loose-ends')).toBe(true)
    expect(steps.some((s) => s.deadlineKind === 'tentative' && !s.deadline && s.dueWhen)).toBe(true)
    expect(steps.some((s) => s.deadline && s.deadline < '2026-08-31')).toBe(true)
  })
})
