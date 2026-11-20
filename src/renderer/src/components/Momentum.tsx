import { useEffect, useId, useRef, useState, type JSX } from 'react'
import type { ActivityStats } from '../../../common/types'
import { localDateKey } from '../../../common/schedule'
import { paceSentence } from '../lib/pace'
import { useQueue } from '../lib/queue'
import { Button, SegmentedControl, Skeleton } from '../ui'

export interface MomentumProps {
  /** Show how long steps take versus their estimates (History only). */
  showPace?: boolean
}

type Range = '1m' | '3m' | '6m' | '1y'
const RANGES: { value: Range; label: string; weeks: number }[] = [
  { value: '1m', label: 'Month', weeks: 5 },
  { value: '3m', label: '3 months', weeks: 13 },
  { value: '6m', label: '6 months', weeks: 26 },
  { value: '1y', label: 'Year', weeks: 53 }
]
const RANGE_KEY = 'focusforge.momentum.range'
const GAP = 3
const MIN_CELL = 6
/** Row height cap: short ranges get wider cells rather than a very tall grid. */
const MAX_CELL = 30

function readRange(): Range {
  try {
    const stored = window.localStorage.getItem(RANGE_KEY)
    if (RANGES.some((r) => r.value === stored)) return stored as Range
  } catch {
    // Storage can be unavailable; fall back to the default.
  }
  return '3m'
}

/** Row height for the chosen range; columns always stretch to the full width (scrolls only below MIN_CELL). */
function cellSize(width: number, weeks: number): number {
  return Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor((width + GAP) / weeks) - GAP))
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  // Calendar arithmetic keeps weekdays aligned across 23- and 25-hour days.
  next.setDate(next.getDate() + days)
  return next
}

function activityGrid(
  today: Date,
  weeks: number,
  counts: ActivityStats['countsByDate']
): {
  cells: { date: Date; key: string; count: number; future: boolean }[]
  months: { column: number; label: string }[]
  thisWeek: number
} {
  const monday = addDays(today, -((today.getDay() + 6) % 7))
  const start = addDays(monday, -(weeks - 1) * 7)
  const todayKey = localDateKey(today)
  const cells = Array.from({ length: weeks * 7 }, (_, index) => {
    const date = addDays(start, index)
    const key = localDateKey(date)
    return { date, key, count: counts[key] ?? 0, future: key > todayKey }
  })
  const months: { column: number; label: string }[] = []
  cells.forEach(({ date, future }, index) => {
    if (future || (index !== 0 && date.getDate() !== 1)) return
    const column = Math.floor(index / 7)
    const previous = months[months.length - 1]
    if ((previous && column - previous.column < 3) || weeks - column < 3) return
    months.push({ column, label: date.toLocaleDateString('en-GB', { month: 'short' }) })
  })
  let thisWeek = 0
  for (let day = 0; day <= (today.getDay() + 6) % 7; day++) {
    thisWeek += counts[localDateKey(addDays(monday, day))] ?? 0
  }
  return { cells, months, thisWeek }
}

/** Four strengths of the theme's green (the "easy" colour) on the charcoal panel. */
function cellClass(count: number): string {
  if (count <= 0) return 'bg-bg-3 text-fg-2'
  if (count === 1) return 'bg-easy/30 text-fg-1'
  if (count <= 3) return 'bg-easy/55 text-fg-1'
  if (count <= 5) return 'bg-easy/80 text-on-accent'
  return 'bg-easy text-on-accent'
}

function tipText(key: string, count: number): string {
  const day = new Date(`${key}T12:00:00`).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long'
  })
  if (count <= 0) return `No steps on ${day}`
  return `${count} ${count === 1 ? 'step' : 'steps'} on ${day}`
}

