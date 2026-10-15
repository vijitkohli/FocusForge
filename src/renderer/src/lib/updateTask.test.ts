import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LedgerNote, ProjectData, ProjectTask } from '../../../common/types'
import { updateTask } from './updateTask'

const note: LedgerNote = { section: 'Plan Adjustments', note: 'Renamed the task.' }
const task = (id: string): ProjectTask => ({
  id,
  title: 'Original title',
  createdAt: '2026-10-01T00:00:00',
  deadline: '2026-10-20',
  status: 'active',
  depth: 'brief',
  model: 'test',
  subtasks: [{ id: 'step', title: 'Keep this step', isCompleted: false }]
})

function setup(data: ProjectData | null): {
  load: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
} {
  const load = vi.fn().mockResolvedValue(data)
  const save = vi.fn().mockResolvedValue({ success: true })
  vi.stubGlobal('window', { api: { loadProjectData: load, saveProjectData: save } })
  return { load, save }
}

afterEach(() => vi.unstubAllGlobals())

describe('updateTask', () => {
  it('updates only the matching task and preserves project metadata and the ledger note', async () => {
    const target = task('target')
    const other = task('other')
    const file: ProjectData = {
      name: 'Project',
      created: '2026-10-01',
      lastModel: 'saved-model',
      tasks: [other, target]
    }
    const { load, save } = setup(file)
    const updater = vi.fn((current: ProjectTask) => ({ ...current, title: 'New title' }))
    await updateTask('project', 'target', updater, note)
    expect(load).toHaveBeenCalledExactlyOnceWith('project')
    expect(updater).toHaveBeenCalledExactlyOnceWith(target)
    expect(file.tasks[0]).toBe(other)
    expect(save).toHaveBeenCalledExactlyOnceWith(
      'project',
      { ...file, tasks: [other, { ...target, title: 'New title' }] },
      [note],
      0
    )
  })

  it('rejects a null load before calling the updater or saving any data or notes', async () => {
    const { save } = setup(null)
    const updater = vi.fn((current: ProjectTask) => current)
    await expect(updateTask('project', 'target', updater, note)).rejects.toThrow(
      'project could not be loaded'
    )
    expect(updater).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it.each([{ tasks: [] }, { tasks: [task('other')] }, {} as ProjectData])(
    'rejects a missing task without saving or recording the note: %j',
    async (file) => {
      const { save } = setup(file)
      const before = structuredClone(file)
      const updater = vi.fn((current: ProjectTask) => current)
      await expect(updateTask('project', 'target', updater, note)).rejects.toThrow(
        'no longer exists'
      )
      expect(updater).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
      expect(file).toEqual(before)
    }
  )

  it.each([
    [{ success: false, error: 'Permission denied' }, 'Permission denied'],
    [{ success: false }, 'The task change was not saved to disk. Try again.'],
    [{ success: false, error: '' }, 'The task change was not saved to disk. Try again.']
  ])('rejects a failed save result %j', async (result, message) => {
    const { save } = setup({ tasks: [task('target')] })
    save.mockResolvedValue(result)
    await expect(updateTask('project', 'target', (current) => current, note)).rejects.toThrow(
      message as string
    )
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('propagates a load rejection without invoking the updater or save', async () => {
    const { load, save } = setup(null)
    const failure = new Error('Read failed')
    load.mockRejectedValue(failure)
    const updater = vi.fn((current: ProjectTask) => current)
    await expect(updateTask('project', 'target', updater, note)).rejects.toBe(failure)
    expect(updater).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('propagates an updater rejection without saving or recording the note', async () => {
    const file = { tasks: [task('target')] }
    const { save } = setup(file)
    const before = structuredClone(file)
    const failure = new Error('Step no longer exists')
    await expect(
      updateTask(
        'project',
        'target',
        () => {
          throw failure
        },
        note
      )
    ).rejects.toBe(failure)
    expect(save).not.toHaveBeenCalled()
    expect(file).toEqual(before)
  })

  it('re-applies the change to the fresh file when a concurrent save wins', async () => {
    const stale: ProjectData = { rev: 4, tasks: [task('target')] }
    const fresh: ProjectData = {
      rev: 5,
      tasks: [{ ...task('target'), subtasks: [{ id: 'step', title: 'Ticked', isCompleted: true }] }]
    }
    const { load, save } = setup(stale)
    load.mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh)
    save
      .mockResolvedValueOnce({ success: false, conflict: true })
      .mockResolvedValueOnce({ success: true, rev: 6 })
    await updateTask('project', 'target', (current) => ({ ...current, title: 'Renamed' }), note)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[0][3]).toBe(4)
    expect(save.mock.calls[1][3]).toBe(5)
    expect(save.mock.calls[1][1].tasks[0]).toMatchObject({
      title: 'Renamed',
      subtasks: [{ title: 'Ticked', isCompleted: true }]
    })
  })

  it('gives up after three conflicting saves', async () => {
    const { save } = setup({ rev: 1, tasks: [task('target')] })
    save.mockResolvedValue({ success: false, conflict: true, error: 'This project changed' })
    await expect(updateTask('project', 'target', (current) => current, note)).rejects.toThrow(
      'This project changed'
    )
    expect(save).toHaveBeenCalledTimes(3)
  })

  it('propagates a rejected save', async () => {
    const { save } = setup({ tasks: [task('target')] })
    const failure = new Error('Write failed')
    save.mockRejectedValue(failure)
    await expect(updateTask('project', 'target', (current) => current, note)).rejects.toBe(failure)
  })
})
