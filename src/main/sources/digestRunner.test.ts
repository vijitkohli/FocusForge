import { describe, expect, it } from 'vitest'
import { DEFAULT_PACK_BUDGET, type ContextPack, type PackFile } from '../../common/readers'
import type { ItemDigest } from '../../common/digest'
import { EngineCallRegistry, EngineCancelled, EngineTimeout, type EngineCall } from '../engine'
import {
  buildDigestPayload,
  chooseMode,
  engineDigestRunner,
  parseEngineReply,
  targetChars
} from './digestRunner'
import { packBasis } from './packPrompt'

const file = (
  id: string,
  label: string,
  text: string,
  kind: PackFile['kind'] = 'doc'
): PackFile => ({
  id,
  label,
  ref: `/abs/owner/${label}`,
  kind,
  mtimeMs: new Date('2026-11-10T12:00:00').getTime(),
  size: text.length,
  hash: `h${id}${text.length}`,
  chars: text.length,
  truncated: false,
  redactions: 0,
  changed: true,
  text
})

const pack: ContextPack = {
  version: 1,
  itemId: 'thesis',
  builtAt: '2026-11-11T00:00:00.000Z',
  budget: DEFAULT_PACK_BUDGET,
  totalChars: 30_000,
  truncated: false,
  sources: [{ ref: '/abs/owner/thesis', state: 'ok', files: 3 }],
  files: [
    file('F1', 'thesis/CONTEXT.md', 'c'.repeat(1000), 'context'),
    file('F2', 'thesis/a.md', 'a'.repeat(10_000)),
    file('F3', 'thesis/b.md', 'b'.repeat(19_000))
  ],
  git: [],
  index: [],
  seen: {},
  activityAt: null,
  notDownloaded: 0,
  conflicts: 0,
  fingerprint: 'fp'
}

const prev = (over: Partial<ItemDigest> = {}): ItemDigest => ({
  version: 1,
  itemId: 'thesis',
  generatedAt: '2026-11-10T00:00:00.000Z',
  model: 'm',
  mode: 'full',
  incrementalSinceFull: 0,
  packFingerprint: 'old',
  promptVersion: 1,
  goal: 'g',
  currentState: 's',
  openItems: [],
  dueDates: [],
  recentProgress: [],
  candidateTasks: [],
  constraints: [],
  suggestedKind: null,
  warnings: [],
  basis: packBasis(pack),
  ...over
})

const NOW = new Date('2026-11-11T00:00:00.000Z').getTime()

describe('digestRunner', () => {
  it('targetChars scales with the pack', () => {
    expect(targetChars(2_000)).toEqual([1_500, 2_500])
    expect(targetChars(16_000)).toEqual([4_000, 6_667])
    expect(targetChars(120_000)).toEqual([6_000, 10_000])
  })

  it('chooseMode: full without basis, when old, after 8 runs or a big change', () => {
    expect(chooseMode(null, pack, NOW)).toBe('full')
    expect(chooseMode(prev({ basis: undefined }), pack, NOW)).toBe('full')
    expect(chooseMode(prev(), pack, NOW)).toBe('incremental')
    expect(chooseMode(prev({ generatedAt: '2026-11-01T00:00:00.000Z' }), pack, NOW)).toBe('full')
    expect(chooseMode(prev({ incrementalSinceFull: 8 }), pack, NOW)).toBe('full')
    expect(chooseMode(prev({ promptVersion: 0 }), pack, NOW)).toBe('full')
    const small = prev()
    small.basis!.files['thesis/a.md'] = 'changed' // 10K of 30K = 33%
    expect(chooseMode(small, pack, NOW)).toBe('incremental')
    small.basis!.files['thesis/b.md'] = 'changed'
    expect(chooseMode(small, pack, NOW)).toBe('full')
  })

  it('payload carries labels and excerpts, never absolute refs', () => {
    const { payload, sentIds } = buildDigestPayload(
      { name: 'Thesis', category: 'Learning', kind: 'deadline' },
      pack,
      null,
      { model: 'cliproxy/gemini-3-flash', today: '2026-11-11', full: true }
    )
    expect(payload.files.map((f) => f.label)).toEqual([
      'thesis/CONTEXT.md',
      'thesis/a.md',
      'thesis/b.md'
    ])
    expect(sentIds).toEqual(['F1', 'F2', 'F3'])
    expect(JSON.stringify(payload)).not.toContain('/abs/owner')
    expect(payload.previous).toBeNull()
    expect(payload.targetChars).toEqual([6_000, 10_000])
    const inc = buildDigestPayload(
      { name: 'Thesis', category: 'Learning', kind: 'deadline' },
      pack,
      prev(),
      {
        model: 'm',
        today: '2026-11-11',
        full: false
      }
    )
    expect(inc.payload.files.map((f) => f.id)).toEqual(['F1'])
    expect(inc.payload.previous?.goal).toBe('g')
  })

  it('parseEngineReply maps statuses and unknown errors', () => {
    expect(
      parseEngineReply({ status: 'ok', digest: { goal: 'x' }, repaired: true, warnings: ['w', 3] })
    ).toEqual({
      ok: true,
      raw: { goal: 'x' },
      repaired: true,
      warnings: ['w']
    })
    expect(parseEngineReply({ status: 'error', error: 'proxy-down' })).toEqual({
      ok: false,
      error: 'proxy-down'
    })
    expect(parseEngineReply({ status: 'error', error: 'weird' })).toEqual({
      ok: false,
      error: 'model-error'
    })
    expect(parseEngineReply(null)).toEqual({ ok: false, error: 'model-error' })
  })

  it('engine runner tracks per item and maps cancel and timeout', async () => {
    const registry = new EngineCallRegistry()
    const make = (fail?: Error): EngineCall => {
      let reject!: (e: Error) => void
      let resolve!: (v: Record<string, unknown>) => void
      const promise = new Promise<Record<string, unknown>>((res, rej) => {
        resolve = res
        reject = rej
      })
      if (fail) setTimeout(() => reject(fail), 0)
      else setTimeout(() => resolve({ status: 'ok', digest: { goal: 'g' } }), 5)
      return { promise, cancel: () => reject(new EngineCancelled()) }
    }
    const isC = (e: unknown): boolean => e instanceof EngineCancelled
    const isT = (e: unknown): boolean => e instanceof EngineTimeout
    const runner = engineDigestRunner(() => make(), registry, isC, isT)
    const p = runner.run('a', {} as never, 1000)
    runner.cancel('a')
    expect(await p).toEqual({ ok: false, error: 'cancelled' })
    expect((await runner.run('b', {} as never, 1000)).ok).toBe(true)
    const timeout = engineDigestRunner(() => make(new EngineTimeout(10)), registry, isC, isT)
    expect(await timeout.run('c', {} as never, 10)).toEqual({ ok: false, error: 'timeout' })
  })
})
