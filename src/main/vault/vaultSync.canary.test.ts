// The canary: a full startup, render, tick, conflict and rename run over a
// temp vault whose Life/ folder is chmod 000. Every fs call the vault code
// makes (writes through VaultFs, reads through the guard) is traced.
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeGuardFs, type GuardFs } from '../sources/guard'
import { step, task } from './testFixtures'
import { makeHarness, settle, type Harness } from './testHarness'
import { nodeVaultWriteFs, type VaultWriteFs } from './vaultFs'

let h: Harness
afterEach(() => h?.cleanup())

const trace: { op: string; p: string }[] = []

const writeFs: VaultWriteFs = {
  lstat: (p) => (trace.push({ op: 'lstat', p }), nodeVaultWriteFs.lstat(p)),
  mkdir: (p, o) => (trace.push({ op: 'mkdir', p }), nodeVaultWriteFs.mkdir(p, o)),
  open: (p, f) => (trace.push({ op: 'open', p }), nodeVaultWriteFs.open(p, f)),
  rename: (a, b) => (
    trace.push({ op: 'rename', p: a }, { op: 'rename', p: b }),
    nodeVaultWriteFs.rename(a, b)
  ),
  unlink: (p) => (trace.push({ op: 'unlink', p }), nodeVaultWriteFs.unlink(p))
}

const guardFs: GuardFs = {
  realpathSync: (p) => (trace.push({ op: 'realpath', p }), nodeGuardFs.realpathSync(p)),
  lstatSync: (p) => (trace.push({ op: 'lstatSync', p }), nodeGuardFs.lstatSync(p)),
  promises: {
    opendir: (p) => (trace.push({ op: 'opendir', p }), nodeGuardFs.promises.opendir(p)),
    lstat: (p) => (trace.push({ op: 'glstat', p }), nodeGuardFs.promises.lstat(p)),
    open: (p, f) => (trace.push({ op: 'gopen', p }), nodeGuardFs.promises.open(p, f))
  }
}

function hashTree(dir: string, skip: (rel: string) => boolean): string {
  const h = createHash('sha256')
  const walk = (d: string): void => {
    for (const e of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, e.name)
      const rel = path.relative(dir, full)
      if (skip(rel)) continue
      h.update(rel)
      if (e.isDirectory()) walk(full)
      else h.update(fs.readFileSync(full))
    }
  }
  walk(dir)
  return h.digest('hex')
}

const under = (p: string, dir: string): boolean => {
  const a = p.toLowerCase()
  const b = dir.toLowerCase()
  return a === b || a.startsWith(b + path.sep)
}

describe('vault sync canary', () => {
  it('writes only under vault/FocusForge, never touches Life, leaves everything else unchanged', async () => {
    trace.length = 0
    h = makeHarness({ fsImpl: writeFs, guardFs, lifeCanary: true })
    const real = (p: string): string => fs.realpathSync(p)
    const skipVault = (rel: string): boolean =>
      rel === 'FocusForge' || rel.startsWith(`FocusForge${path.sep}`) || rel === 'Life'
    const lifeStat = fs.statSync(path.join(h.vault, 'Life'))
    const vaultBefore = hashTree(h.vault, skipVault)
    const uniBefore = hashTree(h.uni, () => false)

    h.addItem(
      {
        sources: [
          path.join(h.uni, 'thesis'),
          path.join(h.vault, 'Learning', 'Thesis Hub', 'Thesis.md')
        ]
      },
      {
        rev: 1,
        tasks: [task('t1', 'Proposal', { subtasks: [step('a', 'Draft intro'), step('b', 'Send')] })]
      }
    )
    h.addItem({ id: 'site', name: 'Personal website', category: 'Projects', kind: 'passion' })
    h.addItem(
      { id: 'reading', name: 'Reading', category: 'Life', kind: 'passion' },
      { rev: 1, tasks: [task('r1', 'Finish the novel', { subtasks: [step('x', 'Read ch 3')] })] }
    )

    // Startup, render.
    h.sync.start(1e9)
    await h.sync.restart()
    await settle(h)
    expect(fs.existsSync(h.abs('FocusForge/Life/Reading/Reading.md'))).toBe(true)

    // Ingest a tick, in both a regular and the Life item.
    const tp = 'FocusForge/Learning/Thesis/Proposal.md'
    h.writeNote(tp, h.read(tp).replace('- [ ] Draft intro', '- [x] Draft intro'))
    await h.sync.reader.handleChange(tp)
    const rp = 'FocusForge/Life/Reading/Finish the novel.md'
    h.writeNote(rp, h.read(rp).replace('- [ ] Read ch 3', '- [x] Read ch 3'))
    await h.sync.reader.handleChange(rp)
    expect(h.store.data.get('reading')!.tasks[0].subtasks[0].isCompleted).toBe(true)

    // Conflict copy, rename, removal.
    fs.copyFileSync(
      h.abs('FocusForge/Learning/Thesis/Thesis.md'),
      h.abs('FocusForge/Learning/Thesis/Thesis 2.md')
    )
    h.store.items[0].name = 'Honours thesis'
    h.store.items = h.store.items.filter((i) => i.id !== 'site')
    await h.sync.syncNow()
    await settle(h)
    expect(fs.existsSync(h.abs('FocusForge/Learning/Honours thesis/Honours thesis.md'))).toBe(true)

    const appDir = path.join(h.vault, 'FocusForge')
    const appReal = path.join(real(h.vault), 'FocusForge')
    const lifeDirs = [path.join(h.vault, 'Life'), path.join(real(h.vault), 'Life')]
    const mutating = trace.filter((t) => ['mkdir', 'open', 'rename', 'unlink'].includes(t.op))
    expect(mutating.length).toBeGreaterThan(0)
    for (const t of mutating) {
      expect(under(t.p, appDir) || under(t.p, appReal), `${t.op} outside FocusForge`).toBe(true)
    }
    for (const t of trace) {
      expect(
        lifeDirs.some((l) => under(t.p, l)),
        `${t.op} touched Life`
      ).toBe(false)
    }
    expect(
      mutating.filter((t) => t.op === 'unlink').every((t) => t.p.includes('.tmp.nosync'))
    ).toBe(true)

    const lifeAfter = fs.statSync(path.join(h.vault, 'Life'))
    expect(lifeAfter.mode).toBe(lifeStat.mode)
    expect(lifeAfter.mtimeMs).toBe(lifeStat.mtimeMs)
    expect(hashTree(h.vault, skipVault)).toBe(vaultBefore)
    expect(hashTree(h.uni, () => false)).toBe(uniBefore)
  })
})
