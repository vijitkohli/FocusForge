import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectData, UpcomingSubtask } from '../../../common/types'

const { flushSync } = vi.hoisted(() => ({ flushSync: vi.fn((callback: () => void) => callback()) }))
vi.mock('react-dom', () => ({ flushSync }))

function transitionTitles(withQueue = true): {
  hero: { style: { viewTransitionName: string } }
  queued: { style: { viewTransitionName: string } } | null
  querySelector: ReturnType<typeof vi.fn>
} {
  const hero = { style: { viewTransitionName: 'now-title' } }
  const queued = withQueue ? { style: { viewTransitionName: 'queue-0' } } : null
  const querySelector = vi.fn((selector: string) => {
    const name = selector.includes('queue-0') ? 'queue-0' : 'now-title'
    return [hero, queued].find((title) => title?.style.viewTransitionName === name) ?? null
  })
  return { hero, queued, querySelector }
}

const item: UpcomingSubtask = {
  projectId: 'p',
  projectName: 'Project',
  taskId: 't',
  taskTitle: 'Task',
  subtaskId: 's',
  subtaskTitle: 'Finish step',
  difficulty: 'easy',
  deadline: '2026-10-20',
  daysRemaining: 1
}

function setup(): {
  file: ProjectData
  saveProjectData: ReturnType<typeof vi.fn>
  getUpcomingSubtasks: ReturnType<typeof vi.fn>
} {
  const file: ProjectData = {
    tasks: [
      {
        id: 't',
        title: 'Task',
        createdAt: '',
        deadline: item.deadline,
        status: 'active',
        depth: 'brief',
        model: 'test',
        subtasks: [
          { id: 's', title: item.subtaskTitle, isCompleted: false, status: 'doing' },
          { id: 'other', title: 'Keep', isCompleted: false }
        ]
      }
    ]
  }
  const saveProjectData = vi.fn().mockResolvedValue({ success: true })
  const getUpcomingSubtasks = vi.fn().mockResolvedValue([])
  vi.stubGlobal('window', {
    api: {
      loadProjectData: vi.fn().mockResolvedValue(file),
      saveProjectData,
      getUpcomingSubtasks
    }
  })
  return { file, saveProjectData, getUpcomingSubtasks }
}

