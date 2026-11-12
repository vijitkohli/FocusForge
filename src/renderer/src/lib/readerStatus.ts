// Reader (Phase 3) status for the renderer: one shared subscription to the
// main process's `reader-status` push, plus the copy each state shows.
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReaderStatus } from 'src/common/readers'

export type SyncTone = 'quiet' | 'busy' | 'warn'

function ago(iso: string, nowMs: number): string {
  const ms = nowMs - Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const min = Math.max(0, Math.round(ms / 60_000))
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return `${d} ${d === 1 ? 'day' : 'days'} ago`
}

/** Short, friendly copy for an item's sync state (never paths). */
export function syncLabel(
  s: ReaderStatus | undefined,
  nowMs: number
): { text: string; tone: SyncTone } {
  if (!s) return { text: '', tone: 'quiet' }
  switch (s.state) {
    case 'pending':
    case 'reading':
      return { text: 'Checking for changes…', tone: 'busy' }
    case 'queued':
    case 'digesting':
      return { text: 'Summarising…', tone: 'busy' }
    case 'waiting-ai':
      return { text: "Waiting for AI (it'll resume on its own)", tone: 'quiet' }
    case 'error':
      return { text: s.error?.message ?? 'Something went wrong while syncing.', tone: 'warn' }
    case 'off':
      return {
        text: s.lastDigestAt
          ? `Not syncing · summary from ${ago(s.lastDigestAt, nowMs)}`
          : 'Not syncing',
        tone: 'quiet'
      }
    case 'no-sources':
      return { text: '', tone: 'quiet' }
    default:
      return {
        text: s.lastDigestAt
          ? `Synced ${ago(s.lastDigestAt, nowMs)}`
          : s.lastPackAt
            ? 'Read, not summarised yet'
            : 'Not synced yet',
        tone: 'quiet'
      }
  }
}

// ---- one shared store for every component

let snapshot: Record<string, ReaderStatus> = {}
const listeners = new Set<() => void>()
let unsubscribe: (() => void) | null = null

function emit(next: Record<string, ReaderStatus>): void {
  snapshot = next
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  if (!unsubscribe && typeof window !== 'undefined' && window.api?.onReaderStatus) {
    unsubscribe = window.api.onReaderStatus(emit)
    void window.api.getReaderStatus().then(emit, () => undefined)
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0 && unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
  }
}

export function useReaderStatuses(): Record<string, ReaderStatus> {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot
  )
}

/** The current time, refreshed every `ms` so "3 min ago" stays fresh. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}
