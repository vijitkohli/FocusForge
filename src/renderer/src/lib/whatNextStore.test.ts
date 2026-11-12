import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ItemNextStep } from '../../../common/nextSteps'
import type { UpcomingSubtask } from '../../../common/types'
import { localDateKey } from '../../../common/schedule'

const mem = new Map<string, string>()

function day(offset: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return localDateKey(d)
}

function up(projectId: string, subtaskId: string, title: string): UpcomingSubtask {
  return {
    projectId,
    projectName: projectId === 'a' ? 'Alpha' : 'Beta',
    taskId: `t-${projectId}`,
    taskTitle: 'Task',
    subtaskId,
    subtaskTitle: title,
    difficulty: 'easy',
    timeEstimate: 15,
    deadline: projectId === 'a' ? day(1) : day(9),
    daysRemaining: projectId === 'a' ? 1 : 9
  }
}

function step(projectId: string, subtaskId: string, title: string): ItemNextStep {
  return {
    projectId,
    itemName: projectId === 'a' ? 'Alpha' : 'Beta',
    itemKind: 'deadline',
    category: 'Learning',
    taskId: `t-${projectId}`,
    taskTitle: 'Task',
    subtaskId,
    title,
    minutes: 15,
    difficulty: 'easy',
    deadline: projectId === 'a' ? day(1) : day(9),
    deadlineKind: 'hard',
    needsPlan: false
  }
}

const alpha = up('a', 's-a', 'Open the spec')
const beta = up('b', 's-b', 'Sketch the homepage')

