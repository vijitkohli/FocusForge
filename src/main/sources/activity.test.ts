import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PathGuard } from './guard'
import { gitLastCommit, scanActivity, type ExecFileLike } from './activity'

let tmp: string
let projects: string
let g: PathGuard

const DAY = 86_400_000

function write(p: string, mtimeMs?: number): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, 'x')
  if (mtimeMs !== undefined) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000)
}

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-activity-')))
  projects = path.join(tmp, 'projects')
  fs.mkdirSync(projects, { recursive: true })
  g = new PathGuard({
    sourceRoots: [projects],
    vaultRoots: [],
    readableVault: null,
    caseInsensitive: true
  })
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('scanActivity', () => {
  it('uses newest non-dot file mtime', async () => {
    const dir = path.join(projects, 'a')
    const now = Date.now()
    write(path.join(dir, 'old.md'), now - 10 * DAY)
    write(path.join(dir, 'sub', 'new.md'), now - 2 * DAY)
    write(path.join(dir, '.DS_Store'), now)
    const a = await scanActivity(g, dir, { git: async () => null })
    expect(a.signal).toBe('files')
    expect(Math.abs((a.lastMs ?? 0) - (now - 2 * DAY))).toBeLessThan(1000)
  })

  it('ignores node_modules, secrets and dotfiles', async () => {
    const dir = path.join(projects, 'b')
    const now = Date.now()
    write(path.join(dir, 'main.ts'), now - 30 * DAY)
    write(path.join(dir, 'node_modules', 'x', 'index.js'), now)
    write(path.join(dir, '.env'), now)
    write(path.join(dir, 'deploy-token.txt'), now)
    write(path.join(dir, '.cache', 'y'), now)
    const a = await scanActivity(g, dir, { git: async () => null })
    expect(Math.abs((a.lastMs ?? 0) - (now - 30 * DAY))).toBeLessThan(1000)
  })

  it('prefers git when a .git folder exists and the commit is newer', async () => {
    const dir = path.join(projects, 'c')
    const now = Date.now()
    write(path.join(dir, 'a.md'), now - 20 * DAY)
    fs.mkdirSync(path.join(dir, '.git'))
    const calls: string[] = []
    const a = await scanActivity(g, dir, {
      git: async (d) => (calls.push(d), now - DAY)
    })
    expect(calls).toEqual([dir])
    expect(a).toMatchObject({ signal: 'git', lastMs: now - DAY })
  })

  it('reads last commit time from git', async () => {
    if (!hasGit()) return
    const dir = path.join(projects, 'repo')
    write(path.join(dir, 'a.md'))
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_COMMITTER_DATE: '2026-11-08T10:00:00+11:00',
      GIT_AUTHOR_DATE: '2026-11-08T10:00:00+11:00'
    }
    execFileSync('git', ['init', '-q'], { cwd: dir, env })
    execFileSync('git', ['add', '.'], { cwd: dir, env })
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'x'], { cwd: dir, env })
    expect(await gitLastCommit(dir)).toBe(new Date('2026-11-08T10:00:00+11:00').getTime())
  })

  it('handles missing git, errors and timeouts as null', async () => {
    const enoent: ExecFileLike = (_f, _a, _o, cb) =>
      cb(Object.assign(new Error('x'), { code: 'ENOENT' }), '')
    const throws: ExecFileLike = () => {
      throw new Error('spawn failed')
    }
    const junk: ExecFileLike = (_f, _a, _o, cb) => cb(null, 'not a number')
    const seen: unknown[] = []
    const spy: ExecFileLike = (f, a, o, cb) => (
      seen.push([f, a, o.timeout, o.env.GIT_OPTIONAL_LOCKS]),
      cb(null, '1700000000\n')
    )
    expect(await gitLastCommit('/x', 2000, enoent)).toBeNull()
    expect(await gitLastCommit('/x', 2000, throws)).toBeNull()
    expect(await gitLastCommit('/x', 2000, junk)).toBeNull()
    expect(await gitLastCommit('/x', 1234, spy)).toBe(1_700_000_000_000)
    expect(seen).toEqual([
      ['git', ['-C', '/x', '-c', 'core.fsmonitor=false', 'log', '-1', '--format=%ct'], 1234, '0']
    ])
  })

  it('reports timeout when the deadline passes', async () => {
    const dir = path.join(projects, 'd')
    write(path.join(dir, 'a.md'))
    const a = await scanActivity(g, dir, { deadline: Date.now() - 1, git: async () => null })
    expect(a).toEqual({ lastMs: null, signal: 'timeout', truncated: true })
  })

  it('a single file reports its own mtime; denied paths report none', async () => {
    const f = path.join(projects, 'e', 'note.md')
    write(f, Date.now() - 5 * DAY)
    expect((await scanActivity(g, f)).signal).toBe('files')
    expect(await scanActivity(g, path.join(tmp, 'outside'))).toEqual({
      lastMs: null,
      signal: 'none',
      truncated: false
    })
  })
})
