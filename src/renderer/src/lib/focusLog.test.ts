import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectData } from '../../../common/types'
import { recordFocusSession } from './focusLog'

function setup(): { save: ReturnType<typeof vi.fn> } {
  const file: ProjectData = {
    rev: 2,
    tasks: [
      {
        id: 't',
        title: 'Task',
        createdAt: '',
        deadline: '2026-10-20',
        status: '',
        depth: 'Brief',
        model: '',
        subtasks: [
          { id: 's', title: 'Step', isCompleted: true, focusSeconds: 60 },
          { id: 'other', title: 'Other', isCompleted: false }
        ]
      }
    ]
  }
  const save = vi.fn().mockResolvedValue({ success: true, rev: 3 })
  vi.stubGlobal('window', {
    api: { loadProjectData: vi.fn().mockResolvedValue(file), saveProjectData: save }
  })
  return { save }
}

afterEach(() => vi.unstubAllGlobals())

describe('recordFocusSession', () => {
  it('adds the session to the step without a ledger note', async () => {
    const { save } = setup()
    await recordFocusSession(JSON.stringify(['p', 't', 's']), 90)
    const [projectId, data, notes, rev] = save.mock.calls[0]
    expect(projectId).toBe('p')
    expect(notes).toBeUndefined()
    expect(rev).toBe(2)
    expect(data.tasks[0].subtasks).toEqual([
      { id: 's', title: 'Step', isCompleted: true, focusSeconds: 150 },
      { id: 'other', title: 'Other', isCompleted: false }
    ])
  })

  it('ignores short sessions and malformed keys', async () => {
    const { save } = setup()
    await recordFocusSession(JSON.stringify(['p', 't', 's']), 29)
    await recordFocusSession('not json', 300)
    await recordFocusSession(JSON.stringify(['p', 't']), 300)
    expect(save).not.toHaveBeenCalled()
  })

  it('swallows a failed write', async () => {
    const { save } = setup()
    save.mockResolvedValue({ success: false, error: 'disk' })
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(recordFocusSession(JSON.stringify(['p', 't', 's']), 90)).resolves.toBeUndefined()
    expect(log).toHaveBeenCalled()
  })
})
