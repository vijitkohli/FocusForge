import os from 'os'
import path from 'path'
import fs from 'fs-extra'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// FileSystemManager derives its ROOT_DIR from app.getPath('documents') at
// import time. Point that at a fresh temp dir so tests can never touch the
// real ~/Documents/FlowState.
vi.mock('electron', async () => {
  const nodeFs = await import('fs')
  const nodeOs = await import('os')
  const nodePath = await import('path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'flowstate-test-'))
  return { app: { getPath: () => dir } }
})

import { app } from 'electron'
import type { Subtask } from '../common/types'
import { FileSystemManager } from './fs-manager'

const DOCS = app.getPath('documents')
const ROOT = path.join(DOCS, 'FlowState')
const SYSTEM = path.join(ROOT, 'system')
const DAY = 86400000

// Tests run with TZ=Australia/Sydney (vitest.config.ts) so local-vs-UTC date
// bucketing is actually exercised: 09:00 AEDT is still "yesterday" in UTC.
function local(y: number, m: number, d: number, h = 12, min = 0): Date {
  return new Date(y, m - 1, d, h, min)
}

interface SeedTask {
  id: string
  title?: string
  deadline: string
  subtasks: Partial<Subtask>[]
}

interface SeedProject {
  id: string
  name?: string
  lastActive?: string
  tasks: SeedTask[]
}

function seed(projects: SeedProject[]): void {
  const registry = projects.map((p) => ({
    id: p.id,
    name: p.name ?? p.id,
    path: path.join(ROOT, p.id),
    progress: 0,
    lastActive: p.lastActive ?? new Date().toISOString()
  }))
  fs.outputJSONSync(path.join(SYSTEM, 'master_index.json'), registry)
  for (const p of projects) {
    fs.outputJSONSync(path.join(ROOT, p.id, 'project_data.json'), {
      name: p.name ?? p.id,
      tasks: p.tasks.map((t) => ({ title: t.id, ...t }))
    })
  }
}

function completedOn(id: string, d: Date): Subtask {
  return {
    id,
    title: `step ${id}`,
    isCompleted: true,
    status: 'done',
    completedAt: d.toISOString()
  }
}

function open(id: string, extra: Partial<Subtask> | Record<string, unknown> = {}): Subtask {
  return { id, title: `step ${id}`, isCompleted: false, ...extra }
}

let fsm: FileSystemManager

beforeAll(() => {
  // Hard safety net: refuse to run against anything but a temp dir.
  expect(path.resolve(DOCS).startsWith(path.resolve(os.tmpdir()))).toBe(true)
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  // 13:00 AEDT = 02:00Z, so the UTC and local dates agree by default; the
  // tests that care about the difference set an earlier time explicitly.
  vi.setSystemTime(local(2026, 10, 15, 13, 0))
  fs.removeSync(ROOT)
  fsm = new FileSystemManager()
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(() => {
  fs.removeSync(DOCS)
})

describe('constructor', () => {
  it('creates the system folder, empty registry and user profile under the temp root', () => {
    expect(fs.readJSONSync(path.join(SYSTEM, 'master_index.json'))).toEqual([])
    expect(fs.readFileSync(path.join(SYSTEM, 'user_profile.md'), 'utf-8')).toContain(
      '## Patterns & Friction'
    )
  })
})

describe('getActivityStats', () => {
  it('counts a streak ending today', async () => {
    seed([
      {
        id: 'p',
        tasks: [
          {
            id: 't',
            deadline: '2026-10-30',
            subtasks: [
              completedOn('1', local(2026, 10, 15, 9)),
              completedOn('2', local(2026, 10, 14, 20)),
              completedOn('3', local(2026, 10, 13, 8))
            ]
          }
        ]
      }
    ])
    const stats = await fsm.getActivityStats()
    expect(stats.currentStreak).toBe(3)
    expect(stats.longestStreak).toBe(3)
    expect(stats.totalCompleted).toBe(3)
  })

  it('does not break the streak when today has no completions yet (starts from yesterday)', async () => {
    seed([
      {
        id: 'p',
        tasks: [
          {
            id: 't',
            deadline: '2026-10-30',
            subtasks: [
              completedOn('1', local(2026, 10, 14, 9)),
              completedOn('2', local(2026, 10, 13, 9))
            ]
          }
        ]
      }
    ])
    expect((await fsm.getActivityStats()).currentStreak).toBe(2)
  })

  it('current streak is 0 when neither today nor yesterday has completions', async () => {
    seed([
      {
        id: 'p',
        tasks: [
          {
            id: 't',
            deadline: '2026-10-30',
            subtasks: [
              completedOn('1', local(2026, 10, 13, 9)),
              completedOn('2', local(2026, 10, 12, 9))
            ]
          }
        ]
      }
    ])
    const stats = await fsm.getActivityStats()
    expect(stats.currentStreak).toBe(0)
    expect(stats.longestStreak).toBe(2)
  })

  it('longest streak spans gaps correctly and counts per local day', async () => {
    seed([
      {
        id: 'p',
        tasks: [
          {
            id: 't',
            deadline: '2026-10-30',
            subtasks: [
              completedOn('a', local(2026, 10, 1)),
              completedOn('b', local(2026, 10, 2)),
              completedOn('c', local(2026, 10, 2, 18)),
              completedOn('d', local(2026, 10, 3)),
              completedOn('e', local(2026, 10, 4)),
              // gap on the 5th
              completedOn('f', local(2026, 10, 6)),
              completedOn('g', local(2026, 10, 15))
            ]
          }
        ]
      }
    ])
    const stats = await fsm.getActivityStats()
    expect(stats.longestStreak).toBe(4)
    expect(stats.currentStreak).toBe(1)
    expect(stats.countsByDate['2026-10-02']).toBe(2)
    expect(Object.keys(stats.countsByDate).sort()).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-06',
      '2026-10-15'
    ])
  })

  it('buckets by LOCAL date, not UTC (09:00 AEDT is the previous day in UTC)', async () => {
    const morning = local(2026, 10, 15, 9)
    expect(morning.toISOString().slice(0, 10)).toBe('2026-10-14') // sanity: TZ is ahead of UTC
    seed([
      {
        id: 'p',
        tasks: [{ id: 't', deadline: '2026-10-30', subtasks: [completedOn('1', morning)] }]
      }
    ])
    const stats = await fsm.getActivityStats()
    expect(stats.countsByDate).toEqual({ '2026-10-15': 1 })
    expect(stats.currentStreak).toBe(1)
  })

  it('treats a DST transition day (23h) as consecutive', async () => {
    // Sydney DST starts 2026-10-04 02:00.
    seed([
      {
        id: 'p',
        tasks: [
          {
            id: 't',
            deadline: '2026-10-30',
            subtasks: [
              completedOn('1', local(2026, 10, 3, 23)),
              completedOn('2', local(2026, 10, 4, 23)),
              completedOn('3', local(2026, 10, 5, 23))
            ]
          }
        ]
      }
    ])
    expect((await fsm.getActivityStats()).longestStreak).toBe(3)
  })

  it('aggregates across projects; legacy completions (no completedAt) count only toward total', async () => {
    seed([
      {
        id: 'a',
        tasks: [
          {
            id: 't',
            deadline: '2026-10-30',
            subtasks: [completedOn('1', local(2026, 10, 15)), open('2')]
          }
        ]
      },
      {
        id: 'b',
        tasks: [
          {
            id: 't',
            deadline: '2026-10-30',
            subtasks: [
              completedOn('3', local(2026, 10, 15)),
              { id: '4', title: 'legacy', isCompleted: true },
              { id: '5', title: 'garbage date', isCompleted: true, completedAt: 'not-a-date' }
            ]
          }
        ]
      }
    ])
    const stats = await fsm.getActivityStats()
    expect(stats.totalCompleted).toBe(4)
    expect(stats.countsByDate).toEqual({ '2026-10-15': 2 })
  })

  it('returns zeros with no projects', async () => {
    expect(await fsm.getActivityStats()).toEqual({
      currentStreak: 0,
      longestStreak: 0,
      countsByDate: {},
      totalCompleted: 0
    })
  })
})

describe('unplanned tasks (no steps)', () => {
  it('are ignored by the queue and stats, and count as 0% progress', async () => {
    seed([
      {
        id: 'p',
        tasks: [
          { id: 'empty', deadline: '2026-11-30', subtasks: [] },
          { id: 't', deadline: '2026-11-30', subtasks: [open('a')] }
        ]
      }
    ])
    expect((await fsm.getUpcomingSubtasks()).map((s) => s.subtaskId)).toEqual(['a'])
    expect((await fsm.getActivityStats()).totalCompleted).toBe(0)
    const data = await fsm.loadProjectData('p')
    await fsm.saveProjectData('p', data!)
    expect(fsm.getProjects()[0].progress).toBe(0)
  })
})

describe('getWeekSummary', () => {
  it('counts the Monday–Sunday week in local time', async () => {
    const wed = local(2026, 10, 14, 9)
    seed([
      {
        id: 'p1',
        name: 'COMP9321',
        tasks: [
          {
            id: 'done-task',
            deadline: '2026-10-16',
            subtasks: [
              { ...completedOn('a', wed), focusSeconds: 600 },
              completedOn('b', local(2026, 10, 18, 22))
            ]
          },
          {
            id: 'open-task',
            deadline: '2026-10-30',
            subtasks: [
              completedOn('c', local(2026, 10, 11, 23)),
              open('late', { scheduledDate: '2026-10-17' }),
              open('future', { scheduledDate: '2026-10-20' })
            ]
          }
        ]
      },
      {
        id: 'p2',
        name: 'Other',
        tasks: [{ id: 't', deadline: '2026-10-30', subtasks: [completedOn('d', wed)] }]
      }
    ])
    const summary = await fsm.getWeekSummary('2026-10-12')
    expect(summary).toMatchObject({
      weekStart: '2026-10-12',
      weekEnd: '2026-10-18',
      stepsDone: 3,
      activeDays: 2,
      tasksFinished: 2,
      carriedOver: 1,
      topProject: { name: 'COMP9321', steps: 2 },
      focusMinutes: 10
    })
  })
})

describe('getEstimateAccuracy', () => {
  it('uses completed steps with focus time and an estimate', async () => {
    const done = (id: string, focusSeconds: number, timeEstimate?: number): Subtask => ({
      ...completedOn(id, local(2026, 10, 10)),
      focusSeconds,
      timeEstimate
    })
    seed([
      {
        id: 'p',
        tasks: [
          {
            id: 't',
            deadline: '2026-10-20',
            subtasks: [
              ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => done(id, 1200, 10)),
              done('no-estimate', 1200),
              open('open', { focusSeconds: 9000, timeEstimate: 10 })
            ]
          }
        ]
      }
    ])
    expect(await fsm.getEstimateAccuracy()).toEqual({ ratio: 2, samples: 6 })
  })

  it('is null without enough data', async () => {
    seed([{ id: 'p', tasks: [{ id: 't', deadline: '2026-10-20', subtasks: [] }] }])
    expect(await fsm.getEstimateAccuracy()).toBeNull()
  })
})

