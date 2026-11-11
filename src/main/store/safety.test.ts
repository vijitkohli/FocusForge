import path from 'path'
import fs from 'fs-extra'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const nodeFs = await import('fs')
  const nodeOs = await import('os')
  const nodePath = await import('path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'flowstate-safety-'))
  return { app: { getPath: () => dir } }
})

import { app } from 'electron'
import { writeFileAtomic, writeJsonAtomic } from './atomic'
import { withLock } from './locks'
import { Backups } from './Backups'
import { FileSystemManager } from '../fs-manager'
import { BACKUP_DIR, ROOT_DIR } from './paths'
import type { SaveResult, Subtask } from '../../common/types'

const ROOT = path.join(app.getPath('documents'), 'FlowState')

beforeEach(() => {
  expect(ROOT_DIR).toBe(ROOT)
  expect(ROOT.includes('flowstate-safety-')).toBe(true)
  fs.removeSync(ROOT)
})

describe('writeFileAtomic', () => {
  it('replaces the file and leaves no temp files behind', async () => {
    const target = path.join(ROOT, 'a', 'file.json')
    await writeJsonAtomic(target, { v: 1 })
    await writeJsonAtomic(target, { v: 2 })
    expect(fs.readJSONSync(target)).toEqual({ v: 2 })
    expect(fs.readdirSync(path.dirname(target))).toEqual(['file.json'])
  })

  it('keeps the original intact when the write fails', async () => {
    const target = path.join(ROOT, 'b', 'file.txt')
    await writeFileAtomic(target, 'original')
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full') as never)
    await expect(writeFileAtomic(target, 'new')).rejects.toThrow('disk full')
    rename.mockRestore()
    expect(fs.readFileSync(target, 'utf-8')).toBe('original')
    expect(fs.readdirSync(path.dirname(target))).toEqual(['file.txt'])
  })
})

describe('withLock', () => {
  it('serialises callers with the same key and keeps going after a failure', async () => {
    const order: string[] = []
    const slow =
      (name: string, ms: number, fail = false) =>
      async () => {
        order.push(`start ${name}`)
        await new Promise((resolve) => setTimeout(resolve, ms))
        order.push(`end ${name}`)
        if (fail) throw new Error(name)
        return name
      }
    const a = withLock('k', slow('a', 20, true))
    const b = withLock('k', slow('b', 1))
    const other = withLock('other', slow('c', 1))
    await expect(a).rejects.toThrow('a')
    await expect(b).resolves.toBe('b')
    await other
    expect(order.indexOf('end a')).toBeLessThan(order.indexOf('start b'))
    expect(order.indexOf('start c')).toBeLessThan(order.indexOf('end a'))
  })
})

describe('project saves', () => {
  it('bumps rev and refuses a save whose expectedRev is stale', async () => {
    const fsm = new FileSystemManager()
    const project = await fsm.createProject('Rev test')
    const first = await fsm.saveProjectData(project.id, { tasks: [] }, undefined, 0)
    expect(first).toMatchObject({ success: true, rev: 1 })
    const stale = await fsm.saveProjectData(project.id, { tasks: [] }, undefined, 0)
    expect(stale).toMatchObject({ success: false, conflict: true })
    const fresh = await fsm.saveProjectData(project.id, { tasks: [] }, undefined, 1)
    expect(fresh).toMatchObject({ success: true, rev: 2 })
    expect((await fsm.loadProjectData(project.id))?.rev).toBe(2)
  })

  it('treats a file without rev as rev 0 and still accepts saves without expectedRev', async () => {
    const fsm = new FileSystemManager()
    const project = await fsm.createProject('Legacy')
    fs.writeJSONSync(path.join(ROOT, project.id, 'project_data.json'), { tasks: [] })
    expect(await fsm.saveProjectData(project.id, { tasks: [] }, undefined, 0)).toMatchObject({
      success: true
    })
    expect(await fsm.saveProjectData(project.id, { tasks: [] })).toMatchObject({ success: true })
  })

  it('does not lose either of two overlapping updates or registry entries', async () => {
    const fsm = new FileSystemManager()
    const a = await fsm.createProject('A')
    const b = await fsm.createProject('B')
    const step = (id: string): Subtask => ({ id, title: id, isCompleted: false })
    const task = {
      id: 't',
      title: 't',
      createdAt: '',
      deadline: '2026-11-01',
      status: '',
      depth: 'Brief',
      model: '',
      subtasks: [step('one'), step('two')]
    }
    await fsm.saveProjectData(a.id, { tasks: [task] })
    const tick = (stepId: string): Promise<SaveResult | null> =>
      fsm.updateProjectData(a.id, async (data) => ({
        data: {
          ...data,
          tasks: data.tasks.map((t) => ({
            ...t,
            subtasks: t.subtasks.map((s) => (s.id === stepId ? { ...s, isCompleted: true } : s))
          }))
        }
      }))
    await Promise.all([tick('one'), tick('two'), fsm.saveProjectData(b.id, { tasks: [] })])
    const saved = await fsm.loadProjectData(a.id)
    expect(saved?.tasks[0].subtasks.every((s) => s.isCompleted)).toBe(true)
    expect(
      fsm
        .getProjects()
        .map((p) => p.id)
        .sort()
    ).toEqual([a.id, b.id].sort())
  })
})

describe('Backups', () => {
  it('copies the pre-save state once per day', async () => {
    const fsm = new FileSystemManager()
    const project = await fsm.createProject('Backed up')
    await fsm.saveProjectData(project.id, { name: 'first', tasks: [] })
    await fsm.saveProjectData(project.id, { name: 'second', tasks: [] })
    const day = fs.readdirSync(BACKUP_DIR)
    expect(day).toHaveLength(1)
    const copy = fs.readJSONSync(path.join(BACKUP_DIR, day[0], project.id, 'project_data.json'))
    expect(copy.name).toBe('Backed up')
    expect(fs.existsSync(path.join(BACKUP_DIR, day[0], 'system', 'master_index.json'))).toBe(true)
  })

  it('prunes day folders older than 14 days', async () => {
    for (const name of ['2026-10-01', '2026-10-02', '2026-10-15', 'notes']) {
      fs.ensureDirSync(path.join(BACKUP_DIR, name))
    }
    await new Backups().prune(new Date(2026, 9, 15, 9))
    expect(fs.readdirSync(BACKUP_DIR).sort()).toEqual(['2026-10-02', '2026-10-15', 'notes'])
  })
})
