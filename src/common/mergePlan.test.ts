import { describe, expect, it } from 'vitest'
import { mergeChecklist, mergePlan } from './merge'
import { spliceSplit } from './split'
import type { Milestone, Subtask } from './types'

const DONE_AT = '2026-10-10T08:00:00.000Z'

function sub(id: string, title: string, o: Partial<Subtask> = {}): Subtask {
  return { id, title, isCompleted: false, status: 'todo', ...o }
}
function done(id: string, title: string, o: Partial<Subtask> = {}): Subtask {
  return sub(id, title, { isCompleted: true, status: 'done', completedAt: DONE_AT, ...o })
}
function ms(
  id: string,
  title: string,
  status: Milestone['status'],
  o: Partial<Milestone> = {}
): Milestone {
  return { id, title, estimateMinutes: 120, doneWhen: `${title} finished`, status, ...o }
}

describe('mergeChecklist completedIds ("I already did X")', () => {
  it('marks a kept open step done with completedAt', () => {
    const r = mergeChecklist(
      { subtasks: [sub('1', 'Read week 5'), sub('2', 'Write outline')] },
      {
        subtasks: [
          { id: '1', title: 'Read week 5' },
          { id: '2', title: 'Write outline' }
        ],
        completedIds: ['1']
      }
    )
    expect(r.subtasks[0]).toMatchObject({ id: '1', isCompleted: true, status: 'done' })
    expect(r.subtasks[0].completedAt).toBeTruthy()
    expect(r.completedSubtasks.map((s) => s.id)).toEqual(['1'])
    expect(r.subtasks[1].isCompleted).toBe(false)
  })

  it('keeps a step marked done even if the reply dropped it', () => {
    const r = mergeChecklist(
      { subtasks: [sub('1', 'Read week 5'), sub('2', 'Write outline')] },
      { subtasks: [{ id: '2', title: 'Write outline' }], completedIds: ['1'] }
    )
    expect(r.subtasks.map((s) => [s.id, s.isCompleted])).toEqual([
      ['1', true],
      ['2', false]
    ])
  })

  it('ignores completedIds for already-done items and leaves their date alone', () => {
    const r = mergeChecklist(
      {
        subtasks: [done('1', 'Open spec')],
        prerequisites: [{ id: 'p1', title: 'Install', isCompleted: false }]
      },
      {
        subtasks: [{ id: '1', title: 'Open spec' }],
        prerequisites: [{ id: 'p1', title: 'Install' }],
        completedIds: ['1', 'p1']
      }
    )
    expect(r.subtasks[0].completedAt).toBe(DONE_AT)
    expect(r.completedSubtasks).toEqual([])
    expect(r.prerequisites[0].isCompleted).toBe(true)
  })
})

describe('mergePlan', () => {
  const prev = {
    milestones: [
      ms('m1', 'Clean the data', 'done', { completedAt: DONE_AT }),
      ms('m2', 'Explore', 'active', { expanded: 'partial' }),
      ms('m3', 'Model', 'todo')
    ],
    subtasks: [
      done('a', 'Parse dates', { milestoneId: 'm1' }),
      done('b', 'Plot years', { milestoneId: 'm2' }),
      sub('c', 'Genre table', { milestoneId: 'm2' })
    ],
    prerequisites: []
  }

  it('mergePlan keeps done milestone verbatim', () => {
    const r = mergePlan(prev, {
      milestones: [
        { id: 'm1', title: 'Clean the data', estimateMinutes: 999, status: 'todo' },
        { id: 'm2', title: 'Explore', estimateMinutes: 200 }
      ],
      subtasks: []
    })
    expect(r.milestones[0]).toEqual(prev.milestones[0])
    expect(r.milestones[1]).toMatchObject({
      estimateMinutes: 200,
      status: 'active',
      expanded: 'partial'
    })
  })

  it('mergePlan restores dropped done milestone', () => {
    const r = mergePlan(prev, {
      milestones: [
        { id: 'm2', title: 'Explore' },
        { id: 'm3', title: 'Model' }
      ],
      subtasks: []
    })
    expect(r.milestones.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(r.restoredMilestones.map((m) => m.id)).toEqual(['m1'])
    // the done step of the done milestone survives with its milestoneId
    expect(r.subtasks.find((s) => s.id === 'a')).toMatchObject({
      isCompleted: true,
      milestoneId: 'm1'
    })
  })

  it('mergePlan remaps step milestoneIds through id map', () => {
    const r = mergePlan(prev, {
      milestones: [
        { id: 'x2', title: 'Explore', estimateMinutes: 150 },
        { id: 'new-1', title: 'Write up', estimateMinutes: 90 }
      ],
      subtasks: [{ id: 'n1', title: 'Make the ROI chart', milestoneId: 'x2' }]
    })
    expect(r.milestoneIdMap.get('x2')).toBe('m2')
    expect(r.subtasks.find((s) => s.title === 'Make the ROI chart')?.milestoneId).toBe('m2')
    expect(r.milestones.find((m) => m.title === 'Write up')?.id).toBe('new-1')
  })

  it('mergePlan matches renamed milestone by title', () => {
    const r = mergePlan(prev, { milestones: [{ id: 'zz', title: 'model' }], subtasks: [] })
    expect(r.milestones.map((m) => m.id)).toEqual(['m1', 'm3'])
    expect(r.milestones[1].status).toBe('active')
  })

  it('mergePlan done milestone id reused for different title is not inherited', () => {
    const r = mergePlan(prev, {
      milestones: [{ id: 'm1', title: 'Totally new part' }],
      subtasks: []
    })
    expect(r.milestones.find((m) => m.title === 'Totally new part')?.id).not.toBe('m1')
    expect(r.milestones.find((m) => m.id === 'm1')?.status).toBe('done')
  })

  it('mergeChecklist unchanged for tasks without milestones', () => {
    const r = mergeChecklist(
      { subtasks: [done('1', 'A'), sub('2', 'B')] },
      { subtasks: [{ id: '2', title: 'B2' }] }
    )
    expect(r.subtasks.map((s) => s.id)).toEqual(['1', '2'])
    expect(r.subtasks[1].title).toBe('B2')
    expect(r.subtasks.every((s) => s.milestoneId === undefined)).toBe(true)
  })
})

describe('spliceSplit with milestones', () => {
  it('spliceSplit copies milestoneId to new steps', () => {
    let k = 0
    const out = spliceSplit(
      [sub('a', 'Big step', { milestoneId: 'm2', timeEstimate: 20 })],
      'a',
      [
        { title: 'Open it', timeEstimate: 3, difficulty: 'easy' },
        { title: 'Do it', timeEstimate: 15, difficulty: 'medium' }
      ],
      () => `n${k++}`
    )
    if (typeof out === 'string') throw new Error(out)
    expect(out.created.map((s) => s.milestoneId)).toEqual(['m2', 'm2'])
  })
})
