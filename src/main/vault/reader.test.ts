import fs from 'fs'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WatchFs } from '../sources/watch'
import { gapBlockId } from './format'
import { digest, step, task } from './testFixtures'
import { makeHarness, settle, type Harness } from './testHarness'

let h: Harness
afterEach(() => h?.cleanup())

const ITEM = 'FocusForge/Learning/Thesis/Thesis.md'
const TASK = 'FocusForge/Learning/Thesis/Proposal.md'
const LOOSE = 'FocusForge/Learning/Thesis/Loose ends.md'

async function seedAndWrite(): Promise<void> {
  h.addItem(
    {},
    {
      rev: 1,
      tasks: [task('t1', 'Proposal', { subtasks: [step('a', 'Draft intro'), step('b', 'Send')] })]
    }
  )
  await h.sync.writer.syncAll()
}

const tick = (rel: string, title: string, mark = 'x'): void =>
  h.writeNote(
    rel,
    h.read(rel).replace(new RegExp(`- \\[[ xX]\\] ${title}`), `- [${mark}] ${title}`)
  )

const steps = (): { id: string; isCompleted: boolean; completedAt?: string }[] =>
  h.store.data.get('thesis')!.tasks[0].subtasks

describe('VaultReader', () => {
  it('own write echo is ignored by hash', async () => {
    h = makeHarness()
    await seedAndWrite()
    const saves = h.store.saves.length
    await h.sync.reader.handleChange(TASK)
    await h.sync.reader.handleChange(ITEM)
    expect(h.store.saves.length).toBe(saves)
  })

  it('a tick in Obsidian completes the step through the locked save, tagged vault, and logs it', async () => {
    h = makeHarness()
    await seedAndWrite()
    h.sync.start(1e9)
    tick(TASK, 'Draft intro')
    await h.sync.reader.handleChange(TASK)
    expect(steps()[0].isCompleted).toBe(true)
    expect(steps()[0].completedAt).toBeTruthy()
    expect(h.store.data.get('thesis')!.rev).toBe(2)
    expect(h.store.saves.at(-1)).toEqual({ id: 'thesis', by: 'vault' })
    expect(h.store.ledger.at(-1)?.notes[0].note).toBe('Ticked in Obsidian: "Draft intro".')
    expect(h.notified).toContain('tasks-changed')
    await settle(h)
    expect(h.read(TASK)).toContain('- [x] Draft intro')
    expect(h.read(TASK)).toContain('Ticked "Draft intro" in Obsidian')
    // No "Done in FocusForge" double log for the vault save.
    expect(h.read(TASK)).not.toContain('Done in FocusForge')
  })

  it('untick sets the step back to todo and clears completedAt', async () => {
    h = makeHarness()
    await seedAndWrite()
    tick(TASK, 'Draft intro')
    await h.sync.reader.handleChange(TASK)
    await h.sync.writer.flushNow('thesis')
    tick(TASK, 'Draft intro', ' ')
    await h.sync.reader.handleChange(TASK)
    expect(steps()[0].isCompleted).toBe(false)
    expect(steps()[0].completedAt).toBeUndefined()
  })

  it('a concurrent renderer save with a stale rev gets a conflict and the retry keeps the tick', async () => {
    h = makeHarness()
    await seedAndWrite()
    const loaded = (await h.store.loadProjectData('thesis'))!
    tick(TASK, 'Draft intro')
    await h.sync.reader.handleChange(TASK)
    loaded.tasks[0].subtasks[1].title = 'Send it'
    const first = await h.store.saveProjectData('thesis', loaded, loaded.rev)
    expect(first.conflict).toBe(true)
    const fresh = (await h.store.loadProjectData('thesis'))!
    fresh.tasks[0].subtasks[1].title = 'Send it'
    expect((await h.store.saveProjectData('thesis', fresh, fresh.rev)).success).toBe(true)
    expect(steps()[0].isCompleted).toBe(true)
  })

  it("a tick on a re-planned step isn't applied and is logged once", async () => {
    h = makeHarness()
    await seedAndWrite()
    const text = h
      .read(TASK)
      .replace('- [ ] Send', '- [ ] Send\n- [x] Pasted from an old plan ^ff-s-zzzzzzzzzz')
    h.writeNote(TASK, text)
    await h.sync.reader.handleChange(TASK)
    expect(steps().every((s) => !s.isCompleted)).toBe(true)
    const log = await h.sync.writer.logs.read('thesis')
    expect(log.filter((e) => e.kind === 'notice').map((e) => e.text)).toEqual([
      "A tick on a step that was re-planned wasn't applied"
    ])
  })

  it('a My notes change calls Phase 3 refresh without any vault write', async () => {
    h = makeHarness()
    await seedAndWrite()
    const writes = h.sync.writer.writes
    h.writeNote(ITEM, h.read(ITEM).replace(/## My notes\n$/, '## My notes\nAsk about ablations\n'))
    await h.sync.reader.handleChange(ITEM)
    expect(h.myNotesChanged).toEqual(['thesis'])
    expect(h.sync.writer.writes).toBe(writes)
    expect(h.store.saves.length).toBe(0)
    // Ticks inside My notes are never read.
    h.writeNote(ITEM, h.read(ITEM) + `- [x] Draft intro ^${'ff-s-'}${'0'.repeat(10)}\n`)
    await h.sync.reader.handleChange(ITEM)
    expect(steps()[0].isCompleted).toBe(false)
  })

  it('ticks in a conflict copy are not applied', async () => {
    h = makeHarness()
    await seedAndWrite()
    const copy = 'FocusForge/Learning/Thesis/Proposal 2.md'
    h.writeNote(copy, h.read(TASK).replace('- [ ] Draft intro', '- [x] Draft intro'))
    await h.sync.reader.handleChange(copy)
    await settle(h)
    expect(steps()[0].isCompleted).toBe(false)
    expect((await h.sync.status()).notes.find((n) => n.taskId === 't1')?.state).toBe('conflict')
  })

  it('the poll catches a change the watcher missed', async () => {
    h = makeHarness()
    await seedAndWrite()
    h.sync.reader.start({ vaultRoot: h.vault, guard: h.guard() })
    tick(TASK, 'Send')
    await h.sync.reader.rescan(true)
    expect(steps()[1].isCompleted).toBe(true)
  })

  it('^ff-g ticks resolve through gapId in the Loose ends task', async () => {
    h = makeHarness()
    h.addItem(
      {},
      {
        rev: 1,
        tasks: [
          task('le', 'Loose ends', {
            auto: 'loose-ends',
            deadlineKind: 'none',
            subtasks: [step('g1', 'Find the presentation slot', { gapId: 'abc123' })]
          })
        ]
      }
    )
    h.digests.set(
      'thesis',
      digest({
        candidateTasks: [
          {
            id: 'abc123',
            title: 'Find the presentation slot',
            minutes: 5,
            gapKind: 'to-check',
            why: 'date TBC',
            sources: [{ label: 'CONTEXT.md' }]
          }
        ]
      })
    )
    await h.sync.writer.syncAll()
    const id = gapBlockId('abc123')
    expect(h.read(LOOSE)).toContain(`^${id}`)
    h.writeNote(LOOSE, h.read(LOOSE).replace(/- \[ \] (.*\^ff-g-abc123)/, '- [x] $1'))
    await h.sync.reader.handleChange(LOOSE)
    expect(h.store.data.get('thesis')!.tasks[0].subtasks[0].isCompleted).toBe(true)
  })

  it('^ff-t ticks complete the remaining steps; untick reverts only those', async () => {
    h = makeHarness()
    h.addItem(
      {},
      {
        rev: 1,
        tasks: [
          task('t1', 'Proposal', {
            subtasks: [
              step('a', 'A', { isCompleted: true, status: 'done' }),
              step('b', 'B'),
              step('c', 'C')
            ]
          })
        ]
      }
    )
    await h.sync.writer.syncAll()
    h.writeNote(ITEM, h.read(ITEM).replace(/- \[ \] (Proposal \[due::[^\n]*\^ff-t-)/, '- [x] $1'))
    await h.sync.reader.handleChange(ITEM)
    expect(steps().map((s) => s.isCompleted)).toEqual([true, true, true])
    await h.sync.writer.flushNow('thesis')
    h.writeNote(ITEM, h.read(ITEM).replace(/- \[x\] (Proposal \[due::[^\n]*\^ff-t-)/, '- [ ] $1'))
    await h.sync.reader.handleChange(ITEM)
    expect(steps().map((s) => s.isCompleted)).toEqual([true, false, false])
  })

  it('a note moved inside FocusForge is adopted, not recreated', async () => {
    h = makeHarness()
    await seedAndWrite()
    fs.mkdirSync(h.abs('FocusForge/Learning/Thesis/Archive'))
    const moved = 'FocusForge/Learning/Thesis/Archive/Proposal.md'
    fs.renameSync(h.abs(TASK), h.abs(moved))
    h.store.data.get('thesis')!.tasks[0].subtasks[1].title = 'Send today'
    await h.sync.writer.flushNow('thesis')
    expect(fs.existsSync(h.abs(TASK))).toBe(false)
    expect(h.read(moved)).toContain('Send today')
    expect(h.read(ITEM)).toContain('[[FocusForge/Learning/Thesis/Archive/Proposal|Proposal]]')
  })

  it('myNotesRefs lists the item and task notes in sync, as My-notes section refs', async () => {
    h = makeHarness()
    await seedAndWrite()
    expect(await h.sync.myNotesRefs('thesis')).toEqual([
      `${h.abs(ITEM)}#My notes`,
      `${h.abs(TASK)}#My notes`
    ])
    h.settings.vaultNotes = false
    expect(await h.sync.myNotesRefs('thesis')).toEqual([])
  })

  it('watches only <vault>/FocusForge and filters event names before reading', async () => {
    const watched: string[] = []
    let emit: (name: string | null) => void = () => undefined
    const watchFs: WatchFs = {
      watch: (p, _o, cb) => {
        watched.push(p)
        emit = (n) => cb('change', n)
        return { close: () => undefined, on: () => undefined }
      }
    }
    h = makeHarness({ watchFs })
    await seedAndWrite()
    h.sync.reader.start({ vaultRoot: h.vault, guard: h.guard() })
    expect(watched).toEqual([path.join(h.vault, 'FocusForge')])
    tick(TASK, 'Draft intro')
    emit('.tmp.nosync/x.md')
    emit('Learning/Thesis/notes.txt')
    emit('../Life/canary.md')
    emit('Learning/Thesis/Proposal.md')
    await new Promise((r) => setTimeout(r, 40))
    await settle(h)
    expect(steps()[0].isCompleted).toBe(true)
  })
})
