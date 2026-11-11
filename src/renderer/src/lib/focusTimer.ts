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
  /**
   * Fires when the timer moves to a different step, with the time spent on the
   * one it left. `reset()` discards time instead of reporting it.
   */
  onSessionEnd(listener: SessionEndListener): () => void
  /** Moves the current session (elapsed time, play state) onto another step, e.g. after a split. */
  retarget(subtaskId: string, estimateMinutes?: number): void
  play(): void
  pause(): void
  reset(): void
}

export type SessionEndListener = (subtaskId: string, seconds: number) => void

const listeners = new Set<() => void>()
const sessionEndListeners = new Set<SessionEndListener>()
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
    const leaving = snapshot.subtaskId
    const spentMs = elapsedMs + (snapshot.running ? performance.now() - startedAt : 0)
    stopInterval()
    elapsedMs = 0
    publish({ subtaskId, estimateMinutes: estimate, elapsed: 0, running: false })
    if (leaving !== null && spentMs >= 1000) {
      const seconds = Math.floor(spentMs / 1000)
      sessionEndListeners.forEach((listener) => listener(leaving, seconds))
    }
  },
  retarget(subtaskId, estimateMinutes = 15) {
    const estimate = Number.isFinite(estimateMinutes) && estimateMinutes > 0 ? estimateMinutes : 15
    publish({ subtaskId, estimateMinutes: estimate })
  },
  onSessionEnd(listener) {
    sessionEndListeners.add(listener)
    return () => {
      sessionEndListeners.delete(listener)
    }
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