describe('getUpcomingSubtasks', () => {
  // new Date('YYYY-MM-DD') is UTC midnight; west of UTC that is the previous
  // local day, so every scheduled step would show one day early.
  it('daysRemaining is correct in a timezone behind UTC (America/New_York)', async () => {
    const prevTz = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      vi.setSystemTime(new Date(2026, 9, 15, 10, 0))
      seed([
        {
          id: 'a',
          tasks: [
            {
              id: 't',
              deadline: '2026-10-20',
              subtasks: [open('1', { scheduledDate: '2026-10-16' })]
            }
          ]
        }
      ])
      expect((await fsm.getUpcomingSubtasks())[0].daysRemaining).toBe(1)
    } finally {
      process.env.TZ = prevTz
    }
  })

  it('flattens incomplete subtasks, prefers scheduledDate over the task deadline, defaults difficulty', async () => {
    seed([
      {
        id: 'a',
        name: 'COMP1511',
        tasks: [
          {
            id: 't',
            title: 'Ass 1',
            deadline: '2026-10-25',
            subtasks: [
              open('1', { scheduledDate: '2026-10-17', difficulty: 'easy', timeEstimate: 10 }),
              open('2'),
              completedOn('3', local(2026, 10, 14)),
              open('4', { scheduledDate: '2026-10-14' })
            ]
          }
        ]
      }
    ])
    const out = await fsm.getUpcomingSubtasks()
    expect(out.map((s) => [s.subtaskId, s.daysRemaining, s.deadline, s.difficulty])).toEqual([
      ['4', -1, '2026-10-14', 'medium'],
      ['1', 2, '2026-10-17', 'easy'],
      ['2', 10, '2026-10-25', 'medium']
    ])
    expect(out[1]).toMatchObject({
      projectName: 'COMP1511',
      taskTitle: 'Ass 1',
      timeEstimate: 10,
      scheduledDate: '2026-10-17'
    })
    expect(out[2].scheduledDate).toBeUndefined()
  })

  it('skips subtasks whose task deadline is invalid and subtasks with an invalid scheduledDate', async () => {
    seed([
      {
        id: 'a',
        tasks: [
          {
            id: 'bad',
            deadline: 'whenever',
            subtasks: [open('1', { scheduledDate: '2026-10-16' })]
          },
          {
            id: 'ok',
            deadline: '2026-10-20',
            subtasks: [open('2', { scheduledDate: 'soon' }), open('3')]
          }
        ]
      }
    ])
    expect((await fsm.getUpcomingSubtasks()).map((s) => s.subtaskId)).toEqual(['3'])
  })
})

