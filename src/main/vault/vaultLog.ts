// src/main/vault/vaultLog.ts
// The notes' Log section: per-item entries in `FlowState/system/vault/log/
// <id>.json` (lock `vaultlog:<id>`), de-duplicated by key and trimmed to 300
// entries / 120 days, plus the pure functions that turn saves, ticks, commits
// and digest progress into entries. Never holds My-notes text.
import fs from 'fs-extra'
import path from 'path'
import { normalizeTitle } from '../../common/merge'
import type { ItemDigest } from '../../common/digest'
import type { ContextPack } from '../../common/readers'
import type { ProjectData, ProjectTask } from '../../common/types'
import { writeJsonAtomic } from '../store/atomic'
import { withLock } from '../store/locks'
import { addDays, localDateOf } from './format'
import type { AppliedTick } from './ticks'
import type { VaultLogEntry, VaultLogKind } from './types'

export const LOG_MAX_ENTRIES = 300
export const LOG_MAX_DAYS = 120
/** Commits and digest progress older than this aren't logged. */
export const LOG_SOURCE_DAYS = 30
/** At most this many commits per day per repo. */
export const COMMITS_PER_DAY = 5

const KINDS: ReadonlySet<VaultLogKind> = new Set([
  'tick',
  'untick',
  'done',
  'task-done',
  'milestone-done',
  'planned',
  'progress',
  'commit',
  'notice'
])

function isEntry(e: unknown): e is VaultLogEntry {
  if (!e || typeof e !== 'object') return false
  const r = e as Record<string, unknown>
  return (
    typeof r.at === 'string' &&
    typeof r.date === 'string' &&
    typeof r.text === 'string' &&
    typeof r.key === 'string' &&
    KINDS.has(r.kind as VaultLogKind) &&
    (r.taskId === undefined || typeof r.taskId === 'string')
  )
}

/**
 * Merges `add` into `existing`: a key already present is skipped, entries
 * older than 120 days go, and the newest 300 stay (oldest first on disk).
 */
export function mergeLog(
  existing: VaultLogEntry[],
  add: VaultLogEntry[],
  today: string
): { entries: VaultLogEntry[]; added: number } {
  const keys = new Set(existing.map((e) => e.key))
  let added = 0
  const all = [...existing]
  for (const e of add) {
    if (keys.has(e.key)) continue
    keys.add(e.key)
    all.push(e)
    added++
  }
  const since = addDays(today, -LOG_MAX_DAYS)
  const kept = all
    .filter((e) => e.date >= since)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-LOG_MAX_ENTRIES)
  return { entries: kept, added }
}

/** Log files, one per item. Pure Node; `dir` is `FlowState/system/vault/log`. */
export class VaultLogStore {
  constructor(private readonly dir: string) {}

  private file(itemId: string): string {
    if (!itemId || /[/\\\0]/.test(itemId) || itemId === '.' || itemId === '..') {
      throw new Error('Bad item id for the vault log')
    }
    return path.join(this.dir, `${encodeURIComponent(itemId)}.json`)
  }

  async read(itemId: string): Promise<VaultLogEntry[]> {
    try {
      const f = this.file(itemId)
      if (!(await fs.pathExists(f))) return []
      const raw = await fs.readJSON(f)
      return Array.isArray(raw) ? raw.filter(isEntry) : []
    } catch {
      return []
    }
  }

  /** Appends new entries (by key) under `vaultlog:<id>`; resolves how many were new. */
  append(itemId: string, add: VaultLogEntry[], today: string): Promise<number> {
    if (add.length === 0) return Promise.resolve(0)
    return withLock(`vaultlog:${itemId}`, async () => {
      const existing = await this.read(itemId)
      const { entries, added } = mergeLog(existing, add, today)
      if (added > 0 || entries.length !== existing.length) {
        await writeJsonAtomic(this.file(itemId), entries)
      }
      return added
    })
  }
}

function entry(
  now: Date,
  kind: VaultLogKind,
  text: string,
  key: string,
  taskId?: string
): VaultLogEntry {
  const iso = now.toISOString()
  return {
    at: iso,
    date: localDateOf(iso) as string,
    kind,
    text,
    key,
    ...(taskId ? { taskId } : {})
  }
}

const allStepsDone = (t: ProjectTask | undefined): boolean =>
  !!t && t.subtasks.length > 0 && t.subtasks.every((s) => s.isCompleted)

/**
 * Entries for one project save, from the previous and the new data:
 * `done` (a step completed in the app; skipped for vault-tick saves, which
 * the reader logs itself), `task-done`, `milestone-done` (status became done)
 * and `planned` (the step set changed). Un-completing in the app isn't logged.
 */
