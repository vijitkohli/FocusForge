import { localDateKey, redistributeSchedule } from './schedule'
import type { ProjectTask, Subtask } from './types'

// Weekly recurring tasks: the original task is the series template (week 1);
// one upcoming copy at a time is created within the next 7 days.

export const LOOKAHEAD_DAYS = 7

export interface Recurrence {
  every: 'week'
  weekday: number // 0 = Sunday … 6 = Saturday, local
  until: string // last possible due date, YYYY-MM-DD
  baseTitle: string
  /** Due date of the newest copy created; later copies start after it. Deleted copies never return. */
  lastCreated: string
}

function parseKey(key: string): Date {
  return new Date(`${key}T00:00:00`)
}

function addDays(key: string, days: number): string {
  const d = parseKey(key)
  d.setDate(d.getDate() + days)
  return localDateKey(d)
}

/** First date strictly after `key` that falls on `weekday`. */
export function nextWeekday(key: string, weekday: number): string {
  const d = parseKey(key)
  const ahead = (weekday - d.getDay() + 7) % 7 || 7
  d.setDate(d.getDate() + ahead)
  return localDateKey(d)
}

export function weekdayOf(key: string): number {
  return parseKey(key).getDay()
}

/** Turns `task` into a weekly series template (it stays week 1). */
export function startSeries(task: ProjectTask, weekday: number, until: string): ProjectTask {
  return {
    ...task,
    seriesId: task.seriesId ?? task.id,
    recurrence: {
      every: 'week',
      weekday,
      until,
      baseTitle: task.recurrence?.baseTitle ?? task.title,
      lastCreated: task.recurrence?.lastCreated ?? task.deadline
    }
  }
}

export function stopSeries(task: ProjectTask): ProjectTask {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { recurrence, ...rest } = task
  return rest
}

function freshStep(step: Subtask, id: string): Subtask {
  return {
    id,
    title: step.title,
    isCompleted: false,
    status: 'todo',
    ...(step.difficulty ? { difficulty: step.difficulty } : {}),
    ...(step.timeEstimate ? { timeEstimate: step.timeEstimate } : {})
  }
}

/**
 * Creates the next copy for every series whose next due date is within
 * LOOKAHEAD_DAYS of `today` and on or before `until`. Weeks that passed while
 * the app was closed are skipped rather than created already overdue.
 * Idempotent: running it again creates nothing until another week comes due.
 */
export function materialiseSeries(
  tasks: readonly ProjectTask[],
  today: string,
  newId: () => string
): { tasks: ProjectTask[]; created: ProjectTask[] } {
  const next = tasks.map((task) => ({ ...task }))
  const created: ProjectTask[] = []
  for (const template of next) {
    const rule = template.recurrence
    if (!rule || rule.every !== 'week') continue
    let due = nextWeekday(rule.lastCreated, rule.weekday)
    while (due < today) due = addDays(due, 7)
    if (due > rule.until || due > addDays(today, LOOKAHEAD_DAYS)) continue
    const week =
      Math.round(
        (parseKey(due).getTime() - parseKey(template.deadline).getTime()) / (7 * 86_400_000)
      ) + 1
    const start = addDays(due, -6) > today ? addDays(due, -6) : today
    const steps = redistributeSchedule(
      template.subtasks.map((step) => freshStep(step, newId())),
      due,
      start
    )
    const copy: ProjectTask = {
      id: newId(),
      title: `${rule.baseTitle} · week ${week}`,
      createdAt: new Date().toISOString(),
      deadline: due,
      status: 'in-progress',
      depth: template.depth,
      model: template.model,
      subtasks: steps,
      prerequisites: [],
      seriesId: template.seriesId ?? template.id
    }
    created.push(copy)
    template.recurrence = { ...rule, lastCreated: due }
  }
  return { tasks: [...next, ...created], created }
}

/** The template that owns `task`'s series (itself when it is the template). */
export function seriesTemplate(
  tasks: readonly ProjectTask[],
  task: ProjectTask
): ProjectTask | undefined {
  if (task.recurrence) return task
  if (!task.seriesId) return undefined
  return tasks.find((t) => t.recurrence && (t.seriesId ?? t.id) === task.seriesId)
}
