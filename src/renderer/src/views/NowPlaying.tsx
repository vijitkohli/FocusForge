import { useEffect, useState, type JSX } from 'react'
import { Clock, Disc3 } from 'lucide-react'
import { queueKey, queueStore, useQueue } from '../lib/queue'
import { completeSubtask } from '../lib/completion'
import { focusTimer, useFocusTimer } from '../lib/focusTimer'
import { whatNextStore, useWhatNext } from '../lib/whatNextStore'
import { Button, EmptyState, Skeleton } from '../ui'
import type { NavigationProps } from '../shell/navigation'
import { Momentum } from '../components/Momentum'
import { CarriedOver } from '../components/QueueControls'
import { TodayPlan } from '../components/TodayPlan'
import { WhatNextCard } from '../components/WhatNextCard'
import { NowChat } from '../components/NowChat'
import { useTodayPlan } from '../lib/todayPlan'

export function NowPlaying({
  onNavigate,
  onOpenProject,
  onOpenFocus
}: NavigationProps): JSX.Element {
  const queue = useQueue()
  const whatNext = useWhatNext()
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
    whatNextStore.markStart(current.projectId)
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
        ![' ', 's', 'S', 'b', 'B', 'ArrowRight', 'Escape'].includes(event.key)
      )
        return
      if (
        (event.target as Element)?.closest(
          'input,textarea,select,button,[contenteditable],[role="dialog"],[role="menu"]'
        )
      )
        return
      if (event.key === 'Escape') {
        whatNextStore.dismissReasons()
        return
      }
      event.preventDefault()
      if (event.key === 's' || event.key === 'S' || event.key === 'ArrowRight') {
        whatNextStore.notThis()
        return
      }
      if (event.key === 'b' || event.key === 'B') {
        void whatNextStore.tooBig()
        return
      }
      if (current && timer.running && timer.subtaskId === queueKey(current)) focusTimer.pause()
      else play()
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  })
  async function done(): Promise<void> {
    if (!current || saving) return
    whatNextStore.noteDone(current)
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
  return (
    <div className="flex w-full flex-col gap-8 md:px-10">
      <h1 className="sr-only">Now</h1>
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
      ) : queue.loading && !queue.loaded && !whatNext.lastKnown ? (
        <div className="now-top">
          <Skeleton height={420} />
          <Skeleton height={420} />
        </div>
      ) : (
        <>
          <div className="now-top">
            <div className="flex min-w-0 flex-col gap-6">
              <WhatNextCard
                compact={compact}
                hasProjects={hasProjects}
                onNavigate={onNavigate}
                onOpenProject={onOpenProject}
                onPlay={play}
                saving={saving}
                onDone={() => void done()}
              />
              <NowChat />
              <div className="flex flex-col gap-4">
                {!plan && !planningToday && queue.items.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    leadingIcon={Clock}
                    className="self-start"
                    onClick={() => setPlanningToday(true)}
                  >
                    Plan today
                  </Button>
                )}
                <TodayPlan
                  onOpen={(projectId, taskId) => onOpenProject(projectId, taskId)}
                  formOpen={planningToday}
                  onCloseForm={() => setPlanningToday(false)}
                />
                <CarriedOver />
              </div>
            </div>
            <Momentum />
          </div>
        </>
      )}
    </div>
  )
}
