import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PathGuard } from './guard'
import { gitLog, parseGitLog, type GitRunner } from './git'

let tmp: string
let uni: string

function guard(): PathGuard {
  return new PathGuard({
    sourceRoots: [uni],
    vaultRoots: [],
    readableVault: null,
    caseInsensitive: true
  })
}

const R = '\x1e'
const U = '\x1f'

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Every path, size and mtime under a folder (to prove nothing was written). */
function tree(dir: string): string {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name)
      const st = fs.lstatSync(p)
      out.push(`${path.relative(dir, p)}:${st.size}:${st.mtimeMs}`)
      if (e.isDirectory()) walk(p)
    }
  }
  walk(dir)
  return out.join('\n')
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-git-')))
  uni = path.join(tmp, 'UNI')
  fs.mkdirSync(path.join(uni, 'repo/.git'), { recursive: true })
  fs.mkdirSync(path.join(uni, 'plain'), { recursive: true })
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('gitLog', () => {
  it('parses log with dates and files', () => {
    const out = `${R}abc1234${U}2026-11-10T10:00:00+11:00${U}add guard study\nsrc/a.ts\nREADME.md\n\n${R}def5678${U}2026-11-09T09:00:00+11:00${U}init\n`
    expect(parseGitLog(out)).toEqual([
      {
        hash: 'abc1234',
        date: '2026-11-10T10:00:00+11:00',
        subject: 'add guard study',
        files: ['src/a.ts', 'README.md']
      },
      { hash: 'def5678', date: '2026-11-09T09:00:00+11:00', subject: 'init', files: [] }
    ])
  })

  it('filters secret and noise file names', () => {
    const out = `${R}abc${U}2026-11-10T10:00:00Z${U}s\n.env\nconfig/api_key.txt\nnode_modules/x/index.js\nsecrets/a.md\nsrc/keyboard.ts\nAPI TOKEN.rtf\nok.md\n`
    expect(parseGitLog(out)[0].files).toEqual(['src/keyboard.ts', 'ok.md'])
  })

  it('caps files per commit', () => {
    const files = Array.from({ length: 25 }, (_, i) => `f${i}.md`).join('\n')
    const c = parseGitLog(`${R}abc${U}2026-11-10T10:00:00Z${U}s\n${files}\n`)[0]
    expect(c.files).toHaveLength(21)
    expect(c.files[20]).toBe('+5 more')
  })

  it('returns null on timeout or non-repo', async () => {
    const failing: GitRunner = async () => {
      throw Object.assign(new Error('timeout'), { killed: true })
    }
    expect(await gitLog(guard(), path.join(uni, 'repo'), { runner: failing })).toBeNull()
    let called = false
    const spy: GitRunner = async () => ((called = true), '')
    expect(await gitLog(guard(), path.join(uni, 'plain'), { runner: spy })).toBeNull()
    expect(await gitLog(guard(), path.join(tmp, 'elsewhere'), { runner: spy })).toBeNull()
    expect(called).toBe(false)
  })

  it('passes GIT_OPTIONAL_LOCKS=0 and no author fields', async () => {
    let seen: { args: string[]; env: NodeJS.ProcessEnv } | null = null
    const runner: GitRunner = async (args, o) => {
      seen = { args, env: o.env }
      return ''
    }
    expect(await gitLog(guard(), path.join(uni, 'repo'), { runner })).toEqual([])
    expect(seen!.env.GIT_OPTIONAL_LOCKS).toBe('0')
    expect(seen!.env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(seen!.args).toContain('core.fsmonitor=false')
    const fmt = seen!.args.find((a) => a.startsWith('--pretty='))!
    expect(fmt).not.toMatch(/%a[neNE]/)
    expect(fmt).not.toMatch(/%c[neNE]/)
  })

  it.runIf(hasGit())('real repo: .git tree unchanged after gitLog', async () => {
    const repo = path.join(uni, 'real')
    fs.mkdirSync(repo, { recursive: true })
    fs.writeFileSync(path.join(repo, 'CONTEXT.md'), 'hello\n')
    fs.writeFileSync(path.join(repo, '.env'), 'X=1\n')
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    const git = (...a: string[]): void => {
      execFileSync(
        'git',
        ['-C', repo, '-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', ...a],
        { env, stdio: 'ignore' }
      )
    }
    git('init', '-q')
    git('add', '-A')
    git('commit', '-q', '--no-gpg-sign', '-m', 'first commit')
    const before = tree(path.join(repo, '.git'))
    const commits = await gitLog(guard(), repo)
    expect(commits).toHaveLength(1)
    expect(commits![0].subject).toBe('first commit')
    expect(commits![0].files).toEqual(['CONTEXT.md'])
    expect(commits![0].date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(tree(path.join(repo, '.git'))).toBe(before)
  })
})
