import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { normalizeSyncState, SyncStateStore } from './syncState'

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'ff-vaultstate-'))

describe('vault sync state', () => {
  it('missing or malformed file loads as empty', async () => {
    const dir = tmp()
    const store = new SyncStateStore(path.join(dir, 'state.json'))
    expect(await store.load()).toEqual({ version: 1, notes: {} })
    fs.writeFileSync(path.join(dir, 'state.json'), '{not json')
    expect(await store.load()).toEqual({ version: 1, notes: {} })
  })

  it('normalize drops bad records, keeps known fields and NFC keys', () => {
    const s = normalizeSyncState({
      paused: 'folder-removed',
      notes: {
        'FocusForge/Learning/Café/Café.md': {
          itemId: 'cafe',
          kind: 'item',
          hash: 'h',
          checks: { 'ff-s-a': true, bad: 'x' },
          bulk: { 'ff-t-a': ['s1', 2] },
          state: 'weird',
          folder: 'FocusForge/Learning/Café'
        },
        'FocusForge/x.md': { kind: 'item' },
        'FocusForge/y.md': null
      }
    })
    expect(s.paused).toBe('folder-removed')
    const keys = Object.keys(s.notes)
    expect(keys).toEqual(['FocusForge/Learning/Café/Café.md'])
    const rec = s.notes[keys[0]]
    expect(rec.checks).toEqual({ 'ff-s-a': true })
    expect(rec.bulk).toEqual({ 'ff-t-a': ['s1'] })
    expect(rec.state).toBe('ok')
    expect(rec.folder).toBe('FocusForge/Learning/Café')
  })

  it('update writes only on change and serialises concurrent updates', async () => {
    const file = path.join(tmp(), 'state.json')
    const store = new SyncStateStore(file)
    await store.update(() => undefined)
    expect(fs.existsSync(file)).toBe(false)
    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        store.update((s) => {
          s.notes[`FocusForge/${id}.md`] = {
            itemId: id,
            kind: 'item',
            hash: '',
            mtimeMs: 0,
            size: 0,
            checks: {},
            appRegionHash: '',
            myNotesHash: '',
            state: 'ok',
            writtenAt: ''
          }
        })
      )
    )
    expect(Object.keys((await store.load()).notes).sort()).toEqual([
      'FocusForge/a.md',
      'FocusForge/b.md',
      'FocusForge/c.md'
    ])
  })
})
