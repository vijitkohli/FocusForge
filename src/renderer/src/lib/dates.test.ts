import { describe, expect, it } from 'vitest'
import { dayLabel, deadlineLabel, formatLocalDate, parseLocalDate } from './dates'

describe('local date labels', () => {
  it('uses local midnight rather than UTC parsing', () => {
    const date = parseLocalDate('2026-07-08')!
    expect(date.getHours()).toBe(0)
    expect(date.getDate()).toBe(8)
    expect(formatLocalDate('2026-07-08')).toBe('Wed 8 Jul')
    expect(deadlineLabel('2026-08-01')).toBe('Due Sat 1 Aug')
  })

  it('labels today/tomorrow through month/year and daylight-saving boundaries', () => {
    const today = new Date(2026, 11, 31, 23, 59)
    expect(dayLabel('2026-12-31', today)).toBe('Today')
    expect(dayLabel('2027-01-01', today)).toBe('Tomorrow')
    expect(dayLabel('2026-10-05', new Date(2026, 9, 4, 12))).toBe('Tomorrow')
    expect(dayLabel('2026-07-08', today)).toBe('Wed 8 Jul')
    expect(today.getFullYear()).toBe(2026)
  })

  it('rejects invalid dates instead of silently rolling them over', () => {
    for (const key of [
      '',
      '2026-02-29',
      '2026-13-01',
      '2026-04-31',
      '2026-7-8',
      '2026-07-08T00:00:00Z'
    ]) {
      expect(parseLocalDate(key)).toBeNull()
      expect(dayLabel(key)).toBe('')
      expect(deadlineLabel(key)).toBe('')
    }
    expect(parseLocalDate('2028-02-29')).not.toBeNull()
  })

  it('also formats correctly west of UTC', () => {
    const previous = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      expect(formatLocalDate('2026-07-08')).toBe('Wed 8 Jul')
      expect(dayLabel('2026-07-08', new Date(2026, 6, 8))).toBe('Today')
    } finally {
      process.env.TZ = previous
    }
  })
})
