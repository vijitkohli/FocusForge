import { describe, expect, it } from 'vitest'
import { mondayOf, reviewWeekDue, templateReview, weekBounds, type WeekSummary } from './review'

const summary: WeekSummary = {
  weekStart: '2026-10-12',
  weekEnd: '2026-10-18',
  stepsDone: 9,
  activeDays: 4,
  currentStreak: 3,
  longestStreak: 5,
  tasksFinished: 1,
  carriedOver: 0,
  topProject: { name: 'COMP9321', steps: 6 },
  focusMinutes: 120,
  estimateRatio: null
}

describe('week bounds (Sydney time)', () => {
  it('runs Monday to Sunday', () => {
    expect(weekBounds(new Date(2026, 9, 15, 9))).toEqual({ start: '2026-10-12', end: '2026-10-18' })
    expect(weekBounds(new Date(2026, 9, 18, 23, 59))).toEqual({
      start: '2026-10-12',
      end: '2026-10-18'
    })
    expect(weekBounds(new Date(2026, 9, 19, 0, 1)).start).toBe('2026-10-19')
  })

  it('survives the daylight-saving change (Sun 4 Oct 2026 in Sydney)', () => {
    expect(weekBounds(new Date(2026, 9, 4, 12))).toEqual({ start: '2026-09-28', end: '2026-10-04' })
    expect(mondayOf(new Date(2026, 9, 4, 3)).getHours()).toBe(0)
    expect(reviewWeekDue(new Date(2026, 9, 4, 18))).toBe('2026-09-28')
  })
})

describe('reviewWeekDue', () => {
  it('is due from Sunday 17:00 for three days, then not', () => {
    expect(reviewWeekDue(new Date(2026, 9, 18, 16, 59))).toBe(
      '2026-10-05'.replace('05', '05') && null
    )
    expect(reviewWeekDue(new Date(2026, 9, 18, 17, 0))).toBe('2026-10-12')
    expect(reviewWeekDue(new Date(2026, 9, 20, 9))).toBe('2026-10-12')
    expect(reviewWeekDue(new Date(2026, 9, 21, 17, 1))).toBeNull()
  })
})

describe('templateReview', () => {
  it('is warm about an empty week', () => {
    expect(templateReview({ ...summary, stepsDone: 0, activeDays: 0 }).text).toContain(
      "quiet week, and that's fine"
    )
  })

  it('summarises the week and picks one suggestion', () => {
    const review = templateReview(summary)
    expect(review.text).toBe(
      "You finished 9 steps across 4 days, mostly on COMP9321. 1 task wrapped up completely. You're on a 3-day streak."
    )
    expect(review.suggestion).toContain('same rhythm')
    expect(templateReview({ ...summary, carriedOver: 2 }).suggestion).toContain(
      '2 steps slipped past their day'
    )
    expect(templateReview({ ...summary, estimateRatio: 1.5 }).suggestion).toContain('1.5×')
  })
})
