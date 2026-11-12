import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PathGuard } from '../sources/guard'
import {
  MAX_NOTE_BYTES,
  VaultFs,
  VaultWriteDenied,
  appRel,
  nodeVaultWriteFs,
  type VaultWriteFs
} from './vaultFs'

// Temp dirs only:
//   home/vault/{.obsidian, Life/canary.md, Learning/x.md, FocusForge/}
//   home/uni/course/notes.md
let tmp: string
let vault: string
let uni: string
let app: string
let calls: { op: string; p: string }[]

function write(p: string, contents = 'x'): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, contents)
}

function tracingFs(hooks: { onOpen?: () => void } = {}): VaultWriteFs {
  const log =
    <A extends unknown[], R>(op: string, f: (p: string, ...a: A) => R) =>
    (p: string, ...a: A): R => {
      calls.push({ op, p })
      return f(p, ...a)
    }
  return {
    lstat: log('lstat', nodeVaultWriteFs.lstat),
    mkdir: log('mkdir', nodeVaultWriteFs.mkdir),
    open: log('open', (p: string, flags: 'w') => {
      hooks.onOpen?.()
      return nodeVaultWriteFs.open(p, flags)
    }),
    rename: (a, b) => {
      calls.push({ op: 'rename', p: a }, { op: 'rename', p: b })
      return nodeVaultWriteFs.rename(a, b)
    },
    unlink: log('unlink', nodeVaultWriteFs.unlink)
  }
}

function guard(appVaultWrite = true): PathGuard {
  return new PathGuard({
    sourceRoots: [uni],
    vaultRoots: [vault],
    readableVault: vault,
    writableRoots: [path.join(tmp, 'flowstate')],
    caseInsensitive: true,
    appVaultWrite
  })
}

/** Content hash of everything under `dir` except FocusForge/ (relative path -> bytes). */
function snapshot(dir: string, skip = 'FocusForge'): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      const rel = path.relative(dir, full)
      if (rel === skip) continue
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) out[rel] = fs.readFileSync(full, 'utf8')
    }
  }
  walk(dir)
  return out
}

const isUnder = (p: string, dir: string): boolean => p === dir || p.startsWith(dir + path.sep)

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-vaultfs-')))
  vault = path.join(tmp, 'vault')
  uni = path.join(tmp, 'uni')
  app = path.join(vault, 'FocusForge')
  write(path.join(vault, '.obsidian', 'app.json'), '{}')
  write(path.join(vault, 'Life', 'canary.md'), 'CANARY-LIFE')
  write(path.join(vault, 'Learning', 'x.md'), 'learning')
  write(path.join(uni, 'course', 'notes.md'), 'uni')
  fs.mkdirSync(app)
  calls = []
})

afterAll(() => {
  // each test made its own temp dir; remove them all
  for (const d of fs.readdirSync(os.tmpdir())) {
    if (d.startsWith('ff-vaultfs-')) {
      fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true })
    }
  }
})

describe('appRel', () => {
  it('accepts only clean paths under FocusForge/', () => {
    expect(appRel('FocusForge/Learning/Thesis/Thesis.md')).toBe(
      'FocusForge/Learning/Thesis/Thesis.md'
    )
    expect(appRel('FocusForge')).toBeNull()
    expect(appRel('FocusForge', { allowRoot: true })).toBe('FocusForge')
    for (const bad of [
      '',
      'Learning/x.md',
      'Life/canary.md',
      'focusforge/x.md',
      'FocusForge/../Life/x.md',
      'FocusForge/./x.md',
      'FocusForge//x.md',
      'FocusForge/.obsidian/x',
      'FocusForge/.tmp.nosync/x',
      '/FocusForge/x.md',
      'FocusForge\\..\\Life',
      'FocusForge/x\0.md',
      3
    ]) {
      expect(appRel(bad)).toBeNull()
    }
  })
})

