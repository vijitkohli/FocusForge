import { useEffect, useSyncExternalStore } from 'react'

export interface FocusTimerSnapshot {
  readonly subtaskId: string | null
  readonly estimateMinutes: number
  readonly elapsed: number // seconds, including time beyond the estimate
  readonly running: boolean
}

export interface FocusTimerStore {
  getSnapshot(): FocusTimerSnapshot
  subscribe(listener: () => void): () => void
  setStep(subtaskId: string | null, estimateMinutes?: number): void
  play(): void
  pause(): void
  reset(): void
}

const listeners = new Set<() => void>()
let snapshot: FocusTimerSnapshot = {
  subtaskId: null,
  estimateMinutes: 15,
  elapsed: 0,
  running: false
}
let elapsedMs = 0
let startedAt = 0
let interval: ReturnType<typeof setInterval> | null = null

function publish(patch: Partial<FocusTimerSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  listeners.forEach((listener) => listener())
}

function stopInterval(): void {
  if (interval !== null) clearInterval(interval)
  interval = null
}

function tick(): void {
  publish({ elapsed: Math.floor((elapsedMs + performance.now() - startedAt) / 1000) })
}

export const focusTimer: FocusTimerStore = {
  getSnapshot: () => snapshot,
  subscribe(listener) {
    listeners.add(listener)
    // Unsubscribing must not pause a session: navigation can unmount every reader.
    return () => {
      listeners.delete(listener)
    }
  },
  setStep(subtaskId, estimateMinutes = 15) {
    const estimate = Number.isFinite(estimateMinutes) && estimateMinutes > 0 ? estimateMinutes : 15
    if (subtaskId === snapshot.subtaskId) {
      if (estimate !== snapshot.estimateMinutes) publish({ estimateMinutes: estimate })
      return
    }
    stopInterval()
    elapsedMs = 0
    publish({ subtaskId, estimateMinutes: estimate, elapsed: 0, running: false })
  },
  play() {
    if (snapshot.running || snapshot.subtaskId === null) return
    startedAt = performance.now()
    publish({ running: true })
    interval = setInterval(tick, 250)
  },
  pause() {
    if (!snapshot.running) return
    elapsedMs += performance.now() - startedAt
    stopInterval()
    publish({ running: false, elapsed: Math.floor(elapsedMs / 1000) })
  },
  reset() {
    stopInterval()
    elapsedMs = 0
    publish({ elapsed: 0, running: false })
  }
}

/** Omit the identity to read the active session without changing it. */
export function useFocusTimer(
  subtaskId?: string | null,
  estimateMinutes = 15
): FocusTimerSnapshot & {
  play: () => void
  pause: () => void
  reset: () => void
} {
  const state = useSyncExternalStore(
    focusTimer.subscribe,
    focusTimer.getSnapshot,
    focusTimer.getSnapshot
  )
  useEffect(() => {
    if (subtaskId !== undefined) focusTimer.setStep(subtaskId, estimateMinutes)
  }, [subtaskId, estimateMinutes])
  return { ...state, play: focusTimer.play, pause: focusTimer.pause, reset: focusTimer.reset }
}