export function saveLogEntries(
  prev: ProjectData | null,
  next: ProjectData,
  opts: { now: Date; byVault: boolean }
): VaultLogEntry[] {
  if (!prev) return []
  const { now } = opts
  const day = localDateOf(now.toISOString()) as string
  const before = new Map((prev.tasks ?? []).map((t) => [t.id, t]))
  const out: VaultLogEntry[] = []
  for (const t of next.tasks ?? []) {
    const old = before.get(t.id)
    const oldSteps = new Map((old?.subtasks ?? []).map((s) => [s.id, s]))
    if (!opts.byVault) {
      for (const s of t.subtasks) {
        const o = oldSteps.get(s.id)
        if (s.isCompleted && o && !o.isCompleted) {
          out.push(
            entry(
              now,
              'done',
              `Done in FocusForge: "${s.title}"`,
              `step:${t.id}/${s.id}:done:${day}`,
              t.id
            )
          )
        }
      }
    }
    if (old && allStepsDone(t) && !allStepsDone(old)) {
      out.push(entry(now, 'task-done', `Finished "${t.title}"`, `task-done:${t.id}:${day}`, t.id))
    }
    const oldMs = new Map((old?.milestones ?? []).map((m) => [m.id, m]))
    for (const m of t.milestones ?? []) {
      const o = oldMs.get(m.id)
      if (m.status === 'done' && o && o.status !== 'done') {
        out.push(
          entry(
            now,
            'milestone-done',
            `Milestone done: "${m.title}"`,
            `milestone:${t.id}/${m.id}`,
            t.id
          )
        )
      }
    }
    const added = t.subtasks.filter((s) => !oldSteps.has(s.id)).length
    const newIds = new Set(t.subtasks.map((s) => s.id))
    const removed = (old?.subtasks ?? []).filter((s) => !newIds.has(s.id)).length
    if (t.auto !== 'loose-ends' && (added > 0 || removed > 0) && !opts.byVault) {
      const delta = [added ? `+${added}` : '', removed ? `−${removed}` : ''].filter(Boolean)
      const noun = added + removed === 1 ? 'step' : 'steps'
      out.push(
        entry(
          now,
          'planned',
          `Plan updated for "${t.title}" (${delta.join(' ')} ${noun})`,
          `planned:${t.id}:${next.rev ?? now.getTime()}`,
          t.id
        )
      )
    }
  }
  return out
}

/** One entry per applied Obsidian tick. */
export function tickLogEntries(applied: AppliedTick[], now: Date): VaultLogEntry[] {
  const day = localDateOf(now.toISOString()) as string
  return applied.map((a) => {
    const verb = a.checked ? 'Ticked' : 'Unticked'
    const what =
      a.kind === 'task' ? `${verb} "${a.title}" (the whole task)` : `${verb} "${a.title}"`
    return entry(
      now,
      a.checked ? 'tick' : 'untick',
      `${what} in Obsidian`,
      `step:${a.taskId}/${a.id}:${a.checked ? 'done' : 'undone'}:${day}:${now.getTime()}`,
      a.taskId
    )
  })
}

/** `Commit "subject" (git:repo)` for the last 30 days, at most 5 a day per repo. */
export function commitLogEntries(pack: ContextPack | null, today: string): VaultLogEntry[] {
  if (!pack) return []
  const since = addDays(today, -LOG_SOURCE_DAYS)
  const out: VaultLogEntry[] = []
  for (const g of pack.git ?? []) {
    const perDay = new Map<string, number>()
    const commits = [...(g.commits ?? [])].sort((a, b) => b.date.localeCompare(a.date))
    for (const c of commits) {
      const date = localDateOf(c.date)
      if (!date || date < since || date > today || !c.hash) continue
      const n = perDay.get(date) ?? 0
      if (n >= COMMITS_PER_DAY) continue
      perDay.set(date, n + 1)
      const at = new Date(c.date)
      out.push({
        at: Number.isNaN(at.getTime()) ? `${date}T00:00:00.000Z` : at.toISOString(),
        date,
        kind: 'commit',
        text: `Commit "${c.subject}" (${g.label})`,
        key: `commit:${c.hash}`
      })
    }
  }
  return out
}

/** Digest `recentProgress` from the last 30 days, keyed by date and normalised text. */
export function progressLogEntries(digest: ItemDigest | null, today: string): VaultLogEntry[] {
  if (!digest) return []
  const since = addDays(today, -LOG_SOURCE_DAYS)
  const out: VaultLogEntry[] = []
  for (const p of digest.recentProgress ?? []) {
    const date = localDateOf(p.date)
    const norm = normalizeTitle(p.text)
    if (!date || !norm || date < since || date > today) continue
    out.push({
      at: `${date}T00:00:00.000Z`,
      date,
      kind: 'progress',
      text: p.text,
      key: `progress:${date}|${norm}`
    })
  }
  return out
}

/** A one-off notice (overwritten edit, moved sections, re-planned tick). */
export function noticeEntry(now: Date, text: string, key: string, taskId?: string): VaultLogEntry {
  return entry(now, 'notice', text, key, taskId)
}
