import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  GuardConfig,
  GuardFs,
  PathGuard,
  WalkEntry,
  expandHome,
  foldPath,
  nodeGuardFs
} from './guard'

// Fixture (temp dir only):
//   vault/ (.obsidian, .trash, Life/canary.md, Life/Journal/x.md, Learning/..., Projects/...)
//   uni/  projects/  outside/  other-vault/ (a second obsidian.json vault, not readable)
let tmp: string
let vault: string
let uni: string
let projects: string
let outside: string
let flow: string

function write(p: string, contents = 'x'): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, contents)
}

function guard(extra: Partial<GuardConfig> = {}): PathGuard {
  return new PathGuard({
    sourceRoots: [uni, projects],
    vaultRoots: [vault],
    readableVault: vault,
    writableRoots: [flow],
    caseInsensitive: true,
    ...extra
  })
}

/** Records every path the guard hands to the filesystem. */
function tracingFs(log: string[]): GuardFs {
  return {
    realpathSync: (p) => (log.push(p), nodeGuardFs.realpathSync(p)),
    lstatSync: (p) => (log.push(p), nodeGuardFs.lstatSync(p)),
    promises: {
      opendir: (p) => (log.push(p), nodeGuardFs.promises.opendir(p)),
      lstat: (p) => (log.push(p), nodeGuardFs.promises.lstat(p)),
      open: (p, f) => (log.push(p), nodeGuardFs.promises.open(p, f))
    }
  }
}

async function collect(g: PathGuard, root: string, maxDepth = 10): Promise<WalkEntry[]> {
  const out: WalkEntry[] = []
  for await (const e of g.walk(root, { maxDepth, maxEntries: 10_000 })) out.push(e)
  return out
}

