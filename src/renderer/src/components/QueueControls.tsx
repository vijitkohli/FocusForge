import { CalendarClock } from 'lucide-react'
import { useState, type JSX } from 'react'
import { localDateKey } from 'src/common/schedule'
import { queueStore, useQueue, type QueueMood } from '../lib/queue'
import { replanAllOverdue } from '../lib/replan'
import { Button, SegmentedControl } from '../ui'

export function MoodFilter(): JSX.Element {
  const { mood } = useQueue()
  return (
    <SegmentedControl<QueueMood>
      label="Queue mood"
      value={mood}
      onChange={queueStore.setMood}
      className="max-w-full flex-wrap"
      options={[
        { value: 'all', label: 'All' },
        { value: 'lazy', label: 'Low energy' },
        { value: 'normal', label: 'Steady' },
        { value: 'motivated', label: 'Fired up' }
      ]}
    />
  )
}

export function CarriedOver(): JSX.Element | null {
  const queue = useQueue()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const today = localDateKey(new Date())
  const count = queue.all.filter((s) => s.scheduledDate && s.scheduledDate < today).length
  async function replan(): Promise<void> {
    setBusy(true)
    try {
      const moved = await replanAllOverdue()
      setMessage(`Moved ${moved} steps into the days ahead.`)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not re-plan. Try again.')
    } finally {
      setBusy(false)
    }
  }
  if (!count && !message) return null
  return (
    <section className="mt-6 border-t border-line pt-5">
      {count > 0 && (
        <>
          <h3 className="section-title mb-3">
            Carried over <span className="text-fg-2 tabular-nums">({count})</span>
          </h3>
          <Button
            variant="secondary"
            leadingIcon={CalendarClock}
            loading={busy}
            onClick={() => void replan()}
          >
            Re-plan all from today
          </Button>
        </>
      )}
      {message && (
        <p role="status" className="mt-3 text-sm text-fg-2">
          {message}
        </p>
      )}
    </section>
  )
}