beforeEach(() => {
  vi.resetModules()
  mem.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => mem.set(key, value),
    removeItem: (key: string) => mem.delete(key)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function setup(
  items = [beta, alpha],
  steps: ItemNextStep[] = [
    step('a', 's-a', 'Open the spec'),
    step('b', 's-b', 'Sketch the homepage')
  ]
): Promise<{
  queueStore: typeof import('./queue').queueStore
  whatNextStore: typeof import('./whatNextStore').whatNextStore
  recordSkip: ReturnType<typeof vi.fn>
  updateSkipReason: ReturnType<typeof vi.fn>
  splitStep: ReturnType<typeof vi.fn>
  getUpcomingSubtasks: ReturnType<typeof vi.fn>
  getNextSteps: ReturnType<typeof vi.fn>
}> {
  const getUpcomingSubtasks = vi.fn().mockResolvedValue(items)
  const getNextSteps = vi.fn().mockResolvedValue(steps)
  const recordSkip = vi.fn().mockResolvedValue(true)
  const updateSkipReason = vi.fn().mockResolvedValue(undefined)
  const splitStep = vi.fn()
  vi.stubGlobal('window', {
    api: {
      getUpcomingSubtasks,
      getNextSteps,
      getWhatNextSignals: vi.fn().mockResolvedValue({
        date: day(0),
        dues: [],
        starts: {},
        skipsToday: []
      }),
      recordSkip,
      updateSkipReason,
      markTouched: vi.fn().mockResolvedValue(undefined),
      clearTodaySkips: vi.fn().mockResolvedValue(undefined),
      getProxyHealth: vi.fn().mockResolvedValue({ status: 'up', checkedAt: null }),
      onProxyHealth: vi.fn().mockReturnValue(() => {}),
      onTasksChanged: vi.fn().mockReturnValue(() => {}),
      onDigestUpdated: vi.fn().mockReturnValue(() => {}),
      onPlanStatus: vi.fn().mockReturnValue(() => {}),
      getPlanQueueStatus: vi.fn().mockResolvedValue({ state: 'idle', queued: 0, current: null }),
      splitStep,
      getTodayPlan: vi.fn().mockResolvedValue(null)
    }
  })
  const { queueStore } = await import('./queue')
  const { whatNextStore } = await import('./whatNextStore')
  const stop = whatNextStore.start()
  await queueStore.load()
  await new Promise((resolve) => setTimeout(resolve, 0))
  return {
    queueStore,
    whatNextStore,
    recordSkip,
    updateSkipReason,
    splitStep,
    getUpcomingSubtasks,
    getNextSteps,
    stop
  } as never
}

describe('whatNextStore', () => {
  it('applies the pick as the queue front override', async () => {
    const { queueStore, whatNextStore } = await setup()
    expect(queueStore.getSnapshot().current?.projectId).toBe('a')
    expect(whatNextStore.getSnapshot().userPicked).toBe(false)
    expect(whatNextStore.getSnapshot().reason).toContain('Alpha')
  })

  it('does not override a user Play next', async () => {
    const { queueStore, whatNextStore } = await setup()
    queueStore.playNext(beta)
    expect(queueStore.getSnapshot().current?.projectId).toBe('b')
    expect(whatNextStore.getSnapshot().userPicked).toBe(true)
    expect(whatNextStore.getSnapshot().reason).toBe('You picked this one.')
    await queueStore.refresh()
    expect(queueStore.getSnapshot().current?.projectId).toBe('b')
  })

  it('Not this skips and shows the next candidate synchronously', async () => {
    const { queueStore, whatNextStore, recordSkip } = await setup()
    whatNextStore.notThis()
    expect(queueStore.getSnapshot().current?.projectId).toBe('b')
    expect(whatNextStore.getSnapshot().reasons?.title).toBe('Open the spec')
    expect(recordSkip).toHaveBeenCalledTimes(1)
    const event = recordSkip.mock.calls[0][0] as { reason: string; title?: string }
    expect(event.reason).toBe('none')
    expect(event.title).toBeUndefined()
  })

  it('a reason after Not this updates the logged event', async () => {
    const { whatNextStore, updateSkipReason } = await setup()
    whatNextStore.notThis()
    const at = whatNextStore.getSnapshot().reasons?.at
    await whatNextStore.setReason('not-now')
    expect(updateSkipReason).toHaveBeenCalledWith(at, 'not-now')
    expect(whatNextStore.getSnapshot().notice).toBe('Got it.')
    expect(whatNextStore.getSnapshot().reasons).toBeNull()
  })

  it('Too big splits the skipped step and brings its first part to the front', async () => {
    const { queueStore, whatNextStore, splitStep, getUpcomingSubtasks, getNextSteps } =
      await setup()
    const smaller = {
      ...alpha,
      subtaskId: 's-small',
      subtaskTitle: 'Read the first paragraph',
      timeEstimate: 5
    }
    splitStep.mockResolvedValue({
      success: true,
      message: 'Split',
      created: [{ id: 's-small', title: 'Read the first paragraph', timeEstimate: 5 }]
    })
    getUpcomingSubtasks.mockResolvedValue([smaller, beta])
    getNextSteps.mockResolvedValue([
      step('a', 's-small', 'Read the first paragraph'),
      step('b', 's-b', 'Sketch the homepage')
    ])
    await whatNextStore.tooBig()
    expect(queueStore.getSnapshot().current?.subtaskId).toBe('s-small')
    expect(whatNextStore.getSnapshot().notice).toBe('Split into 1 smaller step.')
  })

  it('split failure restores the step quietly', async () => {
    const { queueStore, whatNextStore, splitStep } = await setup()
    splitStep.mockResolvedValue({ success: false, message: 'no' })
    await whatNextStore.tooBig()
    expect(queueStore.getSnapshot().current?.subtaskId).toBe('s-a')
    expect(whatNextStore.getSnapshot().notice).toBe(
      "Couldn't split that one right now. It's back in your queue."
    )
  })

  it('done advances to the next pick within the completion refresh', async () => {
    const { queueStore, whatNextStore, getUpcomingSubtasks, getNextSteps } = await setup()
    whatNextStore.noteDone(alpha)
    getUpcomingSubtasks.mockResolvedValue([beta])
    getNextSteps.mockResolvedValue([step('b', 's-b', 'Sketch the homepage')])
    await queueStore.refresh()
    expect(queueStore.getSnapshot().current?.projectId).toBe('b')
  })

  it('last-known card is present before load and replaced when that step is gone', async () => {
    mem.set(
      'focusforge.whatnext.last',
      JSON.stringify({
        key: '["gone","t","s"]',
        stepTitle: 'Old step',
        itemName: 'Old',
        taskTitle: 'Old task',
        projectId: 'gone',
        reason: 'Old · due tomorrow',
        minutes: 10,
        difficulty: 'easy'
      })
    )
    vi.resetModules()
    const { whatNextStore } = await setup()
    expect(whatNextStore.getSnapshot().lastKnown?.stepTitle).not.toBe('Old step')
    expect(whatNextStore.getSnapshot().lastKnown?.projectId).toBe('a')
  })

  it('chip persists for the day and resets tomorrow', async () => {
    const { whatNextStore } = await setup()
    whatNextStore.setChip('deadline')
    expect(JSON.parse(mem.get('focusforge.whatnext.chip') || '').chip).toBe('deadline')
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    mem.set(
      'focusforge.whatnext.chip',
      JSON.stringify({ date: localDateKey(yesterday), chip: 'deadline' })
    )
    vi.resetModules()
    vi.stubGlobal('window', {
      api: {
        getUpcomingSubtasks: vi.fn().mockResolvedValue([]),
        getNextSteps: vi.fn().mockResolvedValue([]),
        getWhatNextSignals: vi.fn().mockResolvedValue({
          date: day(0),
          dues: [],
          starts: {},
          skipsToday: []
        }),
        getProxyHealth: vi.fn().mockResolvedValue({ status: 'not-used', checkedAt: null }),
        onProxyHealth: () => () => {},
        onTasksChanged: () => () => {},
        onDigestUpdated: () => () => {},
        onPlanStatus: () => () => {},
        getPlanQueueStatus: vi.fn().mockResolvedValue(null)
      }
    })
    const { whatNextStore: again } = await import('./whatNextStore')
    expect(again.getSnapshot().chip).toBe('anything')
  })

  it('Light sets mood lazy; moving mood off lazy resets the chip to Anything', async () => {
    const { queueStore, whatNextStore } = await setup()
    whatNextStore.setChip('light')
    expect(queueStore.getSnapshot().mood).toBe('lazy')
    expect(whatNextStore.getSnapshot().chip).toBe('light')
    queueStore.setMood('normal')
    expect(whatNextStore.getSnapshot().chip).toBe('anything')
    queueStore.setMood('lazy')
    expect(whatNextStore.getSnapshot().chip).toBe('light')
  })

  it('Bring it back undoes the skip', async () => {
    const { queueStore, whatNextStore, updateSkipReason } = await setup()
    whatNextStore.notThis()
    expect(queueStore.getSnapshot().current?.projectId).toBe('b')
    whatNextStore.bringBack()
    expect(queueStore.getSnapshot().current?.projectId).toBe('a')
    expect(updateSkipReason).toHaveBeenCalledWith(expect.any(String), 'none', true)
  })
})
