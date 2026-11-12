import { describe, expect, it } from 'vitest'
import type { ItemNextStep } from '../../common/nextSteps'
import type { ReaderState } from '../../common/readers'
import { fillMissing, planJobsFor, type FillTarget } from './fillMissing'

function step(
  over: Partial<ItemNextStep> & Pick<ItemNextStep, 'projectId' | 'taskId'>
): ItemNextStep {
  return {
    itemKind: 'deadline',
    category: 'Learning',
    taskTitle: over.taskId,
    subtaskId: null,
    title: null,
    difficulty: 'medium',
    deadlineKind: 'none',
    needsPlan: true,
    ...over
  }
}

const blocked = (state: ReaderState): { state: ReaderState } => ({ state })

describe('planJobsFor', () => {
  it('orders confirmed soonest, then tentative, then goal, then the rest', () => {
    const jobs = planJobsFor(
      [
        step({ projectId: 'focusforge', taskId: 'g', origin: 'goal', deadlineKind: 'none' }),
        step({
          projectId: 'thesis',
          taskId: 'late',
          deadlineKind: 'hard',
          deadline: '2026-11-20'
        }),
        step({ projectId: 'psyc1023', taskId: 'rest', deadlineKind: 'none' }),
        step({
          projectId: 'comp9321',
          taskId: 'soon',
          deadlineKind: 'hard',
          deadline: '2026-11-13'
        }),
        step({
          projectId: 'thesis',
          taskId: 'tent',
          deadlineKind: 'tentative',
          deadline: '2026-11-18'
        }),
        step({
          projectId: 'comp9321',
          taskId: 'done',
          needsPlan: false,
          subtaskId: 's',
          title: 'Go'
        })
      ],
      {},
      []
    )
    expect(jobs.map((j) => j.taskId)).toEqual(['soon', 'late', 'tent', 'g', 'rest'])
  })

  it('skips readers that are blocked and dedupes a task', () => {
    const jobs = planJobsFor(
      [
        step({ projectId: 'a', taskId: '1', deadlineKind: 'hard', deadline: '2026-11-13' }),
        step({ projectId: 'a', taskId: '1', deadlineKind: 'hard', deadline: '2026-11-13' }),
        step({ projectId: 'b', taskId: '2', deadlineKind: 'hard', deadline: '2026-11-13' }),
        step({ projectId: 'c', taskId: '3', deadlineKind: 'hard', deadline: '2026-11-13' }),
        step({ projectId: 'd', taskId: '4', deadlineKind: 'hard', deadline: '2026-11-13' })
      ],
      {
        b: blocked('error'),
        c: blocked('no-sources'),
        d: blocked('waiting-ai')
      }
    )
    expect(jobs).toEqual([{ projectId: 'a', taskId: '1' }])
  })
})

describe('fillMissing', () => {
  it('stops at the remaining daily cap and ignores a refused enqueue', async () => {
    const seen: FillTarget[] = []
    const added = await fillMissing({
      getNextSteps: async () => [
        step({ projectId: 'a', taskId: '1', deadlineKind: 'hard', deadline: '2026-11-13' }),
        step({ projectId: 'b', taskId: '2', deadlineKind: 'hard', deadline: '2026-11-14' }),
        step({ projectId: 'c', taskId: '3', deadlineKind: 'hard', deadline: '2026-11-15' })
      ],
      readerStatus: () => ({}),
      dues: () => [],
      remaining: 2,
      enqueue: (job) => {
        if (job.projectId === 'a') return false
        seen.push(job)
        return true
      }
    })
    expect(added).toBe(2)
    expect(seen.map((j) => j.projectId)).toEqual(['b', 'c'])
  })

  it('enqueues nothing when the cap is already spent', async () => {
    let calls = 0
    const added = await fillMissing({
      getNextSteps: async () => [
        step({ projectId: 'a', taskId: '1', deadlineKind: 'hard', deadline: '2026-11-13' })
      ],
      readerStatus: () => ({}),
      dues: () => [],
      remaining: 0,
      enqueue: () => {
        calls += 1
        return true
      }
    })
    expect(added).toBe(0)
    expect(calls).toBe(0)
  })
})
