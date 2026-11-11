import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GuardFs, PathGuard, foldPath, nodeGuardFs } from './guard'
import { detectVault, readObsidianVaults, nodeVaultFs, type VaultFs } from './vault'
import { discover, localDaysBetween, scanSource, type DiscoverOptions } from './discover'
import { readDiscoveryCache, saveDismissedKeys, writeDiscoveryResult } from './discoveryCache'
import type { DiscoveryCandidate, DiscoveryResult, VaultInfo } from '../../common/discovery'
import type { ProjectSummary } from '../../common/types'
import { DEFAULT_INITIAL_ACTIVE } from './slice'

// A synthetic home in a temp dir. Generic names only (the repo is public);
// the slice keys are generic match keys.
const DAY = 86_400_000
const NOW = new Date(2026, 10, 11, 12) // 11 Nov 2026, local noon
let tmp: string
let home: string
let uni: string
let projects: string
let vault: string
let appData: string

function write(rel: string, contents = 'x', daysAgo = 1): string {
  const p = path.join(home, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, contents)
  const t = (NOW.getTime() - daysAgo * DAY) / 1000
  fs.utimesSync(p, t, t)
  return p
}

const GIT_DAYS: Record<string, number> = {
  'thesis-data': 3,
  'garden-planner': 1,
  FocusForge: 2
}
const gitCalls: string[] = []
const fakeGit = async (dir: string): Promise<number | null> => {
  gitCalls.push(dir)
  const d = GIT_DAYS[path.basename(dir)]
  return d === undefined ? null : NOW.getTime() - d * DAY
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-discover-')))
  home = path.join(tmp, 'home')
  uni = path.join(home, 'UNI')
  projects = path.join(home, 'Projects')
  vault = path.join(home, 'Vault')
  appData = path.join(tmp, 'appdata')

  write('UNI/comp9321/ass2/todo.md', 'x', 2)
  write('UNI/comp9321/node_modules/x/index.js', 'x', 0)
  write('UNI/pscy1023/ideas.md', 'x', 4)
  write('UNI/thesis/CLAUDE.md', 'x', 6)
  write('UNI/thesis/research/status.md', 'x', 5)
  write('UNI/thesis-data/run.py', 'x', 30)
  fs.mkdirSync(path.join(uni, 'thesis-data', '.git'))
  write('UNI/hist2001/old.md', 'x', 200)
  write('UNI/SERVICE PAT.rtf', 'CANARY-SECRET-7f3a', 0)
  write('UNI/loose-file.rtf', 'x', 0)
  write('UNI/day44/a.md', 'x', 44)
  write('UNI/day45/a.md', 'x', 45)
  write('UNI/day46/a.md', 'x', 46)

  write('Projects/garden-planner/index.html', 'x', 60)
  fs.mkdirSync(path.join(projects, 'garden-planner', '.git'))
  write('Projects/personal-website/index.html', 'x', 3)
  write('Projects/archive-personal/index.html', 'x', 100)
  write('Projects/FocusForge/CLAUDE.md', 'x', 9)
  fs.mkdirSync(path.join(projects, 'FocusForge', '.git'))
  write('Projects/.env', 'CANARY-SECRET-7f3a', 0)

  write('Vault/.obsidian/app.json', '{}')
  write('Vault/Learning/Courses/25T1/COMP9321 - Course Notes.md', 'x', 1)
  write('Vault/Learning/Courses/25T1/PSYC1023.md', 'x', 2)
  write('Vault/Learning/Courses/Course List.md', 'x', 2)
  write('Vault/Learning/Thesis Hub/Thesis.md', 'x', 8)
  write('Vault/Learning/Thesis Hub/Draft notes.md', 'x', 8)
  write('Vault/Learning/Practice.md', 'x', 20)
  write('Vault/Learning/Learning Hub.md', '# Learning\n## Thesis\nBODY-NOT-NEEDED-5d1e', 1)
  write('Vault/Projects/Garden Planner Website.md', 'x', 10)
  write('Vault/Projects/Personal Web Notes.md', 'x', 12)
  write(
    'Vault/Projects/IDEAS TO DO.md',
    '## FocusForge\n- [ ] thing BODY-NOT-NEEDED-5d1e\n## Garden\n## Random Idea\n',
    1
  )
  write('Vault/Career/Applications.md', 'x', 7)
  write('Vault/TODO/Now.md', 'x', 0)
  write('Vault/FocusForge/Life/Reading/Reading.md', 'x', 0)
  write('Vault/Life/CANARY-LIFE-DO-NOT-READ.md', 'CANARY-LIFE-91c2', 0)
  write('Vault/Life/Journal/day.md', 'CANARY-LIFE-91c2', 0)
  fs.symlinkSync(path.join(vault, 'Life'), path.join(uni, 'comp9321', 'linked-life'))

  fs.mkdirSync(path.join(appData, 'obsidian'), { recursive: true })
  fs.writeFileSync(
    path.join(appData, 'obsidian', 'obsidian.json'),
    JSON.stringify({ vaults: { a: { path: vault, ts: 1, open: true } } })
  )
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

interface Trace {
  all: string[]
  reads: string[]
  listed: string[]
}

function tracingGuardFs(t: Trace): GuardFs {
  return {
    realpathSync: (p) => (t.all.push(p), nodeGuardFs.realpathSync(p)),
    lstatSync: (p) => (t.all.push(p), nodeGuardFs.lstatSync(p)),
    promises: {
      opendir: (p) => (t.all.push(p), t.listed.push(p), nodeGuardFs.promises.opendir(p)),
      lstat: (p) => (t.all.push(p), nodeGuardFs.promises.lstat(p)),
      open: (p, f) => (t.all.push(p), t.reads.push(p), nodeGuardFs.promises.open(p, f))
    }
  }
}

function tracingVaultFs(t: Trace): VaultFs {
  return {
    readFile: (p) => (t.all.push(p), t.reads.push(p), nodeVaultFs.readFile(p)),
    lstat: (p) => (t.all.push(p), nodeVaultFs.lstat(p)),
    stat: (p) => (t.all.push(p), nodeVaultFs.stat(p))
  }
}

const VAULT_INFO = (): VaultInfo => ({ path: vault, source: 'settings', valid: true, others: [] })

function makeGuard(fsImpl?: GuardFs): PathGuard {
  return new PathGuard({
    sourceRoots: [uni, projects],
    vaultRoots: [vault],
    readableVault: vault,
    caseInsensitive: true,
    fsImpl
  })
}

function options(over: Partial<DiscoverOptions> = {}): DiscoverOptions {
  return {
    guard: makeGuard(),
    sourceRoots: [
      { path: uni, label: '~/UNI', category: 'Learning' },
      { path: projects, label: '~/Projects', category: 'Projects' }
    ],
    vault: VAULT_INFO(),
    vaultCategories: ['Learning', 'Projects', 'Career'],
    initialActiveKeys: [...DEFAULT_INITIAL_ACTIVE],
    registry: [],
    dismissedKeys: [],
    firstRun: true,
    now: NOW,
    git: fakeGit,
    home,
    ...over
  }
}

const entry = (id: string, extra: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id,
  name: id,
  path: `/flow/${id}`,
  progress: 0,
  lastActive: '2026-10-01T00:00:00.000Z',
  ...extra
})

