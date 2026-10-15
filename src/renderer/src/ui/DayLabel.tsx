import type { ComponentPropsWithRef, JSX } from 'react'
import { dayLabel, deadlineLabel, parseLocalDate } from '../lib/dates'
import { cx } from './internal'

export interface DayLabelProps extends Omit<
  ComponentPropsWithRef<'time'>,
  'dateTime' | 'children'
> {
  date: string
  deadline?: boolean
  today?: Date
}

export function DayLabel({
  date,
  deadline = false,
  today,
  className,
  ...props
}: DayLabelProps): JSX.Element | null {
  if (!parseLocalDate(date)) return null
  return (
    <time
      {...props}
      dateTime={date}
      className={cx('text-[12.5px] font-medium text-fg-2', className)}
    >
      {deadline ? deadlineLabel(date) : dayLabel(date, today)}
    </time>
  )
}
