import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeChecklist, normalizeTitle, requestsRemovingCompleted } from './merge'
import { Prerequisite, Subtask } from './types'

const NOW = new Date('2026-10-15T09:30:00.000Z')
const DONE_AT = '2026-10-10T08:00:00.000Z'
const makeId = (i: number): string => `new-${i}`

function sub(id: string, title: string, overrides: Partial<Subtask> = {}): Subtask {
  return { id, title, isCompleted: false, status: 'todo', ...overrides }
}

function done(id: string, title: string, overrides: Partial<Subtask> = {}): Subtask {
  return sub(id, title, { isCompleted: true, status: 'done', completedAt: DONE_AT, ...overrides })
}

function pre(
  id: string,
  title: string,
  isCompleted = false,
  kind: Prerequisite['kind'] = 'learn'
): Prerequisite {
  return { id, title, kind, isCompleted }
}

const ids = (xs: { id: string }[]): string[] => xs.map((x) => x.id)
const titles = (xs: { title: string }[]): string[] => xs.map((x) => x.title)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('normalizeTitle', () => {
  it('lowercases and collapses punctuation/whitespace', () => {
    expect(normalizeTitle('  Write the Intro!!  (draft) ')).toBe('write the intro draft')
  })

  it('keeps non-ASCII letters and digits', () => {
    expect(normalizeTitle('Résumé — v2')).toBe('résumé v2')
  })

  it('handles undefined', () => {
    expect(normalizeTitle(undefined)).toBe('')
  })
})

describe('requestsRemovingCompleted', () => {
  it.each([
    'remove the done ones',
    'Delete completed steps please',
    'get rid of everything I have finished',
    'clear the ticked items',
    'hide all the checked off tasks'
  ])('detects "%s"', (req) => {
    expect(requestsRemovingCompleted(req)).toBe(true)
  })

  it.each([
    'make this shorter',
    'expand step 3',
    'remove the slides step',
    'I finished the intro, what next?',
    ''
  ])('ignores "%s"', (req) => {
    expect(requestsRemovingCompleted(req)).toBe(false)
  })
})

