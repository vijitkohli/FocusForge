import { describe, expect, it } from 'vitest'
import type { Milestone, ProjectTask, Subtask } from './types'
import {
  appendExpansion,
  applyAdvance,
  currentMilestone,
  milestoneMinutes,
  nextPlanAction,
  nextStepForTask,
  planToTask,
  redistributeMilestones,
  setMilestoneDone,
  slippedMilestones,
  taskProgress,
  visibleSteps
} from './milestones'

function ms(
  id: string,
  status: Milestone['status'],
  est = 120,
  extra: Partial<Milestone> = {}
): Milestone {
  return { id, title: `Part ${id}`, estimateMinutes: est, doneWhen: `${id} done`, status, ...extra }
}

function step(
  id: string,
  milestoneId: string | undefined,
  done = false,
  extra: Partial<Subtask> = {}
): Subtask {
  return {
    id,
    title: `Step ${id}`,
    isCompleted: done,
    status: done ? 'done' : 'todo',
    timeEstimate: 15,
    ...(done ? { completedAt: '2026-11-10T01:00:00.000Z' } : {}),
    ...(milestoneId ? { milestoneId } : {}),
    ...extra
  }
}

function task(milestones: Milestone[] | undefined, subtasks: Subtask[]): ProjectTask {
  return {
    id: 't1',
    title: 'Assignment',
    createdAt: '2026-11-01T00:00:00.000Z',
    deadline: '2026-11-25',
    status: 'in-progress',
    depth: 'Deep',
    model: '',
    subtasks,
    ...(milestones ? { milestones } : {})
  }
}

let n = 0
const newId = (): string => `id-${++n}`

