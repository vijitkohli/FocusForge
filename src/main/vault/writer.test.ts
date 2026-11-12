import fs from 'fs'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { digest, done, step, task } from './testFixtures'
import { makeHarness, settle, type Harness } from './testHarness'
import { nodeVaultWriteFs, type VaultWriteFs } from './vaultFs'

let h: Harness
afterEach(() => h?.cleanup())

const ITEM = 'FocusForge/Learning/Thesis/Thesis.md'
const TASK = 'FocusForge/Learning/Thesis/Proposal.md'
const ABOUT = 'FocusForge/About these notes.md'

function seed(over: Parameters<Harness['addItem']>[0] = {}): void {
  h.addItem(over, {
    rev: 1,
    tasks: [task('t1', 'Proposal', { subtasks: [step('a', 'Draft intro'), step('b', 'Send')] })]
  })
}

async function state(): Promise<Awaited<ReturnType<Harness['sync']['writer']['state']['load']>>> {
  return h.sync.writer.state.load()
}

describe('VaultWriter', () => {
  it('writes the item, task and About notes and records the item note path', async () => {
    h = makeHarness()
    seed()
    h.addItem({ id: 'reading', name: 'Reading', category: 'Life', kind: 'passion' })
    await h.sync.writer.syncAll()
    expect(h.read(ITEM)).toContain('# Thesis')
    expect(h.read(ITEM)).toContain('[[FocusForge/Learning/Thesis/Proposal|Proposal]]')
    expect(h.read(TASK)).toContain('- [ ] Draft intro')
    expect(h.read(ABOUT)).toContain('```dataview')
    expect(fs.existsSync(h.abs('FocusForge/Life/Reading/Reading.md'))).toBe(true)
    expect(h.store.items[0].vaultNote).toBe(ITEM)
    expect(h.notified).toContain('vault-sync-changed')
    // Temp files are cleaned up.
    expect(fs.readdirSync(h.abs('FocusForge/.tmp.nosync'))).toEqual([])
  })

  it('no write when rendered bytes equal the current file; updated stays the same', async () => {
    h = makeHarness()
    seed()
    await h.sync.writer.syncAll()
    const before = h.read(ITEM)
    const writes = h.sync.writer.writes
    await new Promise((r) => setTimeout(r, 1100))
    await h.sync.writer.syncAll()
    await h.sync.writer.syncAll()
    expect(h.sync.writer.writes).toBe(writes)
    expect(h.read(ITEM)).toBe(before)
  })

  it('skips and reschedules when the file changed under 5 s ago', async () => {
    h = makeHarness({ config: { quietMs: 400 } })
    seed()
    await new Promise((r) => setTimeout(r, 0))
    await h.sync.writer.syncAll()
    // First write happened (no file yet). Now touch it and change the app.
    const touchedAt = Date.now()
    fs.utimesSync(h.abs(TASK), new Date(touchedAt), new Date(touchedAt))
    const data = h.store.data.get('thesis')!
    data.tasks[0].subtasks[1].title = 'Send to supervisor'
    await h.sync.writer.flushNow('thesis')
    expect(h.read(TASK)).not.toContain('Send to supervisor')
    await settle(h)
    await new Promise((r) => setTimeout(r, 500))
    await settle(h)
    expect(h.read(TASK)).toContain('Send to supervisor')
    expect(fs.statSync(h.abs(TASK)).mtimeMs - touchedAt).toBeGreaterThanOrEqual(390)
  })

  it('aborts when the file changes between read and rename', async () => {
    let sabotage = false
    const fsImpl: VaultWriteFs = {
      ...nodeVaultWriteFs,
      open: async (p, flags) => {
        if (sabotage && p.includes('.tmp.nosync')) {
          sabotage = false
          fs.appendFileSync(h.abs(TASK), '\nowner typed this\n')
        }
        return nodeVaultWriteFs.open(p, flags)
      }
    }
    h = makeHarness({ fsImpl })
    seed()
    await h.sync.writer.syncAll()
    h.store.data.get('thesis')!.tasks[0].subtasks[0].title = 'Draft the intro'
    sabotage = true
    await h.sync.writer.flushNow('thesis')
    // The owner's text survived; nothing was renamed over it.
    expect(h.read(TASK)).toContain('owner typed this')
  })

  it('never writes over an .icloud stub and asks iCloud to download it', async () => {
    h = makeHarness()
    seed()
    await h.sync.writer.syncAll()
    fs.renameSync(h.abs(TASK), h.abs('FocusForge/Learning/Thesis/.Proposal.md.icloud'))
    await h.sync.writer.flushNow('thesis')
    expect(fs.existsSync(h.abs(TASK))).toBe(false)
    expect((await state()).notes[TASK].state).toBe('evicted')
    expect(h.downloads).toEqual([h.abs(TASK)])
    expect((await h.sync.status()).notes.find((n) => n.taskId === 't1')?.state).toBe('waiting')
  })

  it('does not recreate an owner-deleted note; recreate works with empty My notes', async () => {
    h = makeHarness()
    seed()
    await h.sync.writer.syncAll()
    h.writeNote(TASK, h.read(TASK).replace('## My notes\n', '## My notes\nmine\n'))
    fs.unlinkSync(h.abs(TASK))
    await h.sync.writer.flushNow('thesis')
    await h.sync.writer.syncAll()
    expect(fs.existsSync(h.abs(TASK))).toBe(false)
    expect((await state()).notes[TASK].state).toBe('deleted')
    const st = await h.sync.status()
    expect(st.notes.find((n) => n.taskId === 't1')?.message).toMatch(/Recreate/)
    expect(await h.sync.recreate('thesis', 't1')).toEqual({ ok: true })
    expect(h.read(TASK)).toMatch(/## My notes\n$/)
  })

  it('owner edit in an app section is overwritten, backed up to FlowState and logged', async () => {
    h = makeHarness()
    seed()
    h.digests.set('thesis', digest())
    await h.sync.writer.syncAll()
    const edited = h.read(ITEM).replace('Pilot v2 ran', 'I rewrote this')
    h.writeNote(ITEM, edited)
    await h.sync.writer.flushNow('thesis')
    const now = h.read(ITEM)
    expect(now).not.toContain('I rewrote this')
    expect(now).toContain('FocusForge replaced your edit in “State”')
    const backups = path.join(h.flow, 'system', 'vault', 'overwritten')
    const day = fs.readdirSync(backups)[0]
    expect(fs.readFileSync(path.join(backups, day, ...ITEM.split('/')), 'utf8')).toBe(edited)
  })

  it('a tick alone is not treated as an edit (no backup)', async () => {
    h = makeHarness()
    seed()
    await h.sync.writer.syncAll()
    h.writeNote(TASK, h.read(TASK).replace('- [ ] Draft intro', '- [x] Draft intro'))
    await h.sync.writer.flushNow('thesis')
    expect(fs.existsSync(path.join(h.flow, 'system', 'vault', 'overwritten'))).toBe(false)
  })

  it('pending ticks are ingested before rendering', async () => {
    h = makeHarness()
    seed()
    await h.sync.writer.syncAll()
    h.writeNote(TASK, h.read(TASK).replace('- [ ] Draft intro', '- [x] Draft intro'))
    await h.sync.writer.flushNow('thesis')
    expect(h.store.data.get('thesis')!.tasks[0].subtasks[0].isCompleted).toBe(true)
    expect(h.read(TASK)).toContain('- [x] Draft intro')
    // The item note's next step moved on.
    expect(h.read(ITEM)).toMatch(/## Next step \(auto\)\n- \[ \] Send/)
  })

  it('My notes are kept byte for byte, CRLF and subheadings included', async () => {
    h = makeHarness()
    seed()
    await h.sync.writer.syncAll()
    const mine =
      '## My notes\r\nAsk about the table.  \r\n### Sub\r\n- [x] not a tick ^ff-s-0000000000\r\n'
    h.writeNote(TASK, h.read(TASK).replace(/## My notes\n$/, mine))
    h.store.data.get('thesis')!.tasks[0].subtasks.push(step('c', 'Proofread'))
    await h.sync.writer.flushNow('thesis')
    const text = h.read(TASK)
    expect(text).toContain('Proofread')
    expect(text.endsWith(mine)).toBe(true)
  })

  it('paused item gets one final status write, then none', async () => {
    h = makeHarness()
    seed()
    await h.sync.writer.syncAll()
    h.store.items[0].status = 'paused'
    h.store.data.get('thesis')!.tasks[0].subtasks[0].title = 'Changed while paused'
    await h.sync.writer.flushNow('thesis')
    expect(h.read(ITEM)).toMatch(/\nstatus: paused\n/)
    expect(h.read(TASK)).not.toContain('Changed while paused')
    const writes = h.sync.writer.writes
    await h.sync.writer.flushNow('thesis')
    expect(h.sync.writer.writes).toBe(writes)
  })

  it('removed task gets the removed callout and is never deleted; its name is not reused', async () => {
    h = makeHarness()
    seed()
    await h.sync.writer.syncAll()
    h.store.data.get('thesis')!.tasks = [task('t2', 'Proposal', { subtasks: [step('x', 'New')] })]
    await h.sync.writer.flushNow('thesis')
    expect(h.read(TASK)).toContain('Removed from FocusForge on')
    expect(h.read(TASK)).toMatch(/\nstatus: removed\n/)
    expect(h.read('FocusForge/Learning/Thesis/Proposal (2).md')).toContain('- [ ] New')
    const writes = h.sync.writer.writes
    await h.sync.writer.flushNow('thesis')
    expect(h.sync.writer.writes).toBe(writes)
  })

  it('deleted item: its notes say removed, nothing is deleted', async () => {
    h = makeHarness()
    seed()
    await h.sync.writer.syncAll()
    h.store.items = []
    await h.sync.writer.flushNow('thesis')
    expect(h.read(ITEM)).toContain('Removed from FocusForge on')
    expect(h.read(TASK)).toContain('Removed from FocusForge on')
  })

  it('debounce coalesces 10 saves into one flush', async () => {
    h = makeHarness({ config: { debounceMs: 30, maxWaitMs: 1000 } })
    seed()
    h.sync.start(1e9)
    await h.sync.restart()
    await settle(h)
    const writes = h.sync.writer.writes
    for (let i = 0; i < 10; i++) {
      await h.store.updateProjectData('thesis', async (d) => {
        d.tasks[0].subtasks[1].title = `Send v${i}`
        return { data: d }
      })
    }
    await settle(h)
    expect(h.read(TASK)).toContain('Send v9')
    // One flush: the task note and the item note (its next step didn't change, its tasks line didn't either).
    expect(h.sync.writer.writes - writes).toBeLessThanOrEqual(2)
  })

  it('write gate: nothing with an auto-detected vault, with vault notes off, or with a symlinked FocusForge', async () => {
    h = makeHarness()
    seed()
    h.settings.vaultPath = ''
    await h.sync.writer.syncAll()
    expect(fs.existsSync(h.abs('FocusForge'))).toBe(false)
    expect((await h.sync.status()).reason).toBe('no-vault')
    h.settings.vaultPath = h.vault
    h.settings.vaultNotes = false
    await h.sync.writer.syncAll()
    expect(fs.existsSync(h.abs('FocusForge'))).toBe(false)
    expect((await h.sync.status()).reason).toBe('off')
    h.settings.vaultNotes = true
    fs.symlinkSync(path.join(h.uni, 'thesis'), h.abs('FocusForge'))
    await h.sync.writer.syncAll()
    expect(fs.readdirSync(path.join(h.uni, 'thesis'))).toEqual(['CONTEXT.md'])
    expect((await h.sync.status()).reason).toBe('symlink')
  })

  it('a removed FocusForge folder pauses writes until Recreate', async () => {
    h = makeHarness()
    seed()
    await h.sync.writer.syncAll()
    fs.rmSync(h.abs('FocusForge'), { recursive: true })
    await h.sync.writer.syncAll()
    expect(fs.existsSync(h.abs('FocusForge'))).toBe(false)
    expect((await h.sync.status()).reason).toBe('folder-removed')
    await h.sync.resumeFolder()
    expect(fs.existsSync(h.abs(ITEM))).toBe(true)
  })

  it('digest-updated triggers a render', async () => {
    h = makeHarness()
    seed()
    h.sync.start(1e9)
    await h.sync.restart()
    await settle(h)
    h.digests.set('thesis', digest({ goal: 'Finish the thesis calmly' }))
    h.digestListeners.forEach((l) => l('thesis'))
    await settle(h)
    expect(h.read(ITEM)).toContain('> Goal: Finish the thesis calmly')
  })

  it('conflict copies are reported, never merged, and clear when gone', async () => {
    h = makeHarness()
    seed()
    await h.sync.writer.syncAll()
    fs.copyFileSync(h.abs(ITEM), h.abs('FocusForge/Learning/Thesis/Thesis 2.md'))
    h.store.data.get('thesis')!.tasks[0].subtasks[0].title = 'Still syncing'
    await h.sync.writer.flushNow('thesis')
    let st = await h.sync.status()
    const n = st.notes.find((x) => x.itemId === 'thesis' && !x.taskId)
    expect(n?.state).toBe('conflict')
    expect(n?.message).toBe('Obsidian has two copies of Thesis. Open both and keep one.')
    expect(h.read(TASK)).toContain('Still syncing')
    fs.unlinkSync(h.abs('FocusForge/Learning/Thesis/Thesis 2.md'))
    await h.sync.writer.flushNow('thesis')
    st = await h.sync.status()
    expect(st.notes.find((x) => x.itemId === 'thesis' && !x.taskId)?.state).toBe('ok')
  })

  it('item rename moves the folder and renames the note; links follow', async () => {
    h = makeHarness()
    seed()
    await h.sync.writer.syncAll()
    h.writeNote(ITEM, h.read(ITEM).replace(/## My notes\n$/, '## My notes\nkeep me\n'))
    h.store.items[0].name = 'Honours thesis'
    await h.sync.writer.flushNow('thesis')
    const rel = 'FocusForge/Learning/Honours thesis/Honours thesis.md'
    expect(h.read(rel)).toContain('# Honours thesis')
    expect(h.read(rel)).toMatch(/keep me\n$/)
    expect(h.read(rel)).toContain('[[FocusForge/Learning/Honours thesis/Proposal|Proposal]]')
    expect(fs.existsSync(h.abs('FocusForge/Learning/Thesis'))).toBe(false)
    expect(h.store.items[0].vaultNote).toBe(rel)
  })

  it('a file the app did not write is never overwritten', async () => {
    h = makeHarness()
    seed()
    h.writeNote(ITEM, '# My own Thesis page\n')
    await h.sync.writer.syncAll()
    await settle(h)
    expect(h.read(ITEM)).toBe('# My own Thesis page\n')
    expect(fs.existsSync(h.abs('FocusForge/Learning/Thesis (2)/Thesis (2).md'))).toBe(true)
  })

  it('done steps and commits land in the Log section', async () => {
    h = makeHarness()
    seed()
    const today = new Date()
    const iso = today.toISOString()
    h.packs.set('thesis', {
      git: [
        {
          id: 'G1',
          label: 'git:thesis',
          head: 'abc',
          commits: [{ hash: 'abc', date: iso, subject: 'add guard study', files: [] }],
          text: ''
        }
      ]
    } as never)
    h.sync.start(1e9)
    await h.sync.restart()
    await settle(h)
    const data = h.store.data.get('thesis')!
    await h.store.updateProjectData('thesis', async () => ({
      data: {
        ...data,
        tasks: [{ ...data.tasks[0], subtasks: [done('a', 'Draft intro'), step('b', 'Send')] }]
      }
    }))
    await settle(h)
    const text = h.read(ITEM)
    expect(text).toContain('Commit "add guard study" (git:thesis)')
    expect(text).toContain('Done in FocusForge: "Draft intro"')
    expect(h.read(TASK)).toContain('Done in FocusForge: "Draft intro"')
  })
})