function byName(r: DiscoveryResult, name: string): DiscoveryCandidate {
  const c = r.candidates.find((x) => x.name === name)
  if (!c) throw new Error(`no candidate ${name}: ${r.candidates.map((x) => x.name).join(', ')}`)
  return c
}

const labels = (c: DiscoveryCandidate): string[] => c.sources.map((s) => s.label)

describe('discover', () => {
  let result: DiscoveryResult
  beforeAll(async () => {
    result = await discover(options({ registry: [entry('comp9321'), entry('practice')] }))
  })

  it('suggests one item per top-level folder with root categories', () => {
    const names = result.candidates.map((c) => c.name)
    for (const n of ['HIST2001', 'Garden Planner', 'Archive Personal', 'FocusForge']) {
      expect(names).toContain(n)
    }
    expect(byName(result, 'HIST2001').category).toBe('Learning')
    expect(byName(result, 'Archive Personal').category).toBe('Projects')
    expect(names).not.toContain('Loose File')
    expect(result.roots.map((r) => [r.label, r.reachable])).toEqual([
      ['~/UNI', true],
      ['~/Projects', true]
    ])
  })

  it('thesis gets thesis, thesis-data and Thesis Hub', () => {
    const t = byName(result, 'Thesis')
    expect(labels(t)).toEqual([
      '~/UNI/thesis',
      '~/UNI/thesis-data',
      'Thesis Hub/',
      'Learning Hub.md › Thesis'
    ])
    expect(t.sources.map((s) => s.match)).toEqual(['primary', 'merge', 'exact', 'section'])
    expect(t.reasons).toContain('Merged with thesis-data')
    expect(t.activitySignal).toBe('git')
    expect(t.reasons[0]).toBe('Last commit 3 days ago')
    expect(t.kind).toBe('deadline')
  })

  it('PSYC1023 gets pscy1023 as similar plus the course note', () => {
    const p = byName(result, 'PSYC1023')
    expect(p.sources.map((s) => [s.label, s.match])).toEqual([
      ['~/UNI/pscy1023', 'primary'],
      ['PSYC1023.md', 'similar']
    ])
    expect(p.reasons).toContain('Matched to PSYC1023.md by a similar name')
    expect(p.category).toBe('Learning')
  })

  it('vault category wins on match and tokens/sections attach', () => {
    const w = byName(result, 'Personal Website')
    expect(w.sources.map((s) => [s.label, s.match])).toEqual([
      ['~/Projects/personal-website', 'primary'],
      ['Personal Web Notes.md', 'tokens']
    ])
    const ff = byName(result, 'FocusForge')
    expect(labels(ff)).toContain('IDEAS TO DO.md › FocusForge')
    const section = ff.sources.find((s) => s.type === 'vault-section')!
    expect(section.path).toBe(path.join(vault, 'Projects', 'IDEAS TO DO.md') + '#FocusForge')
    expect(section.heading).toBe('FocusForge')
    const h = byName(result, 'Garden Planner')
    expect(labels(h)).toEqual([
      '~/Projects/garden-planner',
      'Garden Planner Website.md',
      'IDEAS TO DO.md › Garden'
    ])
    expect(
      byName(result, 'Thesis').sources.some((s) => s.label === 'Learning Hub.md › Thesis')
    ).toBe(true)
  })

  it('skips hub and list notes, TODO, the app folder and term/grouping folders', () => {
    const all = JSON.stringify(result.candidates)
    for (const n of [
      'Learning Hub',
      'Course List',
      'IDEAS TO DO',
      'TODO',
      'Now',
      'Reading',
      '25T1'
    ]) {
      expect(result.candidates.some((c) => c.name === n)).toBe(false)
    }
    expect(result.candidates.some((c) => c.name === 'Courses')).toBe(false)
    expect(all).not.toContain('Random Idea')
    expect(
      result.candidates.some((c) => c.sources.some((s) => s.path.includes('FocusForge/Life')))
    ).toBe(false)
  })

  it('Career becomes one item', () => {
    const c = byName(result, 'Career')
    expect(c.category).toBe('Career')
    expect(c.sources.map((s) => [s.type, s.label])).toEqual([['vault-folder', 'Career/']])
    expect(c.kind).toBe('ongoing')
  })

  it('only initialActiveKeys start active and ticked; others unticked', () => {
    const ticked = result.candidates.filter((c) => c.included && c.inSlice).map((c) => c.name)
    expect(ticked.sort()).toEqual([
      'FocusForge',
      'PSYC1023',
      'Personal Website',
      'Thesis',
      'comp9321'
    ])
    for (const name of ticked) expect(byName(result, name).status).toBe('active')
    expect(byName(result, 'Garden Planner').included).toBe(false)
    expect(byName(result, 'Garden Planner').recent).toBe(true)
    expect(byName(result, 'HIST2001').included).toBe(false)
    expect(byName(result, 'HIST2001').recent).toBe(false)
    expect(byName(result, 'HIST2001').reasons[0]).toMatch(/^Quiet since /)
    expect(byName(result, 'Career').included).toBe(false)
  })

  it('adopted practice starts paused, adopted comp9321 active, no duplicates', () => {
    const comp = byName(result, 'comp9321')
    expect(comp).toMatchObject({
      adoptsProjectId: 'comp9321',
      status: 'active',
      included: true,
      suggestedName: 'COMP9321'
    })
    expect(labels(comp)).toEqual(['~/UNI/comp9321', 'COMP9321 - Course Notes.md'])
    const leet = byName(result, 'practice')
    expect(leet).toMatchObject({ adoptsProjectId: 'practice', status: 'paused', included: true })
    expect(leet.reasons).toContain("Paused for now. It's saved and ready when you are.")
    expect(result.candidates.filter((c) => /comp9321/i.test(c.name))).toHaveLength(1)
    expect(result.existingUnmatched).toEqual([])
  })

  it('old folders are quiet after 45 local days', () => {
    expect(localDaysBetween(new Date(NOW.getTime() - 45 * DAY), NOW)).toBe(45)
    expect(byName(result, 'Day44').recent).toBe(true)
    expect(byName(result, 'Day45').recent).toBe(true)
    expect(byName(result, 'Day46').recent).toBe(false)
  })

  it('later runs keep saved statuses and only tick existing items', async () => {
    const r = await discover(
      options({
        firstRun: false,
        registry: [
          entry('practice', { status: 'archived' }),
          entry('Reading', { category: 'Life' })
        ]
      })
    )
    expect(byName(r, 'practice').status).toBe('archived')
    expect(byName(r, 'Thesis').included).toBe(false)
    expect(r.existingUnmatched.map((e) => [e.id, e.category])).toEqual([['Reading', 'Life']])
  })

  it('adopts by saved sources even after a rename', async () => {
    const r = await discover(
      options({
        registry: [
          entry('x1', { name: 'My website', sources: [path.join(projects, 'personal-website')] })
        ]
      })
    )
    expect(r.candidates.find((c) => c.adoptsProjectId === 'x1')?.key).toBe(
      foldPath(path.join(projects, 'personal-website'), true)
    )
  })

  it('honours dismissed keys', async () => {
    const key = byName(result, 'HIST2001').key
    const r = await discover(options({ dismissedKeys: [key] }))
    expect(r.candidates.some((c) => c.key === key)).toBe(false)
    expect(r.dismissed.map((c) => c.key)).toEqual([key])
  })

  it('skips vault FocusForge folder', async () => {
    const r = await discover(options({ vaultCategories: ['FocusForge', 'Learning'] }))
    expect(
      r.candidates.some((c) =>
        c.sources.some((s) => s.path.includes(`${path.sep}FocusForge${path.sep}Life`))
      )
    ).toBe(false)
  })

  it('respects total deadline and abort', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await discover(options({ signal: ac.signal }))
    expect(r.truncated).toBe(true)
    expect(r.warnings).toContain('I stopped early; some dates may be missing.')
    const slow = await discover(options({ totalBudgetMs: -1 }))
    expect(slow.truncated).toBe(true)
  })

  it('warns warmly about an unreachable root', async () => {
    const r = await discover(
      options({
        sourceRoots: [
          { path: path.join(home, 'Missing'), label: '~/Missing', category: 'Learning' },
          { path: projects, label: '~/Projects', category: 'Projects' }
        ]
      })
    )
    expect(r.warnings).toContain("Couldn't reach ~/Missing. The rest is here.")
    expect(r.candidates.length).toBeGreaterThan(0)
  })

  it('never touches Life or secrets during a full discovery', async () => {
    const t: Trace = { all: [], reads: [], listed: [] }
    const vfs = tracingVaultFs(t)
    const info = await detectVault(
      { vaultPath: '' },
      await readObsidianVaults(appData, vfs),
      vfs,
      home
    )
    expect(info.path).toBe(vault)
    gitCalls.length = 0
    const r = await discover(
      options({
        guard: makeGuard(tracingGuardFs(t)),
        vault: info,
        // even if Life is passed straight in, it is never scanned
        vaultCategories: ['Life', 'life', 'Learning', 'Projects', 'Career', '../Life'],
        registry: [entry('comp9321'), entry('practice')]
      })
    )
    const cacheFile = path.join(tmp, 'flow', 'system', 'discovery.json')
    await writeDiscoveryResult(cacheFile, r)

    const lifeRoot = foldPath(path.join(vault, 'life'), true)
    const touched = [...t.all, ...gitCalls]
    expect(touched.length).toBeGreaterThan(20)
    expect(touched.filter((p) => foldPath(p, true).startsWith(lifeRoot))).toEqual([])
    expect(touched.filter((p) => /SERVICE PAT\.rtf$|\.env$/.test(p))).toEqual([])
    expect(touched.filter((p) => p.includes('linked-life'))).toEqual([])
    // The vault root is never listed, so the name "Life" never enters memory.
    expect(t.listed).not.toContain(vault)
    expect(t.listed).toContain(path.join(vault, 'Learning'))
    // Content reads: obsidian.json and hub notes in scanned categories only.
    expect(t.reads.map((p) => path.relative(tmp, p)).sort()).toEqual(
      [
        path.join('appdata', 'obsidian', 'obsidian.json'),
        path.join('home', 'Vault', 'Learning', 'Learning Hub.md'),
        path.join('home', 'Vault', 'Projects', 'IDEAS TO DO.md')
      ].sort()
    )
    for (const blob of [JSON.stringify(r), fs.readFileSync(cacheFile, 'utf8')]) {
      for (const bad of [
        'CANARY',
        'Journal',
        'BODY-NOT-NEEDED',
        'Random Idea',
        'SERVICE PAT',
        '.env'
      ]) {
        expect(blob).not.toContain(bad)
      }
      expect(blob.toLowerCase()).not.toContain(`${path.sep}life${path.sep}canary`)
    }
    expect(r.candidates.every((c) => c.category !== 'Life')).toBe(true)
  })
})

