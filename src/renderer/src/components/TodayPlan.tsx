import { useEffect, useId, useState, type JSX } from 'react'
import { CalendarPlus, CheckCircle2, Clock } from 'lucide-react'
import { localDateKey } from 'src/common/schedule'
import { backToBack, buildIcs } from 'src/common/ics'
import {
  BUDGET_OPTIONS,
  fillToday,
  formatMinutes,
  totalMinutes,
  type TodayItem
} from 'src/common/today'
import { queueKey, queueStore, useQueue } from '../lib/queue'
import { todayPlanStore, useTodayPlan } from '../lib/todayPlan'
import { Button, Checkbox, Cover, Input, Menu, Select } from '../ui'
import { TrackRow } from './TrackRow'

// Quarter-hour slots. A native <input type="time"> keeps keyboard focus inside
// Chromium's own segments, where the app's focus ring can't be drawn.
const START_TIMES = Array.from({ length: 96 }, (_, i) => {
  const minutes = i * 15
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
})

function nextQuarterHour(now = new Date()): string {
  const d = new Date(now)
  d.setSeconds(0, 0)
  d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15)
  // Past 23:45 the next slot is tomorrow; start at the last slot instead.
  if (d.getDate() !== now.getDate()) return '23:45'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Now Playing's "Plan today": pick how much time you have and the queue fills
 * it. While a plan is active it replaces the plain Up next list, and the hero
 * follows the first unfinished step in it.
 */
