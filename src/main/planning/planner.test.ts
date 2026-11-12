import { describe, expect, it, vi } from 'vitest'
import type { ProjectData, ProjectTask, Workstream } from '../../common/types'
import type { ProjectMutation } from '../store/ProjectStore'
import { PlannerDeps, buildPlanPayload, runPlan } from './planner'

function deps(
  data: ProjectData,
  reply: Record<string, unknown>
): {
  d: PlannerDeps
  store: { data: ProjectData; saves: number }
  runEngine: ReturnType<typeof vi.fn>
} {
  const store = { data, saves: 0 }
  const runEngine = vi.fn(async () => reply)
  const d: PlannerDeps = {
    loadProjectData: async () => store.data,
    updateProjectData: async (_id, mutate: (x: ProjectData) => Promise<ProjectMutation>) => {
      const change = await mutate(structuredClone(store.data))
      if (!change) return null
      store.data = change.data
      store.saves++
      return { success: true }
    },
    getProject: () =>
      ({ id: 'p', name: 'DATA9001', kind: 'deadline', category: 'Learning' }) as Workstream,
    packSource: { getContextPack: async () => null },
    readLedger: async () => 'ledger',
    readProfile: async () => 'profile',
    planModel: async () => 'cliproxy/m',
    estimateRatio: async () => 1.4,
    runEngine,
    newId: (() => {
      let n = 0
      return () => `n${++n}`
    })(),
    today: () => '2026-11-11'
  }
  return { d, store, runEngine }
}

const unplanned: ProjectTask = {
  id: 't1',
  title: 'Assignment 3',
  createdAt: '2026-11-01T00:00:00.000Z',
  deadline: '2026-11-25',
  status: 'unplanned',
  depth: 'Deep',
  model: '',
  subtasks: [],
  origin: { kind: 'deliverable', key: 'deliverable:assignment 3', source: 'c/spec.md' },
  assessment: { weight: 15, kind: 'assignment', notes: '', when: '', source: 'c/spec.md' }
}

const planReply = {
  status: 'complete',
  message: "Here's the whole job in 2 parts (~8 h). The first step is ready.",
  data: {
    milestones: [
      { id: 'm1', title: 'Clean', estimateMinutes: 180, doneWhen: 'Q1 table', status: 'active' },
      { id: 'm2', title: 'Model', estimateMinutes: 300, doneWhen: 'Q3 done', status: 'todo' }
    ],
    currentMilestoneId: 'm1',
    coversRest: false,
    subtasks: [
      {
        id: 's1',
        title: 'Open the spec',
        timeEstimate: 3,
        scheduledDate: '2026-11-11',
        milestoneId: 'm1'
      }
    ],
    assumptions: []
  },
  validation: { repaired: false, issues: [] }
}

describe('planning/planner', () => {
  it('plan result merged into existing unplanned task keeps id and origin', async () => {
    const { d, store } = deps({ tasks: [unplanned] }, planReply)
    const r = await runPlan(d, 'p', 't1', 'plan')
    expect(r).toMatchObject({ success: true, status: 'planned' })
    const t = store.data.tasks[0]
    expect(t.id).toBe('t1')
    expect(t.origin?.key).toBe('deliverable:assignment 3')
    expect(t.status).toBe('in-progress')
    expect(t.milestones?.map((m) => m.status)).toEqual(['active', 'todo'])
    expect(t.subtasks[0].milestoneId).toBe('m1')
  })

  it('replan routes AdjustPlan request for milestone tasks', async () => {
    const planned: ProjectTask = {
      ...unplanned,
      status: 'in-progress',
      milestones: [
        { id: 'm1', title: 'Clean', estimateMinutes: 180, doneWhen: 'x', status: 'done' },
        { id: 'm2', title: 'Model', estimateMinutes: 300, doneWhen: 'y', status: 'active' }
      ],
      subtasks: [
        {
          id: 'a',
          title: 'Parse dates',
          isCompleted: true,
          status: 'done',
          milestoneId: 'm1',
          completedAt: '2026-11-10T00:00:00Z'
        }
      ]
    }
    const reply = {
      status: 'updated',
      message: 'Lighter this week.',
      data: {
        milestones: [{ id: 'm2', title: 'Model', estimateMinutes: 300, doneWhen: 'y' }],
        currentMilestoneId: 'm2',
        coversRest: true,
        subtasks: [{ id: 'x1', title: 'Fit the regression', timeEstimate: 15, milestoneId: 'm2' }]
      }
    }
    const { d, store, runEngine } = deps({ tasks: [planned] }, reply)
    const r = await runPlan(d, 'p', 't1', 'replan', { request: 'lighter this week' })
    expect(r.success).toBe(true)
    const payload = (runEngine.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(payload).toMatchObject({ mode: 'replan', request: 'lighter this week' })
    expect((payload.existingPlan as { milestones: unknown[] }).milestones).toHaveLength(2)
    const t = store.data.tasks[0]
    expect(t.milestones?.map((m) => [m.id, m.status])).toEqual([
      ['m1', 'done'],
      ['m2', 'active']
    ])
    expect(t.subtasks.find((s) => s.id === 'a')?.isCompleted).toBe(true)
    expect(t.milestones?.[1].expanded).toBe('full')
  })

  it('clarifying result saves nothing', async () => {
    const { d, store } = deps(
      { tasks: [unplanned] },
      { status: 'clarifying', message: 'What does finished look like?', data: null }
    )
    const r = await runPlan(d, 'p', 't1', 'plan')
    expect(r).toMatchObject({
      success: false,
      status: 'clarifying',
      question: 'What does finished look like?'
    })
    expect(store.saves).toBe(0)
  })

  it('expand skips when the milestone already has open steps', async () => {
    const planned: ProjectTask = {
      ...unplanned,
      status: 'in-progress',
      milestones: [
        { id: 'm1', title: 'Clean', estimateMinutes: 180, doneWhen: 'x', status: 'active' }
      ],
      subtasks: [{ id: 'a', title: 'Open', isCompleted: false, status: 'todo', milestoneId: 'm1' }]
    }
    const { d, store } = deps(
      { tasks: [planned] },
      { status: 'expanded', message: '', data: { subtasks: [{ title: 'More' }], coversRest: true } }
    )
    const r = await runPlan(d, 'p', 't1', 'expand', { milestoneId: 'm1' })
    expect(r.status).toBe('skipped')
    expect(store.saves).toBe(0)
  })

  it('payload carries item, task kind and siblings', async () => {
    const other: ProjectTask = {
      ...unplanned,
      id: 't2',
      title: 'Final exam',
      subtasks: [{ id: 'z', title: 'Revise', isCompleted: false, timeEstimate: 30 }]
    }
    const { d } = deps({ tasks: [unplanned, other] }, planReply)
    const built = await buildPlanPayload(d, 'p', 't1', 'plan')
    expect(built?.payload).toMatchObject({
      today: '2026-11-11',
      item: { name: 'DATA9001', kind: 'deadline' },
      task: {
        title: 'Assignment 3',
        deadline: '2026-11-25',
        deadlineKind: 'hard',
        scope: 'deliverable'
      },
      siblings: [{ title: 'Final exam', remainingMinutes: 30 }],
      contextPack: null,
      estimateRatio: 1.4
    })
  })
})