export function Momentum({ showPace = false }: MomentumProps = {}): JSX.Element {
  const { all } = useQueue()
  const headingId = useId()
  const viewport = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(13 * 17)
  const [range, setRange] = useState<Range>(readRange)
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null)
  const tipHost = useRef<HTMLDivElement>(null)
  const [stats, setStats] = useState<ActivityStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [pace, setPace] = useState<string | null>(null)

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    window.api.getActivityStats().then(
      (next) => {
        if (cancelled) return
        setStats(next)
        setError(null)
      },
      () => {
        if (!cancelled) setError('Could not load activity. Retry to update your momentum.')
      }
    )
    return () => {
      cancelled = true
    }
  }, [all, attempt])

  useEffect(() => {
    if (!showPace) return
    let cancelled = false
    window.api.getEstimateAccuracy().then(
      (accuracy) => {
        if (!cancelled) setPace(paceSentence(accuracy))
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [all, showPace])

  const count = RANGES.find((r) => r.value === range)?.weeks ?? 13
  const cell = cellSize(width, count)
  const minWidth = count * (MIN_CELL + GAP) - GAP
  /** Day numbers only fit on roomy cells (Month and 3 months on most windows). */
  const showDates = cell >= 18 && (width + GAP) / count - GAP >= 22
  const gridStyle = {
    gridTemplateRows: `repeat(7, ${cell}px)`,
    gridAutoFlow: 'column' as const,
    gridAutoColumns: 'minmax(0, 1fr)',
    gap: `${GAP}px`
  }
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const { cells, months } = activityGrid(today, count, stats?.countsByDate ?? {})
  const loading = !stats && !error

  const retry = (): void => {
    setError(null)
    setAttempt((value) => value + 1)
  }

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={loading}
      className="min-w-0 max-w-full rounded-md bg-bg-2 p-5"
    >
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
        <h2 id={headingId} className="section-title">
          Momentum
        </h2>
        {loading && (
          <span className="sr-only" role="status">
            Loading activity
          </span>
        )}
        <SegmentedControl
          label="Time frame"
          className="ml-auto"
          options={RANGES.map(({ value, label }) => ({ value, label }))}
          value={range}
          onChange={(next) => {
            setRange(next)
            try {
              window.localStorage.setItem(RANGE_KEY, next)
            } catch {
              // The choice still applies for this session.
            }
          }}
        />
      </div>

      {showPace && pace && <p className="mt-2 text-sm text-fg-2">{pace}</p>}

      {error && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-fg-2">
            {error}
          </p>
          <Button size="sm" variant="secondary" onClick={retry}>
            Retry
          </Button>
        </div>
      )}

      <div
        ref={tipHost}
        className="relative mt-4 flex min-w-0 gap-2"
        onMouseLeave={() => setTip(null)}
      >
        <div
          ref={viewport}
          role="region"
          aria-label={`${count}-week completion heatmap`}
          tabIndex={0}
          className="min-w-0 flex-1 overflow-x-auto rounded-xs pb-1"
        >
          <div style={{ width: '100%', minWidth }}>
            <div aria-hidden="true" className="relative h-6 overflow-hidden text-[11px] text-fg-3">
              {months.map(({ column, label }) => (
                <span
                  key={column}
                  className="absolute top-0"
                  style={{ left: `${(column / count) * 100}%` }}
                >
                  {label}
                </span>
              ))}
            </div>
            <div className="grid" style={gridStyle} role="list" aria-label="Daily completed steps">
              {cells.map(({ key, count: completed, future }) => {
                if (future) return <span key={key} aria-hidden="true" />
                if (loading) return <Skeleton key={key} width="100%" height={cell} />
                const text = tipText(key, completed)
                const show = (el: HTMLElement): void => {
                  const host = tipHost.current?.getBoundingClientRect()
                  const box = el.getBoundingClientRect()
                  if (host)
                    setTip({ text, x: box.left - host.left + box.width / 2, y: box.top - host.top })
                }
                return (
                  <span
                    key={key}
                    role="listitem"
                    tabIndex={-1}
                    aria-label={text}
                    onMouseEnter={(e) => show(e.currentTarget)}
                    onFocus={(e) => show(e.currentTarget)}
                    onBlur={() => setTip(null)}
                    className={`flex items-start justify-end overflow-hidden rounded-xs px-1 pt-0.5 text-[10px] leading-none tabular-nums ${cellClass(completed)}`}
                  >
                    {showDates && <span aria-hidden="true">{Number(key.slice(8, 10))}</span>}
                  </span>
                )
              })}
            </div>
          </div>
        </div>
        {tip && (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-xs bg-bg-4 px-2 py-1 text-xs text-fg-1 shadow-[0_4px_12px_rgba(0,0,0,0.35)]"
            style={{ left: tip.x, top: tip.y - 6 }}
          >
            {tip.text}
          </div>
        )}
      </div>
    </section>
  )
}
