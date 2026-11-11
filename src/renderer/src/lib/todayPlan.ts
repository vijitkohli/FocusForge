import { useEffect, useSyncExternalStore } from 'react'
import { localDateKey } from 'src/common/schedule'
import { planForToday, type TodayPlan } from 'src/common/today'

interface TodayPlanSnapshot {
  readonly plan: TodayPlan | null
  readonly loaded: boolean
}

const listeners = new Set<() => void>()
let snapshot: TodayPlanSnapshot = { plan: null, loaded: false }
let loading: Promise<void> | null = null

function publish(next: TodayPlanSnapshot): void {
  snapshot = next
  listeners.forEach((listener) => listener())
}

/** Shared "Plan today" state, persisted in system/today.json through the main process. */
export const todayPlanStore = {
  getSnapshot: (): TodayPlanSnapshot => snapshot,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  load(): Promise<void> {
    if (snapshot.loaded) return Promise.resolve()
    loading ??= window.api
      .getTodayPlan()
      .then(
        (plan) => publish({ plan, loaded: true }),
        () => publish({ plan: null, loaded: true })
      )
      .finally(() => {
        loading = null
      })
    return loading
  },
  async save(plan: TodayPlan | null): Promise<void> {
    const saved = await window.api.saveTodayPlan(plan)
    publish({ plan: saved, loaded: true })
  }
}

export function useTodayPlan(): TodayPlan | null {
  const state = useSyncExternalStore(
    todayPlanStore.subscribe,
    todayPlanStore.getSnapshot,
    todayPlanStore.getSnapshot
  )
  useEffect(() => {
    void todayPlanStore.load()
  }, [])
  // A plan made yesterday quietly expires at midnight while the app stays open.
  return planForToday(state.plan, localDateKey(new Date()))
}
