import { useEffect, useState, type JSX } from 'react'
import { Check, Clock, Disc3, SkipForward } from 'lucide-react'
import { localDateKey } from 'src/common/schedule'
import { queueKey, queueStore, useQueue } from '../lib/queue'
import { completeSubtask } from '../lib/completion'
import { focusTimer, useFocusTimer } from '../lib/focusTimer'
import { coverFor } from '../lib/cover'
import { dayLabel } from '../lib/dates'
import { Button, Cover, DifficultyTag, EmptyState, PlayButton, Skeleton } from '../ui'
import type { NavigationProps } from '../shell/navigation'
import { Momentum } from '../components/Momentum'
import { MoodFilter, CarriedOver } from '../components/QueueControls'
import { TrackRow } from '../components/TrackRow'
import { TodayPlan } from '../components/TodayPlan'
import { useTodayPlan } from '../lib/todayPlan'
import { Scrubber } from '../components/Scrubber'

export function NowPlaying({
  onNavigate,
  onOpenProject,
  onOpenFocus
}: NavigationProps): JSX.Element {
  const queue = useQueue()
  const plan = useTodayPlan()
  const timer = useFocusTimer()
  const current = queue.current
  const [saving, setSaving] = useState(false)
  const [planningToday, setPlanningToday] = useState(false)
  const [error, setError] = useState('')
  const [hasProjects, setHasProjects] = useState(true)
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 1099px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1099px)')
    const update = (): void => setCompact(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    window.api
      .getProjects()
      .then((p) => setHasProjects(p.length > 0))
      .catch(() => {})
  }, [])
  function play(): void {
    if (!current) return
    focusTimer.setStep(queueKey(current), current.timeEstimate)
    focusTimer.play()
    onOpenFocus()
  }
  useEffect(() => {
    function keydown(event: KeyboardEvent): void {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.key !== ' '
      )
        return
      if (
        (event.target as Element)?.closest(
          'input,textarea,select,button,[contenteditable],[role="dialog"],[role="menu"]'
        )
      )
        return
      event.preventDefault()
      if (current && timer.running && timer.subtaskId === queueKey(current)) focusTimer.pause()
      else play()
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  })
  async function done(): Promise<void> {
    if (!current || saving) return
    setSaving(true)
    setError('')
    const running = timer.running
    try {
      await completeSubtask(current, {
        onCompleted: () => {
          const next = queueStore.getSnapshot().current
          focusTimer.setStep(next ? queueKey(next) : null, next?.timeEstimate)
          if (running && next) focusTimer.play()
        }
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save this step. Try again.')
    } finally {
      setSaving(false)
    }
  }
  const carried = current?.scheduledDate && current.scheduledDate < localDateKey(new Date())
  return (
    <div className="flex w-full flex-col gap-6">
      <h1 className="section-title text-fg-2">Now Playing</h1>
      {error && (
        <p role="alert" className="rounded-md bg-bg-2 p-3 text-hard">
          {error}
        </p>
      )}
      {queue.error ? (
        <EmptyState
          icon={Disc3}
          title="Queue couldn't load"
          description={queue.error}
          action={
            <Button onClick={() => void queueStore.refresh().catch(() => {})}>Try again</Button>
          }
        />
      ) : queue.loading && !queue.loaded ? (
        <div className="now-layout">
          <Skeleton height={420} />
          <Skeleton height={420} />
        </div>
      ) : (
        <div className="now-layout">
          <section className="now-panel flex min-w-0 flex-col rounded-md bg-bg-2">
            {current ? (
              <>
                <div className="mb-4 flex flex-wrap items-end gap-5">
                  <div className="relative isolate shrink-0">
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute -inset-12 -z-10"
                      style={{
                        background: `radial-gradient(closest-side, color-mix(in srgb, var(--color-${coverFor(current.projectId, current.projectName).hue}) 12%, transparent), transparent)`
                      }}
                    />
                    <Cover
                      projectId={current.projectId}
                      name={current.projectName}
                      size={compact ? 96 : 160}
                    />
                  </div>
                  <button
                    onClick={() => onOpenProject(current.projectId, current.taskId)}
                    className="min-w-0 text-left text-sm text-fg-2 hover:text-fg-1"
                  >
                    {current.taskTitle}
                    <span className="mt-1 block">{current.projectName}</span>
                  </button>
                </div>
                <h2 className="now-title" style={{ viewTransitionName: 'now-title' }}>
                  {current.subtaskTitle}
                </h2>
                <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-fg-2">
                  <span className="meta tabular-nums">{current.timeEstimate || 15} min</span>
                  <DifficultyTag difficulty={current.difficulty} />
                  <span className="meta">
                    {carried ? 'from ' : ''}
                    {dayLabel(current.scheduledDate || current.deadline)}
                  </span>
                </div>
                <div className="pt-5">
                  <Scrubber stepKey={queueKey(current)} estimateMinutes={current.timeEstimate} />
                </div>
                <div className="mt-4 flex items-center justify-center gap-5">
                  <Button
                    variant="ghost"
                    leadingIcon={SkipForward}
                    disabled={saving}
                    onClick={() => queueStore.skip(current)}
                  >
                    Skip
                  </Button>
                  <PlayButton size={64} label="Play in Focus (Space)" onClick={play} />
                  <Button
                    variant="secondary"
                    leadingIcon={Check}
                    loading={saving}
                    onClick={() => void done()}
                  >
                    Done
                  </Button>
                </div>
              </>
            ) : (
              <EmptyState
                icon={Disc3}
                title={
                  !hasProjects
                    ? 'Nothing playing yet'
                    : queue.mood !== 'all'
                      ? `No ${queue.mood === 'lazy' ? 'easy' : queue.mood === 'normal' ? 'medium' : 'hard'} steps queued.`
                      : 'Queue’s empty.'
                }
                description={
                  !hasProjects
                    ? "Tell the coach what you're avoiding."
                    : queue.mood !== 'all'
                      ? "Switch mood or play what's next."
                      : 'Plan your next task with the coach.'
                }
                action={
                  queue.mood !== 'all' ? (
                    <Button onClick={() => queueStore.setMood('all')}>Play what’s next</Button>
                  ) : queue.skipped.length ? (
                    <Button onClick={queueStore.clearSkips}>Restore skipped steps</Button>
                  ) : (
                    <Button onClick={() => onNavigate({ name: 'library' })}>New task</Button>
                  )
                }
              />
            )}
          </section>
          <aside className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="section-title">Up next</h2>
              {!plan && !planningToday && queue.items.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  leadingIcon={Clock}
                  onClick={() => setPlanningToday(true)}
                >
                  Plan today
                </Button>
              )}
            </div>
            <MoodFilter />
            <div className="mt-4">
              <TodayPlan
                onOpen={(projectId, taskId) => onOpenProject(projectId, taskId)}
                formOpen={planningToday}
                onCloseForm={() => setPlanningToday(false)}
              />
              {!plan && (
                <>
                  {queue.items.slice(1, 7).map((item, i) => (
                    <TrackRow
                      key={queueKey(item)}
                      item={item}
                      transitionName={i === 0 ? 'queue-0' : undefined}
                      onOpen={() => onOpenProject(item.projectId, item.taskId)}
                    />
                  ))}
                  {queue.items.length < 2 && (
                    <p className="py-5 text-sm text-fg-3">Your next steps will appear here.</p>
                  )}
                </>
              )}
            </div>
            <CarriedOver />
          </aside>
        </div>
      )}
      <Momentum />
    </div>
  )
}
