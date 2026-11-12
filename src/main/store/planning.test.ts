import path from 'path'
import fs from 'fs-extra'
import { beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'

vi.mock('electron', async () => {
  const nodeFs = await import('fs')
  const nodeOs = await import('os')
  const nodePath = await import('path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'flowstate-plan-test-'))
  return { app: { getPath: () => dir } }
})

import { app } from 'electron'
import type { ProjectData, ProjectTask } from '../../common/types'
import { FileSystemManager } from '../fs-manager'
import { projectProgress } from './ProjectStore'

const ROOT = path.join(app.getPath('documents'), 'FlowState')

function seed(tasks: ProjectTask[], extra: Record<string, unknown> = {}): void {
  fs.outputJSONSync(path.join(ROOT, 'system', 'master_index.json'), [
    {
      id: 'p',
      name: 'DATA9001',
      path: path.join(ROOT, 'p'),
      progress: 0,
      lastActive: '',
      status: 'active',
      kind: 'deadline',
      category: 'Learning',
      sourceActivityAt: '2026-11-09T00:00:00.000Z',
      ...extra
    }
  ])
  fs.outputJSONSync(path.join(ROOT, 'p', 'project_data.json'), { name: 'DATA9001', tasks })
}

const planned: ProjectTask = {
  id: 't1',
  title: 'Assignment 3',
  createdAt: '2026-11-01T00:00:00.000Z',
  deadline: '2099-11-25',
  status: 'in-progress',
  depth: 'Deep',
  model: '',
  milestones: [
    { id: 'm1', title: 'Clean the data', estimateMinutes: 100, doneWhen: 'x', status: 'active' },
    { id: 'm2', title: 'Model', estimateMinutes: 300, doneWhen: 'y', status: 'todo' }
  ],
  subtasks: [
    {
      id: 'a',
      title: 'Open spec',
      isCompleted: true,
      status: 'done',
      timeEstimate: 50,
      milestoneId: 'm1',
      completedAt: '2026-11-10T00:00:00.000Z'
    },
    {
      id: 'b',
      title: 'Parse dates',
      isCompleted: false,
      status: 'todo',
      timeEstimate: 15,
      milestoneId: 'm1'
    },
    {
      id: 's',
      title: 'Staged model step',
      isCompleted: false,
      status: 'todo',
      timeEstimate: 15,
      milestoneId: 'm2'
    }
  ]
}

const unplanned: ProjectTask = {
  id: 't2',
  title: 'Final exam',
  createdAt: '',
  deadline: '2099-12-08',
  status: 'unplanned',
  depth: 'Deep',
  model: '',
  subtasks: [],
  deadlineKind: 'tentative',
  origin: { kind: 'deliverable', key: 'deliverable:final exam', source: 'c/CONTEXT.md' },
  assessment: { weight: 40, kind: 'exam', notes: '', when: 'Week 13', source: 'c' }
}

let fsm: FileSystemManager

beforeEach(() => {
  fs.removeSync(ROOT)
  fsm = new FileSystemManager()
})

describe('planning in the stores', () => {
  it('getUpcomingSubtasks hides steps of todo milestones', async () => {
    seed([planned])
    const up = await fsm.getUpcomingSubtasks()
    expect(up.map((u) => u.subtaskId)).toEqual(['b'])
    expect(up[0]).toMatchObject({
      milestoneTitle: 'Clean the data',
      milestoneIndex: 1,
      milestoneCount: 2
    })
  })

  it('getNextSteps returns needsPlan for unplanned task', async () => {
    seed([planned, unplanned])
    const steps = await fsm.getNextSteps()
    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatchObject({
      taskId: 't1',
      subtaskId: 'b',
      needsPlan: false,
      milestoneTitle: 'Clean the data',
      itemName: 'DATA9001',
      itemKind: 'deadline',
      category: 'Learning',
      deadlineKind: 'hard',
      lastTouchedAt: '2026-11-10T00:00:00.000Z'
    })
    expect(steps[1]).toMatchObject({
      taskId: 't2',
      subtaskId: null,
      title: null,
      needsPlan: true,
      deadlineKind: 'tentative',
      origin: 'deliverable',
      dueWhen: 'Week 13',
      lastTouchedAt: '2026-11-09T00:00:00.000Z'
    })
  })

  it('getNextSteps skips paused items', async () => {
    seed([planned], { status: 'paused' })
    expect(await fsm.getNextSteps()).toEqual([])
  })

  it('updateProjectProgress uses minutes for milestone tasks', async () => {
    seed([planned])
    const data = (await fsm.loadProjectData('p')) as ProjectData
    await fsm.saveProjectData('p', data)
    // 50 of 400 minutes done (the staged step doesn't count yet)
    expect(fsm.getProjects()[0].progress).toBe(13)
    expect(projectProgress([{ ...planned, milestones: undefined }])).toBe(33)
  })

  it('onSaved listeners get every save with its tag', async () => {
    seed([planned])
    const seen: [string, number | undefined, string | undefined][] = []
    const off = fsm.onSaved((id, data, tag) => seen.push([id, data.rev, tag.by]))
    const data = (await fsm.loadProjectData('p')) as ProjectData
    await fsm.saveProjectData('p', data, undefined, undefined, { by: 'vault' })
    await fsm.updateProjectData('p', async (d) => ({ data: d }))
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual([
      ['p', 1, 'vault'],
      ['p', 2, undefined]
    ])
    off()
    await fsm.updateProjectData('p', async (d) => ({ data: d }))
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toHaveLength(2)
  })
})
