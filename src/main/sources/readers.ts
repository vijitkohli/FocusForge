// src/main/sources/readers.ts
// ReaderService: keeps every active item's context pack and digest current.
// Watches folder sources (recursive fs.watch), polls single notes, debounces
// changes (2 min quiet, 10 min max wait), rebuilds the pack locally, and runs
// at most one background digest at a time when the pack's fingerprint moved.
// After a digest is saved it emits `digest-updated(itemId)` (onDigest), which
// Phase 4 (note rewrite), Phase 5 (tasks) and Phase 6 (re-rank) subscribe to.
//
// No electron import: everything is injected, so it runs under fake timers.
// Logs carry item ids, counts and codes only, never paths or content.
import type {
  ContextPack,
  ReaderErrorCode,
  ReaderStatus,
  RefreshResult
} from '../../common/readers'
import { READER_ERROR_COPY } from '../../common/readers'
import { localDay, normalizeDigest, type ItemDigest } from '../../common/digest'
import type { Workstream } from '../../common/types'
import type { PathGuard } from './guard'
import type { PackStore } from './packStore'
import { buildPack, type BuildPackDeps } from './pack'
import { packBasis } from './packPrompt'
import { DigestQueue, type DigestPriority, type QueueEntry } from './queue'
import {
  buildDigestPayload,
  chooseMode,
  FULL_TIMEOUT_MS,
  INCREMENTAL_TIMEOUT_MS,
  type DigestRunner
} from './digestRunner'
import { planWatches, relevantEvent, type WatchFs, type Watcher } from './watch'
import { usesProxy, type ProxyHealth } from '../proxyHealth'

export type RefreshReason = 'manual' | 'watch' | 'start' | 'rescan'

export interface ReaderConfig {
  quietMs: number
  maxWaitMs: number
  rescanMs: number
  pollMs: number
  staggerMs: number
  maxRecursive: number
  /** Rescan interval for items that couldn't get a recursive watcher. */
  slowRescanMs: number
  minAutoIntervalMs: number
  maxAutoPerDay: number
  /** Back-off while the proxy is down. */
  proxyBackoffMs: number[]
  rateLimitMs: number
}

export const DEFAULT_READER_CONFIG: ReaderConfig = {
  quietMs: 120_000,
  maxWaitMs: 600_000,
  rescanMs: 30 * 60_000,
  pollMs: 60_000,
  staggerMs: 15_000,
  maxRecursive: 24,
  slowRescanMs: 15 * 60_000,
  minAutoIntervalMs: 10 * 60_000,
  maxAutoPerDay: 24,
  proxyBackoffMs: [60_000, 120_000, 300_000, 900_000],
  rateLimitMs: 15 * 60_000
}

export interface ReaderSettings {
  digestModel: string
  readersEnabled: boolean
}

export interface ReaderDeps {
  getGuard(): Promise<PathGuard>
  listItems(): Promise<Workstream[]> | Workstream[]
  getSettings(): Promise<ReaderSettings>
  store: PackStore
  digest: DigestRunner
  health: ProxyHealth
  pack: BuildPackDeps
  setSourceActivity(id: string, iso: string): Promise<void>
  onStatus(all: Record<string, ReaderStatus>): void
  /** Phase 4's virtual `…FocusForge/…md#My notes` refs for an item. */
  virtualRefs?(itemId: string): Promise<string[]> | string[]
  watchFs?: WatchFs
  /** Test seam; defaults to the real pack builder. */
  buildPack?: typeof buildPack
  now?: () => number
  config?: Partial<ReaderConfig>
  log?: (msg: string) => void
}

interface ItemState {
  item: Workstream
  sig: string
  status: ReaderStatus
  watchers: { path: string; w: Watcher }[]
  pollTargets: Map<string, string>
  pollTimer: ReturnType<typeof setInterval> | null
  rescanTimer: ReturnType<typeof setInterval> | null
  debounceTimer: ReturnType<typeof setTimeout> | null
  retryTimer: ReturnType<typeof setTimeout> | null
  dirtySince: number | null
  building: Promise<unknown> | null
  autoDay: string
  autoCount: number
  lastAutoAt: number
  backoffUntil: number
}

