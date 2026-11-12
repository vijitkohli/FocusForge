import fs from 'fs-extra'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const nodeFs = await import('fs')
  const nodeOs = await import('os')
  const nodePath = await import('path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'flowstate-whatnext-'))
  return { app: { getPath: () => dir } }
})

import type { SkipEvent } from '../../common/whatNext'
import { WhatNextStore } from './WhatNextStore'
import { SKIPS_LOG_PATH, WHATNEXT_PATH } from './paths'

let clock = new Date(2026, 10, 12, 15, 0, 0)

function event(over: Partial<SkipEvent> = {}): SkipEvent {
  return {
    at: '2026-11-12T04:00:00.000Z',
    date: '2026-11-12',
    hour: 15,
    itemId: 'thesis',
    taskId: 'proposal',
    subtaskId: 's1',
    reason: 'none',
    chip: 'anything',
    mood: 'all',
    itemKind: 'deadline',
    category: 'Learning',
    difficulty: 'easy',
    minutes: 15,
    dueDays: 9,
    dueConfidence: 'confirmed',
    isLooseEnd: false,
    rank: 0,
    ...over
  }
}

function store(): WhatNextStore {
  return new WhatNextStore({
    now: () => clock,
    itemIds: () => ['thesis', 'comp9321'],
    readDigest: async (id) =>
      id === 'thesis'
        ? {
            dueDates: [
              { what: 'Proposal v5', date: '2026-11-21', confidence: 'confirmed' as const }
            ]
          }
        : null
  })
}

beforeEach(async () => {
  clock = new Date(2026, 10, 12, 15, 0, 0)
  await fs.remove(WHATNEXT_PATH)
  await fs.remove(SKIPS_LOG_PATH)
})

describe('WhatNextStore', () => {
  it('today state resets at local midnight', async () => {
    const s = store()
    expect(await s.recordSkip(event())).toBe(true)
    await s.markTouched('thesis')
    await s.addEnqueues(2)
    clock = new Date(2026, 10, 13, 9, 0, 0)
    const signals = await s.signals()
    expect(signals.date).toBe('2026-11-13')
    expect(signals.skipsToday).toEqual([])
    expect(signals.starts).toEqual({})
    expect(await s.enqueuedToday()).toBe(0)
  })

  it('recordSkip appends a jsonl line without titles', async () => {
    const s = store()
    expect(await s.recordSkip({ ...event(), title: 'Draft the methods paragraph' })).toBe(true)
    const line = (await fs.readFile(SKIPS_LOG_PATH, 'utf-8')).trim()
    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed.title).toBeUndefined()
    expect(line).not.toContain('Draft the methods')
    expect(parsed.itemId).toBe('thesis')
    expect(parsed.reason).toBe('none')
  })

  it('updateSkipReason rewrites today and appends the change', async () => {
    const s = store()
    await s.recordSkip(event())
    await s.updateSkipReason(event().at, 'tired')
    const signals = await s.signals()
    expect(signals.skipsToday).toHaveLength(1)
    expect(signals.skipsToday[0].reason).toBe('tired')
    const lines = (await fs.readFile(SKIPS_LOG_PATH, 'utf-8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]).reason).toBe('tired')
  })

  it('skip log older than 180 days is pruned', async () => {
    const old = {
      ...event(),
      at: new Date(clock.getTime() - 200 * 24 * 60 * 60 * 1000).toISOString(),
      date: '2026-04-26'
    }
    await fs.outputFile(SKIPS_LOG_PATH, `${JSON.stringify(old)}\n`)
    const s = store()
    await s.recordSkip(event())
    const text = await fs.readFile(SKIPS_LOG_PATH, 'utf-8')
    expect(text).not.toContain('2026-04-26')
    expect(text).toContain('"subtaskId":"s1"')
  })

  it('signals carry digest dues and a start today', async () => {
    const s = store()
    await s.markTouched('thesis')
    const signals = await s.signals()
    expect(signals.dues.find((d) => d.itemId === 'thesis')?.nextDue).toMatchObject({
      what: 'Proposal v5',
      date: '2026-11-21',
      confidence: 'confirmed'
    })
    expect(signals.dues.find((d) => d.itemId === 'comp9321')?.nextDue).toBeNull()
    expect(signals.starts.thesis).toBe(clock.toISOString())
  })

  it('rejects a skip from another day and a bad item id', async () => {
    const s = store()
    expect(await s.recordSkip(event({ date: '2026-11-11' }))).toBe(false)
    await s.markTouched('../vault/Life')
    expect((await s.signals()).starts).toEqual({})
  })
})