export function TodayPlan({
  onOpen,
  formOpen,
  onCloseForm
}: {
  onOpen: (projectId: string, taskId: string) => void
  /** Show the "how much time do you have" form (when no plan exists yet). */
  formOpen: boolean
  onCloseForm: () => void
}): JSX.Element | null {
  const queue = useQueue()
  const plan = useTodayPlan()
  const id = useId()
  const [budget, setBudget] = useState('60')
  const [custom, setCustom] = useState('90')
  const [includeCarried, setIncludeCarried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [start, setStart] = useState(nextQuarterHour)
  const today = localDateKey(new Date())
  const carriedCount = queue.all.filter((s) => s.scheduledDate && s.scheduledDate < today).length

  const pendingKeys = new Set(queue.all.map(queueKey))
  const pending = plan?.items.filter((item) => pendingKeys.has(item.key)) ?? []
  const done = plan?.items.filter((item) => !pendingKeys.has(item.key)) ?? []
  const firstPending = pending[0]
  const current = queue.current

  // Keep the hero on today's set: the first unfinished planned step plays next.
  const firstPendingKey = firstPending?.key ?? null
  const currentKey = current ? queueKey(current) : null
  const pendingList = pending.map((item) => item.key).join('\n')
  useEffect(() => {
    if (!firstPendingKey || !currentKey || currentKey === firstPendingKey) return
    if (pendingList.split('\n').includes(currentKey)) return
    const target = queue.items.find((item) => queueKey(item) === firstPendingKey)
    if (target) queueStore.playNext(target)
  }, [firstPendingKey, currentKey, pendingList, queue.items])

  const make = async (): Promise<void> => {
    const minutes = budget === 'custom' ? Math.round(Number(custom)) : Number(budget)
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > 16 * 60) {
      setMessage('Choose between 5 minutes and 16 hours.')
      return
    }
    setBusy(true)
    setMessage('')
    try {
      const accuracy = await window.api.getEstimateAccuracy().catch(() => null)
      const items = fillToday(
        queue.items.map((item) => ({ ...item, key: queueKey(item) })),
        minutes,
        accuracy?.ratio ?? null,
        { includeCarried, today }
      )
      if (items.length === 0) {
        setMessage('No steps to plan right now.')
        return
      }
      await todayPlanStore.save({ date: today, budgetMinutes: minutes, includeCarried, items })
      onCloseForm()
    } catch {
      setMessage("Couldn't save today's plan. Try again.")
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    setMessage('')
    try {
      await todayPlanStore.save(null)
    } catch {
      setMessage("Couldn't clear today's plan. Try again.")
    }
  }

  const exportCalendar = async (): Promise<void> => {
    if (pending.length === 0) return
    const [hours, minutes] = start.split(':').map(Number)
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
      setMessage('Choose a start time.')
      return
    }
    const begin = new Date()
    begin.setHours(hours, minutes, 0, 0)
    try {
      const result = await window.api.saveCalendarFile(
        `focusforge-${today}.ics`,
        buildIcs(backToBack(pending, begin))
      )
      if (result.saved) setMessage('Saved. Open the file to add the steps to your calendar.')
    } catch {
      setMessage("Couldn't save the calendar file. Try again.")
    }
  }

  if (!plan) {
    if (!formOpen) return null
    return (
      <section aria-labelledby={`${id}-title`} className="mb-5 rounded-md bg-bg-2 p-4">
        <h3 id={`${id}-title`} className="row-title mb-3 flex items-center gap-2">
          <Clock size={18} strokeWidth={1.75} aria-hidden="true" className="text-fg-2" />
          Plan today
        </h3>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void make()
          }}
        >
          <div className="w-[140px]">
            <Select
              label="I have"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
            >
              {BUDGET_OPTIONS.map((minutes) => (
                <option key={minutes} value={String(minutes)}>
                  {formatMinutes(minutes)}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </Select>
          </div>
          {budget === 'custom' && (
            <div className="w-[110px]">
              <Input
                label="Minutes"
                type="number"
                min={5}
                max={960}
                step={5}
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
              />
            </div>
          )}
          <Button type="submit" variant="secondary" loading={busy} loadingLabel="Planning today">
            Fill today
          </Button>
          <Button variant="ghost" onClick={onCloseForm} disabled={busy}>
            Cancel
          </Button>
        </form>
        {carriedCount > 0 && (
          <div className="mt-3">
            <Checkbox
              label={`Include carried over (${carriedCount})`}
              checked={includeCarried}
              onChange={(event) => setIncludeCarried(event.target.checked)}
            />
          </div>
        )}
        {message && (
          <p role="status" className="mt-3 text-sm text-fg-2">
            {message}
          </p>
        )}
      </section>
    )
  }

  const planned = totalMinutes(plan.items)
  const left = totalMinutes(pending)
  const byKey = new Map(queue.all.map((item) => [queueKey(item), item]))

  return (
    <section aria-labelledby={`${id}-title`} className="mb-5">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`${id}-title`} className="row-title">
          Today
        </h3>
        <p className="meta text-fg-2">
          <span className="tabular-nums">{formatMinutes(planned)}</span> of{' '}
          <span className="tabular-nums">{formatMinutes(plan.budgetMinutes)}</span>
          {done.length > 0 && left > 0 && (
            <>
              {' · '}
              <span className="tabular-nums">{formatMinutes(left)}</span> left
            </>
          )}
        </p>
      </div>
      {pending.length === 0 ? (
        <p className="py-4 text-sm text-fg-2">
          Today&rsquo;s set is done. Anything more is a bonus.
        </p>
      ) : (
        <div>
          {pending
            .slice(firstPending && current && queueKey(current) === firstPending.key ? 1 : 0)
            .map((item) => {
              const upcoming = byKey.get(item.key)
              return upcoming ? (
                <TrackRow
                  key={item.key}
                  item={upcoming}
                  onOpen={() => onOpen(item.projectId, item.taskId)}
                />
              ) : null
            })}
        </div>
      )}
      {done.length > 0 && (
        <ul aria-label="Done today" className="mt-1">
          {done.map((item: TodayItem) => (
            <li key={item.key} className="flex min-w-0 items-center gap-3 px-3 py-2 text-fg-3">
              <Cover projectId={item.projectId} name={item.projectName} size={32} decorative />
              <CheckCircle2 size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 flex-1 truncate text-sm line-through">
                <span className="sr-only">Done: </span>
                {item.title}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        {pending.length > 0 && (
          <>
            <div className="w-[120px]">
              <Select
                label="Start at"
                value={start}
                onChange={(event) => setStart(event.target.value)}
              >
                {START_TIMES.map((time) => (
                  <option key={time} value={time}>
                    {time}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              variant="secondary"
              leadingIcon={CalendarPlus}
              onClick={() => void exportCalendar()}
            >
              Add to calendar
            </Button>
          </>
        )}
        <Menu
          label="Today's plan options"
          items={[{ id: 'clear', label: 'Clear today’s plan', onSelect: () => void clear() }]}
        />
      </div>
      {message && (
        <p role="status" className="mt-3 text-sm text-fg-2">
          {message}
        </p>
      )}
    </section>
  )
}