const sigOf = (w: Workstream): string => JSON.stringify([w.status, [...w.sources].sort()])

function emptyStatus(itemId: string): ReaderStatus {
  return {
    itemId,
    state: 'idle',
    watching: false,
    lastPackAt: null,
    lastDigestAt: null,
    pendingSince: null,
    files: 0,
    chars: 0,
    notDownloaded: 0,
    conflicts: 0,
    skippedSources: 0
  }
}

export class ReaderService {
  private readonly cfg: ReaderConfig
  private readonly now: () => number
  private readonly items = new Map<string, ItemState>()
  private readonly queue = new DigestQueue()
  private readonly digestListeners = new Set<(itemId: string) => void>()
  private running: string | null = null
  private started = false
  private stopped = false
  private proxyStep = 0
  /** True while the proxy is down: the queue holds until a retry or an "up" flip. */
  private proxyWaiting = false
  private proxyTimer: ReturnType<typeof setTimeout> | null = null
  private unsubHealth: (() => void) | null = null
  private startTimers: ReturnType<typeof setTimeout>[] = []
  private settings: ReaderSettings | null = null

  constructor(private readonly deps: ReaderDeps) {
    this.cfg = { ...DEFAULT_READER_CONFIG, ...deps.config }
    this.now = deps.now ?? Date.now
  }

  // ------------------------------------------------------------ public API