describe('mergeChecklist - subtasks', () => {
  it('id match keeps isCompleted/completedAt/status of a completed item verbatim', () => {
    const prev = {
      subtasks: [done('1', 'Write intro', { timeEstimate: 10 }), sub('2', 'Write body')]
    }
    const out = mergeChecklist(
      prev,
      {
        subtasks: [
          { id: '1', title: 'Write the intro', timeEstimate: 25 },
          { id: '2', title: 'Write body paragraphs' }
        ]
      },
      { makeId }
    )
    expect(out.subtasks[0]).toEqual({ ...prev.subtasks[0], status: 'done', isCompleted: true })
    expect(out.subtasks[0].completedAt).toBe(DONE_AT)
    expect(out.subtasks[1]).toMatchObject({
      id: '2',
      title: 'Write body paragraphs',
      isCompleted: false,
      status: 'todo'
    })
    expect(out.restoredSubtasks).toEqual([])
  })

  it('incomplete id match takes the AI fields', () => {
    const prev = {
      subtasks: [sub('1', 'Write intro', { timeEstimate: 30, scheduledDate: '2026-10-16' })]
    }
    const out = mergeChecklist(
      prev,
      {
        subtasks: [
          {
            id: '1',
            title: 'Write a 3-sentence intro',
            timeEstimate: 10,
            scheduledDate: '2026-10-17'
          }
        ]
      },
      { makeId }
    )
    expect(out.subtasks).toEqual([
      {
        id: '1',
        title: 'Write a 3-sentence intro',
        timeEstimate: 10,
        scheduledDate: '2026-10-17',
        isCompleted: false,
        status: 'todo',
        completedAt: undefined
      }
    ])
  })

  it('a completed id reused for an unrelated title does NOT inherit done, and the original is restored', () => {
    const prev = { subtasks: [done('1', 'Write intro'), sub('2', 'Write body')] }
    const out = mergeChecklist(
      prev,
      {
        subtasks: [
          { id: '1', title: 'Submit on Moodle' },
          { id: '2', title: 'Write body' }
        ]
      },
      { makeId }
    )

    const moodle = out.subtasks.find((s) => s.title === 'Submit on Moodle')!
    expect(moodle).toMatchObject({ isCompleted: false, status: 'todo' })
    expect(moodle.completedAt).toBeUndefined()
    expect(moodle.id).toBe('new-0') // '1' is taken by the restored original

    expect(out.restoredSubtasks).toEqual([prev.subtasks[0]])
    expect(out.subtasks[0]).toEqual(prev.subtasks[0]) // restored at the front
    expect(titles(out.subtasks)).toEqual(['Write intro', 'Submit on Moodle', 'Write body'])
  })

  it("re-id'd item is matched by normalized title and keeps its old id + completion", () => {
    const prev = { subtasks: [done('a', 'Write the Intro!')] }
    const out = mergeChecklist(
      prev,
      {
        subtasks: [
          { id: 'z', title: 'write the intro' },
          { id: 'y', title: 'Write body' }
        ]
      },
      { makeId }
    )
    expect(out.subtasks[0]).toMatchObject({
      id: 'a',
      title: 'Write the Intro!',
      isCompleted: true,
      completedAt: DONE_AT
    })
    expect(out.subtasks[1]).toMatchObject({ id: 'y', title: 'Write body', isCompleted: false })
    expect(out.restoredSubtasks).toEqual([])
  })

  it('a genuinely new item claiming isCompleted:true comes out todo', () => {
    const out = mergeChecklist(
      { subtasks: [] },
      {
        subtasks: [
          {
            id: 'x',
            title: 'Brand new step',
            isCompleted: true,
            status: 'done',
            completedAt: DONE_AT
          }
        ]
      },
      { makeId }
    )
    expect(out.subtasks[0]).toMatchObject({ id: 'x', isCompleted: false, status: 'todo' })
    expect(out.subtasks[0].completedAt).toBeUndefined()
  })

  it('duplicate incoming ids get fresh ids', () => {
    const out = mergeChecklist(
      { subtasks: [] },
      {
        subtasks: [{ id: 'x', title: 'Step A' }, { id: 'x', title: 'Step B' }, { title: 'Step C' }]
      },
      { makeId }
    )
    expect(ids(out.subtasks)).toEqual(['x', 'new-0', 'new-1'])
    expect(new Set(ids(out.subtasks)).size).toBe(3)
  })

  it('a new item reusing an existing incomplete id that was already claimed gets a fresh id', () => {
    const prev = { subtasks: [sub('1', 'Write intro')] }
    const out = mergeChecklist(
      prev,
      {
        subtasks: [
          { id: '1', title: 'Write intro' },
          { id: '1', title: 'Totally different' }
        ]
      },
      { makeId }
    )
    expect(ids(out.subtasks)).toEqual(['1', 'new-0'])
  })

  it('dropped completed items are restored at the front in original order; dropped incomplete items go', () => {
    const prev = {
      subtasks: [
        done('1', 'Read spec'),
        sub('2', 'Skim rubric'),
        done('3', 'Set up repo'),
        sub('4', 'Write tests')
      ]
    }
    const out = mergeChecklist(prev, { subtasks: [{ id: '4', title: 'Write tests' }] }, { makeId })
    expect(ids(out.restoredSubtasks)).toEqual(['1', '3'])
    expect(ids(out.subtasks)).toEqual(['1', '3', '4'])
  })

  it('allowDropCompleted lets completed items disappear', () => {
    const prev = { subtasks: [done('1', 'Read spec'), sub('2', 'Write tests')] }
    const out = mergeChecklist(
      prev,
      { subtasks: [{ id: '2', title: 'Write tests' }] },
      { makeId, allowDropCompleted: true }
    )
    expect(ids(out.subtasks)).toEqual(['2'])
    expect(out.restoredSubtasks).toEqual([])
  })

  it('doing status carries over to the edited item', () => {
    const prev = { subtasks: [sub('1', 'Write intro', { status: 'doing' })] }
    const out = mergeChecklist(
      prev,
      { subtasks: [{ id: '1', title: 'Write intro (3 sentences)', status: 'todo' }] },
      { makeId }
    )
    expect(out.subtasks[0]).toMatchObject({
      id: '1',
      title: 'Write intro (3 sentences)',
      status: 'doing',
      isCompleted: false
    })
  })

  it('a legacy completed item (no completedAt) is not stamped with today (no fake streak day)', () => {
    const legacy: Subtask = { id: '1', title: 'Read spec', isCompleted: true }
    const out = mergeChecklist(
      { subtasks: [legacy] },
      { subtasks: [{ id: '1', title: 'Read spec' }] },
      { makeId }
    )
    expect(out.subtasks[0]).toMatchObject({ isCompleted: true, status: 'done' })
    expect(out.subtasks[0].completedAt).toBeUndefined()
  })

  it('ignores incoming items with blank titles', () => {
    const out = mergeChecklist(
      { subtasks: [] },
      {
        subtasks: [
          { id: 'a', title: '   ' },
          { id: 'b', title: '!!' },
          { id: 'c', title: 'Real step' }
        ]
      },
      { makeId }
    )
    expect(ids(out.subtasks)).toEqual(['c'])
  })

  it('does not mutate its inputs', () => {
    const prev = {
      subtasks: [done('1', 'Read spec'), sub('2', 'Write tests', { status: 'doing' })]
    }
    const incoming = { subtasks: [{ id: '2', title: 'Write more tests', isCompleted: true }] }
    const prevCopy = structuredClone(prev)
    const inCopy = structuredClone(incoming)
    mergeChecklist(prev, incoming, { makeId })
    expect(prev).toEqual(prevCopy)
    expect(incoming).toEqual(inCopy)
  })

  // BUG (reported): titlesSimilar() measures word overlap relative to the
  // SHORTER title and also accepts substring containment, so numbered steps
  // that differ only by their number look "similar". Models often renumber
  // ids 1..n on a mutation; when the completed "Write up Q1" keeps id "1"
  // and the AI's id "1" is now "Write up Q2", the done item is kept verbatim
  // and the new Q2 step silently disappears from the plan.
  it('a completed numbered step does not swallow a different numbered step that reuses its id', () => {
    const prev = { subtasks: [done('1', 'Write up Q1 answer'), sub('2', 'Write up Q2 answer')] }
    const out = mergeChecklist(
      prev,
      {
        subtasks: [
          { id: '1', title: 'Write up Q2 answer' },
          { id: '2', title: 'Write up Q3 answer' }
        ]
      },
      { makeId }
    )
    expect(titles(out.subtasks)).toContain('Write up Q2 answer')
    expect(titles(out.subtasks)).toContain('Write up Q3 answer')
    expect(out.subtasks.find((s) => s.title === 'Write up Q2 answer')?.isCompleted).toBe(false)
  })

  it('"Q1" vs "Q10" is not treated as the same step (substring containment)', () => {
    const prev = { subtasks: [done('1', 'Solve Q1')] }
    const out = mergeChecklist(prev, { subtasks: [{ id: '1', title: 'Solve Q10' }] }, { makeId })
    expect(titles(out.subtasks)).toContain('Solve Q10')
  })
})