describe('scanSource', () => {
  const roots = [
    { path: '', label: '~/UNI', category: 'Learning' as const },
    { path: '', label: '~/Projects', category: 'Projects' as const }
  ]
  const opts = (): Parameters<typeof scanSource>[2] => ({
    roots: [
      { ...roots[0], path: uni },
      { ...roots[1], path: projects }
    ],
    vault: VAULT_INFO(),
    now: NOW,
    home,
    git: fakeGit
  })

  it('rejects paths outside roots and inside Life with a path-free error', async () => {
    const g = makeGuard()
    const outside = await scanSource(g, '/etc', opts())
    expect(outside).toEqual({
      error: 'FocusForge only reads ~/UNI, ~/Projects and your vault for now.'
    })
    const life = await scanSource(g, path.join(vault, 'Life'), opts())
    expect(life).toEqual({ error: "Your vault's Life folder stays closed. Pick something else." })
    const linked = await scanSource(g, path.join(uni, 'comp9321', 'linked-life'), opts())
    expect('error' in linked && !linked.error.includes(vault)).toBe(true)
    const secret = await scanSource(g, path.join(uni, 'SERVICE PAT.rtf'), opts())
    expect(secret).toEqual({ error: "That looks like it holds secrets, so I'll leave it alone." })
    expect(await scanSource(g, path.join(uni, 'loose-file.rtf'), opts())).toEqual({
      error: 'Pick a folder, or a note from your vault.'
    })
    expect(await scanSource(g, vault, opts())).toEqual({
      error: 'Pick a folder or note inside your vault, not the whole vault.'
    })
  })

  it('accepts a folder in a root and a note in the vault', async () => {
    const g = makeGuard()
    const r = await scanSource(g, path.join(uni, 'comp9321', 'ass2'), opts())
    expect('candidate' in r && r.candidate).toMatchObject({
      name: 'Ass2',
      category: 'Learning',
      included: true,
      status: 'active',
      sources: [{ label: '~/UNI/comp9321/ass2', match: 'user', type: 'folder' }]
    })
    const n = await scanSource(g, path.join(vault, 'Career', 'Applications.md'), opts())
    expect('candidate' in n && n.candidate).toMatchObject({
      name: 'Applications',
      category: 'Career',
      sources: [{ type: 'vault-note', label: 'Applications.md' }]
    })
  })
})

describe('discovery cache', () => {
  it('keeps dismissed keys across result writes', async () => {
    const file = path.join(tmp, 'cache', 'discovery.json')
    expect((await readDiscoveryCache(file)).result).toBeNull()
    await saveDismissedKeys(file, ['k1', 'k1', 'k2'])
    const r = await discover(options())
    await writeDiscoveryResult(file, r)
    const c = await readDiscoveryCache(file)
    expect(c.dismissedKeys).toEqual(['k1', 'k2'])
    expect(c.result?.dismissedKeys).toEqual(['k1', 'k2'])
    expect(c.result?.candidates.length).toBe(r.candidates.length)
    fs.writeFileSync(file, '{broken')
    expect(await readDiscoveryCache(file)).toEqual({
      version: 1,
      ranAt: null,
      result: null,
      dismissedKeys: []
    })
  })
})