describe('milestones', () => {
  it('currentMilestone returns first non-done', () => {
    const t = task([ms('m1', 'done'), ms('m2', 'active'), ms('m3', 'todo')], [])
    expect(currentMilestone(t)?.id).toBe('m2')
  })

  it('nextPlanAction: prefetch when one step left', () => {
    const t = task(
      [ms('m1', 'active', 120, { expanded: 'full' }), ms('m2', 'todo')],
      [step('a', 'm1', true), step('b', 'm1')]
    )
    expect(nextPlanAction(t)).toEqual({ kind: 'prefetch', milestoneId: 'm2' })
  })

  it('nextPlanAction: advance when batch done and full', () => {
    const t = task(
      [ms('m1', 'active', 120, { expanded: 'full' }), ms('m2', 'todo')],
      [step('a', 'm1', true)]
    )
    expect(nextPlanAction(t)).toEqual({ kind: 'advance', from: 'm1', to: 'm2' })
  })

  it('nextPlanAction: continue when batch done and partial', () => {
    const t = task(
      [ms('m1', 'active', 600, { expanded: 'partial' }), ms('m2', 'todo')],
      [step('a', 'm1', true)]
    )
    expect(nextPlanAction(t)).toEqual({ kind: 'continue', milestoneId: 'm1' })
  })

  it('nextPlanAction: expand when active has no steps', () => {
    const t = task([ms('m1', 'done'), ms('m2', 'active')], [step('a', 'm1', true)])
    expect(nextPlanAction(t)).toEqual({ kind: 'expand', milestoneId: 'm2' })
  })

  it('nextPlanAction: none for tasks without milestones', () => {
    expect(nextPlanAction(task(undefined, [step('a', undefined)]))).toEqual({ kind: 'none' })
  })

  it('applyAdvance stamps completedAt and actualMinutes and activates next', () => {
    const t = task(
      [ms('m1', 'active'), ms('m2', 'todo')],
      [step('a', 'm1', true, { focusSeconds: 600 }), step('b', 'm1', true, { focusSeconds: 300 })]
    )
    const now = new Date('2026-11-12T03:00:00.000Z')
    const out = applyAdvance(t, now)
    expect(out.milestones?.[0]).toMatchObject({
      status: 'done',
      completedAt: now.toISOString(),
      actualMinutes: 15
    })
    expect(out.milestones?.[1].status).toBe('active')
  })

  it('setMilestoneDone false reopens and returns to continue', () => {
    const done = applyAdvance(task([ms('m1', 'active'), ms('m2', 'todo')], [step('a', 'm1', true)]))
    const reopened = setMilestoneDone(done, 'm1', false)
    expect(reopened.milestones?.map((m) => m.status)).toEqual(['active', 'todo'])
    expect(reopened.milestones?.[0].completedAt).toBeUndefined()
    expect(nextPlanAction(reopened)).toEqual({ kind: 'continue', milestoneId: 'm1' })
    const closed = setMilestoneDone(reopened, 'm1', true)
    expect(closed.milestones?.map((m) => m.status)).toEqual(['done', 'active'])
  })

  it('appendExpansion tags steps with milestoneId and avoids id collisions', () => {
    let k = 0
    const ids = ['a', 'a', 'x1']
    const t = task([ms('m1', 'done'), ms('m2', 'active')], [step('a', 'm1', true)])
    const out = appendExpansion(
      t,
      'm2',
      [{ title: 'Write Q2 plot' }, { title: '' }],
      true,
      () => ids[k++],
      200
    )
    const added = out.subtasks.slice(1)
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({
      id: 'x1',
      milestoneId: 'm2',
      isCompleted: false,
      status: 'todo'
    })
    expect(out.milestones?.[1]).toMatchObject({ expanded: 'full', estimateMinutes: 200 })
  })

  it('planToTask sets first milestone active and keeps origin/assessment', () => {
    const base = task(undefined, [])
    base.status = 'unplanned'
    base.origin = { kind: 'deliverable', key: 'deliverable:a3', source: 'c/spec.md' }
    base.assessment = { weight: 15, kind: 'assignment', notes: '', when: '', source: 'x' }
    const out = planToTask(
      base,
      {
        originalTask: 'ignored',
        milestones: [
          { id: 'm1', title: 'Clean', estimateMinutes: 180, doneWhen: 'clean', status: 'todo' },
          { id: 'm2', title: 'Model', estimateMinutes: 300, doneWhen: 'model', status: 'todo' }
        ],
        currentMilestoneId: 'm1',
        coversRest: false,
        subtasks: [
          {
            id: '1',
            title: 'Open the spec',
            isCompleted: false,
            timeEstimate: 3,
            milestoneId: 'm1'
          }
        ],
        assumptions: ['Q4 uses the same data']
      },
      newId
    )
    expect(out.id).toBe('t1')
    expect(out.status).toBe('in-progress')
    expect(out.origin?.key).toBe('deliverable:a3')
    expect(out.assessment?.weight).toBe(15)
    expect(out.milestones?.map((m) => m.status)).toEqual(['active', 'todo'])
    expect(out.milestones?.[0].expanded).toBe('partial')
    expect(out.subtasks[0].milestoneId).toBe('m1')
    expect(out.planAssumptions).toEqual(['Q4 uses the same data'])
  })

  it('milestoneMinutes counts done milestones fully and active by done steps', () => {
    const t = task(
      [ms('m1', 'done', 100), ms('m2', 'active', 200), ms('m3', 'todo', 300)],
      [step('a', 'm2', true), step('b', 'm2', true), step('c', 'm2')]
    )
    expect(milestoneMinutes(t)).toEqual({ total: 600, done: 130, remaining: 470 })
    expect(taskProgress(t)).toBe(22)
  })

  it('taskProgress falls back to step ratio without milestones', () => {
    expect(taskProgress(task(undefined, [step('a', undefined, true), step('b', undefined)]))).toBe(
      50
    )
    expect(taskProgress(task(undefined, []))).toBe(0)
  })

  it('slippedMilestones uses local dates', () => {
    const t = task(
      [
        ms('m1', 'done', 60, { targetDate: '2026-11-01' }),
        ms('m2', 'active', 60, { targetDate: '2026-11-10' }),
        ms('m3', 'todo', 60, { targetDate: '2026-11-11' })
      ],
      []
    )
    expect(slippedMilestones(t, '2026-11-11').map((m) => m.id)).toEqual(['m2'])
  })

  it('redistributeMilestones proportional to estimates within deadline', () => {
    const out = redistributeMilestones(
      [
        ms('m1', 'done', 100, { targetDate: '2026-11-01' }),
        ms('m2', 'active', 100),
        ms('m3', 'todo', 300)
      ],
      '2026-11-21',
      '2026-11-11'
    )
    expect(out[0].targetDate).toBe('2026-11-01')
    expect(out[1].targetDate).toBe('2026-11-13') // 9 usable days * 1/4 ≈ 2
    expect(out[2].targetDate).toBe('2026-11-20') // a day of buffer
  })

  it('nextStepForTask skips staged todo-milestone steps', () => {
    const t = task(
      [ms('m1', 'active'), ms('m2', 'todo')],
      [step('s', 'm2'), step('a', 'm1', true), step('b', 'm1')]
    )
    expect(nextStepForTask(t)?.id).toBe('b')
    const groups = visibleSteps(t)
    expect(groups.current.map((s) => s.id)).toEqual(['a', 'b'])
    expect(groups.earlier).toEqual([])
  })

  it('visibleSteps groups current, earlier, unassigned', () => {
    const t = task(
      [ms('m1', 'done'), ms('m2', 'active')],
      [step('a', 'm1', true), step('b', 'm2'), step('c', undefined), step('d', 'gone')]
    )
    const g = visibleSteps(t)
    expect(g.current.map((s) => s.id)).toEqual(['b'])
    expect(g.earlier.map((s) => s.id)).toEqual(['a'])
    expect(g.unassigned.map((s) => s.id)).toEqual(['c', 'd'])
    expect(visibleSteps(task(undefined, [step('x', undefined)])).current).toHaveLength(1)
  })
})
