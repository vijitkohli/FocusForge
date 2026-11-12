import path from 'path'
import fs from 'fs-extra'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const nodeFs = await import('fs')
  const nodeOs = await import('os')
  const nodePath = await import('path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'flowstate-items-'))
  return { app: { getPath: () => dir } }
})

import { FileSystemManager } from '../fs-manager'
import { REGISTRY_PATH, ROOT_DIR } from './paths'
import type { ProjectSummary, Subtask } from '../../common/types'

beforeEach(() => {
  expect(ROOT_DIR.includes('flowstate-items-')).toBe(true)
  fs.removeSync(ROOT_DIR)
})

const legacy = (id: string, name = id): ProjectSummary => ({
  id,
  name,
  path: path.join(ROOT_DIR, id),
  progress: 0,
  lastActive: '2026-10-01T00:00:00.000Z'
})

function seedLegacy(entries: ProjectSummary[]): FileSystemManager {
  const fsm = new FileSystemManager()
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(entries, null, 2))
  for (const e of entries) {
    fs.outputJSONSync(path.join(ROOT_DIR, e.id, 'project_data.json'), { name: e.name, tasks: [] })
  }
  return fsm
}

describe('ProjectStore items', () => {
  it('getProjects fills defaults without rewriting the registry', () => {
    const fsm = seedLegacy([legacy('comp9321'), legacy('practice')])
    const before = fs.readFileSync(REGISTRY_PATH)
    const list = fsm.getProjects()
    expect(list.map((p) => [p.id, p.category, p.kind, p.status, p.sources])).toEqual([
      ['comp9321', 'Learning', 'ongoing', 'active', []],
      ['practice', 'Projects', 'ongoing', 'active', []]
    ])
    expect(fs.readFileSync(REGISTRY_PATH).equals(before)).toBe(true)
  })

  it('progress updates preserve workstream fields', async () => {
    const fsm = new FileSystemManager()
    const ws = await fsm.createProject('Thesis', {
      category: 'Learning',
      kind: 'deadline',
      status: 'paused',
      sources: ['/x/thesis']
    })
    const step: Subtask = { id: 's', title: 's', isCompleted: true }
    await fsm.saveProjectData(ws.id, {
      tasks: [
        {
          id: 't',
          title: 't',
          createdAt: '',
          deadline: '2026-12-01',
          status: '',
          depth: 'Brief',
          model: '',
          subtasks: [step]
        }
      ]
    })
    const raw = fs.readJSONSync(REGISTRY_PATH)[0]
    expect(raw).toMatchObject({
      progress: 100,
      category: 'Learning',
      kind: 'deadline',
      status: 'paused',
      sources: ['/x/thesis']
    })
  })

  it('createProject with fields and unique id never overwrites', async () => {
    const fsm = new FileSystemManager()
    const a = await fsm.createProject('Thesis')
    await fsm.saveProjectData(a.id, { name: 'Thesis', tasks: [], created: 'keep-me' })
    const b = await fsm.createProject('Thesis', { category: 'Life', kind: 'passion' })
    const c = await fsm.createProject('thesis')
    expect([a.id, b.id, c.id]).toEqual(['Thesis', 'Thesis_2', 'thesis_3'])
    expect(b).toMatchObject({ name: 'Thesis', category: 'Life', kind: 'passion', status: 'active' })
    expect((await fsm.loadProjectData('Thesis'))?.created).toBe('keep-me')
    // an orphan folder with no registry entry is not reused either
    fs.ensureDirSync(path.join(ROOT_DIR, 'Orphan'))
    expect((await fsm.createProject('Orphan')).id).toBe('Orphan_2')
    // plain createProject stores no item fields (defaults apply on read)
    const raw = fs.readJSONSync(REGISTRY_PATH).find((p: ProjectSummary) => p.id === 'Thesis')
    expect(raw.category).toBeUndefined()
  })

  it('concurrent creates get distinct ids', async () => {
    const fsm = new FileSystemManager()
    const made = await Promise.all([1, 2, 3].map(() => fsm.createProject('Same')))
    expect(made.map((m) => m.id).sort()).toEqual(['Same', 'Same_2', 'Same_3'])
    expect(fsm.getProjects()).toHaveLength(3)
  })

  it('updateWorkstream patches only given keys', async () => {
    const fsm = seedLegacy([legacy('practice'), legacy('other')])
    expect(await fsm.updateWorkstream('practice', { status: 'paused' })).toEqual({ success: true })
    const raw: ProjectSummary[] = fs.readJSONSync(REGISTRY_PATH)
    expect(raw[0]).toEqual({ ...legacy('practice'), status: 'paused' })
    expect(raw[1]).toEqual(legacy('other'))
    expect(await fsm.updateWorkstream('missing', { status: 'paused' })).toEqual({
      success: false,
      error: 'not-found'
    })
    // junk keys are dropped
    await fsm.updateWorkstream('other', { path: '/etc', category: 'Nope' } as never)
    expect(fs.readJSONSync(REGISTRY_PATH)[1]).toEqual(legacy('other'))
  })

  it('rename updates ProjectData.name and bumps rev', async () => {
    const fsm = new FileSystemManager()
    const ws = await fsm.createProject('comp9321')
    const r1 = await fsm.saveProjectData(ws.id, { name: 'comp9321', tasks: [] })
    expect(await fsm.updateWorkstream(ws.id, { name: 'COMP9321' })).toEqual({ success: true })
    const data = await fsm.loadProjectData(ws.id)
    expect(data?.name).toBe('COMP9321')
    expect(data?.rev).toBe((r1.rev ?? 0) + 1)
    expect(fsm.getProjects()[0].name).toBe('COMP9321')
    expect(fsm.getProjects()[0].id).toBe('comp9321')
  })

  it('applyWorkstreams creates and adopts, never deletes', async () => {
    const fsm = seedLegacy([legacy('comp9321'), legacy('practice')])
    const result = await fsm.applyWorkstreams([
      {
        op: 'update',
        id: 'comp9321',
        patch: { status: 'active', kind: 'deadline', sources: ['/u/comp9321'] }
      },
      { op: 'update', id: 'practice', patch: { status: 'paused' } },
      {
        op: 'create',
        fields: {
          name: 'Reading',
          category: 'Life',
          kind: 'passion',
          status: 'active',
          sources: []
        }
      },
      { op: 'update', id: 'gone', patch: { status: 'paused' } }
    ])
    expect(result).toEqual({
      created: ['Reading'],
      updated: ['comp9321', 'practice'],
      failed: ['gone']
    })
    const list = fsm.getProjects()
    expect(list.map((p) => [p.id, p.status])).toEqual([
      ['comp9321', 'active'],
      ['practice', 'paused'],
      ['Reading', 'active']
    ])
    expect(list[0].sources).toEqual(['/u/comp9321'])
    expect(list[2].category).toBe('Life')
  })
})