describe('getNudge', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  const overdueSetup = (lastActive = new Date().toISOString()): void =>
    seed([
      {
        id: 'a',
        name: 'COMP2521',
        lastActive,
        tasks: [
          {
            id: 't',
            deadline: '2026-10-20',
            subtasks: [
              open('late', { title: 'Write BFS', scheduledDate: '2026-10-12' }),
              open('less-late', { title: 'Write DFS', scheduledDate: '2026-10-14' })
            ]
          }
        ]
      }
    ])

  it.each([
    [7, 59],
    [22, 0],
    [2, 30]
  ])('is silent during quiet hours (%i:%i)', async (h, m) => {
    vi.setSystemTime(local(2026, 10, 15, h, m))
    overdueSetup()
    expect(await fsm.getNudge()).toBeNull()
  })

  it('nudges at 08:00 sharp', async () => {
    vi.setSystemTime(local(2026, 10, 15, 8, 0))
    overdueSetup()
    expect(await fsm.getNudge()).not.toBeNull()
  })

  it('prefers the most overdue step over a stale project', async () => {
    overdueSetup(new Date(Date.now() - 5 * DAY).toISOString())
    const nudge = await fsm.getNudge()
    expect(nudge).toMatchObject({
      title: 'Flow State',
      body: expect.stringContaining('"Write BFS"'),
      subject: 'Write BFS',
      reason: 'overdue'
    })
    expect(fs.readJSONSync(path.join(SYSTEM, 'nudges.json'))).toEqual({ 'sub:late': '2026-10-15' })
  })

  it('nudges an item at most once per day, then again the next day', async () => {
    overdueSetup() // project active today -> no stale fallback
    expect((await fsm.getNudge())?.subject).toBe('Write BFS')
    // Most overdue already nudged today -> the next overdue step, not silence
    expect((await fsm.getNudge())?.subject).toBe('Write DFS')
    expect(await fsm.getNudge()).toBeNull()
    vi.setSystemTime(local(2026, 10, 16, 13, 0))
    expect((await fsm.getNudge())?.body).toContain('Write BFS')
  })

  it('falls back to a stale project (idle >= 2 days) with open work', async () => {
    seed([
      {
        id: 'fresh',
        name: 'Fresh',
        lastActive: new Date(Date.now() - 1 * DAY).toISOString(),
        tasks: [{ id: 't', deadline: '2026-10-20', subtasks: [open('1')] }]
      },
      {
        id: 'stale',
        name: 'Stale One',
        lastActive: new Date(Date.now() - 3 * DAY).toISOString(),
        tasks: [{ id: 't', deadline: '2026-10-20', subtasks: [open('2')] }]
      },
      {
        id: 'staler',
        name: 'Done Project',
        lastActive: new Date(Date.now() - 9 * DAY).toISOString(),
        tasks: [
          { id: 't', deadline: '2026-10-20', subtasks: [completedOn('3', local(2026, 10, 1))] }
        ]
      }
    ])
    const nudge = await fsm.getNudge()
    expect(nudge).toMatchObject({
      body: expect.stringContaining('"Stale One"'),
      subject: 'Stale One',
      reason: 'idle'
    })
    expect(fs.readJSONSync(path.join(SYSTEM, 'nudges.json'))).toEqual({
      'proj:stale': '2026-10-15'
    })
    expect(await fsm.getNudge()).toBeNull()
  })

  it('returns null when nothing is overdue and nothing is stale', async () => {
    seed([{ id: 'a', tasks: [{ id: 't', deadline: '2026-10-20', subtasks: [open('1')] }] }])
    expect(await fsm.getNudge()).toBeNull()
  })

  it('returns null with no open work at all', async () => {
    expect(await fsm.getNudge()).toBeNull()
  })

  it('tolerates a corrupt nudge log', async () => {
    overdueSetup()
    fs.outputFileSync(path.join(SYSTEM, 'nudges.json'), '{not json')
    expect(await fsm.getNudge()).not.toBeNull()
  })
})

