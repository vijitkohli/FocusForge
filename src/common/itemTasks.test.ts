import { describe, expect, it } from 'vitest'
import type { ItemDigest } from './digest'
import type { ProjectTask } from './types'
import { deliverableKey, tasksFromDigest, withDismissed } from './itemTasks'

const TODAY = '2026-11-11'
const item = { id: 'c', name: 'DATA9001', kind: 'deadline' as const }
let n = 0
const newId = (): string => `t${++n}`

function due(over: Partial<ItemDigest['dueDates'][number]>): ItemDigest['dueDates'][number] {
  return {
    what: 'Assignment 3',
    date: '2026-11-25',
    confidence: 'confirmed',
    weight: 15,
    kind: 'assignment',
    sources: [{ label: 'c/spec.md' }],
    ...over
  }
}

function existing(over: Partial<ProjectTask>): ProjectTask {
  return {
    id: 'e1',
    title: 'Assignment 3',
    createdAt: '',
    deadline: '2026-11-25',
    status: 'unplanned',
    depth: 'Brief',
    model: '',
    subtasks: [],
    ...over
  }
}

describe('tasksFromDigest', () => {
  it('due-dated deliverable becomes unplanned task', () => {
    const { add } = tasksFromDigest({ dueDates: [due({})] }, item, [], [], TODAY, newId)
    expect(add).toHaveLength(1)
    expect(add[0]).toMatchObject({
      title: 'Assignment 3',
      status: 'unplanned',
      deadline: '2026-11-25',
      deadlineKind: 'hard',
      scope: 'deliverable',
      origin: { kind: 'deliverable', key: deliverableKey('Assignment 3'), source: 'c/spec.md' }
    })
    expect(add[0].assessment).toMatchObject({ weight: 15, kind: 'assignment' })
  })

  it('tentative deliverable gets tentative deadline', () => {
    const { add } = tasksFromDigest(
      {
        dueDates: [
          due({
            what: 'Thesis A presentation',
            date: null,
            when: 'Week 11 (TBC)',
            confidence: 'tentative',
            kind: 'presentation',
            weight: null
          })
        ]
      },
      item,
      [],
      [],
      TODAY,
      newId
    )
    expect(add[0]).toMatchObject({ deadline: '2026-11-25', deadlineKind: 'tentative' })
    expect(add[0].assessment?.when).toBe('Week 11 (TBC)')
  })

  it('creates no gap tasks (Phase 3 owns Loose ends)', () => {
    const { add } = tasksFromDigest(
      { dueDates: [due({ what: 'Reply to Priya', kind: 'other' })] },
      item,
      [],
      [],
      TODAY,
      newId
    )
    expect(add).toEqual([])
  })

  it('dismissed origins never return', () => {
    const { add } = tasksFromDigest(
      { dueDates: [due({})] },
      item,
      [],
      [deliverableKey('Assignment 3')],
      TODAY,
      newId
    )
    expect(add).toEqual([])
    const dismissed = withDismissed(
      [],
      existing({ origin: { kind: 'deliverable', key: 'k', source: 's' } })
    )
    expect(dismissed).toEqual(['k'])
  })

  it('existing outline task not duplicated', () => {
    const { add, update } = tasksFromDigest(
      { dueDates: [due({ what: 'assignment 3!' })] },
      item,
      [existing({})],
      [],
      TODAY,
      newId
    )
    expect(add).toEqual([])
    expect(update).toEqual([])
  })

  it('changed due date yields update patch', () => {
    const prior = existing({
      deadline: '2026-11-20',
      deadlineKind: 'tentative',
      origin: { kind: 'deliverable', key: deliverableKey('Assignment 3'), source: 'x' }
    })
    const { add, update } = tasksFromDigest(
      { dueDates: [due({})] },
      item,
      [prior],
      [],
      TODAY,
      newId
    )
    expect(add).toEqual([])
    expect(update).toEqual([
      { taskId: 'e1', patch: { deadline: '2026-11-25', deadlineKind: 'hard' } }
    ])
  })

  it('passion item without deliverables gets one goal task', () => {
    const passion = { id: 'w', name: 'Personal website', kind: 'passion' as const }
    const { add } = tasksFromDigest({ dueDates: [] }, passion, [], [], TODAY, newId)
    expect(add).toHaveLength(1)
    expect(add[0]).toMatchObject({
      title: 'Personal website: next steps',
      scope: 'goal',
      deadlineKind: 'none',
      deadline: '2026-12-09',
      origin: { kind: 'goal' }
    })
    const again = tasksFromDigest({ dueDates: [] }, passion, add, [], TODAY, newId)
    expect(again.add).toEqual([])
    expect(tasksFromDigest({ dueDates: [] }, item, [], [], TODAY, newId).add).toEqual([])
  })
})
