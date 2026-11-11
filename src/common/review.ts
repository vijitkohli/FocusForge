import { localDateKey } from './schedule'

// Weekly review: a kind Sunday-evening look back at the week (Monday–Sunday).

export const REVIEW_HOUR = 17 // Sunday 17:00 local
export const REVIEW_GRACE_DAYS = 3 // still generated if the app opens by Wednesday evening

export interface WeekSummary {
  weekStart: string // Monday, local YYYY-MM-DD
  weekEnd: string // Sunday
  stepsDone: number
  activeDays: number
  currentStreak: number
  longestStreak: number
  tasksFinished: number
  /** Unfinished steps that were scheduled on or before Sunday. */
  carriedOver: number
  topProject: { name: string; steps: number } | null
  focusMinutes: number
  estimateRatio: number | null
}

export interface WeeklyReview {
  weekStart: string
  generatedAt: string
  summary: WeekSummary
  text: string
  suggestion: string
  source: 'ai' | 'template'
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

/** Monday 00:00 local of the week containing `date`. */
export function mondayOf(date: Date): Date {
  const monday = new Date(date)
  monday.setHours(0, 0, 0, 0)
  return addDays(monday, -((monday.getDay() + 6) % 7))
}

export function weekBounds(date: Date): { start: string; end: string } {
  const monday = mondayOf(date)
  return { start: localDateKey(monday), end: localDateKey(addDays(monday, 6)) }
}

/**
 * The week (Monday key) whose review is due at `now`, or null. Due from Sunday
 * 17:00 until REVIEW_GRACE_DAYS later, so a laptop that was closed on Sunday
 * evening still gets the review when it next opens.
 */
export function reviewWeekDue(now: Date): string | null {
  const sunday = addDays(mondayOf(now), 6)
  sunday.setHours(REVIEW_HOUR, 0, 0, 0)
  // Before this Sunday's 17:00, the candidate is last week's Sunday.
  const due = sunday <= now ? sunday : addDays(sunday, -7)
  const elapsed = now.getTime() - due.getTime()
  if (elapsed < 0 || elapsed > REVIEW_GRACE_DAYS * 86_400_000) return null
  return localDateKey(mondayOf(addDays(due, -1)))
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Warm, specific copy without AI; also the fallback when the model is unavailable. */
export function templateReview(summary: WeekSummary): { text: string; suggestion: string } {
  if (summary.stepsDone === 0) {
    return {
      text: "A quiet week, and that's fine. Rest counts, and the plan is still here when you are.",
      suggestion: 'Pick one 5-minute step for Monday morning and let that be the whole goal.'
    }
  }
  const parts = [
    `You finished ${plural(summary.stepsDone, 'step')} across ${plural(summary.activeDays, 'day')}${
      summary.topProject ? `, mostly on ${summary.topProject.name}` : ''
    }.`
  ]
  if (summary.tasksFinished > 0)
    parts.push(`${plural(summary.tasksFinished, 'task')} wrapped up completely.`)
  if (summary.currentStreak >= 2) parts.push(`You're on a ${summary.currentStreak}-day streak.`)
  let suggestion = 'Keep the same rhythm: start each day with the smallest step in your queue.'
  if (summary.carriedOver > 0) {
    suggestion = `${plural(summary.carriedOver, 'step')} slipped past ${summary.carriedOver === 1 ? 'its' : 'their'} day. On Monday, try "Re-plan all from today" so the week starts clean.`
  } else if (summary.estimateRatio !== null && summary.estimateRatio >= 1.3) {
    suggestion = `Steps took about ${summary.estimateRatio.toFixed(1)}× the estimate. Try planning one less step each day.`
  }
  return { text: parts.join(' '), suggestion }
}