describe('mergeChecklist - prerequisites', () => {
  it('matched prerequisites keep isCompleted; completed ones keep their old fields', () => {
    const prev = {
      subtasks: [],
      prerequisites: [pre('p1', 'Watch lecture 4', true), pre('p2', 'Install Node', false, 'setup')]
    }
    const out = mergeChecklist(
      prev,
      {
        subtasks: [],
        prerequisites: [
          { id: 'p1', title: 'Watch lecture 4 on recursion', kind: 'learn' },
          { id: 'p2', title: 'Install Node 22', kind: 'setup', isCompleted: true }
        ]
      },
      { makeId }
    )
    expect(out.prerequisites[0]).toEqual(prev.prerequisites[0])
    expect(out.prerequisites[1]).toEqual({
      id: 'p2',
      title: 'Install Node 22',
      kind: 'setup',
      isCompleted: false
    })
  })

  it('new prerequisites always start incomplete', () => {
    const out = mergeChecklist(
      { subtasks: [] },
      {
        subtasks: [],
        prerequisites: [{ id: 'p9', title: 'Buy tape', kind: 'acquire', isCompleted: true }]
      },
      { makeId }
    )
    expect(out.prerequisites).toEqual([
      { id: 'p9', title: 'Buy tape', kind: 'acquire', isCompleted: false }
    ])
  })

  it('dropped completed prerequisites are restored unless allowDropCompleted', () => {
    const prev = {
      subtasks: [],
      prerequisites: [pre('p1', 'Watch lecture 4', true), pre('p2', 'Read chapter 2')]
    }
    const kept = mergeChecklist(prev, { subtasks: [], prerequisites: [] }, { makeId })
    expect(kept.prerequisites).toEqual([prev.prerequisites[0]])
    expect(kept.restoredPrerequisites).toEqual([prev.prerequisites[0]])

    const dropped = mergeChecklist(
      prev,
      { subtasks: [], prerequisites: [] },
      { makeId, allowDropCompleted: true }
    )
    expect(dropped.prerequisites).toEqual([])
  })

  it('missing prerequisites on both sides yields an empty list', () => {
    const out = mergeChecklist({ subtasks: [] }, { subtasks: [] }, { makeId })
    expect(out.prerequisites).toEqual([])
  })

  it('fresh ids never collide across subtasks and prerequisites', () => {
    const prev = { subtasks: [sub('1', 'Write intro')], prerequisites: [pre('p1', 'Read spec')] }
    const out = mergeChecklist(
      prev,
      {
        subtasks: [{ id: 'p1', title: 'New step' }],
        prerequisites: [{ id: '1', title: 'New prereq', kind: 'learn' }]
      },
      { makeId }
    )
    const all = [...ids(out.subtasks), ...ids(out.prerequisites)]
    expect(new Set(all).size).toBe(all.length)
    expect(all).not.toContain('1')
    expect(all).not.toContain('p1')
  })
})

describe('mergeChecklist - default id factory', () => {
  it('generates unique ids without makeId', () => {
    const out = mergeChecklist({ subtasks: [] }, { subtasks: [{ title: 'A' }, { title: 'B' }] })
    expect(ids(out.subtasks)).toEqual([`ai-${NOW.getTime()}-0`, `ai-${NOW.getTime()}-1`])
  })
})