const underLife = (p: string): boolean =>
  foldPath(p, true).startsWith(foldPath(path.join(vault, 'life'), true))

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-guard-')))
  vault = path.join(tmp, 'vault')
  uni = path.join(tmp, 'uni')
  projects = path.join(tmp, 'projects')
  outside = path.join(tmp, 'outside')
  flow = path.join(tmp, 'flowstate')
  write(path.join(vault, '.obsidian', 'app.json'), '{}')
  write(path.join(vault, '.trash', 'x.md'))
  write(path.join(vault, 'Life', 'canary.md'), 'CANARY-LIFE')
  write(path.join(vault, 'Life', 'Journal', 'x.md'), 'CANARY-LIFE')
  write(path.join(vault, 'Learning', 'Practice.md'))
  write(path.join(vault, 'Learning', 'Life Sciences.md'))
  write(path.join(vault, 'Projects', 'Life', 'x.md'))
  write(path.join(vault, 'Projects', 'IDEAS TO DO.md'), '## FocusForge\n')
  write(path.join(vault, 'FocusForge', 'Life', 'Reading', 'Reading.md'))
  write(path.join(uni, 'course1', 'notes.md'))
  write(path.join(uni, 'SERVICE PAT.rtf'), 'CANARY-SECRET')
  write(path.join(uni, 'course1', 'node_modules', 'x', 'index.js'))
  write(path.join(projects, 'game', 'src', 'life', 'a.ts'))
  write(path.join(projects, '.env'), 'CANARY-SECRET')
  write(path.join(projects, 'notes-vault', '.obsidian', 'app.json'), '{}')
  write(path.join(projects, 'notes-vault', 'Life', 'canary.md'), 'CANARY-LIFE')
  write(path.join(projects, 'notes-vault', 'Ideas', 'a.md'))
  write(path.join(projects, 'old-vault', 'Life', 'canary.md'), 'CANARY-LIFE')
  write(path.join(projects, 'old-vault', 'Notes', 'a.md'))
  write(path.join(outside, 'private.txt'), 'outside')
  fs.mkdirSync(flow, { recursive: true })
  fs.symlinkSync(path.join(vault, 'Life'), path.join(uni, 'linked-life'))
  fs.symlinkSync(vault, path.join(outside, 'vaultlink'))
  fs.symlinkSync(path.join(outside, 'private.txt'), path.join(vault, 'Learning', 'escape.txt'))
  fs.symlinkSync(path.join(uni, 'loop'), path.join(uni, 'loop'), 'dir')
  fs.mkdirSync(path.join(uni, 'cycle'))
  fs.symlinkSync(path.join(uni, 'cycle'), path.join(uni, 'cycle', 'again'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('Life rules', () => {
  it('denies vault Life folder and every descendant', () => {
    const g = guard()
    for (const p of [
      'Life',
      'Life/canary.md',
      'Life/Journal',
      'Life/Journal/x.md',
      'Life/missing'
    ]) {
      expect(g.check(path.join(vault, p))).toEqual({ ok: false, reason: 'life' })
    }
  })

  it('denies Life with different case', () => {
    const g = guard()
    for (const n of ['life', 'LIFE', 'LiFe']) {
      expect(g.check(path.join(vault, n, 'x.md'))).toEqual({ ok: false, reason: 'life' })
    }
    // vault root itself in another case
    expect(g.check(path.join(tmp, 'VAULT', 'Life', 'x.md'))).toEqual({ ok: false, reason: 'life' })
  })

  it('denies iCloud conflict copy "Life 2"', () => {
    expect(guard().check(path.join(vault, 'Life 2', 'a.md'))).toEqual({ ok: false, reason: 'life' })
    expect(guard().check(path.join(vault, '.Life.icloud'))).toEqual({ ok: false, reason: 'life' })
  })

  it('denies NFD-encoded Life path', () => {
    const g = guard()
    expect(g.check(path.join(vault, 'Life'.normalize('NFD'), 'x.md')).ok).toBe(false)
    const accented = path.join(tmp, 'Notés'.normalize('NFC'))
    fs.mkdirSync(path.join(accented, '.obsidian'), { recursive: true })
    const g2 = guard({ vaultRoots: [accented], readableVault: accented })
    const nfd = path.join(tmp, 'Notés'.normalize('NFD'), 'Life', 'x.md')
    expect(g2.check(nfd)).toEqual({ ok: false, reason: 'life' })
    expect(g2.check(path.join(tmp, 'Notés'.normalize('NFD'), 'Learning', 'a.md')).ok).toBe(true)
  })

  it('denies Life reached through ..', () => {
    expect(guard().check(`${vault}/Learning/../Life/canary.md`)).toEqual({
      ok: false,
      reason: 'life'
    })
  })

  it('denies symlink in uni that points into vault/Life', () => {
    const g = guard()
    expect(g.check(path.join(uni, 'linked-life'))).toEqual({ ok: false, reason: 'life' })
    expect(g.check(path.join(uni, 'linked-life', 'canary.md'))).toEqual({
      ok: false,
      reason: 'life'
    })
  })

  it('denies symlinked vault root alias', () => {
    expect(guard().check(path.join(outside, 'vaultlink', 'Life', 'canary.md'))).toEqual({
      ok: false,
      reason: 'life'
    })
  })

  it('denies Life in every obsidian.json vault even when not the readable vault', () => {
    const old = path.join(projects, 'old-vault')
    const g = guard({ vaultRoots: [vault, old] })
    expect(g.check(path.join(old, 'Life', 'canary.md'))).toEqual({ ok: false, reason: 'life' })
    expect(g.check(path.join(old, 'Notes', 'a.md')).ok).toBe(true)
  })

  it('allows a folder named life outside the vault top level', () => {
    const g = guard()
    expect(g.check(path.join(projects, 'game', 'src', 'life', 'a.ts')).ok).toBe(true)
    expect(g.check(path.join(vault, 'Learning', 'Life Sciences.md')).ok).toBe(true)
    expect(g.check(path.join(vault, 'Projects', 'Life', 'x.md')).ok).toBe(true)
  })

  it('allows vault FocusForge/Life (app-owned) while denying vault Life', () => {
    const g = guard()
    expect(g.check(path.join(vault, 'FocusForge', 'Life', 'Reading', 'Reading.md')).ok).toBe(true)
    expect(g.check(path.join(vault, 'Life', 'x.md'))).toEqual({ ok: false, reason: 'life' })
  })

  it('allowlist permits only the exact listed file', () => {
    const g = guard({ lifeAllowlist: ['Life/Allowed.md'] })
    expect(g.check(path.join(vault, 'Life', 'Allowed.md')).ok).toBe(true)
    expect(g.check(path.join(vault, 'life', 'allowed.md')).ok).toBe(true)
    expect(g.check(path.join(vault, 'Life', 'other.md')).ok).toBe(false)
    expect(g.check(`${vault}/Life/Allowed.md/../x`).ok).toBe(false)
    expect(g.check(path.join(vault, 'Life')).ok).toBe(false)
  })

  it('walk never opens or lists Life even with an allowlist', async () => {
    const log: string[] = []
    const g = guard({ lifeAllowlist: ['Life/Allowed.md'], fsImpl: tracingFs(log) })
    const entries = await collect(g, vault)
    expect(entries.length).toBeGreaterThan(0)
    expect(log.length).toBeGreaterThan(0)
    expect(log.filter(underLife)).toEqual([])
    expect(entries.some((e) => underLife(e.path))).toBe(false)
    expect(entries.some((e) => e.path.includes('canary'))).toBe(false)
  })

  it('walk treats a nested dir with .obsidian as a vault and skips its Life', async () => {
    const log: string[] = []
    const g = guard({ fsImpl: tracingFs(log) })
    const nested = path.join(projects, 'notes-vault')
    const entries = await collect(g, projects)
    expect(entries.some((e) => e.path === path.join(nested, 'Ideas', 'a.md'))).toBe(true)
    expect(entries.some((e) => e.path.startsWith(path.join(nested, 'Life')))).toBe(false)
    expect(log.some((p) => p.startsWith(path.join(nested, 'Life')))).toBe(false)
    expect(g.check(path.join(nested, 'Life', 'canary.md'))).toEqual({ ok: false, reason: 'life' })
  })
})

describe('roots, symlinks, secrets and noise', () => {
  it('denies symlink in vault pointing outside roots', () => {
    expect(guard().check(path.join(vault, 'Learning', 'escape.txt'))).toEqual({
      ok: false,
      reason: 'outside-roots'
    })
  })

  it('denies paths outside roots and ancestors of roots', () => {
    const g = guard()
    for (const p of [
      '/',
      os.homedir(),
      tmp,
      path.dirname(vault),
      path.join(outside, 'private.txt')
    ]) {
      expect(g.check(p)).toEqual({ ok: false, reason: 'outside-roots' })
    }
  })

  it('allows the roots themselves and ordinary files', () => {
    const g = guard()
    for (const p of [uni, projects, vault, path.join(uni, 'course1', 'notes.md')]) {
      expect(g.check(p).ok).toBe(true)
    }
  })

  it('denies relative paths', () => {
    expect(guard().check('uni/course1')).toEqual({ ok: false, reason: 'not-absolute' })
    expect(guard().check('')).toEqual({ ok: false, reason: 'not-absolute' })
  })

  it('denies secret names', () => {
    const g = guard()
    for (const p of [
      path.join(uni, 'SERVICE PAT.rtf'),
      path.join(uni, '.SERVICE PAT.rtf.icloud'),
      path.join(projects, '.env'),
      path.join(projects, 'app', '.env.local'),
      path.join(projects, 'app', '.envrc'),
      path.join(projects, 'app', 'secrets', 'db.txt'),
      path.join(projects, 'app', 'aws-keys.json')
    ]) {
      expect(g.check(p)).toEqual({ ok: false, reason: 'secret' })
    }
    expect(g.check(path.join(projects, 'app', 'keyboard.md')).ok).toBe(true)
  })

  it('denies noise dirs', () => {
    const g = guard()
    for (const rel of [
      'node_modules',
      'node_modules/x/index.js',
      '.git/HEAD',
      '.venv/bin/python',
      'env/lib/x.py',
      'dist/a.js',
      'out/a.js',
      'build/a.js',
      'target/a',
      '__pycache__/a.pyc',
      'a/node_modules/b'
    ]) {
      expect(g.check(path.join(projects, 'app', rel))).toEqual({ ok: false, reason: 'noise' })
    }
  })

  it('denies vault config', () => {
    const g = guard()
    expect(g.check(path.join(vault, '.obsidian', 'app.json'))).toEqual({
      ok: false,
      reason: 'vault-config'
    })
    expect(g.check(path.join(vault, '.trash', 'x.md'))).toEqual({
      ok: false,
      reason: 'vault-config'
    })
    expect(g.check(path.join(vault, '.obsidian'))).toEqual({ ok: false, reason: 'vault-config' })
  })

  it('checkSource strips the heading and denies Life refs', () => {
    const g = guard()
    expect(g.checkSource(`${vault}/Life/Allowed.md#Goals`)).toEqual({ ok: false, reason: 'life' })
    expect(g.checkSource(`${uni}/SERVICE PAT.rtf#x`)).toEqual({ ok: false, reason: 'secret' })
    expect(g.checkSource(`${vault}/Projects/IDEAS TO DO.md#FocusForge`).ok).toBe(true)
    expect(g.checkSource(`${vault}/Projects/IDEAS TO DO.md#../../Life/x`).ok).toBe(true)
  })

  it('walk skips symlinks, secrets and noise and does not loop', async () => {
    const entries = await collect(guard(), uni)
    const names = entries.map((e) => path.relative(uni, e.path))
    expect(names).toContain(path.join('course1', 'notes.md'))
    expect(names).toContain('cycle')
    expect(names.some((n) => n.includes('linked-life'))).toBe(false)
    expect(names.some((n) => n.includes('again'))).toBe(false)
    expect(names.some((n) => n.includes('loop'))).toBe(false)
    expect(names.some((n) => n.includes('PAT'))).toBe(false)
    expect(names.some((n) => n.includes('node_modules'))).toBe(false)
  })

  it('walk skips vault config and never returns denied entries', async () => {
    const g = guard()
    const entries = await collect(g, vault)
    expect(entries.some((e) => e.path.includes('.obsidian') || e.path.includes('.trash'))).toBe(
      false
    )
    expect(entries.some((e) => e.path.endsWith('escape.txt'))).toBe(false)
    for (const e of entries) expect(g.check(e.path).ok).toBe(true)
  })

  it('walk of a denied root yields nothing', async () => {
    const g = guard()
    const it1 = g.walk(path.join(vault, 'Life'), { maxDepth: 3, maxEntries: 10 })
    const r = await it1.next()
    expect(r).toEqual({ done: true, value: { truncated: false, denied: 'life' } })
    expect(await g.listDir(outside)).toEqual([])
  })

  it('walk respects maxDepth, maxEntries, deadline and abort and reports truncated', async () => {
    const big = path.join(projects, 'big')
    for (let i = 0; i < 30; i++) write(path.join(big, `d${i % 3}`, `deep`, `f${i}.md`))
    const g = guard()

    const shallow = await g.listDir(big)
    expect(shallow.map((e) => e.name).sort()).toEqual(['d0', 'd1', 'd2'])
    expect(shallow.every((e) => e.depth === 0 && e.isDir)).toBe(true)

    const depth1: WalkEntry[] = []
    for await (const e of g.walk(big, { maxDepth: 1, maxEntries: 1000 })) depth1.push(e)
    expect(depth1.some((e) => e.name.endsWith('.md'))).toBe(false)

    const run = async (
      opts: Parameters<PathGuard['walk']>[1]
    ): Promise<{ n: number; stats: unknown }> => {
      const gen = g.walk(big, opts)
      let n = 0
      for (;;) {
        const r = await gen.next()
        if (r.done) return { n, stats: r.value }
        n++
      }
    }
    expect(await run({ maxDepth: 5, maxEntries: 5 })).toEqual({
      n: 5,
      stats: { truncated: true, reason: 'entries' }
    })
    expect((await run({ maxDepth: 5, maxEntries: 1000, deadline: Date.now() - 1 })).stats).toEqual({
      truncated: true,
      reason: 'deadline'
    })
    const ac = new AbortController()
    ac.abort()
    expect((await run({ maxDepth: 5, maxEntries: 1000, signal: ac.signal })).stats).toEqual({
      truncated: true,
      reason: 'aborted'
    })
    expect(await run({ maxDepth: 5, maxEntries: 1000 })).toEqual({
      n: 36,
      stats: { truncated: false }
    })
  })

  it('walk unwraps iCloud stubs and skips secret stubs', async () => {
    const dir = path.join(projects, 'icloud')
    write(path.join(dir, '.Thesis.md.icloud'))
    write(path.join(dir, '.SERVICE PAT.rtf.icloud'))
    const entries = await guard().listDir(dir)
    expect(entries.map((e) => [e.name, e.icloudStub])).toEqual([['Thesis.md', true]])
  })
})

describe('case handling, reads, writes, logging', () => {
  it('case-sensitive mode still folds Life', () => {
    const g = guard({ caseInsensitive: false })
    expect(g.check(path.join(vault, 'life', 'x.md'))).toEqual({ ok: false, reason: 'life' })
    expect(g.check(path.join(vault, 'LIFE'))).toEqual({ ok: false, reason: 'life' })
  })

  it('canWrite denies source roots and vault (FocusForge too when appVaultWrite is unset), allows FlowState root', () => {
    const g = guard()
    expect(g.canWrite(path.join(flow, 'system', 'discovery.json'))).toBe(true)
    expect(g.canWrite(path.join(uni, 'course1', 'x.md'))).toBe(false)
    expect(g.canWrite(path.join(vault, 'FocusForge', 'x.md'))).toBe(false)
    expect(g.canWrite(path.join(vault, 'Life', 'x.md'))).toBe(false)
    expect(g.canWrite(path.join(outside, 'x'))).toBe(false)
    expect(g.canWrite('relative')).toBe(false)
  })

  it('canWrite allows vault FocusForge/** when appVaultWrite', () => {
    const g = guard({ appVaultWrite: true })
    expect(g.appVaultWritable()).toBe(true)
    expect(guard().appVaultWritable()).toBe(false)
    const app = path.join(vault, 'FocusForge')
    expect(g.canWrite(app)).toBe(true)
    expect(g.canWrite(path.join(app, 'Learning', 'Thesis', 'Thesis.md'))).toBe(true)
    expect(g.canWrite(path.join(app, '.tmp.nosync', 'x.tmp'))).toBe(true)
    expect(g.canWrite(path.join(app, 'New', 'Deep', 'missing.md'))).toBe(true)
    expect(g.canWrite(path.join(vault, 'focusforge', 'x.md'))).toBe(true) // APFS folds case
    expect(g.canWrite(path.join(flow, 'system', 'x.json'))).toBe(true)
    expect(
      guard({ appVaultWrite: true, readableVault: null }).canWrite(path.join(app, 'x.md'))
    ).toBe(false)
  })

  it('canWrite allows FocusForge/Life/** but denies vault Life/** and life/ LIFE/ "Life 2"', () => {
    const g = guard({ appVaultWrite: true })
    expect(g.canWrite(path.join(vault, 'FocusForge', 'Life', 'Reading', 'Reading.md'))).toBe(true)
    for (const life of ['Life', 'life', 'LIFE', 'Life 2']) {
      expect(g.canWrite(path.join(vault, life))).toBe(false)
      expect(g.canWrite(path.join(vault, life, 'canary.md'))).toBe(false)
      expect(g.canWrite(path.join(vault, life, 'FocusForge', 'x.md'))).toBe(false)
    }
    expect(g.canWrite(path.join(uni, 'linked-life', 'x.md'))).toBe(false)
  })

  it('canWrite denies vault root, vault/Learning/x.md, vault/.obsidian when appVaultWrite', () => {
    const g = guard({ appVaultWrite: true })
    expect(g.canWrite(vault)).toBe(false)
    expect(g.canWrite(path.join(vault, 'x.md'))).toBe(false)
    expect(g.canWrite(path.join(vault, 'Learning', 'x.md'))).toBe(false)
    expect(g.canWrite(path.join(vault, '.obsidian', 'app.json'))).toBe(false)
    expect(g.canWrite(path.join(vault, '.trash', 'x.md'))).toBe(false)
    expect(g.canWrite(path.join(vault, 'FocusForge 2', 'x.md'))).toBe(false)
    expect(g.canWrite(path.join(vault, 'FocusForgeX.md'))).toBe(false)
    expect(g.canWrite(path.join(uni, 'course1', 'x.md'))).toBe(false)
    expect(g.canWrite(path.join(outside, 'vaultlink', 'Learning', 'x.md'))).toBe(false)
  })

  it('canWrite denies when vault FocusForge is a symlink (to uni or to Life)', () => {
    for (const target of ['uni', 'life']) {
      const v = path.join(tmp, `sym-vault-${target}`)
      write(path.join(v, '.obsidian', 'app.json'), '{}')
      write(path.join(v, 'Life', 'canary.md'), 'CANARY-LIFE')
      fs.symlinkSync(target === 'uni' ? uni : path.join(v, 'Life'), path.join(v, 'FocusForge'))
      const g = guard({ vaultRoots: [vault, v], readableVault: v, appVaultWrite: true })
      expect(g.appVaultWritable()).toBe(false)
      expect(g.canWrite(path.join(v, 'FocusForge'))).toBe(false)
      expect(g.canWrite(path.join(v, 'FocusForge', 'x.md'))).toBe(false)
      expect(g.canWrite(path.join(v, 'FocusForge', 'course1', 'notes.md'))).toBe(false)
      expect(fs.readFileSync(path.join(v, 'Life', 'canary.md'), 'utf8')).toBe('CANARY-LIFE')
    }
  })

  it('canWrite denies FocusForge/sub symlinked to a source root or to Life', () => {
    const v = path.join(tmp, 'sub-link-vault')
    write(path.join(v, '.obsidian', 'app.json'), '{}')
    write(path.join(v, 'Life', 'canary.md'), 'CANARY-LIFE')
    write(path.join(v, 'Learning', 'x.md'))
    fs.mkdirSync(path.join(v, 'FocusForge'))
    fs.symlinkSync(uni, path.join(v, 'FocusForge', 'to-uni'))
    fs.symlinkSync(path.join(v, 'Life'), path.join(v, 'FocusForge', 'to-life'))
    fs.symlinkSync(path.join(v, 'Learning'), path.join(v, 'FocusForge', 'to-learning'))
    fs.symlinkSync(path.join(v, 'Life', 'canary.md'), path.join(v, 'FocusForge', 'note.md'))
    const g = guard({ vaultRoots: [vault, v], readableVault: v, appVaultWrite: true })
    expect(g.canWrite(path.join(v, 'FocusForge', 'ok.md'))).toBe(true)
    expect(g.canWrite(path.join(v, 'FocusForge', 'to-uni', 'x.md'))).toBe(false)
    expect(g.canWrite(path.join(v, 'FocusForge', 'to-life', 'x.md'))).toBe(false)
    expect(g.canWrite(path.join(v, 'FocusForge', 'to-life', 'canary.md'))).toBe(false)
    expect(g.canWrite(path.join(v, 'FocusForge', 'to-learning', 'x.md'))).toBe(false)
    expect(g.canWrite(path.join(v, 'FocusForge', 'note.md'))).toBe(false)
  })

  it('canWrite denies ../ traversal out of FocusForge', () => {
    const g = guard({ appVaultWrite: true })
    const app = path.join(vault, 'FocusForge')
    expect(g.canWrite(`${app}/../Learning/x.md`)).toBe(false)
    expect(g.canWrite(`${app}/../Life/canary.md`)).toBe(false)
    expect(g.canWrite(`${app}/Learning/../../x.md`)).toBe(false)
    expect(g.canWrite(`${app}/../../uni/x.md`)).toBe(false)
    expect(g.canWrite(`${app}/a/../b.md`)).toBe(true)
    expect(g.canWrite(`${app}/x\0.md`)).toBe(false)
  })

  it("canWrite denies other obsidian.json vaults' FocusForge", () => {
    const other = path.join(tmp, 'other-vault')
    write(path.join(other, '.obsidian', 'app.json'), '{}')
    write(path.join(other, 'FocusForge', 'x.md'))
    const g = guard({ vaultRoots: [vault, other], appVaultWrite: true })
    expect(g.canWrite(path.join(other, 'FocusForge', 'x.md'))).toBe(false)
    expect(g.canWrite(path.join(other, 'FocusForge'))).toBe(false)
    expect(g.canWrite(path.join(projects, 'notes-vault', 'FocusForge', 'x.md'))).toBe(false)
    expect(g.canWrite(path.join(vault, 'FocusForge', 'x.md'))).toBe(true)
  })

  it('canWrite denies FocusForge when the vault sits inside a source root', () => {
    const v = path.join(projects, 'notes-vault')
    const g = guard({ vaultRoots: [vault, v], readableVault: v, appVaultWrite: true })
    expect(g.canWrite(path.join(v, 'FocusForge', 'x.md'))).toBe(false)
  })

  it('readTextPrefix reads readable files only and caps bytes', async () => {
    const g = guard()
    const hub = path.join(vault, 'Projects', 'IDEAS TO DO.md')
    expect(await g.readTextPrefix(hub, 5)).toEqual({ text: '## Fo', truncated: true })
    expect(await g.readTextPrefix(path.join(vault, 'Life', 'canary.md'), 100)).toBeNull()
    expect(await g.readTextPrefix(path.join(uni, 'SERVICE PAT.rtf'), 100)).toBeNull()
    expect(await g.readTextPrefix(path.join(uni, 'linked-life', 'canary.md'), 100)).toBeNull()
    expect(await g.readTextPrefix(uni, 100)).toBeNull()
  })

  it('hasMarker only looks at readable dirs', async () => {
    const g = guard()
    expect(await g.hasMarker(vault, '.obsidian')).toBe(true)
    expect(await g.hasMarker(uni, '.git')).toBe(false)
    expect(await g.hasMarker(outside, '.git')).toBe(false)
  })

  it('never logs denied paths', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    )
    const g = guard()
    await collect(g, vault)
    await collect(g, uni)
    await collect(g, projects)
    g.check(path.join(vault, 'Life', 'canary.md'))
    g.check(path.join(uni, 'linked-life', 'canary.md'))
    const output = spies.flatMap((s) => s.mock.calls.flat()).map(String)
    expect(output.some((o) => o.includes('canary') || o.includes('Life'))).toBe(false)
  })

  it('expandHome and foldPath', () => {
    expect(expandHome('~', '/h')).toBe('/h')
    expect(expandHome('~/UNI', '/h')).toBe(path.join('/h', 'UNI'))
    expect(expandHome('/abs', '/h')).toBe('/abs')
    expect(foldPath('/A/b/', true)).toBe('/a/b')
    expect(foldPath('/A/b/../C', false)).toBe('/A/C')
  })
})

