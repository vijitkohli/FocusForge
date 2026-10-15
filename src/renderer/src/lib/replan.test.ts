import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LedgerNote, ProjectData, ProjectTask, UpcomingSubtask } from '../../../common/types'

const task = (id: string): ProjectTask => ({
  id,
  title: id,
  createdAt: '',
  deadline: '2026-10-20',
  status: 'active',
  depth: 'brief',
  model: 'test',
  subtasks: [
    { id: `${id}-late`, title: 'Late', isCompleted: false, scheduledDate: '2026-10-14' },
    { id: `${id}-done`, title: 'Done', isCompleted: true, scheduledDate: '2026-10-13' },
    { id: `${id}-future`, title: 'Future', isCompleted: false, scheduledDate: '2026-10-19' }
  ]
})
const upcoming = (
  projectId: string,
  taskId: string,
  subtaskId: string,
  scheduledDate?: string
): UpcomingSubtask => ({
  projectId,
  projectName: projectId,
  taskId,
  taskTitle: taskId,
  subtaskId,
  subtaskTitle: subtaskId,
  difficulty: 'medium',
  deadline: '2026-10-20',
  daysRemaining: -1,
  scheduledDate
})

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 15, 9))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('replanAllOverdue', () => {
  it('groups by project/task, reschedules each task once, records actual totals and refreshes the queue', async () => {
    const files: Record<string, ProjectData> = {
      p: { tasks: [task('a'), task('b')] },
      other: { tasks: [task('a')] }
    }
    // The loaded task has an additional overdue step not present in the flattened snapshot.
    files.p.tasks[0].subtasks.push({
      id: 'extra',
      title: 'Extra',
      isCompleted: false,
      scheduledDate: '2026-10-12'
    })
    const items = [
      upcoming('p', 'a', 'a-late', '2026-10-14'),
      upcoming('p', 'a', 'extra', '2026-10-12'),
      upcoming('p', 'b', 'b-late', '2026-10-14'),
      upcoming('other', 'a', 'a-late', '2026-10-14'),
      upcoming('p', 'future', 'x', '2026-10-19'),
      upcoming('p', 'unscheduled', 'x')
    ]
    const notes: LedgerNote[] = []
    const loadProjectData = vi.fn(async (id: string) => structuredClone(files[id]))
    const saveProjectData = vi.fn(async (id: string, data: ProjectData, ledger: LedgerNote[]) => {
      files[id] = structuredClone(data)
      notes.push(...structuredClone(ledger))
      return { success: true }
    })
    const getUpcomingSubtasks = vi.fn().mockResolvedValueOnce(items).mockResolvedValueOnce([])
    vi.stubGlobal('window', { api: { loadProjectData, saveProjectData, getUpcomingSubtasks } })
    const { replanAllOverdue } = await import('./replan')
    expect(await replanAllOverdue()).toBe(4)
    expect(loadProjectData).toHaveBeenCalledTimes(3)
    expect(saveProjectData).toHaveBeenCalledTimes(3)
    expect(getUpcomingSubtasks).toHaveBeenCalledTimes(2)
    expect(notes).toEqual(
      [2, 1, 1].map((count) => ({
        section: 'Plan Adjustments',
        note: `Re-planned ${count} overdue steps forward from today.`
      }))
    )
    for (const file of Object.values(files)) {
      for (const saved of file.tasks) {
        expect(saved.subtasks[0].scheduledDate! >= '2026-10-15').toBe(true)
        expect(saved.subtasks[1].scheduledDate).toBe('2026-10-13')
        expect(saved.subtasks[2].scheduledDate).toBe('2026-10-19')
      }
    }
    const { queueStore } = await import('./queue')
    expect(queueStore.getSnapshot()).toMatchObject({ loaded: true, current: null })
  })

  it('returns zero with no overdue scheduled steps', async () => {
    const saveProjectData = vi.fn()
    vi.stubGlobal('window', {
      api: { getUpcomingSubtasks: vi.fn().mockResolvedValue([]), saveProjectData }
    })
    const { replanAllOverdue } = await import('./replan')
    expect(await replanAllOverdue()).toBe(0)
    expect(saveProjectData).not.toHaveBeenCalled()
  })

  it('propagates load failures without reporting successful moves', async () => {
    vi.stubGlobal('window', {
      api: {
        getUpcomingSubtasks: vi
          .fn()
          .mockResolvedValue([upcoming('p', 'a', 'a-late', '2026-10-14')]),
        loadProjectData: vi.fn().mockRejectedValue(new Error('read failed'))
      }
    })
    const { replanAllOverdue } = await import('./replan')
    await expect(replanAllOverdue()).rejects.toThrow('read failed')
  })
})
