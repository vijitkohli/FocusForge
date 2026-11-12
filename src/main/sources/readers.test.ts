import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PathGuard } from './guard'
import { ReaderService, type ReaderDeps } from './readers'
import type { PackStore } from './packStore'
import type { DigestPayload, DigestRunResult, DigestRunner } from './digestRunner'
import type { WatchFs } from './watch'
import { ProxyHealth } from '../proxyHealth'
import { DEFAULT_PACK_BUDGET, type ContextPack, type ReaderStatus } from '../../common/readers'
import type { ItemDigest } from '../../common/digest'
import type { Workstream } from '../../common/types'

let tmp: string
let uni: string
let vault: string

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-readers-')))
  uni = path.join(tmp, 'UNI')
  vault = path.join(tmp, 'Vault')
  fs.mkdirSync(path.join(uni, 'thesis'), { recursive: true })
  fs.mkdirSync(path.join(uni, 'comp'), { recursive: true })
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true })
  fs.writeFileSync(path.join(vault, 'Note.md'), '## FocusForge\nx\n')
})
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

function item(id: string, over: Partial<Workstream> = {}): Workstream {
  return {
    id,
    name: id,
    path: `/data/${id}`,
    progress: 0,
    lastActive: '2026-11-01T00:00:00.000Z',
    category: 'Learning',
    kind: 'deadline',
    status: 'active',
    sources: [path.join(uni, id)],
    ...over
  }
}

function makePack(id: string, fp: string, activityAt = '2026-11-10T00:00:00.000Z'): ContextPack {
  return {
    version: 1,
    itemId: id,
    builtAt: new Date().toISOString(),
    budget: DEFAULT_PACK_BUDGET,
    totalChars: 100,
    truncated: false,
    sources: [{ ref: path.join(uni, id), state: 'ok', files: 1 }],
    files: [
      {
        id: 'F1',
        label: `${id}/CONTEXT.md`,
        ref: path.join(uni, id, 'CONTEXT.md'),
        kind: 'context',
        mtimeMs: Date.parse('2026-11-10T00:00:00Z'),
        size: 10,
        hash: fp,
        chars: 20,
        truncated: false,
        redactions: 0,
        changed: true,
        text: `PACK-TEXT-CANARY ${fp}`
      }
    ],
    git: [],
    index: [],
    seen: {},
    activityAt,
    notDownloaded: 0,
    conflicts: 0,
    fingerprint: fp
  }
}

interface Harness {
  svc: ReaderService
  items: Workstream[]
  fps: Record<string, string>
  builds: string[]
  runs: { id: string; payload: DigestPayload; resolve: (r: DigestRunResult) => void }[]
  watchers: {
    path: string
    cb: (ev: string, f: string | null) => void
    closed: boolean
    err?: (e: Error) => void
  }[]
  digests: Map<string, ItemDigest>
  statuses: Record<string, ReaderStatus>[]
  activity: [string, string][]
  proxy: { up: boolean }
  onDigest: string[]
  cancels: string[]
  settings: { digestModel: string; readersEnabled: boolean }
}

