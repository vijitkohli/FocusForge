import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PathGuard } from './guard'
import { planWatches, relevantEvent } from './watch'

let tmp: string
let vault: string
let uni: string

function guard(): PathGuard {
  return new PathGuard({
    sourceRoots: [uni],
    vaultRoots: [vault],
    readableVault: vault,
    caseInsensitive: true
  })
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-watch-')))
  vault = path.join(tmp, 'Vault')
  uni = path.join(tmp, 'UNI')
  for (const d of [
    path.join(vault, '.obsidian'),
    path.join(vault, 'Learning/Thesis Hub'),
    path.join(vault, 'Life'),
    path.join(vault, 'FocusForge/Learning'),
    path.join(uni, 'thesis'),
    path.join(uni, 'notes-vault/.obsidian')
  ]) {
    fs.mkdirSync(d, { recursive: true })
  }
  fs.writeFileSync(path.join(vault, 'Projects.md'), '## FocusForge\n')
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('relevantEvent', () => {
  it('drops noise, secrets, .env, Life and temp files', () => {
    for (const n of [
      'node_modules/x/index.js',
      '.env',
      'sub/.env.local',
      '..env.icloud',
      'api_key.txt',
      'secrets/a.md',
      'API TOKEN.rtf',
      '.venv/lib/x.py',
      'build/out.md',
      'Life/Journal/day.md',
      'life',
      '.DS_Store',
      'notes/.DS_Store',
      'draft.md.swp',
      'x.tmp',
      '~$essay.docx',
      '.~lock.essay.docx#',
      '.git/index',
      '.git/objects/ab/cdef',
      '.obsidian/workspace.json'
    ]) {
      expect(relevantEvent(n)).toBeNull()
    }
    for (const n of [
      'CONTEXT.md',
      'research/status.md',
      'src/keyboard.ts',
      'Learning/Life Sciences.md'
    ]) {
      expect(relevantEvent(n)).toBe('files')
    }
  })

  it('maps .git HEAD and branch refs to git', () => {
    expect(relevantEvent('.git/logs/HEAD')).toBe('git')
    expect(relevantEvent('.git/HEAD')).toBe('git')
    expect(relevantEvent('.git/refs/heads/main')).toBe('git')
  })

  it('null filename counts as a change', () => {
    expect(relevantEvent(null)).toBe('files')
    expect(relevantEvent(Buffer.from('CONTEXT.md'))).toBe('files')
  })
})

describe('planWatches', () => {
  it('never watches a vault root; single notes are polled; named subfolders are watched', async () => {
    const plan = await planWatches(guard(), [
      vault,
      path.join(vault, 'Learning/Thesis Hub'),
      `${path.join(vault, 'Projects.md')}#FocusForge`,
      path.join(vault, 'Life'),
      path.join(vault, 'FocusForge/Learning'),
      path.join(uni, 'thesis'),
      path.join(uni, 'notes-vault'),
      uni,
      tmp,
      path.join(uni, 'missing')
    ])
    expect(plan.recursive).toEqual([
      path.join(vault, 'Learning/Thesis Hub'),
      path.join(uni, 'thesis')
    ])
    expect(plan.poll).toEqual([path.join(vault, 'Projects.md')])
    expect(plan.skipped).toBe(7)
  })
})
