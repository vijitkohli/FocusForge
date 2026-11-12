import { describe, expect, it } from 'vitest'
import {
  earliestDueDate,
  mergeLooseEnds,
  MAX_OPEN_GAPS,
  type MergeLooseEndsOptions
} from './looseEnds'
import type { DigestCandidateTask } from './digest'
import type { ProjectTask } from './types'

const cand = (id: string, title = `Check ${id}`): DigestCandidateTask => ({
  id,
  title,
  minutes: 5,
  gapKind: 'to-check',
  why: 'TBC in context',
  sources: [{ label: 'thesis/CONTEXT.md', date: '2026-11-10' }]
})

let n = 0
const opts = (over: Partial<MergeLooseEndsOptions> = {}): MergeLooseEndsOptions => ({
  today: '2026-11-11',
  newId: () => `t${++n}`,
  now: new Date('2026-11-11T09:00:00'),
  ...over
})

const other: ProjectTask = {
  id: 'x',
  title: 'Essay',
  createdAt: '2026-11-01T00:00:00.000Z',
  deadline: '2026-11-30',
  status: 'in-progress',
  depth: 'Brief',
  model: 'm',
  subtasks: []
}

describe('mergeLooseEnds', () => {
  it('adds new gaps once, at most 3 open, with deadlineKind none', () => {
    const r = mergeLooseEnds([other], [cand('g1'), cand('g2'), cand('g3'), cand('g4')], [], opts())
    const le = r.tasks.find((t) => t.auto === 'loose-ends')!
    expect(r.tasks[0]).toBe(r.tasks[0])
    expect(le.title).toBe('Loose ends')
    expect(le.deadlineKind).toBe('none')
    expect(le.deadline).toBe('2026-11-18')
    expect(le.subtasks.map((s) => [s.gapId, s.title, s.difficulty, s.timeEstimate])).toEqual([
      ['g1', 'Check g1 (thesis/CONTEXT.md)', 'easy', 5],
      ['g2', 'Check g2 (thesis/CONTEXT.md)', 'easy', 5],
      ['g3', 'Check g3 (thesis/CONTEXT.md)', 'easy', 5]
    ])
    expect(r.added).toEqual(['g1', 'g2', 'g3'])
    expect(r.seen).toEqual(['g1', 'g2', 'g3'])
    expect(r.notes[0]).toEqual({
      section: 'Constraints & Specifications',
      note: 'Gap: Check g1 (thesis/CONTEXT.md)'
    })
    // Same digest again: nothing new while 3 are open.
    const again = mergeLooseEnds(
      r.tasks,
      [cand('g1'), cand('g2'), cand('g3'), cand('g4')],
      r.seen,
      opts()
    )
    expect(again.changed).toBe(false)
    expect(again.added).toEqual([])
    // Completing one frees a slot for the queued gap.
    const done = again.tasks.map((t) =>
      t.auto
        ? {
            ...t,
            subtasks: t.subtasks.map((s, i) =>
              i === 0 ? { ...s, isCompleted: true, status: 'done' as const } : s
            )
          }
        : t
    )
    const next = mergeLooseEnds(
      done,
      [cand('g1'), cand('g2'), cand('g3'), cand('g4')],
      again.seen,
      opts()
    )
    expect(next.added).toEqual(['g4'])
    expect(next.tasks.find((t) => t.auto)!.subtasks.filter((s) => !s.isCompleted)).toHaveLength(
      MAX_OPEN_GAPS
    )
  })

  it('never re-adds a deleted gap', () => {
    const r = mergeLooseEnds([], [cand('g1'), cand('g2')], [], opts())
    const deleted = r.tasks.map((t) => ({
      ...t,
      subtasks: t.subtasks.filter((s) => s.gapId !== 'g1')
    }))
    const again = mergeLooseEnds(deleted, [cand('g1'), cand('g2'), cand('g5')], r.seen, opts())
    expect(again.tasks[0].subtasks.map((s) => s.gapId)).toEqual(['g2', 'g5'])
  })

  it('removes vanished untouched gaps, keeps completed and worked-on ones', () => {
    const r = mergeLooseEnds([], [cand('g1'), cand('g2'), cand('g3')], [], opts())
    const t = r.tasks[0]
    t.subtasks[1] = {
      ...t.subtasks[1],
      isCompleted: true,
      status: 'done',
      completedAt: '2026-11-11T10:00:00Z'
    }
    t.subtasks[2] = { ...t.subtasks[2], focusSeconds: 120 }
    const next = mergeLooseEnds(r.tasks, [], r.seen, opts())
    expect(next.removed).toBe(1)
    expect(next.tasks[0].subtasks.map((s) => s.gapId)).toEqual(['g2', 'g3'])
    // An auto-removed gap may come back if it is reported again.
    expect(next.seen).not.toContain('g1')
    // Nothing left at all -> the task goes away.
    const empty = mergeLooseEnds(
      [{ ...r.tasks[0], subtasks: [r.tasks[0].subtasks[0]] }],
      [],
      r.seen,
      opts()
    )
    expect(empty.tasks).toEqual([])
  })

  it('deadline from earliest due date', () => {
    expect(
      earliestDueDate(
        [{ date: '2026-11-20' }, { date: null }, { date: '2026-11-15' }, { date: '2026-11-01' }],
        '2026-11-11'
      )
    ).toBe('2026-11-15')
    const r = mergeLooseEnds([], [cand('g1')], [], opts({ earliestDue: '2026-11-15' }))
    expect(r.tasks[0].deadline).toBe('2026-11-15')
    const past = mergeLooseEnds([], [cand('g1')], [], opts({ earliestDue: '2026-11-01' }))
    expect(past.tasks[0].deadline).toBe('2026-11-18')
  })
})
