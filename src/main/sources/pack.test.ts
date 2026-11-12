import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PathGuard, nodeGuardFs, type GuardFs } from './guard'
import { buildPack, isMyNotesRef, type BuildPackDeps } from './pack'
import type { GitLogFn } from './git'
import type { DocTextFn } from './doctext'
import type { ContextPack } from '../../common/readers'
import { packToPromptText } from './packPrompt'

// Temp fixture only (never the real vault, ~/UNI or ~/Projects).
let tmp: string
let home: string
let vault: string
let uni: string
let projects: string
let flow: string

const LIFE = 'LIFE-CANARY-7f3a'
const SECRET = 'SECRET-CANARY-9b2c'
const SECTION = 'SECTION-CANARY-2e8d'
const APPNOTE = 'APP-NOTE-CANARY-11aa'
const SK = 'sk-test-ABCDEFGHIJKLMNOP123456'

function write(p: string, text = 'x', mtime?: Date): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
  if (mtime) fs.utimesSync(p, mtime, mtime)
}

function tracingFs(log: string[]): GuardFs {
  return {
    realpathSync: (p) => (log.push(`realpath:${p}`), nodeGuardFs.realpathSync(p)),
    lstatSync: (p) => (log.push(`lstat:${p}`), nodeGuardFs.lstatSync(p)),
    promises: {
      opendir: (p) => (log.push(`opendir:${p}`), nodeGuardFs.promises.opendir(p)),
      lstat: (p) => (log.push(`lstat:${p}`), nodeGuardFs.promises.lstat(p)),
      open: (p, f) => (log.push(`open:${p}`), nodeGuardFs.promises.open(p, f))
    }
  }
}

function guard(log?: string[]): PathGuard {
  return new PathGuard({
    sourceRoots: [uni, projects],
    vaultRoots: [vault],
    readableVault: vault,
    writableRoots: [flow],
    caseInsensitive: true,
    ...(log ? { fsImpl: tracingFs(log) } : {})
  })
}

const noGit: GitLogFn = async () => null
const fakeDoc: DocTextFn = async (abs) => ({
  text: `DOC TEXT of ${path.basename(abs)}`,
  hash: `h-${path.basename(abs)}`,
  bytesRead: 10
})
const deps = (over: Partial<BuildPackDeps> = {}): BuildPackDeps => ({
  git: noGit,
  docText: fakeDoc,
  now: () => new Date('2026-11-11T12:00:00'),
  ...over
})

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-pack-')))
  home = path.join(tmp, 'home')
  vault = path.join(home, 'Vault')
  uni = path.join(home, 'UNI')
  projects = path.join(home, 'Projects')
  flow = path.join(tmp, 'flowstate')
  fs.mkdirSync(flow, { recursive: true })
  const old = new Date('2026-10-01T12:00:00')
  write(
    path.join(uni, 'thesis/CONTEXT.md'),
    `# Thesis\nWhat this is: a thesis.\nWeek 11 presentation date TBC.\nkey ${SK}\n`
  )
  write(path.join(uni, 'thesis/research/status.md'), 'Status: drafting\n')
  write(path.join(uni, 'thesis/README.md'), '# readme\n', old)
  write(path.join(uni, 'thesis/.env'), `TOKEN=${SECRET}`)
  write(path.join(uni, 'thesis/api_key.txt'), SECRET)
  write(path.join(uni, 'thesis/node_modules/x.md'), SECRET)
  write(path.join(uni, 'thesis/bin.txt'), 'abc\0def')
  for (let i = 0; i < 5; i++) write(path.join(uni, `thesis/notes/n${i}.md`), `note ${i}\n`, old)
  write(path.join(uni, 'thesis/big.md'), 'H'.repeat(80_000) + 'T'.repeat(80_000))
  write(path.join(uni, 'comp9321/ass1/spec.pdf'), '%PDF-1.4 fake')
  write(path.join(uni, 'comp9321/lecture.pdf'), '%PDF-1.4 fake')
  write(
    path.join(uni, 'comp9321/ass1.ipynb'),
    JSON.stringify({
      cells: [
        { cell_type: 'markdown', source: '# Q1' },
        { cell_type: 'code', source: 'x=1', outputs: [{ data: 'BASE64OUTPUT' }] }
      ]
    })
  )
  fs.symlinkSync(path.join(vault, 'Life'), path.join(uni, 'comp9321/linked-life'))
  write(path.join(vault, '.obsidian/app.json'), '{}')
  write(
    path.join(vault, 'Projects/PROJECTS TO DO.md'),
    `# Projects\n## FocusForge\n- [ ] ship readers\n## Headstart\n${SECTION}\n`
  )
  write(path.join(vault, 'Projects/PERSONAL WEB.md'), 'web plans\n')
  write(path.join(vault, 'Projects/PERSONAL WEB 2.md'), 'conflict copy\n')
  write(path.join(vault, 'Learning/Thesis Hub/Thesis.md'), 'hub note\n')
  write(path.join(vault, 'Learning/Thesis Hub/.Thesis notes.md.icloud'), 'stub')
  write(path.join(vault, 'Learning/Thesis Hub/PERSONAL 2.md'), 'not a conflict (no base)\n')
  write(
    path.join(vault, 'FocusForge/Learning/Thesis/Thesis.md'),
    `# Thesis\n## State (auto)\n${APPNOTE}\n## My notes\nmine\n### sub\nmore mine\n`
  )
  write(path.join(vault, 'Life/CANARY-LIFE-DO-NOT-READ.md'), LIFE)
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function allText(pack: ContextPack): string {
  return JSON.stringify(pack)
}