describe('head/tail and byte reads', () => {
  it('readHeadTail returns head and tail of a large file and flags truncation', async () => {
    const g = guard()
    const big = path.join(uni, 'course1', 'big.md')
    write(big, 'H'.repeat(100) + 'M'.repeat(1000) + 'T'.repeat(50))
    const r = await g.readHeadTail(big, 100, 50)
    expect(r?.truncated).toBe(true)
    expect(r?.size).toBe(1150)
    expect(r?.text.startsWith('H'.repeat(100) + '\n[… 1,000 bytes omitted …]\n')).toBe(true)
    expect(r?.text.endsWith('T'.repeat(50))).toBe(true)
    expect(r?.text.includes('M')).toBe(false)
    const small = await g.readHeadTail(path.join(uni, 'course1', 'notes.md'), 100, 50)
    expect(small).toEqual({ text: 'x', truncated: false, size: 1 })
  })

  it('readHeadTail and readBytes refuse Life, secrets and symlinks', async () => {
    const log: string[] = []
    const g = guard({ fsImpl: tracingFs(log) })
    for (const p of [
      path.join(vault, 'Life', 'canary.md'),
      path.join(uni, 'SERVICE PAT.rtf'),
      path.join(projects, '.env'),
      path.join(uni, 'linked-life', 'canary.md'),
      path.join(vault, 'Learning', 'escape.txt')
    ]) {
      expect(await g.readHeadTail(p, 10, 10)).toBeNull()
      expect(await g.readBytes(p, 1000)).toBeNull()
    }
    expect(log.some((p) => underLife(p) && p.includes('canary'))).toBe(false)
  })

  it('readBytes returns null above maxBytes', async () => {
    const g = guard()
    const f = path.join(uni, 'course1', 'bytes.bin')
    write(f, 'abcdef')
    expect((await g.readBytes(f, 6))?.toString()).toBe('abcdef')
    expect(await g.readBytes(f, 5)).toBeNull()
    expect(await g.readBytes(uni, 100)).toBeNull()
  })
})
