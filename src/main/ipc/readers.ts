// src/main/ipc/readers.ts
// Electron wiring for Phase 3 readers: builds the ReaderService (pack store,
// doc text, digest runner, watcher), turns digests into the per-item Loose
// ends task, forwards `digest-updated` and reader status to the renderer,
// and registers the reader IPC. The renderer gets statuses and digests,
// never pack text or paths.
import { BrowserWindow, ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { ReaderStatus, RefreshResult } from '../../common/readers'
import type { ItemDigest } from '../../common/digest'
import { localDay } from '../../common/digest'
import { earliestDueDate, mergeLooseEnds } from '../../common/looseEnds'
import type { FileSystemManager } from '../fs-manager'
import { EngineCallRegistry, EngineCancelled, EngineTimeout, type EngineCall } from '../engine'
import { loadSettings } from '../settings'
import { DOCTEXT_CACHE_DIR, ROOT_DIR, readerDir } from '../store/paths'
import { getGuard } from '../sources'
import { createPackStore, type PackStore } from '../sources/packStore'
import { createDocText } from '../sources/doctext'
import { gitLog } from '../sources/git'
import { engineDigestRunner, type DigestPayload } from '../sources/digestRunner'
import { ReaderService, type ReaderConfig } from '../sources/readers'
import type { WatchFs } from '../sources/watch'
import type { ProxyHealth } from '../proxyHealth'

export interface ReaderWiringDeps {
  fsManager: FileSystemManager
  health: ProxyHealth
  /** Runs an engine script once (one JSON payload in, last JSON line out). */
  runScript: (
    script: string,
    payload: unknown,
    timeoutMs: number,
    onStderr: (line: string) => void
  ) => EngineCall
  /** Phase 4 hook: virtual My-notes refs per item (none until Phase 4 lands). */
  virtualRefs?: (itemId: string) => Promise<string[]> | string[]
}

export interface ReaderWiring {
  service: ReaderService
  store: PackStore
  /** Call after any item change. */
  sync(): void
  /** Call after a settings change. */
  restart(): void
  start(): Promise<void>
  stop(): void
}

/** QA-only knobs: a short debounce also shortens start delay, stagger and the auto-run interval. */
export function readerConfigFromEnv(env = process.env): {
  config: Partial<ReaderConfig>
  startDelayMs: number
} {
  const n = Number(env.FOCUSFORGE_READER_DEBOUNCE_MS)
  if (!Number.isFinite(n) || n <= 0) return { config: {}, startDelayMs: 20_000 }
  return {
    config: {
      quietMs: n,
      maxWaitMs: n * 5,
      staggerMs: Math.min(15_000, n),
      minAutoIntervalMs: Math.min(10 * 60_000, n),
      pollMs: Math.min(60_000, Math.max(1_000, n))
    },
    startDelayMs: Math.min(20_000, n)
  }
}

/** stderr from digest.py / doctext.py: only error lines, truncated, never content. */
function stderrFilter(script: string): (line: string) => void {
  return (line) => {
    if (/Error|Traceback/.test(line)) console.error(`[${script}]`, line.slice(0, 200))
  }
}

const nodeWatchFs: WatchFs = {
  watch: (p, o, cb) => fs.watch(p, { recursive: o.recursive, persistent: o.persistent }, cb)
}

function send(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args)
  }
}

