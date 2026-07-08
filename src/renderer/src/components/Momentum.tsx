import React, { useEffect, useState } from 'react'
import { ActivityStats } from 'src/common/types'

const HEATMAP_WEEKS = 12
const DAY_MS = 86400000

function localKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Count -> accent intensity. 0 stays a faint empty cell.
function cellClass(count: number): string {
  if (count <= 0) return 'bg-bg-3'
  if (count === 1) return 'bg-accent/30'
  if (count === 2) return 'bg-accent/60'
  return 'bg-accent'
}

/**
 * Dashboard momentum section: streak counter (feature 1) + a GitHub-style
 * completion heatmap and stat chips (feature 3), all derived from
 * getActivityStats(). Dependency-free — plain CSS grid, no chart lib.
 */
export function Momentum(): React.JSX.Element | null {
  const [stats, setStats] = useState<ActivityStats | null>(null)

  useEffect(() => {
    window.api
      .getActivityStats()
      .then(setStats)
      .catch((e) => console.error('Failed to load activity stats', e))
  }, [])

  if (!stats) return null

  // Build the last HEATMAP_WEEKS*7 days, oldest first, aligned so the final
  // column ends on today. Render as 7 rows (weekdays) x N columns (weeks).
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const totalDays = HEATMAP_WEEKS * 7
  // Back up to the start of this week's column (so columns are clean weeks).
  const start = new Date(today.getTime() - (totalDays - 1) * DAY_MS)

  const cells: { key: string; count: number }[] = []
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start.getTime() + i * DAY_MS)
    const key = localKey(d)
    cells.push({ key, count: stats.countsByDate[key] ?? 0 })
  }

  // completed this week (last 7 days inclusive of today)
  let completedThisWeek = 0
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getTime() - i * DAY_MS)
    completedThisWeek += stats.countsByDate[localKey(d)] ?? 0
  }

  return (
    <section className="rounded-2xl glass p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-fg-2">Momentum</h2>
          <p className="mt-1 text-3xl font-semibold tracking-tight">
            {stats.currentStreak > 0 ? (
              <>🔥 {stats.currentStreak} day{stats.currentStreak === 1 ? '' : 's'}</>
            ) : (
              <span className="text-fg-3">No streak yet</span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-fg-3">
            {stats.currentStreak > 0
              ? `Longest: ${stats.longestStreak} days`
              : 'Complete one step to start a streak.'}
          </p>
        </div>

        {/* STAT CHIPS */}
        <div className="flex shrink-0 gap-2 text-center">
          <div className="rounded-lg bg-bg-3 px-3 py-2">
            <p className="text-lg font-semibold">{stats.totalCompleted}</p>
            <p className="text-xs text-fg-3">done</p>
          </div>
          <div className="rounded-lg bg-bg-3 px-3 py-2">
            <p className="text-lg font-semibold">{completedThisWeek}</p>
            <p className="text-xs text-fg-3">this week</p>
          </div>
        </div>
      </div>

      {/* HEATMAP */}
      <div
        className="mt-4 grid grid-flow-col gap-1"
        style={{ gridTemplateRows: 'repeat(7, minmax(0, 1fr))' }}
      >
        {cells.map((c) => (
          <div
            key={c.key}
            title={`${c.key}: ${c.count} completed`}
            className={`h-3 w-3 rounded-sm ${cellClass(c.count)}`}
          />
        ))}
      </div>
    </section>
  )
}
