import type { JSX } from 'react'
import { CalendarDays } from 'lucide-react'
import { localDateKey } from 'src/common/schedule'
import { MoodFilter, CarriedOver } from '../components/QueueControls'
import { Momentum } from '../components/Momentum'
import { WeeklyReviewCard } from '../components/WeeklyReviewCard'
import { TrackRow } from '../components/TrackRow'
import { dayLabel } from '../lib/dates'
import { MOOD_TO_DIFFICULTY, queueKey, queueStore, useQueue } from '../lib/queue'
import type { NavigationProps } from '../shell/navigation'
import { Button, EmptyState, Skeleton } from '../ui'

export function History({ onOpenProject, onNavigate }: NavigationProps): JSX.Element {
  const queue = useQueue()
  const today = localDateKey(new Date())
  // History is a complete schedule, including steps skipped in this session.
  const items = queue.all.filter(
    (item) => queue.mood === 'all' || item.difficulty === MOOD_TO_DIFFICULTY[queue.mood]
  )
  const groups = new Map<string, typeof items>()
  for (const item of items) {
    const date = item.scheduledDate || item.deadline
    const key = date < today ? 'carried' : date
    groups.set(key, [...(groups.get(key) || []), item])
  }
  const entries = [...groups.entries()].sort(([a], [b]) =>
    a === 'carried' ? -1 : b === 'carried' ? 1 : a.localeCompare(b)
  )
  return (
    <div className="flex w-full flex-col gap-8">
      <h1 className="page-title">History</h1>
      <WeeklyReviewCard />
      <Momentum showPace />
      <section>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
          <h2 className="section-title">Coming up</h2>
          <MoodFilter />
        </div>
        {queue.error ? (
          <div role="alert" className="rounded-md bg-bg-2 p-5">
            <p>{queue.error}</p>
            <Button className="mt-3" onClick={() => void queueStore.refresh().catch(() => {})}>
              Try again
            </Button>
          </div>
        ) : !queue.loaded ? (
          <div className="space-y-3">
            <Skeleton height={60} />
            <Skeleton height={60} />
            <Skeleton height={60} />
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title="Nothing coming up"
            description={
              queue.mood === 'all'
                ? 'Plan your next task with the coach.'
                : 'Switch mood to see the rest of your steps.'
            }
            action={
              <Button
                onClick={() =>
                  queue.mood === 'all' ? onNavigate({ name: 'library' }) : queueStore.setMood('all')
                }
              >
                {queue.mood === 'all' ? 'New task' : 'Show all steps'}
              </Button>
            }
          />
        ) : (
          entries.map(([key, steps]) => (
            <section key={key} className="mb-7">
              <h3 className="meta mb-2 border-b border-line pb-3 text-fg-2">
                {key === 'carried' ? 'Carried over' : dayLabel(key)}{' '}
                <span className="ml-2 tabular-nums">{steps.length}</span>
              </h3>
              {steps.map((item) => (
                <div key={queueKey(item)} className="relative">
                  {item.daysRemaining >= 0 && item.daysRemaining <= 2 && (
                    <span
                      className="absolute top-6 left-0 h-1.5 w-1.5 rounded-full bg-medium"
                      title="Due within two days"
                    />
                  )}
                  <TrackRow
                    item={item}
                    showDay={key === 'carried'}
                    onOpen={() => onOpenProject(item.projectId, item.taskId)}
                  />
                </div>
              ))}
            </section>
          ))
        )}
        <CarriedOver />
      </section>
    </div>
  )
}