export function initReaders(deps: ReaderWiringDeps): ReaderWiring & { startDelayMs: number } {
  const { fsManager, health } = deps
  const rootPrefix = ROOT_DIR + path.sep
  const store = createPackStore({
    readerDir,
    canWrite: (p) => path.resolve(p).startsWith(rootPrefix)
  })
  const registry = new EngineCallRegistry()
  const docText = createDocText({
    guard: getGuard,
    cacheDir: DOCTEXT_CACHE_DIR,
    engine: (req, timeoutMs) =>
      deps.runScript('doctext.py', req, timeoutMs, stderrFilter('doctext.py')).promise
  })
  const runner = engineDigestRunner(
    (payload: DigestPayload, timeoutMs) =>
      deps.runScript('digest.py', payload, timeoutMs, stderrFilter('digest.py')),
    registry,
    (e) => e instanceof EngineCancelled,
    (e) => e instanceof EngineTimeout
  )

  // Status push, throttled to once a second (trailing).
  let pending: Record<string, ReaderStatus> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const pushStatus = (all: Record<string, ReaderStatus>): void => {
    pending = all
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      if (pending) send('reader-status', pending)
      pending = null
    }, 1000)
  }

  const { config, startDelayMs } = readerConfigFromEnv()
  const service = new ReaderService({
    getGuard,
    listItems: () => fsManager.getProjects(),
    getSettings: async () => {
      const s = await loadSettings()
      return { digestModel: s.digestModel, readersEnabled: s.readersEnabled }
    },
    store,
    digest: runner,
    health,
    pack: { git: gitLog, docText },
    setSourceActivity: (id, iso) => fsManager.setSourceActivity(id, iso),
    onStatus: pushStatus,
    virtualRefs: deps.virtualRefs,
    watchFs: nodeWatchFs,
    config,
    log: (msg) => console.log(msg)
  })

  /** Digest gaps -> the item's Loose ends task (through the normal locked save). */
  const syncLooseEnds = async (itemId: string, digest?: ItemDigest | null): Promise<void> => {
    const d = digest ?? (await store.readDigest(itemId))
    if (!d) return
    const settings = await loadSettings()
    const today = localDay(Date.now())
    let changed = false
    await fsManager.updateProjectData(itemId, async (data) => {
      const seen = data.looseEndsSeen ?? []
      const r = mergeLooseEnds(data.tasks ?? [], d.candidateTasks, seen, {
        today,
        newId: () => randomUUID(),
        earliestDue: earliestDueDate(d.dueDates, today),
        model: settings.planModel || settings.chatModel
      })
      const seenChanged = r.seen.length !== seen.length || r.seen.some((x, i) => x !== seen[i])
      if (!r.changed && !seenChanged) return null
      changed = true
      return { data: { ...data, tasks: r.tasks, looseEndsSeen: r.seen }, notes: r.notes }
    })
    if (changed) send('tasks-changed')
  }

  service.onDigest((itemId) => {
    void syncLooseEnds(itemId)
      .catch((e) =>
        console.error(`Loose ends for ${itemId} failed:`, (e as Error)?.name ?? 'error')
      )
      .finally(() => send('digest-updated', itemId))
  })

  ipcMain.handle('get-reader-status', (): Record<string, ReaderStatus> => service.status())
  ipcMain.handle('refresh-item', (_e, itemId: unknown): Promise<RefreshResult> => {
    if (typeof itemId !== 'string' || !itemId)
      return Promise.resolve({ queued: false, reason: 'not-found' })
    return service.refresh(itemId, 'manual')
  })
  ipcMain.handle('refresh-all-items', () => service.refreshAll('manual'))
  ipcMain.handle('cancel-item-refresh', (_e, itemId: unknown) => {
    if (typeof itemId === 'string') service.cancel(itemId)
  })
  ipcMain.handle('get-item-digest', async (_e, itemId: unknown): Promise<ItemDigest | null> => {
    if (typeof itemId !== 'string' || !itemId) return null
    const d = await store.readDigest(itemId)
    if (!d) return null
    // basis is bookkeeping (labels -> hashes); the renderer doesn't need it.
    const { basis: _basis, ...rest } = d
    void _basis
    return rest
  })

  const sync = (): void => {
    void service
      .syncItems()
      .catch((e) => console.error('Reader sync failed:', (e as Error)?.name ?? 'error'))
  }

  const start = async (): Promise<void> => {
    await service.start()
    // Fill freed Loose ends slots from stored digests once at start.
    for (const p of fsManager.getProjects()) {
      if (p.status === 'archived') continue
      await syncLooseEnds(p.id).catch(() => undefined)
    }
  }

  /** After a settings change (vault, roots, readersEnabled): new guard, fresh watchers. */
  const restart = (): void => {
    void service
      .restart()
      .catch((e) => console.error('Reader restart failed:', (e as Error)?.name ?? 'error'))
  }

  return { service, store, sync, restart, start, stop: () => service.stop(), startDelayMs }
}