  /** Starts watching active items and stages a pack build for each (staggered). */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.stopped = false
    this.unsubHealth = this.deps.health.onChange((up) => {
      if (up) {
        this.proxyStep = 0
        this.proxyWaiting = false
        if (this.proxyTimer) clearTimeout(this.proxyTimer)
        this.proxyTimer = null
        this.pump()
      }
    })
    await this.syncItems()
    let i = 0
    for (const s of this.items.values()) {
      if (s.item.status !== 'active' || s.item.sources.length === 0) continue
      const id = s.item.id
      const t = setTimeout(() => void this.refresh(id, 'start'), i++ * this.cfg.staggerMs)
      this.startTimers.push(t)
    }
  }

  /** Closes every watcher and timer and cancels the running digest. */
  stop(): void {
    this.stopped = true
    this.started = false
    for (const t of this.startTimers) clearTimeout(t)
    this.startTimers = []
    for (const s of this.items.values()) this.teardown(s)
    if (this.proxyTimer) clearTimeout(this.proxyTimer)
    this.proxyTimer = null
    this.unsubHealth?.()
    this.unsubHealth = null
    this.deps.digest.cancelAll()
  }

  /** Diffs the registry against running watchers (call after any item or settings change). */
  async syncItems(): Promise<void> {
    if (this.stopped) return
    this.settings = await this.deps.getSettings()
    const list = await this.deps.listItems()
    const seen = new Set<string>()
    for (const item of list) {
      seen.add(item.id)
      const sig = sigOf(item)
      let s = this.items.get(item.id)
      if (!s) {
        s = this.newState(item)
        this.items.set(item.id, s)
        const prev = await this.deps.store.readDigest(item.id).catch(() => null)
        if (prev) s.status.lastDigestAt = prev.generatedAt
        const pack = await this.deps.store.readPack(item.id).catch(() => null)
        if (pack) this.applyPackStatus(s, pack)
      } else if (s.sig !== sig) {
        this.cancel(item.id)
        this.teardown(s)
      }
      s.item = item
      const changed = s.sig !== sig
      s.sig = sig
      if (!this.settings.readersEnabled || item.status === 'archived' || item.status === 'paused') {
        this.teardown(s)
        this.setState(s, item.sources.length === 0 ? 'no-sources' : 'off')
        continue
      }
      if (item.sources.length === 0) {
        this.teardown(s)
        this.setState(s, 'no-sources')
        continue
      }
      if (changed || !s.status.watching) await this.setupWatch(s)
      if (s.status.state === 'off' || s.status.state === 'no-sources') this.setState(s, 'idle')
    }
    for (const [id, s] of this.items) {
      if (seen.has(id)) continue
      this.cancel(id)
      this.teardown(s)
      this.items.delete(id)
    }
    this.publish()
  }

  /** Tears every watcher down and re-plans them (after settings or guard changes). */
  async restart(): Promise<void> {
    for (const s of this.items.values()) this.teardown(s)
    await this.syncItems()
  }

  /** Rebuilds the pack; a manual refresh also forces a digest. */
  async refresh(itemId: string, reason: RefreshReason): Promise<RefreshResult> {
    const s = this.items.get(itemId)
    if (!s) return { queued: false, reason: 'not-found' }
    if (s.item.sources.length === 0) return { queued: false, reason: 'no-sources' }
    const settings = this.settings ?? (await this.deps.getSettings())
    if (!settings.readersEnabled) return { queued: false, reason: 'disabled' }
    if (reason !== 'manual' && s.item.status !== 'active')
      return { queued: false, reason: 'disabled' }
    if (s.debounceTimer) clearTimeout(s.debounceTimer)
    s.debounceTimer = null
    s.dirtySince = null
    s.status.pendingSince = null
    // One build per item at a time; a refresh during a build runs after it.
    const run = (s.building ?? Promise.resolve()).then(() => this.buildAndQueue(s, reason))
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    s.building = tail
    void tail.then(() => {
      if (s.building === tail) s.building = null
    })
    return run
  }

  /** Manual refresh of every active item. */
  async refreshAll(reason: 'manual' | 'start'): Promise<void> {
    for (const s of [...this.items.values()]) {
      if (s.item.status === 'active') await this.refresh(s.item.id, reason)
    }
  }

  /** Cancels an item's queued or running digest and its pending debounce. */
  cancel(itemId: string): void {
    this.queue.remove(itemId)
    const s = this.items.get(itemId)
    if (s?.debounceTimer) clearTimeout(s.debounceTimer)
    if (s) {
      s.debounceTimer = null
      s.dirtySince = null
      s.status.pendingSince = null
    }
    if (this.running === itemId) this.deps.digest.cancel(itemId)
  }

  status(): Record<string, ReaderStatus> {
    const out: Record<string, ReaderStatus> = {}
    for (const [id, s] of this.items) out[id] = { ...s.status }
    return out
  }

  /** Paths with a recursive watcher (QA/test introspection; local only). */
  watchedRoots(): string[] {
    return [...this.items.values()].flatMap((s) => s.watchers.map((w) => w.path))
  }

  /** `digest-updated(itemId)`: fires after a new digest is saved. */
  onDigest(cb: (itemId: string) => void): () => void {
    this.digestListeners.add(cb)
    return () => this.digestListeners.delete(cb)
  }

  async getDigest(itemId: string): Promise<ItemDigest | null> {
    return this.deps.store.readDigest(itemId)
  }

  // ------------------------------------------------------------ internals

  private newState(item: Workstream): ItemState {
    return {
      item,
      sig: sigOf(item),
      status: emptyStatus(item.id),
      watchers: [],
      pollTargets: new Map(),
      pollTimer: null,
      rescanTimer: null,
      debounceTimer: null,
      retryTimer: null,
      dirtySince: null,
      building: null,
      autoDay: '',
      autoCount: 0,
      lastAutoAt: -Infinity,
      backoffUntil: 0
    }
  }

  private log(msg: string): void {
    this.deps.log?.(msg)
  }

  private publish(): void {
    try {
      this.deps.onStatus(this.status())
    } catch {
      // a broken listener never stops the readers
    }
  }

  private setState(s: ItemState, state: ReaderStatus['state'], error?: ReaderErrorCode): void {
    s.status.state = state
    if (error) s.status.error = { code: error, message: READER_ERROR_COPY[error] }
    else if (state !== 'error') delete s.status.error
    this.publish()
  }

  private teardown(s: ItemState): void {
    for (const { w } of s.watchers) {
      try {
        w.close()
      } catch {
        // already closed
      }
    }
    s.watchers = []
    for (const t of [s.pollTimer, s.rescanTimer]) if (t) clearInterval(t)
    for (const t of [s.debounceTimer, s.retryTimer]) if (t) clearTimeout(t)
    s.pollTimer = s.rescanTimer = null
    s.debounceTimer = s.retryTimer = null
    s.pollTargets.clear()
    s.dirtySince = null
    s.status.pendingSince = null
    s.status.watching = false
  }

  private recursiveCount(): number {
    let n = 0
    for (const s of this.items.values()) n += s.watchers.length
    return n
  }

  private async setupWatch(s: ItemState): Promise<void> {
    this.teardown(s)
    const guard = await this.deps.getGuard()
    const plan = await planWatches(guard, s.item.sources)
    const fsw = this.deps.watchFs
    let slow = false
    for (const dir of plan.recursive) {
      if (!fsw || this.recursiveCount() >= this.cfg.maxRecursive) {
        slow = true
        continue
      }
      try {
        const w = fsw.watch(dir, { recursive: true, persistent: false }, (_ev, filename) => {
          const kind = relevantEvent(filename)
          if (kind) this.markDirty(s.item.id)
        })
        w.on('error', () => {
          // Folder deleted or permission lost: close it; the rescan retries.
          try {
            w.close()
          } catch {
            // already closed
          }
          s.watchers = s.watchers.filter((x) => x.w !== w)
          s.status.watching = s.watchers.length > 0 || s.pollTargets.size > 0
          this.setState(s, 'error', 'source-missing')
        })
        s.watchers.push({ path: dir, w })
      } catch {
        // ENOENT thrown synchronously when the folder is gone.
        this.setState(s, 'error', 'source-missing')
      }
    }
    for (const p of plan.poll) {
      const st = await guard.statReadable(p)
      s.pollTargets.set(p, st ? `${st.mtimeMs}:${st.size}` : 'missing')
    }
    if (s.pollTargets.size > 0) {
      s.pollTimer = setInterval(() => void this.poll(s), this.cfg.pollMs)
    }
    const rescanEvery = slow
      ? Math.min(this.cfg.slowRescanMs, this.cfg.rescanMs)
      : this.cfg.rescanMs
    s.rescanTimer = setInterval(() => void this.rescan(s), rescanEvery)
    s.status.watching = s.watchers.length > 0 || s.pollTargets.size > 0
    this.publish()
  }

  private async poll(s: ItemState): Promise<void> {
    const guard = await this.deps.getGuard()
    for (const [p, before] of s.pollTargets) {
      const st = await guard.statReadable(p)
      const now = st ? `${st.mtimeMs}:${st.size}` : 'missing'
      if (now !== before) {
        s.pollTargets.set(p, now)
        this.markDirty(s.item.id)
      }
    }
  }

  private async rescan(s: ItemState): Promise<void> {
    if (this.stopped || s.item.status !== 'active') return
    if (s.watchers.length === 0 && s.status.error?.code === 'source-missing')
      await this.setupWatch(s)
    await this.refresh(s.item.id, 'rescan')
  }

  /** A relevant change: (re)start the quiet-period debounce, capped by max wait. */
  markDirty(itemId: string): void {
    const s = this.items.get(itemId)
    if (!s || this.stopped || s.item.status !== 'active') return
    const now = this.now()
    if (s.dirtySince === null) {
      s.dirtySince = now
      s.status.pendingSince = new Date(now).toISOString()
      if (s.status.state === 'idle' || s.status.state === 'error') this.setState(s, 'pending')
    }
    if (s.debounceTimer) clearTimeout(s.debounceTimer)
    const delay = Math.max(0, Math.min(this.cfg.quietMs, s.dirtySince + this.cfg.maxWaitMs - now))
    s.debounceTimer = setTimeout(() => void this.refresh(itemId, 'watch'), delay)
  }

  private applyPackStatus(s: ItemState, pack: ContextPack): void {
    s.status.lastPackAt = pack.builtAt
    s.status.files = pack.files.length
    s.status.chars = pack.totalChars
    s.status.notDownloaded = pack.notDownloaded
    s.status.conflicts = pack.conflicts
    s.status.skippedSources = pack.sources.filter((x) => x.state !== 'ok' && !x.virtual).length
  }

  private async buildAndQueue(s: ItemState, reason: RefreshReason): Promise<RefreshResult> {
    const id = s.item.id
    const started = this.now()
    const busy = this.running === id || this.queue.has(id)
    if (!busy) this.setState(s, 'reading')
    let pack: ContextPack
    try {
      const guard = await this.deps.getGuard()
      const previous = await this.deps.store.readPack(id).catch(() => null)
      const virtualRefs = (await this.deps.virtualRefs?.(id)) ?? []
      pack = await (this.deps.buildPack ?? buildPack)(guard, s.item, previous, this.deps.pack, {
        virtualRefs
      })
      await this.deps.store.writePack(id, pack)
    } catch (e) {
      this.log(`reader ${id}: pack failed (${(e as Error)?.name ?? 'error'})`)
      this.setState(s, 'error', 'internal')
      return { queued: false }
    }
    this.applyPackStatus(s, pack)
    if (
      pack.activityAt &&
      (!s.item.sourceActivityAt || pack.activityAt > s.item.sourceActivityAt)
    ) {
      await this.deps.setSourceActivity(id, pack.activityAt).catch(() => undefined)
      s.item = { ...s.item, sourceActivityAt: pack.activityAt }
    }
    this.log(
      `reader ${id}: pack ${pack.files.length} files, ${pack.totalChars} chars in ${this.now() - started} ms`
    )

    const real = pack.sources.filter((x) => !x.virtual)
    if (real.length > 0 && real.every((x) => x.state === 'denied')) {
      this.setState(s, 'error', 'all-denied')
      return { queued: false }
    }
    if (real.length > 0 && real.every((x) => x.state === 'missing' || x.state === 'denied')) {
      this.setState(s, 'error', 'source-missing')
      return { queued: false }
    }
    if (pack.files.length === 0 && pack.git.length === 0) {
      if (!busy) this.setState(s, 'idle')
      return { queued: false }
    }

    const prev = await this.deps.store.readDigest(id).catch(() => null)
    const force = reason === 'manual'
    if (!force && prev && prev.packFingerprint === pack.fingerprint) {
      if (!busy) this.setState(s, s.status.error?.code === 'source-missing' ? 'error' : 'idle')
      return { queued: false }
    }
    if (!force) {
      const day = localDay(this.now())
      if (s.autoDay !== day) {
        s.autoDay = day
        s.autoCount = 0
      }
      if (s.autoCount >= this.cfg.maxAutoPerDay) {
        if (!busy) this.setState(s, 'idle')
        return { queued: false }
      }
      const wait = s.lastAutoAt + this.cfg.minAutoIntervalMs - this.now()
      if (wait > 0) {
        // Too soon after the last automatic digest: try again when allowed.
        if (s.retryTimer) clearTimeout(s.retryTimer)
        s.retryTimer = setTimeout(() => {
          s.retryTimer = null
          void this.refresh(id, reason)
        }, wait)
        if (!busy) this.setState(s, 'pending')
        return { queued: false }
      }
    }
    const p: DigestPriority = force ? 0 : reason === 'rescan' ? 2 : 1
    this.queue.enqueue(id, p, reason, force)
    if (this.running !== id) this.setState(s, this.proxyWaiting ? 'waiting-ai' : 'queued')
    this.pump()
    return { queued: true }
  }

  private scheduleProxyRetry(): void {
    this.proxyWaiting = true
    if (this.proxyTimer || this.stopped) return
    const steps = this.cfg.proxyBackoffMs
    const delay = steps[Math.min(this.proxyStep, steps.length - 1)]
    this.proxyStep++
    this.proxyTimer = setTimeout(() => {
      this.proxyTimer = null
      this.proxyWaiting = false
      this.pump()
    }, delay)
  }

  /** Runs the next queued digest if nothing is running. */
  private pump(): void {
    if (this.running || this.stopped || this.proxyWaiting) return
    const entry = this.queue.peek()
    if (!entry) return
    const s = this.items.get(entry.id)
    if (!s) {
      this.queue.remove(entry.id)
      this.pump()
      return
    }
    if (!entry.force && s.backoffUntil > this.now()) {
      // Rate-limited item: let others go first, retry it later.
      this.queue.remove(entry.id)
      const wait = s.backoffUntil - this.now()
      if (s.retryTimer) clearTimeout(s.retryTimer)
      s.retryTimer = setTimeout(() => {
        s.retryTimer = null
        this.queue.enqueue(entry.id, entry.p, entry.reason, entry.force)
        this.pump()
      }, wait)
      this.pump()
      return
    }
    this.running = entry.id
    this.queue.remove(entry.id)
    void this.runDigest(s, entry).finally(() => {
      this.running = null
      this.pump()
    })
  }

  private async runDigest(s: ItemState, entry: QueueEntry): Promise<void> {
    const id = s.item.id
    const settings = this.settings ?? (await this.deps.getSettings())
    const model = settings.digestModel
    if (usesProxy(model) && !(await this.deps.health.isUp())) {
      this.queue.enqueue(id, entry.p, entry.reason, entry.force)
      for (const [qid, qs] of this.items) if (this.queue.has(qid)) this.setState(qs, 'waiting-ai')
      this.scheduleProxyRetry()
      return
    }
    const pack = await this.deps.store.readPack(id).catch(() => null)
    if (!pack) {
      this.setState(s, 'idle')
      return
    }
    const prev = await this.deps.store.readDigest(id).catch(() => null)
    let mode = chooseMode(prev, pack, this.now())
    let built = buildDigestPayload(s.item, pack, prev, {
      model,
      today: localDay(this.now()),
      full: mode === 'full'
    })
    if (mode === 'incremental' && built.payload.changedIds.length === 0) {
      mode = 'full'
      built = buildDigestPayload(s.item, pack, prev, {
        model,
        today: localDay(this.now()),
        full: true
      })
    }
    this.setState(s, 'digesting')
    if (!entry.force) {
      s.autoCount++
      s.lastAutoAt = this.now()
    }
    const started = this.now()
    const res = await this.deps.digest.run(
      id,
      built.payload,
      mode === 'full' ? FULL_TIMEOUT_MS : INCREMENTAL_TIMEOUT_MS
    )
    if (!this.items.has(id)) return
    if (!res.ok) {
      this.log(`reader ${id}: digest ${res.error}`)
      switch (res.error) {
        case 'cancelled':
          this.setState(s, s.item.status === 'active' ? 'idle' : 'off')
          return
        case 'proxy-down':
          this.deps.health.markDown()
          this.queue.enqueue(id, entry.p, entry.reason, entry.force)
          this.setState(s, 'waiting-ai')
          this.scheduleProxyRetry()
          return
        case 'rate-limited':
          s.backoffUntil = this.now() + this.cfg.rateLimitMs
          this.queue.enqueue(id, entry.p, entry.reason, entry.force)
          this.setState(s, 'waiting-ai')
          return
        case 'auth':
          this.setState(s, 'error', 'auth')
          return
        case 'timeout':
          this.setState(s, 'error', 'timeout')
          return
        case 'invalid':
          this.setState(s, 'error', 'invalid')
          return
        default:
          this.setState(s, 'error', 'model-error')
          return
      }
    }
    if (usesProxy(model)) this.deps.health.markUp()
    const generatedAt = new Date(this.now()).toISOString()
    const { digest, warnings } = normalizeDigest(res.raw, pack, {
      itemId: id,
      model,
      generatedAt,
      mode,
      incrementalSinceFull: mode === 'full' ? 0 : (prev?.incrementalSinceFull ?? 0) + 1,
      previous: prev,
      sentIds: built.sentIds
    })
    if (!digest) {
      this.setState(s, 'error', 'invalid')
      return
    }
    digest.basis = packBasis(pack)
    if (res.warnings.length)
      digest.warnings = [
        ...new Set([...digest.warnings, ...res.warnings.map((w) => w.slice(0, 120))])
      ].slice(0, 20)
    try {
      await this.deps.store.writeDigest(id, digest)
    } catch {
      this.setState(s, 'error', 'internal')
      return
    }
    s.status.lastDigestAt = generatedAt
    this.log(
      `reader ${id}: digest ${mode} ok in ${this.now() - started} ms (${warnings.length} warnings)`
    )
    this.setState(s, s.dirtySince !== null ? 'pending' : 'idle')
    for (const cb of [...this.digestListeners]) {
      try {
        cb(id)
      } catch {
        // one subscriber's failure never blocks the others
      }
    }
  }
}