describe('appendLedgerNotes', () => {
  const ledgerPath = (id: string): string => path.join(ROOT, id, `context_${id}.md`)

  it('inserts notes at the end of their section, before the next heading, in order', async () => {
    const project = await fsm.createProject('COMP 1531')
    await fsm.appendLedgerNotes(project.id, [
      { section: 'Milestones & Completed Work', note: 'Finished auth routes' },
      { section: 'Constraints & Specifications', note: 'Python 3.10' },
      { section: 'Milestones & Completed Work', note: 'Pipeline green' }
    ])
    expect(fs.readFileSync(ledgerPath(project.id), 'utf-8')).toBe(
      '## Constraints & Specifications\n' +
        '- [2026-10-15] Python 3.10\n' +
        '\n## Document Excerpts\n' +
        '\n## Milestones & Completed Work\n' +
        '- [2026-10-15] Finished auth routes\n' +
        '- [2026-10-15] Pipeline green\n' +
        '\n## Plan Adjustments\n'
    )
  })

  it('appends to the last section at end of file', async () => {
    const project = await fsm.createProject('p')
    await fsm.appendLedgerNotes(project.id, [
      { section: 'Plan Adjustments', note: 'Shortened plan' }
    ])
    expect(
      fs
        .readFileSync(ledgerPath(project.id), 'utf-8')
        .endsWith('## Plan Adjustments\n- [2026-10-15] Shortened plan\n')
    ).toBe(true)
  })

  it('adds a missing section heading at the end (hand-edited ledger)', async () => {
    fs.outputFileSync(ledgerPath('x'), '## Constraints & Specifications\n- keep it short\n')
    await fsm.appendLedgerNotes('x', [{ section: 'Plan Adjustments', note: 'Dropped step 3' }])
    expect(fs.readFileSync(ledgerPath('x'), 'utf-8')).toBe(
      '## Constraints & Specifications\n- keep it short\n\n## Plan Adjustments\n- [2026-10-15] Dropped step 3\n'
    )
  })

  it('lazily creates the ledger when missing, and migrates a legacy context.md', async () => {
    await fsm.appendLedgerNotes('fresh', [{ section: 'Document Excerpts', note: 'page 1' }])
    expect(fs.readFileSync(ledgerPath('fresh'), 'utf-8')).toContain(
      '## Document Excerpts\n- [2026-10-15] page 1\n'
    )

    fs.outputFileSync(
      path.join(ROOT, 'legacy', 'context.md'),
      '## Constraints & Specifications\n- old fact\n'
    )
    await fsm.appendLedgerNotes('legacy', [
      { section: 'Constraints & Specifications', note: 'new fact' }
    ])
    expect(fs.existsSync(path.join(ROOT, 'legacy', 'context.md'))).toBe(false)
    expect(fs.readFileSync(ledgerPath('legacy'), 'utf-8')).toBe(
      '## Constraints & Specifications\n- old fact\n- [2026-10-15] new fact\n'
    )
  })

  it('readContextLedgerForPrompt keeps only the latest 15 bullets of log sections', async () => {
    const project = await fsm.createProject('p')
    await fsm.appendLedgerNotes(
      project.id,
      Array.from({ length: 20 }, (_, i) => ({
        section: 'Plan Adjustments' as const,
        note: `adj ${i}`
      }))
    )
    await fsm.appendLedgerNotes(
      project.id,
      Array.from({ length: 20 }, (_, i) => ({
        section: 'Constraints & Specifications' as const,
        note: `c ${i}`
      }))
    )
    const prompt = await fsm.readContextLedgerForPrompt(project.id)
    expect(prompt).not.toContain('adj 4\n')
    expect(prompt).toContain('adj 5\n')
    expect(prompt).toContain('adj 19\n')
    expect(prompt).toContain('c 0\n') // constraints are never trimmed
  })

  // BUG (reported): note timestamps use toISOString() (UTC date) while every
  // other date in the app is local. Before 11:00 AEDT the ledger records
  // yesterday's date.
  it('stamps notes with the local date (09:00 Sydney)', async () => {
    vi.setSystemTime(local(2026, 10, 15, 9, 0))
    const project = await fsm.createProject('p')
    await fsm.appendLedgerNotes(project.id, [{ section: 'Plan Adjustments', note: 'x' }])
    expect(fs.readFileSync(ledgerPath(project.id), 'utf-8')).toContain('- [2026-10-15] x')
  })
})
