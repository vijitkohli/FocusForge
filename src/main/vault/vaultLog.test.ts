import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import type { ContextPack } from '../../common/readers'
import type { ProjectData } from '../../common/types'
import { digest, done, milestone, step, task } from './testFixtures'
import {
  commitLogEntries,
  mergeLog,
  progressLogEntries,
  saveLogEntries,
  tickLogEntries,
  VaultLogStore
} from './vaultLog'
import type { VaultLogEntry } from './types'

const e = (key: string, date: string, at = `${date}T01:00:00.000Z`): VaultLogEntry => ({
  at,
  date,
  kind: 'notice',
  text: key,
  key
})

describe('vault log', () => {
  it('trim to 300 and 120 days', () => {
    const many = Array.from({ length: 320 }, (_, i) =>
      e(
        `k${i}`,
        '2026-11-10',
        `2026-11-10T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`
      )
    )
    const old = e('old', '2026-07-01')
    const { entries, added } = mergeLog([old], many, '2026-11-12')
    expect(added).toBe(320)
    expect(entries).toHaveLength(300)
    expect(entries.some((x) => x.key === 'old')).toBe(false)
  })

  it('progress de-duplicated by key', () => {
    const d = digest({
      recentProgress: [
        { date: '2026-11-10', text: 'Ran pilot v2', sources: [] },
        { date: '2026-11-10', text: 'ran   Pilot v2!', sources: [] },
        { date: '2026-09-01', text: 'too old', sources: [] }
      ]
    })
    const entries = progressLogEntries(d, '2026-11-12')
    expect(entries).toHaveLength(2)
    const merged = mergeLog([], entries, '2026-11-12')
    expect(merged.added).toBe(1)
    expect(mergeLog(merged.entries, progressLogEntries(d, '2026-11-12'), '2026-11-12').added).toBe(
      0
    )
  })

  it('commit and progress de-duplicated by key; at most 5 commits a day per repo', () => {
    const commits = Array.from({ length: 7 }, (_, i) => ({
      hash: `h${i}`,
      date: `2026-11-10T0${i}:00:00+11:00`,
      subject: `c${i}`,
      files: []
    }))
    const pack = {
      git: [{ id: 'G1', label: 'git:thesis', head: 'h0', commits, text: '' }]
    } as unknown as ContextPack
    const entries = commitLogEntries(pack, '2026-11-12')
    expect(entries).toHaveLength(5)
    expect(entries[0].text).toBe('Commit "c6" (git:thesis)')
    expect(entries[0].key).toBe('commit:h6')
    const first = mergeLog([], entries, '2026-11-12')
    expect(mergeLog(first.entries, entries, '2026-11-12').added).toBe(0)
  })

  it("vault-origin saves don't double log", () => {
    const prev: ProjectData = {
      tasks: [task('t', 'Proposal', { subtasks: [step('a', 'A'), step('b', 'B')] })]
    }
    const next: ProjectData = {
      rev: 4,
      tasks: [task('t', 'Proposal', { subtasks: [done('a', 'A'), step('b', 'B')] })]
    }
    const now = new Date('2026-11-12T01:00:00.000Z')
    expect(saveLogEntries(prev, next, { now, byVault: true })).toEqual([])
    const app = saveLogEntries(prev, next, { now, byVault: false })
    expect(app.map((x) => [x.kind, x.text])).toEqual([['done', 'Done in FocusForge: "A"']])
    expect(saveLogEntries(null, next, { now, byVault: false })).toEqual([])
  })

  it('task-done, milestone-done and planned come from the save diff', () => {
    const prev: ProjectData = {
      tasks: [
        task('t', 'Proposal', {
          subtasks: [done('a', 'A'), step('b', 'B')],
          milestones: [milestone('m1', 'Draft', { status: 'active' })]
        })
      ]
    }
    const next: ProjectData = {
      rev: 9,
      tasks: [
        task('t', 'Proposal', {
          subtasks: [done('a', 'A'), done('b', 'B')],
          milestones: [milestone('m1', 'Draft', { status: 'done' })]
        }),
        task('n', 'New', { subtasks: [step('x', 'X')] })
      ]
    }
    const kinds = saveLogEntries(prev, next, {
      now: new Date('2026-11-12T01:00:00.000Z'),
      byVault: false
    }).map((x) => `${x.kind}:${x.text}`)
    expect(kinds).toEqual([
      'done:Done in FocusForge: "B"',
      'task-done:Finished "Proposal"',
      'milestone-done:Milestone done: "Draft"',
      'planned:Plan updated for "New" (+1 step)'
    ])
  })

  it('tick entries say Obsidian', () => {
    const now = new Date('2026-11-12T01:00:00.000Z')
    const out = tickLogEntries(
      [
        { id: 'ff-s-x', kind: 'step', taskId: 't', title: 'Draft', checked: true },
        { id: 'ff-t-x', kind: 'task', taskId: 't', title: 'Proposal', checked: false }
      ],
      now
    )
    expect(out.map((x) => [x.kind, x.text])).toEqual([
      ['tick', 'Ticked "Draft" in Obsidian'],
      ['untick', 'Unticked "Proposal" (the whole task) in Obsidian']
    ])
  })

  it('store appends by key and refuses unsafe ids', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-vaultlog-'))
    const store = new VaultLogStore(dir)
    expect(await store.append('thesis', [e('a', '2026-11-12')], '2026-11-12')).toBe(1)
    expect(
      await store.append('thesis', [e('a', '2026-11-12'), e('b', '2026-11-12')], '2026-11-12')
    ).toBe(1)
    expect((await store.read('thesis')).map((x) => x.key)).toEqual(['a', 'b'])
    await expect(store.append('../x', [e('a', '2026-11-12')], '2026-11-12')).rejects.toThrow()
  })
})
