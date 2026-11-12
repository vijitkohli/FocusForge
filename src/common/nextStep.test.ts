import { describe, expect, it } from 'vitest'
import { currentMilestoneOf, nextStepFor, nextStepForTask, type NextStepTask } from './nextStep'

const t = (id: string, over: Partial<NextStepTask> = {}): NextStepTask => ({
  id,
  createdAt: '2026-11-01T00:00:00.000Z',
  deadline: '2026-11-20',
  subtasks: [{ id: '1', isCompleted: false }],
  ...over
})

describe('nextStep', () => {
  it('picks the task with the earliest deadline, ties by createdAt', () => {
    const tasks = [
      t('late', { deadline: '2026-12-01' }),
      t('b', { deadline: '2026-11-15', createdAt: '2026-11-03T00:00:00.000Z' }),
      t('a', { deadline: '2026-11-15', createdAt: '2026-11-02T00:00:00.000Z' })
    ]
    expect(nextStepFor(tasks)?.task.id).toBe('a')
  })

  it('compares deadlines as local dates (ISO deadlines too)', () => {
    // 2026-11-14T14:00Z is 15 Nov in Sydney (the test zone), after a plain 14 Nov
    const tasks = [
      t('iso', { deadline: '2026-11-14T14:00:00.000Z' }),
      t('plain', { deadline: '2026-11-14' })
    ]
    expect(nextStepFor(tasks)?.task.id).toBe('plain')
  })

  it('skips finished and unplanned tasks; undated and deadlineKind none come last', () => {
    const tasks = [
      t('finished', { deadline: '2026-11-12', subtasks: [{ id: '1', isCompleted: true }] }),
      t('unplanned', { deadline: '2026-11-12', subtasks: [] }),
      t('loose', {
        deadlineKind: 'none',
        deadline: '2026-11-13',
        createdAt: '2026-10-01T00:00:00.000Z'
      }),
      t('tentative', { deadlineKind: 'tentative', deadline: '2026-11-25' })
    ]
    expect(nextStepFor(tasks)?.task.id).toBe('tentative')
    expect(nextStepFor([tasks[2]])?.task.id).toBe('loose')
    expect(nextStepFor([tasks[0], tasks[1]])).toBeNull()
    expect(nextStepFor([])).toBeNull()
  })

  it("uses the current milestone's first incomplete step; staged steps stay hidden", () => {
    const task = t('x', {
      milestones: [
        { id: 'm1', status: 'done' },
        { id: 'm2', status: 'active' },
        { id: 'm3', status: 'todo' }
      ],
      subtasks: [
        { id: 'staged', isCompleted: false, milestoneId: 'm3' },
        { id: 'a', isCompleted: true, milestoneId: 'm2' },
        { id: 'b', isCompleted: false, milestoneId: 'm2' }
      ]
    })
    const next = nextStepForTask(task)
    expect(next?.step.id).toBe('b')
    expect(next?.milestone?.id).toBe('m2')
    expect(currentMilestoneOf(task)?.id).toBe('m2')
  })

  it('falls back to unassigned steps when the current milestone has none yet', () => {
    const task = t('x', {
      milestones: [
        { id: 'm1', status: 'active' },
        { id: 'm2', status: 'todo' }
      ],
      subtasks: [
        { id: 'staged', isCompleted: false, milestoneId: 'm2' },
        { id: 'orphan', isCompleted: false, milestoneId: 'gone' }
      ]
    })
    expect(nextStepForTask(task)).toMatchObject({ step: { id: 'orphan' }, milestone: null })
    expect(nextStepForTask({ ...task, subtasks: [task.subtasks[0]] })).toBeNull()
    expect(currentMilestoneOf({ milestones: [{ id: 'm', status: 'done' }] })).toBeNull()
    expect(currentMilestoneOf({})).toBeNull()
  })
})
