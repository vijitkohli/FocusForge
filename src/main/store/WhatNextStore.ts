// src/main/store/WhatNextStore.ts
// Today's "What next?" signals: skips, starts and the background-plan count.
// system/whatnext.json resets each local day. system/skips.jsonl is append-only
// (ids and features only, never titles) and pruned to 180 days. Nothing here
// is sent to a model or written to the vault.
import fs from 'fs-extra'
import {
  SKIP_REASONS,
  nextDueOf,
  sanitizeSkipEvent,
  type DigestDues,
  type ItemDueSignal,
  type SkipEvent,
  type SkipReason,
  type WhatNextSignals
} from '../../common/whatNext'
import { writeFileAtomic, writeJsonAtomic } from './atomic'
import { withLock } from './locks'
import { localDateKey, SKIPS_LOG_PATH, SYSTEM_DIR, WHATNEXT_PATH } from './paths'

const KEEP_MS = 180 * 24 * 60 * 60 * 1000

interface Persisted {
  date: string
  skips: SkipEvent[]
  starts: Record<string, string>
  planEnqueues: number
}

export interface WhatNextDeps {
  now?: () => Date
  /** Active item ids. Dues are read per id; pack text is never touched. */
  itemIds?: () => string[]
  readDigest?: (itemId: string) => Promise<DigestDues | null>
}

function blank(date: string): Persisted {
  return { date, skips: [], starts: {}, planEnqueues: 0 }
}

function safeId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[/\\\0]/.test(v)
}

function normalise(raw: unknown, today: string): { state: Persisted; dirty: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { state: blank(today), dirty: true }
  const r = raw as Record<string, unknown>
  if (r.date !== today) return { state: blank(today), dirty: true }
  const skips = Array.isArray(r.skips)
    ? r.skips
        .map((e) => sanitizeSkipEvent(e))
        .filter((e): e is SkipEvent => e !== null && e.date === today)
    : []
  const starts: Record<string, string> = {}
  if (r.starts && typeof r.starts === 'object' && !Array.isArray(r.starts)) {
    for (const [k, v] of Object.entries(r.starts as Record<string, unknown>)) {
      if (safeId(k) && typeof v === 'string' && v.length <= 40) starts[k] = v
    }
  }
  const planEnqueues =
    typeof r.planEnqueues === 'number' && Number.isFinite(r.planEnqueues) && r.planEnqueues > 0
      ? Math.min(1000, Math.floor(r.planEnqueues))
      : 0
  const state = { date: today, skips, starts, planEnqueues }
  const dirty = JSON.stringify(state) !== JSON.stringify(r)
  return { state, dirty }
}

export class WhatNextStore {
  private readonly now: () => Date
  private readonly itemIds: () => string[]
  private readonly readDigest: (itemId: string) => Promise<DigestDues | null>

  constructor(deps: WhatNextDeps = {}) {
    this.now = deps.now ?? ((): Date => new Date())
    this.itemIds = deps.itemIds ?? ((): string[] => [])
    this.readDigest = deps.readDigest ?? (async (): Promise<null> => null)
  }

  /** Dues from each item's digest. Dates and labels only; never pack text. */
  async dues(now = this.now()): Promise<ItemDueSignal[]> {
    const today = localDateKey(now)
    const out: ItemDueSignal[] = []
    for (const itemId of this.itemIds()) {
      let digest: DigestDues | null = null
      try {
        digest = await this.readDigest(itemId)
      } catch {
        digest = null
      }
      out.push({ itemId, nextDue: nextDueOf(digest, today) })
    }
    return out
  }

  async signals(): Promise<WhatNextSignals> {
    const now = this.now()
    const [state, dues] = await Promise.all([this.read(), this.dues(now)])
    return { date: state.date, dues, starts: state.starts, skipsToday: state.skips }
  }

  async enqueuedToday(): Promise<number> {
    return (await this.read()).planEnqueues
  }