beforeEach(() => {
  vi.resetModules()
  flushSync.mockReset().mockImplementation((callback: () => void) => callback())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('completeSubtask', () => {
  it('uses canonical completion, writes the milestone note, then refreshes and calls the parent', async () => {
    const { saveProjectData, getUpcomingSubtasks } = setup()
    vi.stubGlobal('document', {})
    const { completeSubtask } = await import('./completion')
    const onCompleted = vi.fn(() => {
      expect(getUpcomingSubtasks).toHaveBeenCalledTimes(1)
    })
    await completeSubtask(item, { onCompleted })
    const saved = saveProjectData.mock.calls[0][1] as ProjectData
    expect(saved.tasks[0].subtasks[0]).toMatchObject({
      status: 'done',
      isCompleted: true,
      completedAt: expect.any(String)
    })
    expect(saved.tasks[0].subtasks[1]).toEqual({ id: 'other', title: 'Keep', isCompleted: false })
    expect(saveProjectData).toHaveBeenCalledWith(
      'p',
      saved,
      [{ section: 'Milestones & Completed Work', note: 'Completed "Finish step" from Start Now.' }],
      0
    )
    expect(onCompleted).toHaveBeenCalledTimes(1)
    const { queueStore } = await import('./queue')
    expect(queueStore.getSnapshot().current).toBeNull()
  })

  it('updates queue and parent inside a feature-detected View Transition', async () => {
    setup()
    let insideTransition = false
    const startViewTransition = vi.fn((callback: () => Promise<void>) => {
      insideTransition = true
      const updateCallbackDone = callback().finally(() => {
        insideTransition = false
      })
      return { updateCallbackDone, ready: Promise.reject(new Error('animation skipped')) }
    })
    vi.stubGlobal('document', { startViewTransition })
    const { completeSubtask } = await import('./completion')
    const onCompleted = vi.fn(() => {
      expect(insideTransition).toBe(true)
    })
    await completeSubtask(item, { onCompleted })
    expect(startViewTransition).toHaveBeenCalledTimes(1)
    expect(onCompleted).toHaveBeenCalledTimes(1)
  })

  it('pairs the old first queue title with the new hero and flushes before the new capture', async () => {
    setup()
    const { hero, queued, querySelector } = transitionTitles()
    const newFirst = { style: { viewTransitionName: '' } }
    let heroText = item.subtaskTitle
    let commit: (() => void) | undefined
    let flushing = false
    flushSync.mockImplementation((callback) => {
      flushing = true
      callback()
      commit?.()
      flushing = false
    })
    const startViewTransition = vi.fn((callback: () => Promise<void>) => {
      expect(hero.style.viewTransitionName).toBe('completed-title')
      expect(queued?.style.viewTransitionName).toBe('now-title')
      const updateCallbackDone = callback().then(() => {
        expect(heroText).toBe('Next step')
        expect(flushSync).toHaveBeenCalledTimes(2)
        expect(hero.style.viewTransitionName).toBe('now-title')
        expect(newFirst.style.viewTransitionName).toBe('queue-0')
        expect(queued?.style.viewTransitionName).toBe('queue-0')
        expect(
          new Set([hero.style.viewTransitionName, newFirst.style.viewTransitionName]).size
        ).toBe(2)
      })
      return { updateCallbackDone, ready: Promise.resolve() }
    })
    vi.stubGlobal('document', { querySelector, startViewTransition })
    const { completeSubtask } = await import('./completion')
    await completeSubtask(item, {
      onCompleted: () => {
        expect(flushing).toBe(true)
        commit = () => {
          heroText = 'Next step'
          newFirst.style.viewTransitionName = 'queue-0'
        }
      }
    })
    expect(startViewTransition).toHaveBeenCalledTimes(1)
  })

  it('leaves React-assigned names intact when the old queue row survives as an unnamed row', async () => {
    setup()
    const { hero, queued, querySelector } = transitionTitles()
    const newHero = { style: { viewTransitionName: 'now-title' } }
    const startViewTransition = vi.fn((callback: () => Promise<void>) => {
      expect(queued?.style.viewTransitionName).toBe(newHero.style.viewTransitionName)
      const updateCallbackDone = callback().then(() => {
        expect(newHero.style.viewTransitionName).toBe('now-title')
        expect(queued?.style.viewTransitionName).toBe('')
        expect(hero.style.viewTransitionName).toBe('now-title')
      })
      return { updateCallbackDone, ready: Promise.resolve() }
    })
    vi.stubGlobal('document', { querySelector, startViewTransition })
    const { completeSubtask } = await import('./completion')
    await completeSubtask(item, {
      onCompleted: () => {
        if (queued) queued.style.viewTransitionName = ''
      }
    })
  })

  it('captures only the completed title in Focus mode without a queue row', async () => {
    setup()
    const { hero, querySelector } = transitionTitles(false)
    const startViewTransition = vi.fn((callback: () => Promise<void>) => {
      expect(hero.style.viewTransitionName).toBe('completed-title')
      const updateCallbackDone = callback().then(() => {
        expect(hero.style.viewTransitionName).toBe('now-title')
      })
      return { updateCallbackDone, ready: Promise.resolve() }
    })
    vi.stubGlobal('document', { querySelector, startViewTransition })
    const { completeSubtask } = await import('./completion')
    await completeSubtask(item)
    expect(flushSync).toHaveBeenCalledTimes(2)
  })

  it('restores names and advances once when starting the transition throws', async () => {
    const { getUpcomingSubtasks } = setup()
    const { hero, queued, querySelector } = transitionTitles()
    const startViewTransition = vi.fn(() => {
      expect(hero.style.viewTransitionName).toBe('completed-title')
      expect(queued?.style.viewTransitionName).toBe('now-title')
      throw new Error('API unavailable')
    })
    vi.stubGlobal('document', { querySelector, startViewTransition })
    const { completeSubtask } = await import('./completion')
    const onCompleted = vi.fn(() => {
      expect(hero.style.viewTransitionName).toBe('now-title')
      expect(queued?.style.viewTransitionName).toBe('queue-0')
    })
    await completeSubtask(item, { onCompleted })
    expect(getUpcomingSubtasks).toHaveBeenCalledTimes(1)
    expect(onCompleted).toHaveBeenCalledTimes(1)
  })

  it.each(['refresh', 'parent'])(
    'restores names and propagates a %s failure in the update',
    async (failure) => {
      const { getUpcomingSubtasks } = setup()
      const { hero, queued, querySelector } = transitionTitles()
      const error = new Error(`${failure} failed`)
      if (failure === 'refresh') getUpcomingSubtasks.mockRejectedValue(error)
      const onCompleted = vi.fn(async () => {
        throw error
      })
      const startViewTransition = vi.fn((callback: () => Promise<void>) => ({
        updateCallbackDone: callback(),
        ready: Promise.reject(new Error('animation skipped')),
        finished: Promise.reject(new Error('animation skipped'))
      }))
      vi.stubGlobal('document', { querySelector, startViewTransition })
      const { completeSubtask } = await import('./completion')
      await expect(completeSubtask(item, { onCompleted })).rejects.toThrow(error)
      expect(hero.style.viewTransitionName).toBe('now-title')
      expect(queued?.style.viewTransitionName).toBe('queue-0')
      expect(onCompleted).toHaveBeenCalledTimes(failure === 'parent' ? 1 : 0)
    }
  )

  it('skips transitions and name changes when reduced motion is requested', async () => {
    setup()
    const { hero, queued, querySelector } = transitionTitles()
    const startViewTransition = vi.fn()
    Object.assign(window, { matchMedia: vi.fn().mockReturnValue({ matches: true }) })
    vi.stubGlobal('document', { querySelector, startViewTransition })
    const { completeSubtask } = await import('./completion')
    const onCompleted = vi.fn()
    await completeSubtask(item, { onCompleted })
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
    expect(startViewTransition).not.toHaveBeenCalled()
    expect(querySelector).not.toHaveBeenCalled()
    expect(hero.style.viewTransitionName).toBe('now-title')
    expect(queued?.style.viewTransitionName).toBe('queue-0')
    expect(onCompleted).toHaveBeenCalledTimes(1)
  })

  it('does not refresh or advance the parent when persistence rejects', async () => {
    const { saveProjectData, getUpcomingSubtasks } = setup()
    saveProjectData.mockRejectedValue(new Error('write failed'))
    const { completeSubtask } = await import('./completion')
    const onCompleted = vi.fn()
    await expect(completeSubtask(item, { onCompleted })).rejects.toThrow('write failed')
    expect(getUpcomingSubtasks).not.toHaveBeenCalled()
    expect(onCompleted).not.toHaveBeenCalled()
  })

  it('does not advance, refresh, or start a transition when the save reports failure', async () => {
    const { saveProjectData, getUpcomingSubtasks } = setup()
    saveProjectData.mockResolvedValue({ success: false, error: 'Disk full' })
    const startViewTransition = vi.fn()
    vi.stubGlobal('document', { startViewTransition })
    const { completeSubtask } = await import('./completion')
    const onCompleted = vi.fn()
    await expect(completeSubtask(item, { onCompleted })).rejects.toThrow('Disk full')
    expect(getUpcomingSubtasks).not.toHaveBeenCalled()
    expect(startViewTransition).not.toHaveBeenCalled()
    expect(onCompleted).not.toHaveBeenCalled()
  })

  it('rejects a stale completion step before saving a milestone or advancing', async () => {
    const { file, saveProjectData, getUpcomingSubtasks } = setup()
    file.tasks[0].subtasks = file.tasks[0].subtasks.filter((step) => step.id !== item.subtaskId)
    const before = structuredClone(file)
    const startViewTransition = vi.fn()
    vi.stubGlobal('document', { startViewTransition })
    const { completeSubtask } = await import('./completion')
    const onCompleted = vi.fn()
    await expect(completeSubtask(item, { onCompleted })).rejects.toThrow('step no longer exists')
    expect(file).toEqual(before)
    expect(saveProjectData).not.toHaveBeenCalled()
    expect(getUpcomingSubtasks).not.toHaveBeenCalled()
    expect(startViewTransition).not.toHaveBeenCalled()
    expect(onCompleted).not.toHaveBeenCalled()
  })

  it('propagates a queue refresh failure without calling the parent', async () => {
    const { getUpcomingSubtasks } = setup()
    getUpcomingSubtasks.mockRejectedValue(new Error('refresh failed'))
    vi.stubGlobal('document', {})
    const { completeSubtask } = await import('./completion')
    const onCompleted = vi.fn()
    await expect(completeSubtask(item, { onCompleted })).rejects.toThrow('refresh failed')
    expect(onCompleted).not.toHaveBeenCalled()
  })
})