function harness(over: Partial<ReaderDeps> = {}, items = [item('thesis'), item('comp')]): Harness {
  const h: Harness = {
    svc: null as unknown as ReaderService,
    items,
    fps: Object.fromEntries(items.map((i) => [i.id, 'fp1'])),
    builds: [],
    runs: [],
    watchers: [],
    digests: new Map(),
    statuses: [],
    activity: [],
    proxy: { up: true },
    onDigest: [],
    cancels: [],
    settings: { digestModel: 'cliproxy/gemini-3-flash', readersEnabled: true }
  }
  const packs = new Map<string, ContextPack>()
  const store: PackStore = {
    readPack: async (id) => packs.get(id) ?? null,
    writePack: async (id, p) => void packs.set(id, p),
    readDigest: async (id) => h.digests.get(id) ?? null,
    writeDigest: async (id, d) => void h.digests.set(id, d)
  }
  const runner: DigestRunner = {
    run: (id, payload) => new Promise((resolve) => h.runs.push({ id, payload, resolve })),
    cancel: (id) => {
      h.cancels.push(id)
      const r = h.runs.find((x) => x.id === id)
      r?.resolve({ ok: false, error: 'cancelled' })
    },
    cancelAll: () => undefined
  }
  const watchFs: WatchFs = {
    watch: (p, _o, cb) => {
      const w = {
        path: p,
        cb: cb as (ev: string, f: string | null) => void,
        closed: false
      } as Harness['watchers'][number]
      h.watchers.push(w)
      return {
        close: () => void (w.closed = true),
        on: (_ev: 'error', fn: (e: Error) => void) => void (w.err = fn)
      }
    }
  }
  const health = new ProxyHealth({
    ttlMs: 0,
    fetchImpl: (async () => {
      if (!h.proxy.up) throw new Error('refused')
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch
  })
  const guard = new PathGuard({
    sourceRoots: [uni],
    vaultRoots: [vault],
    readableVault: vault,
    caseInsensitive: true
  })
  h.svc = new ReaderService({
    getGuard: async () => guard,
    listItems: () => h.items,
    getSettings: async () => h.settings,
    store,
    digest: runner,
    health,
    pack: { git: async () => null, docText: async () => null },
    setSourceActivity: async (id, iso) => void h.activity.push([id, iso]),
    onStatus: (all) => h.statuses.push(all),
    watchFs,
    buildPack: async (_g, it) => {
      h.builds.push(it.id)
      return makePack(it.id, h.fps[it.id])
    },
    ...over
  })
  h.svc.onDigest((id) => h.onDigest.push(id))
  return h
}

const okDigest = (goal = 'Finish'): DigestRunResult => ({
  ok: true,
  raw: {
    goal,
    currentState: '### Overview\nstate [F1]',
    candidateTasks: [{ title: 'Find the slot', sources: ['F1'] }]
  },
  repaired: false,
  warnings: []
})

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  })
  vi.setSystemTime(new Date('2026-11-11T09:00:00'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('ReaderService', () => {
  it('debounces 2 min of quiet, max wait 10 min', async () => {
    const h = harness()
    await h.svc.syncItems()
    const w = h.watchers.find((x) => x.path === path.join(uni, 'thesis'))!
    w.cb('change', 'CONTEXT.md')
    expect(h.svc.status().thesis.state).toBe('pending')
    await vi.advanceTimersByTimeAsync(119_000)
    expect(h.builds).toEqual([])
    w.cb('change', 'notes.md') // restarts the quiet period
    await vi.advanceTimersByTimeAsync(119_000)
    expect(h.builds).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(h.builds).toEqual(['thesis'])
    // Continuous edits still sync within 10 minutes.
    h.builds.length = 0
    w.cb('change', 'a.md')
    for (let t = 0; t < 10; t++) {
      await vi.advanceTimersByTimeAsync(60_000)
      w.cb('change', 'a.md')
    }
    await flush()
    expect(h.builds).toEqual(['thesis'])
    // The edit right after that sync starts a new quiet period.
    await vi.advanceTimersByTimeAsync(120_000)
    await flush()
    expect(h.builds).toEqual(['thesis', 'thesis'])
    // Ignored names never mark it dirty.
    h.builds.length = 0
    w.cb('change', 'node_modules/x.md')
    w.cb('change', '.env')
    await vi.advanceTimersByTimeAsync(300_000)
    await flush()
    expect(h.builds).toEqual([])
    h.svc.stop()
  })

  it('paused items have no watchers; manual refresh still works', async () => {
    const h = harness({}, [item('thesis', { status: 'paused' })])
    await h.svc.syncItems()
    expect(h.watchers).toEqual([])
    expect(h.svc.status().thesis.state).toBe('off')
    expect(await h.svc.refresh('thesis', 'watch')).toEqual({ queued: false, reason: 'disabled' })
    expect(await h.svc.refresh('thesis', 'manual')).toEqual({ queued: true })
    await flush()
    expect(h.runs).toHaveLength(1)
    expect(await h.svc.refresh('nope', 'manual')).toEqual({ queued: false, reason: 'not-found' })
    h.svc.stop()
  })

  it('no digest when the fingerprint is unchanged; manual refresh forces one', async () => {
    const h = harness()
    await h.svc.syncItems()
    await h.svc.refresh('thesis', 'start')
    await flush()
    h.runs[0].resolve(okDigest())
    await flush()
    expect(h.digests.get('thesis')?.packFingerprint).toBe('fp1')
    expect(h.onDigest).toEqual(['thesis'])
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(await h.svc.refresh('thesis', 'watch')).toEqual({ queued: false })
    expect(h.runs).toHaveLength(1)
    expect(await h.svc.refresh('thesis', 'manual')).toEqual({ queued: true })
    await flush()
    expect(h.runs).toHaveLength(2)
    h.svc.stop()
  })

  it('one digest at a time', async () => {
    const h = harness()
    await h.svc.syncItems()
    await h.svc.refresh('thesis', 'start')
    await h.svc.refresh('comp', 'start')
    await flush()
    expect(h.runs.map((r) => r.id)).toEqual(['thesis'])
    expect(h.svc.status().comp.state).toBe('queued')
    h.runs[0].resolve(okDigest())
    await flush()
    expect(h.runs.map((r) => r.id)).toEqual(['thesis', 'comp'])
    h.svc.stop()
  })

  it('proxy down sets waiting-ai, keeps the queue, resumes on up', async () => {
    const h = harness()
    h.proxy.up = false
    await h.svc.start()
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    expect(h.runs).toEqual([])
    expect(h.svc.status().thesis.state).toBe('waiting-ai')
    await vi.advanceTimersByTimeAsync(15_000)
    await flush()
    expect(h.svc.status().comp.state).toBe('waiting-ai')
    h.proxy.up = true
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(h.runs.map((r) => r.id)).toEqual(['thesis'])
    // A proxy-down outcome from the call itself also waits.
    h.runs[0].resolve({ ok: false, error: 'proxy-down' })
    await flush()
    expect(h.svc.status().thesis.state).toBe('waiting-ai')
    h.svc.stop()
  })

  it('rate-limited backs off 15 min', async () => {
    const h = harness({}, [item('thesis')])
    await h.svc.syncItems()
    await h.svc.refresh('thesis', 'start')
    await flush()
    h.runs[0].resolve({ ok: false, error: 'rate-limited' })
    await flush()
    expect(h.svc.status().thesis.state).toBe('waiting-ai')
    await vi.advanceTimersByTimeAsync(14 * 60_000)
    await flush()
    expect(h.runs).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(h.runs).toHaveLength(2)
    h.svc.stop()
  })

  it('min interval and daily cap for automatic runs', async () => {
    const h = harness({ config: { maxAutoPerDay: 2 } }, [item('thesis')])
    await h.svc.syncItems()
    await h.svc.refresh('thesis', 'start')
    await flush()
    h.runs[0].resolve(okDigest())
    await flush()
    h.fps.thesis = 'fp2'
    expect(await h.svc.refresh('thesis', 'watch')).toEqual({ queued: false })
    expect(h.svc.status().thesis.state).toBe('pending')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await flush()
    expect(h.runs).toHaveLength(2)
    h.runs[1].resolve(okDigest())
    await flush()
    h.fps.thesis = 'fp3'
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(await h.svc.refresh('thesis', 'watch')).toEqual({ queued: false })
    expect(h.runs).toHaveLength(2) // capped for today
    expect(await h.svc.refresh('thesis', 'manual')).toEqual({ queued: true })
    h.svc.stop()
  })

  it('syncItems cancels the in-flight digest of a paused item', async () => {
    const h = harness({}, [item('thesis')])
    await h.svc.syncItems()
    await h.svc.refresh('thesis', 'start')
    await flush()
    expect(h.runs).toHaveLength(1)
    h.items = [item('thesis', { status: 'paused' })]
    await h.svc.syncItems()
    await flush()
    expect(h.cancels).toEqual(['thesis'])
    expect(h.svc.status().thesis.state).toBe('off')
    expect(h.watchers.every((w) => w.closed)).toBe(true)
    expect(h.digests.has('thesis')).toBe(false)
    h.svc.stop()
  })

  it('invalid digest keeps the previous one and sets error', async () => {
    const h = harness({}, [item('thesis')])
    await h.svc.syncItems()
    await h.svc.refresh('thesis', 'manual')
    await flush()
    h.runs[0].resolve(okDigest('First'))
    await flush()
    await h.svc.refresh('thesis', 'manual')
    await flush()
    h.runs[1].resolve({ ok: true, raw: { goal: '' }, repaired: true, warnings: [] })
    await flush()
    expect(h.digests.get('thesis')?.goal).toBe('First')
    expect(h.svc.status().thesis.state).toBe('error')
    expect(h.svc.status().thesis.error?.code).toBe('invalid')
    await h.svc.refresh('thesis', 'manual')
    await flush()
    h.runs[2].resolve({ ok: false, error: 'auth' })
    await flush()
    expect(h.svc.status().thesis.error).toEqual({
      code: 'auth',
      message: 'AI login problem in CLIProxyAPI.'
    })
    h.svc.stop()
  })

  it('saved digest gets basis, candidate ids and resolved citations', async () => {
    const h = harness({}, [item('thesis')])
    await h.svc.syncItems()
    await h.svc.refresh('thesis', 'manual')
    await flush()
    h.runs[0].resolve(okDigest())
    await flush()
    const d = h.digests.get('thesis')!
    expect(d.basis).toEqual({ files: { 'thesis/CONTEXT.md': 'fp1' }, git: {} })
    expect(d.candidateTasks[0].id).toMatch(/^g[a-z0-9]{10}$/)
    expect(d.currentState).toBe('### Overview\nstate (thesis/CONTEXT.md, 10 Nov)')
    expect(d.mode).toBe('full')
    expect(h.svc.status().thesis.lastDigestAt).toBe(d.generatedAt)
    h.svc.stop()
  })

  it('updates sourceActivityAt forward only', async () => {
    const h = harness({}, [
      item('thesis', { sourceActivityAt: '2026-11-12T00:00:00.000Z' }),
      item('comp')
    ])
    await h.svc.syncItems()
    await h.svc.refresh('thesis', 'start')
    await h.svc.refresh('comp', 'start')
    expect(h.activity).toEqual([['comp', '2026-11-10T00:00:00.000Z']])
    h.svc.stop()
  })

  it('watcher error closes it and reports source-missing', async () => {
    const h = harness({}, [item('thesis')])
    await h.svc.syncItems()
    const w = h.watchers[0]
    w.err?.(new Error('EPERM'))
    expect(w.closed).toBe(true)
    expect(h.svc.status().thesis.error?.code).toBe('source-missing')
    expect(h.svc.watchedRoots()).toEqual([])
    h.svc.stop()
  })

  it('caps recursive watchers and never watches the vault root', async () => {
    const many = Array.from({ length: 3 }, (_, i) => {
      fs.mkdirSync(path.join(uni, `c${i}`), { recursive: true })
      return item(`c${i}`)
    })
    const h = harness({ config: { maxRecursive: 2 } }, [
      ...many,
      item('v', { sources: [vault, `${path.join(vault, 'Note.md')}#FocusForge`] })
    ])
    await h.svc.syncItems()
    expect(h.svc.watchedRoots()).toHaveLength(2)
    expect(h.svc.watchedRoots().includes(vault)).toBe(false)
    expect(h.svc.status().v.watching).toBe(true) // the note is polled
    h.svc.stop()
  })

  it('status push never contains paths or content', async () => {
    const h = harness()
    await h.svc.syncItems()
    await h.svc.refresh('thesis', 'manual')
    await flush()
    h.runs[0].resolve(okDigest())
    await flush()
    const blob = JSON.stringify(h.statuses)
    expect(blob.includes(tmp)).toBe(false)
    expect(blob.includes('PACK-TEXT-CANARY')).toBe(false)
    expect(blob.includes('CONTEXT.md')).toBe(false)
    h.svc.stop()
  })

  it('readersEnabled=false turns everything off', async () => {
    const h = harness()
    h.settings.readersEnabled = false
    await h.svc.syncItems()
    expect(h.watchers).toEqual([])
    expect(await h.svc.refresh('thesis', 'manual')).toEqual({ queued: false, reason: 'disabled' })
    h.svc.stop()
  })
})
