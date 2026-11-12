import type { JSX } from 'react'
import { CalendarClock } from 'lucide-react'
import { Button } from '../../ui'

/** A milestone ran past its planned day: offer a one-tap re-plan of the rest (D3). */
export function SlippedBanner({
  title,
  disabled,
  replanning,
  onReplan
}: {
  title: string | null
  disabled: boolean
  replanning: boolean
  onReplan: () => void
}): JSX.Element | null {
  if (!title) return null
  return (
    <section
      className="flex flex-wrap items-center gap-3 rounded-md bg-bg-2 p-4"
      aria-label="Re-plan the rest"
    >
      <CalendarClock size={20} className="text-medium" aria-hidden="true" />
      <p className="min-w-0 flex-1 basis-60 text-sm text-fg-2">
        &lsquo;{title}&rsquo; ran past its planned day. That&apos;s normal — want me to re-plan the
        rest from what&apos;s done?
      </p>
      <Button variant="secondary" size="sm" disabled={disabled} onClick={onReplan}>
        {replanning ? 'Re-planning…' : 'Re-plan the rest'}
      </Button>
    </section>
  )
}

export function ReplanBanner({
  count,
  disabled,
  onReplan
}: {
  count: number
  disabled: boolean
  onReplan: () => void
}): JSX.Element | null {
  if (!count) return null
  return (
    <section
      className="flex flex-wrap items-center gap-3 rounded-md bg-bg-2 p-4"
      aria-label="Re-plan slipped steps"
    >
      <CalendarClock size={20} className="text-medium" aria-hidden="true" />
      <p className="min-w-0 flex-1 basis-60 text-sm text-fg-2">
        {count} step{count === 1 ? '' : 's'} slipped past {count === 1 ? 'its' : 'their'} planned
        day. That&apos;s normal — want to fit {count === 1 ? 'it' : 'them'} into the days ahead?
      </p>
      <Button variant="secondary" size="sm" disabled={disabled} onClick={onReplan}>
        Re-plan from today
      </Button>
    </section>
  )
}
