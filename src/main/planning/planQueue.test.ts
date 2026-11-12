import { describe, expect, it, vi } from 'vitest'
import type { Milestone, ProjectData, ProjectTask, Subtask } from '../../common/types'
import type { PlanStatusEvent, PlanTaskResult } from '../../common/milestones'
import { PlanJob, PlanQueue, PlanQueueDeps, advanceTask, jobKey } from './planQueue'

function ms(id: string, status: Milestone['status'], expanded?: Milestone['expanded']): Milestone {
  return {
    id,
    title: id,
    estimateMinutes: 120,
    doneWhen: 'x',
    status,
    ...(expanded ? { expanded } : {})
  }
}
function step(id: string, mid: string, done = false): Subtask {
  return {
    id,
    title: id,
    isCompleted: done,
    status: done ? 'done' : 'todo',
    milestoneId: mid,
    timeEstimate: 10
  }
}
function task(id: string, milestones: Milestone[], subtasks: Subtask[]): ProjectTask {
  return {
    id,
    title: id,
    createdAt: '',
    deadline: '2026-12-01',
    status: 'in-progress',
    depth: 'Deep',
    model: '',
    milestones,
    subtasks
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

interface Setup {
  q: PlanQueue
  deps: PlanQueueDeps
  events: PlanStatusEvent[]
  store: { data: ProjectData }
  setUp: (v: boolean) => void
}

function setup(data: ProjectData, over: Partial<PlanQueueDeps> = {}): Setup {
  let up = true
  const listeners: ((u: boolean) => void)[] = []
  const events: PlanStatusEvent[] = []
  const store = { data }
  const deps: PlanQueueDeps = {
    health: {
      isUp: () => up,
      onChange: (cb) => {
        listeners.push(cb)
        return () => listeners.splice(listeners.indexOf(cb), 1)
      }
    },
    loadProjectData: vi.fn(async () => store.data),
    isActive: () => true,
    run: vi.fn(
      async (): Promise<PlanTaskResult> => ({ success: true, status: 'expanded', message: '' })
    ),
    advance: vi.fn(async () => {}),
    notify: (e) => events.push(e),
    tasksChanged: vi.fn(),
    setTimer: () => 1,
    clearTimer: () => {},
    ...over
  }
  const q = new PlanQueue(deps)
  return {
    q,
    deps,
    events,
    store,
    setUp: (v: boolean) => {
      up = v
      listeners.forEach((l) => l(v))
    }
  }
}

const expandJob: PlanJob = {
  projectId: 'p',
  taskId: 't',
  kind: 'expand',
  milestoneId: 'm2',
  stepCount: 1
}

describe('PlanQueue', () => {
  it('dedupes identical jobs', async () => {
    const data = {
      tasks: [task('t', [ms('m1', 'done'), ms('m2', 'active')], [step('a', 'm1', true)])]
    }
    const { q, deps } = setup(data)
    expect(q.enqueue(expandJob)).toBe(true)
    expect(q.enqueue({ ...expandJob })).toBe(false)
    await flush()
    expect(deps.run).toHaveBeenCalledTimes(1)
    expect(jobKey(expandJob)).toBe('p:t:expand:m2:1')
  })

  it('runs one at a time', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let concurrent = 0
    let max = 0
    const data = {
      tasks: [
        task('t', [ms('m1', 'done'), ms('m2', 'active')], [step('a', 'm1', true)]),
        task('u', [ms('m1', 'done'), ms('m2', 'active')], [step('b', 'm1', true)])
      ]
    }
    const { q } = setup(data, {
      run: async () => {
        concurrent++
        max = Math.max(max, concurrent)
        await gate
        concurrent--
        return { success: true, status: 'expanded', message: '' }
      }
    })
    q.enqueue(expandJob)
    q.enqueue({ ...expandJob, taskId: 'u' })
    await flush()
    expect(q.status()).toMatchObject({ state: 'running', queued: 1 })
    release()
    await flush()
    await flush()
    expect(max).toBe(1)
    expect(q.status().state).toBe('idle')
  })

  it('re-checks action on fresh data before running', async () => {
    // By the time it runs, m2 already has open steps: nothing to do.
    const data = {
      tasks: [
        task('t', [ms('m1', 'done'), ms('m2', 'active')], [step('a', 'm1', true), step('b', 'm2')])
      ]
    }
    const { q, deps } = setup(data)
    q.enqueue(expandJob)
    await flush()
    expect(deps.run).not.toHaveBeenCalled()
  })

  it('advance applied without engine call', async () => {
    const data = {
      tasks: [task('t', [ms('m1', 'active', 'full'), ms('m2', 'todo')], [step('a', 'm1', true)])]
    }
    const { q, deps } = setup(data)
    await q.onProjectSaved('p', data)
    expect(deps.advance).toHaveBeenCalledWith('p', 't', 'm1')
    expect(deps.run).not.toHaveBeenCalled()
    const next = advanceTask(data.tasks[0], 'm1')
    expect(next?.milestones?.map((m) => m.status)).toEqual(['done', 'active'])
    expect(advanceTask(data.tasks[0], 'm2')).toBeNull()
  })

  it('pauses when proxy health fails and resumes', async () => {
    const data = {
      tasks: [task('t', [ms('m1', 'done'), ms('m2', 'active')], [step('a', 'm1', true)])]
    }
    const ctx = setup(data)
    ctx.setUp(false)
    ctx.q.enqueue(expandJob)
    await flush()
    expect(ctx.q.status()).toMatchObject({ state: 'paused', queued: 1 })
    expect(ctx.deps.run).not.toHaveBeenCalled()
    expect(ctx.events.some((e) => e.state === 'failed')).toBe(false)
    ctx.setUp(true)
    await flush()
    expect(ctx.deps.run).toHaveBeenCalledTimes(1)
  })

  it('sends tasks-changed after save', async () => {
    const data = {
      tasks: [task('t', [ms('m1', 'done'), ms('m2', 'active')], [step('a', 'm1', true)])]
    }
    const { q, deps, events } = setup(data)
    await q.onProjectSaved('p', data)
    await flush()
    expect(deps.run).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'expand', milestoneId: 'm2' })
    )
    expect(deps.tasksChanged).toHaveBeenCalled()
    expect(events.map((e) => e.state)).toEqual(['queued', 'running', 'done'])
  })

  it('auto-plans only auto-created unplanned tasks, once per task state', async () => {
    const auto: ProjectTask = {
      ...task('a', [], []),
      milestones: undefined,
      status: 'unplanned',
      origin: { kind: 'goal', key: 'goal', source: 'item' }
    }
    const manual: ProjectTask = { ...task('m', [], []), milestones: undefined, status: 'unplanned' }
    const data = { tasks: [auto, manual] }
    const { q, deps } = setup(data, {
      run: vi.fn(async () => ({ success: false, status: 'clarifying' as const, message: '?' }))
    })
    await q.onProjectSaved('p', data)
    await flush()
    await q.onProjectSaved('p', data)
    await flush()
    expect(deps.run).toHaveBeenCalledTimes(1)
    expect(deps.run).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'a', kind: 'plan' }))
  })
})
