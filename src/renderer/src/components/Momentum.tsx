import { useEffect, useId, useRef, useState, type JSX } from 'react'
import { Flame } from 'lucide-react'
import type { ActivityStats } from '../../../common/types'
import { localDateKey } from '../../../common/schedule'
import { formatLocalDate } from '../lib/dates'
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
  if (count <= 0) return 'bg-bg-3'
  if (count === 1) return 'bg-easy/25'
  if (count === 2) return 'bg-easy/45'
  if (count <= 4) return 'bg-easy/70'
  return 'bg-easy/90'
}

export function Momentum({ showPace = false }: MomentumProps = {}): JSX.Element {
  const { all } = useQueue()
  const headingId = useId()
  const viewport = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(13 * 17)
  const [range, setRange] = useState<Range>(readRange)
  const [stats, setStats] = useState<ActivityStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [pace, setPace] = useState<string | null>(null)
  // The streak number ticks up (one short motion) only when it grows in place;
  // tracked as state adjusted during render, React's pattern for prop changes.
  const streak = stats?.currentStreak ?? null
  const [seenStreak, setSeenStreak] = useState<number | null>(null)
  const [ticked, setTicked] = useState(false)
  if (streak !== null && streak !== seenStreak) {
    setTicked(seenStreak !== null && streak > seenStreak)
    setSeenStreak(streak)
  }

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
  const gridStyle = {
    gridTemplateRows: `repeat(7, ${cell}px)`,
    gridAutoFlow: 'column' as const,
    gridAutoColumns: 'minmax(0, 1fr)',
    gap: `${GAP}px`
  }
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const { cells, months, thisWeek } = activityGrid(today, count, stats?.countsByDate ?? {})
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
        {stats ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-2">
            <span className="inline-flex items-center gap-1.5 text-fg-1">
              <Flame size={18} className="text-accent" aria-hidden="true" />
              {stats.currentStreak > 0 ? (
                <span>
                  <span
                    key={stats.currentStreak}
                    className={ticked ? 'streak-tick tabular-nums' : 'tabular-nums'}
                  >
                    {stats.currentStreak}
                  </span>
                  -day streak
                </span>
              ) : (
                'No streak yet'
              )}
            </span>
            {stats.longestStreak > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">longest {stats.longestStreak}</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{stats.totalCompleted} done</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{thisWeek} this week</span>
          </p>
        ) : loading ? (
          <>
            <Skeleton width="min(100%, 340px)" height={18} />
            <span className="sr-only" role="status">
              Loading activity
            </span>
          </>
        ) : null}
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

      <div className="mt-4 flex min-w-0 gap-2">
        <div
          aria-hidden="true"
          className="mt-6 grid shrink-0 text-[11px] text-fg-3"
          style={{
            gridTemplateRows: `repeat(7, ${cell}px)`,
            gap: `${GAP}px`,
            lineHeight: `${cell}px`
          }}
        >
          <span style={{ gridRow: 1 }}>Mon</span>
          <span style={{ gridRow: 3 }}>Wed</span>
          <span style={{ gridRow: 5 }}>Fri</span>
        </div>
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
                const label = `${formatLocalDate(key)} · ${completed} ${completed === 1 ? 'step' : 'steps'}`
                return (
                  <span
                    key={key}
                    role="listitem"
                    aria-label={label}
                    title={label}
                    className={`rounded-xs ${cellClass(completed)}`}
                  />
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
