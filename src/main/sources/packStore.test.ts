import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPackStore } from './packStore'
import type { ItemDigest } from '../../common/digest'

let tmp: string

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-packstore-')))
})
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const digest = (n: number): ItemDigest => ({
  version: 1,
  itemId: 'thesis',
  generatedAt: `2026-11-11T00:00:0${n}.000Z`,
  model: 'm',
  mode: 'full',
  incrementalSinceFull: 0,
  packFingerprint: `fp${n}`,
  promptVersion: 1,
  goal: `goal ${n}`,
  currentState: 'state',
  openItems: [],
  dueDates: [],
  recentProgress: [],
  candidateTasks: [],
  constraints: [],
  suggestedKind: null,
  warnings: []
})

describe('packStore', () => {
  it('writes digests atomically and keeps the newest 5 in history', async () => {
    let t = new Date('2026-11-11T10:00:00').getTime()
    const store = createPackStore({
      readerDir: (id) => path.join(tmp, id, 'reader'),
      canWrite: (p) => p.startsWith(tmp),
      now: () => new Date((t += 1000))
    })
    expect(await store.readDigest('thesis')).toBeNull()
    for (let i = 0; i < 8; i++) await store.writeDigest('thesis', digest(i))
    expect((await store.readDigest('thesis'))?.goal).toBe('goal 7')
    const history = fs.readdirSync(path.join(tmp, 'thesis', 'reader', 'digests')).sort()
    expect(history).toHaveLength(5)
    const last = JSON.parse(
      fs.readFileSync(path.join(tmp, 'thesis', 'reader', 'digests', history[4]), 'utf8')
    )
    expect(last.goal).toBe('goal 6')
  })

  it('refuses writes outside the allowed folder and bad ids', async () => {
    const store = createPackStore({
      readerDir: (id) => path.join(tmp, id, 'reader'),
      canWrite: () => false
    })
    await expect(store.writeDigest('x', digest(1))).rejects.toThrow('refused')
    await expect(store.writeDigest('../x', digest(1))).rejects.toThrow()
    expect(await store.readPack('missing')).toBeNull()
  })
})