describe('consumers', () => {
  const step = (id: string): Subtask => ({ id, title: id, isCompleted: false })
  const task = (deadline: string): never =>
    ({
      id: 't',
      title: 't',
      createdAt: '',
      deadline,
      status: '',
      depth: 'Brief',
      model: '',
      subtasks: [step('a')]
    }) as never

  it('upcoming skips archived but keeps paused; nudges only active', async () => {
    const fsm = new FileSystemManager()
    const active = await fsm.createProject('Active', { status: 'active' })
    const paused = await fsm.createProject('Paused', { status: 'paused' })
    const archived = await fsm.createProject('Archived', { status: 'archived' })
    for (const p of [active, paused, archived]) {
      await fsm.saveProjectData(p.id, { tasks: [task('2020-01-01')] })
    }
    const upcoming = await fsm.getUpcomingSubtasks()
    expect(upcoming.map((u) => u.projectId).sort()).toEqual(['Active', 'Paused'])

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 11, 12))
    try {
      const nudge = await fsm.getNudge()
      expect(nudge?.reason).toBe('overdue')
      expect(nudge?.subject).toBe('a')
      // the overdue step in Active was nudged today; Paused's identical step is never picked
      await fsm.updateWorkstream('Active', { status: 'paused' })
      expect(await fsm.getNudge()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('profile overview lists active and paused only', async () => {
    const fsm = new FileSystemManager()
    await fsm.createProject('Shown', { status: 'active' })
    await fsm.createProject('Resting', { status: 'paused' })
    await fsm.createProject('Hidden', { status: 'archived' })
    const prompt = await fsm.readUserProfileForPrompt()
    expect(prompt).toContain('Shown')
    expect(prompt).toContain('Resting')
    expect(prompt).not.toContain('Hidden')
  })

  it('setSourceActivity only moves the date forward', async () => {
    const fsm = new FileSystemManager()
    const ws = await fsm.createProject('Thesis')
    await fsm.setSourceActivity(ws.id, '2026-11-10T00:00:00.000Z')
    await fsm.setSourceActivity(ws.id, '2026-11-01T00:00:00.000Z')
    await fsm.setSourceActivity(ws.id, 'not a date')
    await fsm.setSourceActivity('missing', '2026-11-12T00:00:00.000Z')
    expect(fsm.getProjects()[0].sourceActivityAt).toBe('2026-11-10T00:00:00.000Z')
    await fsm.setSourceActivity(ws.id, '2026-11-11T00:00:00.000Z')
    expect(fsm.getProjects()[0].sourceActivityAt).toBe('2026-11-11T00:00:00.000Z')
  })

  it('setVaultNote persists under the registry lock and leaves other fields alone', async () => {
    const fsm = new FileSystemManager()
    const ws = await fsm.createProject('Thesis', { category: 'Learning', sources: ['/x/t'] })
    const heard: string[] = []
    fsm.onRegistryChanged((id, kind) => heard.push(`${id}:${kind}`))
    // Concurrent writers on the registry: none is lost.
    await Promise.all([
      fsm.setVaultNote(ws.id, 'FocusForge/Learning/Thesis/Thesis.md'),
      fsm.setSourceActivity(ws.id, '2026-11-10T00:00:00.000Z')
    ])
    const got = fsm.getProjects()[0]
    expect(got.vaultNote).toBe('FocusForge/Learning/Thesis/Thesis.md')
    expect(got.sourceActivityAt).toBe('2026-11-10T00:00:00.000Z')
    expect(got.sources).toEqual(['/x/t'])
    await fsm.setVaultNote(ws.id, null)
    expect(fsm.getRegistryEntries()[0].vaultNote).toBeUndefined()
    expect(await fsm.setVaultNote('missing', 'FocusForge/x.md')).toBe(false)
    await new Promise((r) => setTimeout(r, 0))
    expect(heard).toEqual([])
  })

  it('onRegistryChanged fires for create, update and delete, outside the lock', async () => {
    const fsm = new FileSystemManager()
    const heard: string[] = []
    const off = fsm.onRegistryChanged((id, kind) => {
      heard.push(`${id}:${kind}`)
      // Outside the registry lock: a listener may take it again without deadlock.
      void fsm.setVaultNote(id, null)
    })
    const ws = await fsm.createProject('Thesis')
    await fsm.updateWorkstream(ws.id, { name: 'Thesis B' })
    await fsm.updateWorkstream('missing', { name: 'x' })
    await fsm.saveProjectData(ws.id, { tasks: [] })
    await fsm.deleteProject(ws.id)
    await new Promise((r) => setTimeout(r, 10))
    expect(heard).toEqual([`${ws.id}:created`, `${ws.id}:updated`, `${ws.id}:deleted`])
    off()
    await fsm.createProject('Other')
    await new Promise((r) => setTimeout(r, 0))
    expect(heard).toHaveLength(3)
  })
})
