import { useEffect, useSyncExternalStore } from 'react'
import type { UpcomingSubtask } from '../../../common/types'
import { focusTimer } from './focusTimer'

export type QueueMood = 'all' | 'lazy' | 'normal' | 'motivated'
export type QueueIdentity = Pick<UpcomingSubtask, 'projectId' | 'taskId' | 'subtaskId'>
export type QueueScope = { projectId: string; taskId?: string }

export const MOOD_TO_DIFFICULTY = {
  lazy: 'easy',
  normal: 'medium',
  motivated: 'hard'
} as const

export interface QueueSnapshot {
  readonly all: readonly UpcomingSubtask[]
  readonly items: readonly UpcomingSubtask[]
  readonly current: UpcomingSubtask | null
  readonly mood: QueueMood
  readonly skipped: readonly string[]
  readonly frontOverride: string | null
  readonly loading: boolean
  readonly loaded: boolean
  readonly error: string | null
}

export interface QueueStore {
  getSnapshot(): QueueSnapshot
  subscribe(listener: () => void): () => void
  setMood(mood: QueueMood): void
  skip(item: QueueIdentity): void
  playNext(item: QueueIdentity): void
  clearSkips(): void
  clearOverride(): void
  load(): Promise<void>
  refresh(): Promise<void>
}

export function queueKey(item: QueueIdentity): string {
  return JSON.stringify([item.projectId, item.taskId, item.subtaskId])
}

export function selectQueue(
  snapshot: QueueSnapshot,
  scope?: QueueScope
): readonly UpcomingSubtask[] {
  return scope
    ? snapshot.items.filter(
        (item) =>
          item.projectId === scope.projectId && (!scope.taskId || item.taskId === scope.taskId)
      )
    : snapshot.items
}

const listeners = new Set<() => void>()
let snapshot: QueueSnapshot = {
  all: [],
  items: [],
  current: null,
  mood: 'all',
  skipped: [],
  frontOverride: null,
  loading: false,
  loaded: false,
  error: null
}
let request = 0
let pending: Promise<void> | null = null

function reconcileTimer(): void {
  const previous = focusTimer.getSnapshot()
  if (previous.subtaskId === null) return
  const current = snapshot.current
  const key = current ? queueKey(current) : null
  if (previous.subtaskId === key) return
  focusTimer.setStep(key, current?.timeEstimate)
  if (previous.running && current) focusTimer.play()
}

function publish(patch: Partial<QueueSnapshot>, reconcile = false): void {
  const next = { ...snapshot, ...patch }
  const skipped = new Set(next.skipped)
  const difficulty = next.mood === 'all' ? null : MOOD_TO_DIFFICULTY[next.mood]
  const items = next.all.filter(
    (item) => !skipped.has(queueKey(item)) && (!difficulty || item.difficulty === difficulty)
  )
  const front = items.findIndex((item) => queueKey(item) === next.frontOverride)
  if (front > 0) items.unshift(...items.splice(front, 1))
  snapshot = { ...next, items, current: items[0] ?? null }
  if (reconcile) reconcileTimer()
  listeners.forEach((listener) => listener())
}

async function refresh(): Promise<void> {
  const version = ++request
  publish({ loading: true, error: null })
  const operation = (async () => {
    try {
      const all = await window.api.getUpcomingSubtasks()
      if (version === request) {
        const keys = new Set(all.map(queueKey))
        const timerKey = focusTimer.getSnapshot().subtaskId
        publish(
          {
            all,
            loading: false,
            loaded: true,
            skipped: snapshot.skipped.filter((key) => keys.has(key)),
            frontOverride:
              snapshot.frontOverride && keys.has(snapshot.frontOverride)
                ? snapshot.frontOverride
                : null
          },
          // A scoped session need not be the global first item. Only missing identities advance.
          timerKey !== null && !keys.has(timerKey)
        )
      }
    } catch (error) {
      if (version === request)
        publish({ loading: false, error: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      if (version === request) pending = null
    }
  })()
  pending = operation
  return operation
}

export const queueStore: QueueStore = {
  getSnapshot: () => snapshot,
  subscribe(listener) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  setMood: (mood) => publish({ mood }, true),
  skip(item) {
    const key = queueKey(item)
    publish(
      {
        skipped: [...new Set([...snapshot.skipped, key])],
        frontOverride: snapshot.frontOverride === key ? null : snapshot.frontOverride
      },
      true
    )
  },
  playNext(item) {
    const key = queueKey(item)
    publish({ frontOverride: key, skipped: snapshot.skipped.filter((id) => id !== key) }, true)
  },
  clearSkips: () => publish({ skipped: [] }, true),
  clearOverride: () => publish({ frontOverride: null }),
  load: () => pending ?? (snapshot.loaded ? Promise.resolve() : refresh()),
  refresh
}

export function useQueue(): QueueSnapshot {
  const state = useSyncExternalStore(
    queueStore.subscribe,
    queueStore.getSnapshot,
    queueStore.getSnapshot
  )
  useEffect(() => {
    void queueStore.load().catch(() => {})
  }, [])
  return state
}