describe('buildPack', () => {
  it('builds a pack for a folder source with CONTEXT first', async () => {
    const pack = await buildPack(
      guard(),
      { id: 'thesis', sources: [path.join(uni, 'thesis')] },
      null,
      deps()
    )
    expect(pack.files[0]).toMatchObject({
      id: 'F1',
      label: 'thesis/CONTEXT.md',
      kind: 'context',
      changed: true
    })
    expect(pack.files[0].redactions).toBe(1)
    expect(pack.files[0].text).toContain('[redacted]')
    const labels = pack.files.map((f) => f.label)
    expect(labels).toContain('thesis/README.md')
    expect(labels).toContain('thesis/research/status.md')
    // agent files (tier 2) come before other notes (tier 5)
    expect(labels.indexOf('thesis/README.md')).toBeLessThan(labels.indexOf('thesis/notes/n0.md'))
    expect(pack.index.find((e) => e.label === 'thesis/bin.txt')?.note).toBe('binary')
    const big = pack.files.find((f) => f.label === 'thesis/big.md')!
    expect(big.truncated).toBe(true)
    expect(big.chars).toBeLessThanOrEqual(30_000)
    expect(big.text.startsWith('HHHH')).toBe(true)
    expect(big.text.endsWith('TTTT')).toBe(true)
    expect(pack.sources).toEqual([
      { ref: path.join(uni, 'thesis'), state: 'ok', files: expect.any(Number) }
    ])
    expect(pack.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(pack.activityAt).not.toBeNull()
  })

  it('section source includes only that section', async () => {
    const ref = `${path.join(vault, 'Projects/PROJECTS TO DO.md')}#FocusForge`
    const pack = await buildPack(guard(), { id: 'ff', sources: [ref] }, null, deps())
    expect(pack.files).toHaveLength(1)
    expect(pack.files[0]).toMatchObject({
      label: 'vault:Projects/PROJECTS TO DO.md#FocusForge',
      kind: 'vault'
    })
    expect(pack.files[0].text).toBe('## FocusForge\n- [ ] ship readers')
    expect(allText(pack)).not.toContain(SECTION)
  })

  it('section-missing includes nothing from the note', async () => {
    const ref = `${path.join(vault, 'Projects/PROJECTS TO DO.md')}#Nope`
    const pack = await buildPack(guard(), { id: 'ff', sources: [ref] }, null, deps())
    expect(pack.files).toEqual([])
    expect(pack.sources[0].state).toBe('section-missing')
    expect(allText(pack)).not.toContain('ship readers')
  })

  it('vault root (and anything above a root) as a folder source is too-broad', async () => {
    const pack = await buildPack(guard(), { id: 'x', sources: [vault, uni, home] }, null, deps())
    expect(pack.sources.map((s) => s.state)).toEqual(['too-broad', 'too-broad', 'denied'])
    expect(pack.files).toEqual([])
  })

  it('skips the vault FocusForge app folder, except My notes refs', async () => {
    const appNote = path.join(vault, 'FocusForge/Learning/Thesis/Thesis.md')
    const pack = await buildPack(
      guard(),
      { id: 't', sources: [path.join(vault, 'FocusForge'), appNote, `${appNote}#My notes`] },
      null,
      deps({}),
      {
        virtualRefs: [
          `${appNote}#My notes`,
          `${appNote}#State (auto)`,
          path.join(vault, 'Projects/PERSONAL WEB.md')
        ]
      }
    )
    expect(pack.sources.map((s) => [s.state, s.reason ?? null, s.virtual ?? false])).toEqual([
      ['denied', 'app-folder', false],
      ['denied', 'app-folder', false],
      ['denied', 'app-folder', false],
      ['ok', null, true]
    ])
    expect(pack.files).toHaveLength(1)
    expect(pack.files[0].label).toBe('vault:FocusForge/Learning/Thesis/Thesis.md#My notes')
    expect(pack.files[0].text).toBe('## My notes\nmine\n### sub\nmore mine')
    expect(allText(pack)).not.toContain(APPNOTE)
    expect(isMyNotesRef(`${appNote}#my notes`, vault, (p) => p.toLowerCase())).toBe(true)
    expect(isMyNotesRef(`${path.join(vault, 'Projects/x.md')}#My notes`, vault, (p) => p)).toBe(
      false
    )
    expect(isMyNotesRef(`${path.join(vault, 'FocusForge/x.md')}#State`, vault, (p) => p)).toBe(
      false
    )
  })

  it('reuses excerpts when mtime and size are unchanged (no read in trace)', async () => {
    const src = { id: 'thesis', sources: [path.join(uni, 'thesis')] }
    const first = await buildPack(guard(), src, null, deps())
    const log: string[] = []
    const second = await buildPack(guard(log), src, first, deps())
    expect(second.files.map((f) => f.text)).toEqual(first.files.map((f) => f.text))
    expect(second.files.every((f) => !f.changed)).toBe(true)
    expect(second.fingerprint).toBe(first.fingerprint)
    // Only stats/walks happened: no file was opened for reading.
    expect(log.filter((p) => p.startsWith('open:'))).toEqual([])
    const g = guard()
    const spy = vi.spyOn(g, 'readTextPrefix')
    const spy2 = vi.spyOn(g, 'readHeadTail')
    await buildPack(g, src, first, deps())
    expect(spy).not.toHaveBeenCalled()
    expect(spy2).not.toHaveBeenCalled()
  })

  it('mtime-only change with the same hash is not marked changed', async () => {
    const src = { id: 'thesis', sources: [path.join(uni, 'thesis')] }
    const first = await buildPack(guard(), src, null, deps())
    const f = path.join(uni, 'thesis/research/status.md')
    const t = new Date('2026-11-05T12:00:00')
    fs.utimesSync(f, t, t)
    const second = await buildPack(guard(), src, first, deps())
    const entry = second.files.find((x) => x.label === 'thesis/research/status.md')!
    expect(entry.changed).toBe(false)
    expect(second.fingerprint).toBe(first.fingerprint)
    write(f, 'Status: submitted\n')
    const third = await buildPack(guard(), src, second, deps())
    expect(third.files.find((x) => x.label === 'thesis/research/status.md')!.changed).toBe(true)
    expect(third.fingerprint).not.toBe(first.fingerprint)
  })

  it('iCloud stubs are listed as not-downloaded and never opened; conflict copies excluded and counted', async () => {
    const log: string[] = []
    const pack = await buildPack(
      guard(log),
      {
        id: 'web',
        sources: [path.join(vault, 'Learning/Thesis Hub'), path.join(vault, 'Projects')]
      },
      null,
      deps()
    )
    expect(pack.notDownloaded).toBe(1)
    expect(
      pack.index.find((e) => e.label === 'vault:Learning/Thesis Hub/Thesis notes.md')?.note
    ).toBe('not-downloaded')
    expect(log.filter((p) => p.endsWith('.icloud')).every((p) => !p.includes('open'))).toBe(true)
    expect(pack.conflicts).toBe(1)
    const labels = pack.files.map((f) => f.label)
    expect(labels).toContain('vault:Projects/PERSONAL WEB.md')
    expect(labels).not.toContain('vault:Projects/PERSONAL WEB 2.md')
    expect(labels).toContain('vault:Learning/Thesis Hub/PERSONAL 2.md')
  })

  it('labels are relative and never contain the vault name or home', async () => {
    const pack = await buildPack(
      guard(),
      {
        id: 'all',
        sources: [
          path.join(uni, 'thesis'),
          path.join(uni, 'comp9321'),
          path.join(vault, 'Projects'),
          `${path.join(vault, 'Projects/PROJECTS TO DO.md')}#FocusForge`
        ]
      },
      null,
      deps()
    )
    const labels = [
      ...pack.files.map((f) => f.label),
      ...pack.index.map((e) => e.label),
      ...Object.keys(pack.seen),
      ...pack.git.map((g) => g.label)
    ]
    expect(labels.length).toBeGreaterThan(5)
    for (const l of labels) {
      expect(path.isAbsolute(l)).toBe(false)
      expect(l.includes(home)).toBe(false)
      expect(l.includes('Vault')).toBe(false)
    }
    const prompt = packToPromptText(pack)
    expect(prompt.includes(tmp)).toBe(false)
  })

  it('includes brief PDFs and notebook markdown, not other PDFs or outputs', async () => {
    const pack = await buildPack(
      guard(),
      { id: 'c', sources: [path.join(uni, 'comp9321')] },
      null,
      deps()
    )
    const spec = pack.files.find((f) => f.label === 'comp9321/ass1/spec.pdf')
    expect(spec).toMatchObject({ kind: 'brief', text: 'DOC TEXT of spec.pdf' })
    expect(pack.files.find((f) => f.label === 'comp9321/lecture.pdf')).toBeUndefined()
    expect(pack.index.some((e) => e.label === 'comp9321/lecture.pdf')).toBe(true)
    const nb = pack.files.find((f) => f.label === 'comp9321/ass1.ipynb')!
    expect(nb.text).toContain('# %% [markdown]\n# Q1')
    expect(nb.text).not.toContain('BASE64OUTPUT')
  })

  it('canary: Life, .env, api_key and the linked-life symlink never appear in trace, pack or labels', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    )
    const log: string[] = []
    const g = guard(log)
    const docCalls: string[] = []
    const pack = await buildPack(
      g,
      {
        id: 'all',
        sources: [
          path.join(uni, 'thesis'),
          path.join(uni, 'comp9321'),
          path.join(vault, 'Learning'),
          path.join(vault, 'Life'),
          path.join(vault, 'Life/CANARY-LIFE-DO-NOT-READ.md'),
          path.join(uni, 'comp9321/linked-life'),
          path.join(uni, 'thesis/.env')
        ]
      },
      null,
      deps({ docText: async (abs, ...rest) => (docCalls.push(abs), fakeDoc(abs, ...rest)) })
    )
    const blob = allText(pack) + packToPromptText(pack)
    for (const c of [LIFE, SECRET, SK]) expect(blob.includes(c)).toBe(false)
    expect(blob.includes('CANARY-LIFE')).toBe(false)
    const lifeDir = path.join(vault, 'Life')
    expect(log.some((p) => p.includes('CANARY-LIFE') || p.includes(lifeDir))).toBe(false)
    // Secrets may be name-checked, never opened or listed.
    expect(
      log.some(
        (p) => /^(open|opendir):/.test(p) && (p.endsWith('.env') || p.endsWith('api_key.txt'))
      )
    ).toBe(false)
    expect(log.some((p) => p.includes('node_modules'))).toBe(false)
    expect(docCalls.every((p) => !p.includes('Life'))).toBe(true)
    expect(pack.sources.slice(3).map((s) => s.state)).toEqual([
      'denied',
      'denied',
      'denied',
      'denied'
    ])
    expect(pack.sources.slice(3).map((s) => s.reason)).toEqual(['life', 'life', 'life', 'secret'])
    const output = spies
      .flatMap((s) => s.mock.calls.flat())
      .map(String)
      .join('\n')
    expect(output.includes('Life')).toBe(false)
  })

  it('stops at the deadline and marks the pack truncated', async () => {
    const pack = await buildPack(
      guard(),
      { id: 'thesis', sources: [path.join(uni, 'thesis')] },
      null,
      deps(),
      { deadlineMs: -1 }
    )
    expect(pack.truncated).toBe(true)
    expect(pack.files).toEqual([])
  })

  it('adds git blocks for repo roots and reports git-unavailable', async () => {
    fs.mkdirSync(path.join(projects, 'site/.git'), { recursive: true })
    write(path.join(projects, 'site/CONTEXT.md'), 'site context\n')
    const git: GitLogFn = async () => [
      {
        hash: 'abc1234',
        date: '2026-11-10T10:00:00+11:00',
        subject: 'ship it',
        files: ['index.html']
      }
    ]
    const pack = await buildPack(
      guard(),
      { id: 's', sources: [path.join(projects, 'site')] },
      null,
      deps({ git })
    )
    expect(pack.git).toEqual([
      {
        id: 'G1',
        label: 'git:site',
        head: 'abc1234',
        commits: expect.any(Array),
        text: '2026-11-10 abc1234 ship it\n    index.html'
      }
    ])
    const fp1 = pack.fingerprint
    const git2: GitLogFn = async () => [
      { hash: 'def5678', date: '2026-11-11T10:00:00+11:00', subject: 'more', files: [] }
    ]
    const pack2 = await buildPack(
      guard(),
      { id: 's', sources: [path.join(projects, 'site')] },
      pack,
      deps({ git: git2 })
    )
    expect(pack2.fingerprint).not.toBe(fp1)
    const gitless = await buildPack(
      guard(),
      { id: 's', sources: [path.join(projects, 'site')] },
      null,
      deps()
    )
    expect(gitless.git).toEqual([])
    expect(gitless.sources[0].state).toBe('ok')
  })
})
