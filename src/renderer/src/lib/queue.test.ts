import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpcomingSubtask } from '../../../common/types'

const step = (
  subtaskId: string,
  difficulty: UpcomingSubtask['difficulty'] = 'medium',
  projectId = 'p'
): UpcomingSubtask => ({
  projectId,
  projectName: projectId,
  taskId: 'task',
  taskTitle: 'Task',
  subtaskId,
  subtaskTitle: subtaskId,
  difficulty,
  deadline: '2026-10-20',
  daysRemaining: 1
})

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
})
afterEach(async () => {
  const { focusTimer } = await import('./focusTimer')
  focusTimer.setStep(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('queue timer reconciliation', () => {
  const setup = async (
    items = [step('a', 'easy'), step('b'), step('c', 'hard')]
  ): Promise<
    typeof import('./queue') & {
      focusTimer: typeof import('./focusTimer').focusTimer
      getUpcomingSubtasks: ReturnType<typeof vi.fn>
      items: UpcomingSubtask[]
    }
  > => {
    const getUpcomingSubtasks = vi.fn().mockResolvedValue(items)
    vi.stubGlobal('window', { api: { getUpcomingSubtasks } })
    const queue = await import('./queue')
    const { focusTimer } = await import('./focusTimer')
    await queue.queueStore.load()
    return { ...queue, focusTimer, getUpcomingSubtasks, items }
  }

  it.each([true, false])(
    'advances selection actions while preserving running=%s',
    async (running) => {
      const { queueStore, queueKey, focusTimer, items } = await setup()
      const expectTimer = (item: UpcomingSubtask): void => {
        expect(focusTimer.getSnapshot()).toMatchObject({
          subtaskId: queueKey(item),
          estimateMinutes: 15,
          elapsed: 0,
          running
        })
      }
      focusTimer.setStep(queueKey(items[0]))
      focusTimer.play()
      vi.advanceTimersByTime(3000)
      if (!running) focusTimer.pause()
      queueStore.skip(items[0])
      expectTimer(items[1])
      queueStore.playNext(items[2])
      expectTimer(items[2])
      queueStore.setMood('normal')
      expectTimer(items[1])
      queueStore.setMood('all')
      expectTimer(items[2])
      queueStore.clearOverride()
      // Clearing skips is an explicit selection action, even if the global first was unchanged.
      queueStore.clearSkips()
      expectTimer(items[0])
    }
  )

  it('leaves a no-session timer idle during loads, refreshes and selection actions', async () => {
    const { queueStore, focusTimer, items } = await setup()
    queueStore.skip(items[0])
    queueStore.playNext(items[2])
    queueStore.setMood('normal')
    queueStore.clearSkips()
    await queueStore.refresh()
    expect(focusTimer.getSnapshot()).toMatchObject({ subtaskId: null, elapsed: 0, running: false })
  })

  it('uses full identities and the next estimate when subtask ids collide', async () => {
    const items = [step('same'), { ...step('same', 'medium', 'other'), timeEstimate: 7 }]
    const { queueStore, queueKey, focusTimer } = await setup(items)
    focusTimer.setStep(queueKey(items[0]))
    focusTimer.play()
    vi.advanceTimersByTime(3000)
    queueStore.skip(items[0])
    expect(focusTimer.getSnapshot()).toMatchObject({
      subtaskId: queueKey(items[1]),
      estimateMinutes: 7,
      elapsed: 0,
      running: true
    })
  })

  it('preserves elapsed time and playback when selection retains the same identity', async () => {
    const { queueStore, queueKey, focusTimer, items } = await setup()
    focusTimer.setStep(queueKey(items[0]))
    focusTimer.play()
    vi.advanceTimersByTime(3000)
    const previous = focusTimer.getSnapshot()
    queueStore.playNext(items[0])
    queueStore.skip(items[2])
    queueStore.setMood('lazy')
    queueStore.clearSkips()
    expect(focusTimer.getSnapshot()).toBe(previous)
  })

  it.each([true, false])(
    'does not clobber a valid scoped timer on refresh, running=%s',
    async (running) => {
      const { queueStore, queueKey, focusTimer, getUpcomingSubtasks, items } = await setup()
      // Scoped Focus can select a non-global-first item, even outside the global mood.
      queueStore.setMood('lazy')
      focusTimer.setStep(queueKey(items[2]))
      focusTimer.play()
      vi.advanceTimersByTime(3000)
      if (!running) focusTimer.pause()
      const previous = focusTimer.getSnapshot()
      let resolve!: (items: UpcomingSubtask[]) => void
      getUpcomingSubtasks.mockReturnValueOnce(
        new Promise<UpcomingSubtask[]>((done) => {
          resolve = done
        })
      )
      const refresh = queueStore.refresh()
      expect(queueStore.getSnapshot().loading).toBe(true)
      expect(focusTimer.getSnapshot()).toBe(previous)
      resolve([...items].reverse())
      await refresh
      expect(focusTimer.getSnapshot()).toBe(previous)
      getUpcomingSubtasks.mockRejectedValueOnce(new Error('offline'))
      await expect(queueStore.refresh()).rejects.toThrow('offline')
      expect(focusTimer.getSnapshot()).toBe(previous)
    }
  )

  it.each([true, false])(
    'invalidates a completed/deleted scoped identity on refresh, running=%s',
    async (running) => {
      const { queueStore, queueKey, focusTimer, getUpcomingSubtasks, items } = await setup()
      focusTimer.setStep(queueKey(items[2]))
      if (running) focusTimer.play()
      vi.advanceTimersByTime(3000)
      getUpcomingSubtasks.mockResolvedValueOnce(items.slice(0, 2))
      await queueStore.refresh()
      expect(focusTimer.getSnapshot()).toMatchObject({
        subtaskId: queueKey(items[0]),
        elapsed: 0,
        running
      })
      getUpcomingSubtasks.mockResolvedValueOnce([])
      await queueStore.refresh()
      expect(focusTimer.getSnapshot()).toMatchObject({
        subtaskId: null,
        elapsed: 0,
        running: false
      })
      getUpcomingSubtasks.mockResolvedValueOnce(items)
      await queueStore.refresh()
      expect(focusTimer.getSnapshot().subtaskId).toBeNull()
    }
  )

  it('stops an active session when selection leaves no current item', async () => {
    const { queueStore, queueKey, focusTimer, items } = await setup([step('a')])
    focusTimer.setStep(queueKey(items[0]))
    focusTimer.play()
    queueStore.skip(items[0])
    expect(focusTimer.getSnapshot()).toMatchObject({ subtaskId: null, elapsed: 0, running: false })
    queueStore.clearSkips()
    expect(focusTimer.getSnapshot().subtaskId).toBeNull()
  })

  it('does not invalidate a timer using stale refresh results', async () => {
    const { queueStore, queueKey, focusTimer, getUpcomingSubtasks, items } = await setup()
    focusTimer.setStep(queueKey(items[2]))
    focusTimer.play()
    let resolve!: (items: UpcomingSubtask[]) => void
    getUpcomingSubtasks.mockReturnValueOnce(
      new Promise<UpcomingSubtask[]>((done) => {
        resolve = done
      })
    )
    const older = queueStore.refresh()
    await queueStore.refresh()
    resolve([])
    await older
    expect(focusTimer.getSnapshot()).toMatchObject({ subtaskId: queueKey(items[2]), running: true })
  })
})

describe('shared queue', () => {
  it('loads once, preserves source ordering, exposes stable snapshots and shared subscriptions', async () => {
    const getUpcomingSubtasks = vi.fn().mockResolvedValue([step('a'), step('b')])
    vi.stubGlobal('window', { api: { getUpcomingSubtasks } })
    const { queueStore } = await import('./queue')
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribe = queueStore.subscribe(first)
    queueStore.subscribe(second)
    await Promise.all([queueStore.load(), queueStore.load()])
    await queueStore.load()
    expect(getUpcomingSubtasks).toHaveBeenCalledTimes(1)
    expect(queueStore.getSnapshot()).toBe(queueStore.getSnapshot())
    expect(queueStore.getSnapshot().items.map((item) => item.subtaskId)).toEqual(['a', 'b'])
    expect(first).toHaveBeenCalled()
    expect(second).toHaveBeenCalled()
    unsubscribe()
    first.mockClear()
    queueStore.skip(step('a'))
    expect(first).not.toHaveBeenCalled()
    expect(queueStore.getSnapshot().current?.subtaskId).toBe('b')
  })

  it('shares moods, skips and front overrides without conflating duplicate subtask ids', async () => {
    const items = [step('same', 'easy'), step('same', 'hard', 'other'), step('last', 'medium')]
    vi.stubGlobal('window', { api: { getUpcomingSubtasks: vi.fn().mockResolvedValue(items) } })
    const { queueStore, queueKey, selectQueue } = await import('./queue')
    await queueStore.load()
    expect(queueKey(items[0])).not.toBe(queueKey(items[1]))
    queueStore.skip(items[0])
    expect(queueStore.getSnapshot().items).toEqual(items.slice(1))
    queueStore.setMood('motivated')
    expect(queueStore.getSnapshot().items).toEqual([items[1]])
    queueStore.setMood('normal')
    expect(queueStore.getSnapshot().items).toEqual([items[2]])
    queueStore.setMood('lazy')
    expect(queueStore.getSnapshot().current).toBeNull()
    queueStore.playNext(items[0])
    expect(queueStore.getSnapshot().current).toEqual(items[0])
    queueStore.setMood('all')
    queueStore.playNext(items[2])
    expect(queueStore.getSnapshot().items).toEqual([items[2], items[0], items[1]])
    expect(selectQueue(queueStore.getSnapshot(), { projectId: 'other', taskId: 'task' })).toEqual([
      items[1]
    ])
    expect(
      selectQueue(queueStore.getSnapshot(), { projectId: 'other', taskId: 'missing' })
    ).toEqual([])
    queueStore.clearOverride()
    queueStore.skip(items[0])
    queueStore.clearSkips()
    expect(queueStore.getSnapshot().items).toEqual(items)
  })

  it('refreshes data while preserving session choices and pruning completed identities', async () => {
    const items = [step('a'), step('b'), step('c')]
    const getUpcomingSubtasks = vi
      .fn()
      .mockResolvedValueOnce(items)
      .mockResolvedValueOnce(items.slice(1))
    vi.stubGlobal('window', { api: { getUpcomingSubtasks } })
    const { queueStore } = await import('./queue')
    await queueStore.load()
    queueStore.skip(items[0])
    queueStore.skip(items[1])
    queueStore.playNext(items[2])
    await queueStore.refresh()
    expect(queueStore.getSnapshot().skipped).toHaveLength(1)
    expect(queueStore.getSnapshot().current).toEqual(items[2])
    expect(queueStore.getSnapshot().frontOverride).not.toBeNull()
  })

  it('keeps newer refresh results when requests finish out of order', async () => {
    let resolveOld!: (items: UpcomingSubtask[]) => void
    const old = new Promise<UpcomingSubtask[]>((resolve) => {
      resolveOld = resolve
    })
    const getUpcomingSubtasks = vi
      .fn()
      .mockReturnValueOnce(old)
      .mockResolvedValueOnce([step('new')])
    vi.stubGlobal('window', { api: { getUpcomingSubtasks } })
    const { queueStore } = await import('./queue')
    const older = queueStore.refresh()
    await queueStore.refresh()
    resolveOld([step('old')])
    await older
    expect(queueStore.getSnapshot().current?.subtaskId).toBe('new')
  })

  it('exposes load errors, retains existing data and can retry', async () => {
    const getUpcomingSubtasks = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([step('a')])
      .mockRejectedValueOnce(new Error('again'))
    vi.stubGlobal('window', { api: { getUpcomingSubtasks } })
    const { queueStore } = await import('./queue')
    await expect(queueStore.load()).rejects.toThrow('offline')
    expect(queueStore.getSnapshot()).toMatchObject({
      loading: false,
      loaded: false,
      error: 'offline'
    })
    await queueStore.load()
    await expect(queueStore.refresh()).rejects.toThrow('again')
    expect(queueStore.getSnapshot().current?.subtaskId).toBe('a')
    expect(queueStore.getSnapshot().error).toBe('again')
  })
})