  /** Sanitised. Returns false when the event is rejected. Titles are dropped. */
  async recordSkip(raw: unknown): Promise<boolean> {
    const event = sanitizeSkipEvent(raw)
    if (!event || event.date !== localDateKey(this.now())) return false
    await this.write(async (state) => {
      if (!state.skips.some((e) => e.at === event.at)) state.skips.push(event)
      await this.appendLog(event)
      await this.pruneLog(this.now().getTime())
    })
    return true
  }

  async updateSkipReason(at: unknown, reason: unknown, undone?: boolean): Promise<void> {
    if (typeof at !== 'string' || !SKIP_REASONS.includes(reason as SkipReason)) return
    const nextReason = reason as SkipReason
    await this.write(async (state) => {
      const i = state.skips.findIndex((e) => e.at === at)
      if (i < 0) return
      const next: SkipEvent = { ...state.skips[i], reason: nextReason }
      if (undone === true) next.undone = true
      else if (undone === false) delete next.undone
      state.skips[i] = next
      await this.appendLog(next)
    })
  }

  /** Marks today's skips undone so "Show skipped again" brings them back. */
  async clearToday(): Promise<void> {
    await this.write(async (state) => {
      for (let i = 0; i < state.skips.length; i++) {
        if (state.skips[i].undone) continue
        const next: SkipEvent = { ...state.skips[i], undone: true }
        state.skips[i] = next
        await this.appendLog(next)
      }
    })
  }

  async markTouched(itemId: unknown): Promise<void> {
    if (!safeId(itemId)) return
    const iso = this.now().toISOString()
    await this.write((state) => {
      state.starts[itemId] = iso
    })
  }

  async addEnqueues(n: number): Promise<void> {
    if (!Number.isFinite(n) || n <= 0) return
    await this.write((state) => {
      state.planEnqueues = Math.min(1000, state.planEnqueues + Math.floor(n))
    })
  }

  /** Drops skip-log lines older than 180 days. Called once at startup. */
  async prune(): Promise<void> {
    await withLock('whatnext', () => this.pruneLog(this.now().getTime()))
  }

  private async read(): Promise<Persisted> {
    return withLock('whatnext', async () => {
      const { state, dirty } = await this.load()
      if (dirty) await writeJsonAtomic(WHATNEXT_PATH, state)
      return state
    })
  }

  private async write(mutate: (state: Persisted) => void | Promise<void>): Promise<void> {
    await withLock('whatnext', async () => {
      const { state } = await this.load()
      await mutate(state)
      await writeJsonAtomic(WHATNEXT_PATH, state)
    })
  }

  private async load(): Promise<{ state: Persisted; dirty: boolean }> {
    try {
      if (!(await fs.pathExists(WHATNEXT_PATH)))
        return { state: blank(localDateKey(this.now())), dirty: false }
      return normalise(await fs.readJSON(WHATNEXT_PATH), localDateKey(this.now()))
    } catch {
      return { state: blank(localDateKey(this.now())), dirty: true }
    }
  }

  private async appendLog(event: SkipEvent): Promise<void> {
    const clean = sanitizeSkipEvent(event)
    if (!clean) return
    await fs.ensureDir(SYSTEM_DIR)
    await fs.appendFile(SKIPS_LOG_PATH, `${JSON.stringify(clean)}\n`, 'utf-8')
  }

  private async pruneLog(nowMs: number): Promise<void> {
    if (!(await fs.pathExists(SKIPS_LOG_PATH))) return
    const text = await fs.readFile(SKIPS_LOG_PATH, 'utf-8')
    const kept = text.split('\n').filter((line) => {
      if (!line.trim()) return false
      try {
        const at = Date.parse((JSON.parse(line) as { at?: string }).at ?? '')
        return !Number.isNaN(at) && nowMs - at <= KEEP_MS
      } catch {
        return false
      }
    })
    const next = kept.length ? `${kept.join('\n')}\n` : ''
    if (next !== text) await writeFileAtomic(SKIPS_LOG_PATH, next)
  }
}
