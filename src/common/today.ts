import { paceAdjustedMinutes } from './estimates'

// "Plan today": a time budget filled from the queue, kept for the local day.

export const BUDGET_OPTIONS = [30, 60, 120, 180, 240] as const

/** A step in today's set. Title fields are snapshots so done steps can still be listed. */
export interface TodayItem {
  key: string
  projectId: string
  taskId: string
  subtaskId: string
  title: string
  projectName: string
  /** Pace-adjusted minutes used for the budget. */
  minutes: number
}

export interface TodayPlan {
  date: string // local YYYY-MM-DD; a plan from another day is discarded
  budgetMinutes: number
  includeCarried: boolean
  items: TodayItem[]
}

export interface QueueCandidate {
  key: string
  projectId: string
  taskId: string
  subtaskId: string
  subtaskTitle: string
  projectName: string
  timeEstimate?: number
  scheduledDate?: string
}

/**
 * Greedy fill in queue order: each step that still fits the budget is taken,
 * the first step always is (even if it's longer than the budget), and steps
 * scheduled before today are left out unless `includeCarried`.
 */
export function fillToday(
  queue: readonly QueueCandidate[],
  budgetMinutes: number,
  ratio: number | null,
  options: { includeCarried: boolean; today: string }
): TodayItem[] {
  const items: TodayItem[] = []
  let used = 0
  for (const step of queue) {
    if (!options.includeCarried && step.scheduledDate && step.scheduledDate < options.today)
      continue
    const minutes = paceAdjustedMinutes(step.timeEstimate, ratio)
    if (items.length > 0 && used + minutes > budgetMinutes) continue
    items.push({
      key: step.key,
      projectId: step.projectId,
      taskId: step.taskId,
      subtaskId: step.subtaskId,
      title: step.subtaskTitle,
      projectName: step.projectName,
      minutes
    })
    used += minutes
    if (used >= budgetMinutes) break
  }
  return items
}

export function totalMinutes(items: readonly Pick<TodayItem, 'minutes'>[]): number {
  return items.reduce((sum, item) => sum + item.minutes, 0)
}

/** "1h 05m", "45 min", "2h". */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${String(rest).padStart(2, '0')}m` : `${hours}h`
}

/** The plan if it belongs to `today`, else null (yesterday's set never carries over). */
export function planForToday(plan: TodayPlan | null | undefined, today: string): TodayPlan | null {
  return plan && plan.date === today && Array.isArray(plan.items) ? plan : null
}
