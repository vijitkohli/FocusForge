// src/common/schedule.ts
// Pure, local-date scheduling helpers for subtasks. All dates are 'YYYY-MM-DD'
// in the user's LOCAL calendar - never via toISOString(), which is UTC and
// shifts dates back a day for anyone east of Greenwich (e.g. Sydney).

import { Subtask } from './types'

const DAY_MS = 86400000

/** Local 'YYYY-MM-DD' for a date. */
export function localDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Parses 'YYYY-MM-DD' as local midnight. */
function parseLocal(key: string): Date {
  return new Date(`${key}T00:00:00`)
}

function addDays(key: string, n: number): string {
  const d = parseLocal(key)
  d.setDate(d.getDate() + n)
  return localDateKey(d)
}

function daysBetween(fromKey: string, toKey: string): number {
  return Math.round((parseLocal(toKey).getTime() - parseLocal(fromKey).getTime()) / DAY_MS)
}

/**
 * Proportionally re-spreads incomplete subtasks' scheduledDate across
 * today -> deadline (same shape as the AI's original distribution), so
 * changing the deadline doesn't leave stale dates past/before it. Completed
 * subtasks keep their original date - they're done.
 */
export function redistributeSchedule(
  items: Subtask[],
  deadline: string,
  today = localDateKey(new Date())
): Subtask[] {
  const incomplete = items.filter((s) => !s.isCompleted)
  const totalDays = Math.max(0, daysBetween(today, deadline))

  let i = 0
  return items.map((s) => {
    if (s.isCompleted) return s
    const slot =
      incomplete.length <= 1 ? totalDays : Math.round((i / (incomplete.length - 1)) * totalDays)
    i += 1
    return { ...s, scheduledDate: addDays(today, Math.min(slot, totalDays)) }
  })
}

/** Incomplete subtasks whose scheduledDate is before today. */
export function overdueSubtasks(items: Subtask[], today = localDateKey(new Date())): Subtask[] {
  return items.filter((s) => !s.isCompleted && !!s.scheduledDate && s.scheduledDate < today)
}

/**
 * "I fell behind" recovery: moves every overdue incomplete step forward onto
 * the days between today and the deadline, without touching steps that are
 * already scheduled in the future or completed.
 *
 * Steps are placed in their original order (each no earlier than the one
 * before it) onto the least-loaded day, where load is planned minutes. A daily
 * budget is the larger of 60 min and an even share of all remaining work, so
 * nobody wakes up to a 4-hour "today". If the deadline has already passed,
 * the work is spread over the next few days instead of piled onto today.
 */
export function rescheduleOverdue(
  items: Subtask[],
  deadline: string,
  today = localDateKey(new Date())
): { subtasks: Subtask[]; moved: number } {
  const overdue = new Set(overdueSubtasks(items, today).map((s) => s.id))
  if (overdue.size === 0) return { subtasks: items, moved: 0 }

  const remaining = items.filter((s) => !s.isCompleted)
  const minutes = (s: Subtask): number => s.timeEstimate ?? 15
  const totalMinutes = remaining.reduce((sum, s) => sum + minutes(s), 0)

  // Window: today..deadline, or (deadline passed) enough days to keep each under budget.
  let span = daysBetween(today, deadline) + 1
  if (span < 1) span = Math.max(1, Math.min(7, Math.ceil(totalMinutes / 60)))
  const budget = Math.max(60, Math.ceil(totalMinutes / span))

  // Existing load from steps that stay where they are.
  const load = new Map<string, number>()
  for (let d = 0; d < span; d++) load.set(addDays(today, d), 0)
  for (const s of remaining) {
    if (overdue.has(s.id) || !s.scheduledDate || !load.has(s.scheduledDate)) continue
    load.set(s.scheduledDate, (load.get(s.scheduledDate) ?? 0) + minutes(s))
  }

  const days = [...load.keys()]
  const placed = new Map<string, string>()
  let earliest = 0
  for (const s of items) {
    if (!overdue.has(s.id)) continue
    // First day (from `earliest`) with room in the budget, else the least loaded.
    let pick = -1
    for (let d = earliest; d < days.length; d++) {
      if ((load.get(days[d]) ?? 0) + minutes(s) <= budget) {
        pick = d
        break
      }
    }
    if (pick === -1) {
      pick = earliest
      for (let d = earliest; d < days.length; d++) {
        if ((load.get(days[d]) ?? 0) < (load.get(days[pick]) ?? 0)) pick = d
      }
    }
    load.set(days[pick], (load.get(days[pick]) ?? 0) + minutes(s))
    placed.set(s.id, days[pick])
    earliest = pick
  }

  return {
    subtasks: items.map((s) => (placed.has(s.id) ? { ...s, scheduledDate: placed.get(s.id) } : s)),
    moved: placed.size
  }
}