describe('VaultFs', () => {
  it('throws VaultWriteDenied before touching fs for paths outside FocusForge', async () => {
    const other = path.join(tmp, 'other')
    write(path.join(other, '.obsidian', 'app.json'), '{}')
    const before = snapshot(tmp, '')
    const v = new VaultFs(guard(), vault, tracingFs())
    const outside = [
      'Learning/x.md',
      'Life/canary.md',
      'Life/new.md',
      'FocusForge/../Life/canary.md',
      'FocusForge/../Learning/x.md',
      '../uni/course/notes.md',
      path.join(vault, 'Learning', 'x.md'),
      'FocusForge',
      'FocusForge/.obsidian/app.json',
      '.obsidian/app.json'
    ]
    for (const rel of outside) {
      await expect(v.writeIfUnchanged(rel, 'x', 'absent')).rejects.toBeInstanceOf(VaultWriteDenied)
      await expect(v.ensureDir(rel === 'FocusForge' ? 'Life' : rel)).rejects.toBeInstanceOf(
        VaultWriteDenied
      )
      await expect(v.read(rel === 'FocusForge' ? 'Life/canary.md' : rel)).rejects.toBeInstanceOf(
        VaultWriteDenied
      )
    }
    // Vault writes off in the guard, or a vault that isn't the guard's readable vault.
    const off = new VaultFs(guard(false), vault, tracingFs())
    await expect(off.writeIfUnchanged('FocusForge/a.md', 'x', 'absent')).rejects.toBeInstanceOf(
      VaultWriteDenied
    )
    const wrongRoot = new VaultFs(guard(), other, tracingFs())
    await expect(
      wrongRoot.writeIfUnchanged('FocusForge/a.md', 'x', 'absent')
    ).rejects.toBeInstanceOf(VaultWriteDenied)
    expect(calls).toEqual([])
    expect(snapshot(tmp, '')).toEqual(before)
  })

  it('error messages never name the denied path', async () => {
    const v = new VaultFs(guard(), vault, tracingFs())
    const err = await v.writeIfUnchanged('Life/canary.md', 'x', 'absent').catch((e) => e)
    expect(String(err.message)).not.toMatch(/Life|canary/)
  })

  it('temp files live in FocusForge/.tmp.nosync', async () => {
    const v = new VaultFs(guard(), vault, tracingFs())
    const rel = 'FocusForge/Learning/Thesis/Thesis.md'
    expect(await v.writeIfUnchanged(rel, '# Thesis\n', 'absent')).toBe('written')
    expect(fs.readFileSync(path.join(app, 'Learning', 'Thesis', 'Thesis.md'), 'utf8')).toBe(
      '# Thesis\n'
    )
    const tempDir = path.join(app, '.tmp.nosync')
    const opened = calls.filter((c) => c.op === 'open').map((c) => c.p)
    expect(opened).toHaveLength(1)
    expect(path.dirname(opened[0])).toBe(tempDir)
    expect(fs.readdirSync(tempDir)).toEqual([])
    expect(calls.every((c) => isUnder(c.p, app))).toBe(true)
  })

  it('writes only when the file still matches the expected stat', async () => {
    const v = new VaultFs(guard(), vault, tracingFs())
    const rel = 'FocusForge/Projects/Site/Site.md'
    expect(await v.writeIfUnchanged(rel, 'one', 'absent')).toBe('written')
    // exists now, so 'absent' no longer holds
    expect(await v.writeIfUnchanged(rel, 'two', 'absent')).toBe('changed')
    const r = await v.read(rel)
    if (!('text' in r)) throw new Error('expected text')
    expect(r.text).toBe('one')
    expect(await v.writeIfUnchanged(rel, 'two', { mtimeMs: r.stat.mtimeMs, size: 99 })).toBe(
      'changed'
    )
    expect(await v.writeIfUnchanged(rel, 'two', r.stat)).toBe('written')
    expect(fs.readFileSync(path.join(app, 'Projects', 'Site', 'Site.md'), 'utf8')).toBe('two')
    expect(fs.readdirSync(path.join(app, '.tmp.nosync'))).toEqual([])
  })

  it('aborts when the file changes between read and rename', async () => {
    const abs = path.join(app, 'Learning', 'T', 'T.md')
    write(abs, 'before')
    const plain = new VaultFs(guard(), vault)
    const r = await plain.read('FocusForge/Learning/T/T.md')
    if (!('text' in r)) throw new Error('expected text')
    const v = new VaultFs(
      guard(),
      vault,
      tracingFs({ onOpen: () => fs.writeFileSync(abs, 'owner typed this') })
    )
    expect(await v.writeIfUnchanged('FocusForge/Learning/T/T.md', 'app', r.stat)).toBe('changed')
    expect(fs.readFileSync(abs, 'utf8')).toBe('owner typed this')
    expect(fs.readdirSync(path.join(app, '.tmp.nosync'))).toEqual([])
  })

  it('refuses a write through a FocusForge subfolder symlinked to a source root or Life', async () => {
    fs.symlinkSync(uni, path.join(app, 'to-uni'))
    fs.symlinkSync(path.join(vault, 'Life'), path.join(app, 'to-life'))
    const before = snapshot(tmp, '')
    const v = new VaultFs(guard(), vault, tracingFs())
    await expect(
      v.writeIfUnchanged('FocusForge/to-uni/course/notes.md', 'x', 'absent')
    ).rejects.toBeInstanceOf(VaultWriteDenied)
    await expect(
      v.writeIfUnchanged('FocusForge/to-life/canary.md', 'x', 'absent')
    ).rejects.toBeInstanceOf(VaultWriteDenied)
    await expect(v.ensureDir('FocusForge/to-uni/new')).rejects.toBeInstanceOf(VaultWriteDenied)
    expect(calls).toEqual([])
    expect(snapshot(tmp, '')).toEqual(before)
  })

  it('refuses everything when FocusForge itself is a symlink', async () => {
    fs.rmdirSync(app)
    fs.symlinkSync(path.join(vault, 'Life'), app)
    const v = new VaultFs(guard(), vault, tracingFs())
    await expect(v.writeIfUnchanged('FocusForge/x.md', 'x', 'absent')).rejects.toBeInstanceOf(
      VaultWriteDenied
    )
    await expect(v.ensureDir('FocusForge/Learning')).rejects.toBeInstanceOf(VaultWriteDenied)
    expect(calls).toEqual([])
    expect(fs.readdirSync(path.join(vault, 'Life'))).toEqual(['canary.md'])
  })

  it('rename refuses when either end is outside FocusForge', async () => {
    write(path.join(app, 'Learning', 'Old', 'Old.md'), 'old')
    const v = new VaultFs(guard(), vault, tracingFs())
    const inside = 'FocusForge/Learning/Old'
    for (const [a, b] of [
      [inside, 'Learning/Old'],
      [inside, 'Life/Old'],
      [inside, 'FocusForge/../Life/Old'],
      ['Learning/x.md', 'FocusForge/x.md'],
      ['Life/canary.md', 'FocusForge/canary.md']
    ]) {
      await expect(v.rename(a, b)).rejects.toBeInstanceOf(VaultWriteDenied)
    }
    expect(calls).toEqual([])
    await v.rename(inside, 'FocusForge/Projects/New')
    expect(fs.readFileSync(path.join(app, 'Projects', 'New', 'Old.md'), 'utf8')).toBe('old')
    await v.rename('FocusForge/Projects/New/Old.md', 'FocusForge/Projects/New/New.md')
    expect(fs.readdirSync(path.join(app, 'Projects', 'New'))).toEqual(['New.md'])
    // never replaces an existing entry
    write(path.join(app, 'Projects', 'Taken.md'), 'keep')
    await expect(
      v.rename('FocusForge/Projects/New/New.md', 'FocusForge/Projects/Taken.md')
    ).rejects.toThrow('already exists')
    expect(fs.readFileSync(path.join(app, 'Projects', 'Taken.md'), 'utf8')).toBe('keep')
  })

  it('never calls unlink outside .tmp.nosync', async () => {
    const v = new VaultFs(guard(), vault, tracingFs())
    await v.ensureDir('FocusForge/Career/Job')
    await v.writeIfUnchanged('FocusForge/Career/Job/Job.md', 'a', 'absent')
    await v.writeIfUnchanged('FocusForge/Career/Job/Job.md', 'b', 'absent') // aborted
    await v.rename('FocusForge/Career/Job/Job.md', 'FocusForge/Career/Job/Work.md')
    await v.read('FocusForge/Career/Job/Work.md')
    await v.listDir('FocusForge/Career/Job')
    const failing: VaultWriteFs = {
      ...tracingFs(),
      rename: async () => {
        throw new Error('disk full')
      }
    }
    await expect(
      new VaultFs(guard(), vault, failing).writeIfUnchanged('FocusForge/Career/F.md', 'x', 'absent')
    ).rejects.toThrow('disk full')
    const unlinks = calls.filter((c) => c.op === 'unlink').map((c) => c.p)
    expect(unlinks.length).toBeGreaterThanOrEqual(2)
    expect(unlinks.every((p) => path.dirname(p) === path.join(app, '.tmp.nosync'))).toBe(true)
    expect(fs.readdirSync(path.join(app, '.tmp.nosync'))).toEqual([])
    expect(calls.every((c) => isUnder(c.p, app))).toBe(true)
  })

  it('read returns text and stat, missing, iCloud stub, and tooLarge', async () => {
    const v = new VaultFs(guard(), vault, tracingFs())
    write(path.join(app, 'a.md'), 'hello')
    const r = await v.read('FocusForge/a.md')
    expect(r).toMatchObject({ text: 'hello', stat: { size: 5 } })
    expect(await v.read('FocusForge/none.md')).toEqual({ missing: true, stub: false })
    write(path.join(app, '.evicted.md.icloud'), 'stub')
    expect(await v.read('FocusForge/evicted.md')).toEqual({ missing: true, stub: true })
    write(path.join(app, 'big.md'), 'x'.repeat(MAX_NOTE_BYTES + 1))
    expect(await v.read('FocusForge/big.md')).toEqual({ tooLarge: true })
    expect(calls).toEqual([]) // reads go through the guard, never the write fs
  })

  it('listDir lists one FocusForge folder through the guard', async () => {
    const v = new VaultFs(guard(), vault)
    write(path.join(app, 'Learning', 'T', 'T.md'))
    write(path.join(app, 'Learning', 'T', 'T 2.md'))
    fs.mkdirSync(path.join(app, '.tmp.nosync'))
    const names = (await v.listDir('FocusForge/Learning/T')).map((e) => e.name).sort()
    expect(names).toEqual(['T 2.md', 'T.md'])
    expect((await v.listDir('FocusForge')).map((e) => e.name)).toEqual(['Learning'])
    await expect(v.listDir('Life')).rejects.toBeInstanceOf(VaultWriteDenied)
  })

  it('leaves the vault outside FocusForge, Life and the source root untouched', async () => {
    const before = snapshot(vault)
    const uniBefore = snapshot(uni)
    const lifeMtime = fs.statSync(path.join(vault, 'Life')).mtimeMs
    const v = new VaultFs(guard(), vault, tracingFs())
    await v.writeIfUnchanged('FocusForge/Life/Reading/Reading.md', '# Reading\n', 'absent')
    await v.writeIfUnchanged('FocusForge/About these notes.md', 'about', 'absent')
    await v.rename('FocusForge/Life/Reading', 'FocusForge/Life/Books')
    for (const bad of ['Life/Reading.md', 'Learning/x.md', '../uni/course/notes.md']) {
      await v.writeIfUnchanged(bad, 'x', 'absent').catch(() => undefined)
    }
    expect(snapshot(vault)).toEqual(before)
    expect(snapshot(uni)).toEqual(uniBefore)
    expect(fs.statSync(path.join(vault, 'Life')).mtimeMs).toBe(lifeMtime)
    expect(calls.every((c) => isUnder(c.p, app))).toBe(true)
    expect(
      calls.some((c) => isUnder(c.p.toLowerCase(), path.join(vault, 'life').toLowerCase()))
    ).toBe(false)
  })
})
