import { localDateKey } from '../../../common/schedule'

/** Date-only keys are calendar dates, not UTC timestamps. */
export function parseLocalDate(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!match) return null
  const [, year, month, day] = match.map(Number)
  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(0, 0, 0, 0)
  return localDateKey(date) === key ? date : null
}

export function formatLocalDate(key: string): string {
  const date = parseLocalDate(key)
  if (!date) return ''
  const weekday = date.toLocaleDateString('en-GB', { weekday: 'short' })
  const month = date.toLocaleDateString('en-GB', { month: 'short' })
  return `${weekday} ${date.getDate()} ${month}`
}

export function dayLabel(key: string, today = new Date()): string {
  if (!parseLocalDate(key)) return ''
  if (key === localDateKey(today)) return 'Today'
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (key === localDateKey(tomorrow)) return 'Tomorrow'
  return formatLocalDate(key)
}

export function deadlineLabel(key: string): string {
  const label = formatLocalDate(key)
  return label ? `Due ${label}` : ''
}
