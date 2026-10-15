import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { flushSync } from 'react-dom'
import { Check, SkipForward, X } from 'lucide-react'
import { completeSubtask } from '../lib/completion'
import { dayLabel, parseLocalDate } from '../lib/dates'
import { focusTimer, useFocusTimer } from '../lib/focusTimer'
import { queueKey, queueStore, selectQueue, useQueue } from '../lib/queue'
import {
  Button,
  Cover,
  DayLabel,
  DifficultyTag,
  IconButton,
  Kbd,
  PlayButton,
  Skeleton
} from '../ui'
import { Scrubber } from './Scrubber'

export type FocusScope = { scope: 'global' } | { scope: 'task'; projectId: string; taskId: string }

interface FocusModeProps {
  focus: FocusScope
  onExit: () => void
  onOpenProject: (projectId: string, taskId?: string) => void
}

export function FocusMode({ focus, onExit, onOpenProject }: FocusModeProps): JSX.Element {
  const queue = useQueue()
  const timer = useFocusTimer()
  const projectId = focus.scope === 'task' ? focus.projectId : undefined
  const taskId = focus.scope === 'task' ? focus.taskId : undefined
  const scope = projectId ? { projectId, taskId } : undefined
  const current = selectQueue(queue, scope)[0] ?? null
  const [doneCount, setDoneCount] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const initialized = useRef(false)
  const completing = useRef(false)

  const stepKey = current ? queueKey(current) : null
  const stepDate = current?.scheduledDate || current?.deadline
  const parsedStepDate = stepDate ? parseLocalDate(stepDate) : null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const carried = parsedStepDate !== null && parsedStepDate < today

  useEffect(() => {
    if (!queue.loaded || queue.loading || completing.current) return
    const previous = focusTimer.getSnapshot()
    const key = current ? queueKey(current) : null
    const changed = previous.subtaskId !== key
    const autoStart = !initialized.current || previous.running
    focusTimer.setStep(key, current?.timeEstimate)
    if (current && autoStart && (changed || !initialized.current)) focusTimer.play()
    initialized.current = true
  }, [current, projectId, taskId, queue.loaded, queue.loading, saving])

  const togglePlayback = useCallback((): void => {
    if (!current || completing.current || queue.loading) return
    const previous = focusTimer.getSnapshot()
    const key = queueKey(current)
    if (previous.subtaskId === key && previous.running) {
      focusTimer.pause()
    } else {
      focusTimer.setStep(key, current.timeEstimate)
      focusTimer.play()
    }
  }, [current, queue.loading])

  const handleDone = useCallback(async (): Promise<void> => {
    if (!current || completing.current || queue.loading) return
    completing.current = true
    setSaving(true)
    setError('')
    const running = focusTimer.getSnapshot().running
    try {
      await completeSubtask(current, {
        onCompleted: () => {
          const next = selectQueue(
            queueStore.getSnapshot(),
            projectId ? { projectId, taskId } : undefined
          )[0]
          // Commit the session count and next timer before the transition captures the new view.
          flushSync(() => {
            setDoneCount((count) => count + 1)
            focusTimer.setStep(next ? queueKey(next) : null, next?.timeEstimate)
            focusTimer.reset()
            if (running && next) focusTimer.play()
          })
        }
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this step. Try again.')
    } finally {
      completing.current = false
      setSaving(false)
    }
  }, [current, projectId, taskId, queue.loading])

  const handleSkip = useCallback((): void => {
    if (!current || completing.current || queue.loading) return
    const running = focusTimer.getSnapshot().running
    setError('')
    queueStore.skip(current)
    const next = selectQueue(
      queueStore.getSnapshot(),
      projectId ? { projectId, taskId } : undefined
    )[0]
    focusTimer.setStep(next ? queueKey(next) : null, next?.timeEstimate)
    if (running && next) focusTimer.play()
  }, [current, projectId, taskId, queue.loading])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      )
        return
      if (
        document.querySelector(
          'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"]'
        )
      )
        return
      const target = event.target instanceof Element ? event.target : null
      if (
        target?.closest(
          'button, a, input, textarea, select, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="textbox"], [role="slider"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="menu"], [role="listbox"]'
        )
      )
        return
      if (!current || saving || queue.loading) return
      switch (event.key.toLowerCase()) {
        case ' ':
          event.preventDefault()
          togglePlayback()
          break
        case 'enter':
          event.preventDefault()
          void handleDone()
          break
        case 'arrowright':
        case 's':
          event.preventDefault()
          handleSkip()
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [current, saving, queue.loading, togglePlayback, handleDone, handleSkip])

  const pendingInScope = queue.all.filter(
    (item) => !projectId || (item.projectId === projectId && item.taskId === taskId)
  )
  const skippedInScope = pendingInScope.some((item) => queue.skipped.includes(queueKey(item)))
  const moodFiltered =
    !current &&
    queue.mood !== 'all' &&
    pendingInScope.some((item) => !queue.skipped.includes(queueKey(item)))
  const playing = timer.subtaskId === stepKey && timer.running
  const retry = (): void => {
    setError('')
    void queueStore.refresh().catch(() => {})
  }

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-bg-0 text-fg-1">
      <header className="flex shrink-0 items-center justify-end gap-3 px-5 py-4 sm:px-8">
        <Kbd>Esc</Kbd>
        <IconButton icon={X} label="Exit focus" onClick={onExit} />
      </header>

      <main className="flex w-full flex-1 flex-col px-5 pt-4 pb-12 sm:px-8 sm:pb-16">
        <div className="mx-auto my-auto w-full max-w-[880px]">
          {queue.error && !current ? (
            <section className="text-center" aria-labelledby="focus-error-title">
              <h1 id="focus-error-title" className="section-title">
                Could not load the queue.
              </h1>
              <p role="alert" className="mt-3 text-sm text-fg-2">
                {queue.error}
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-3">
                <Button onClick={retry} loading={queue.loading} loadingLabel="Retrying queue">
                  Try again
                </Button>
                <Button variant="ghost" onClick={onExit}>
                  Back
                </Button>
              </div>
            </section>
          ) : !queue.loaded || (queue.loading && !current) ? (
            <div role="status" aria-label="Loading focus queue" className="space-y-8">
              <div className="flex items-center gap-5">
                <Skeleton width={96} height={96} />
                <Skeleton width="55%" height={24} />
              </div>
              <Skeleton width="90%" height={56} />
              <Skeleton width="45%" height={16} />
              <Skeleton width="100%" height={6} />
              <div className="flex justify-center">
                <Skeleton width={80} height={80} circle />
              </div>
            </div>
          ) : current && stepKey ? (
            <section aria-labelledby="focus-title">
              <div className="flex min-w-0 items-center gap-5 sm:gap-6">
                <Cover projectId={current.projectId} name={current.projectName} size={96} />
                <p className="min-w-0 text-lg font-semibold break-words text-fg-2">
                  {current.taskTitle} · {current.projectName}
                </p>
              </div>

              <h1
                id="focus-title"
                className="now-title mt-8"
                style={{ viewTransitionName: 'now-title' }}
              >
                {current.subtaskTitle}
              </h1>
              <div className="meta mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-fg-2">
                <DifficultyTag difficulty={current.difficulty} />
                <span className="tabular-nums">
                  {timer.subtaskId === stepKey ? timer.estimateMinutes : current.timeEstimate || 15}{' '}
                  min
                </span>
                {stepDate &&
                  (carried ? (
                    <time dateTime={stepDate} className="text-[12.5px] font-medium text-fg-2">
                      from {dayLabel(stepDate)}
                    </time>
                  ) : (
                    <DayLabel date={stepDate} />
                  ))}
              </div>

              <div className="mt-8 sm:mt-10">
                <Scrubber
                  stepKey={stepKey}
                  estimateMinutes={
                    timer.subtaskId === stepKey ? timer.estimateMinutes : current.timeEstimate || 15
                  }
                />
              </div>

              <div className="mt-8 flex items-center justify-center gap-5 sm:gap-8">
                <Button
                  variant="ghost"
                  leadingIcon={SkipForward}
                  onClick={handleSkip}
                  disabled={saving || queue.loading}
                  title="Skip (ArrowRight or S)"
                >
                  Skip
                </Button>
                <PlayButton
                  size={80}
                  playing={playing}
                  onClick={togglePlayback}
                  disabled={saving || queue.loading}
                  title={playing ? 'Pause (Space)' : 'Play (Space)'}
                />
                <Button
                  leadingIcon={Check}
                  onClick={() => void handleDone()}
                  loading={saving}
                  loadingLabel="Saving completed step"
                  disabled={queue.loading}
                  title="Done (Enter)"
                >
                  Done
                </Button>
              </div>

              <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenProject(current.projectId, current.taskId)}
                >
                  Open task
                </Button>
                <p className="meta text-fg-2 tabular-nums">{doneCount} done this session</p>
              </div>
              {(error || queue.error) && (
                <div className="mt-5 text-center">
                  <p role="alert" className="text-sm text-fg-2">
                    {error || queue.error}
                  </p>
                  {queue.error && (
                    <Button variant="ghost" size="sm" onClick={retry} loading={queue.loading}>
                      Retry queue
                    </Button>
                  )}
                </div>
              )}
            </section>
          ) : (
            <section className="text-center" aria-labelledby="focus-empty-title">
              <h1 id="focus-empty-title" className="page-title">
                {moodFiltered
                  ? 'No steps match this mood.'
                  : skippedInScope
                    ? 'The remaining steps are skipped.'
                    : "That's the queue cleared."}
              </h1>
              <p className="mt-3 text-sm text-fg-2">
                {moodFiltered
                  ? 'Pending steps are still queued. Show all moods to keep going.'
                  : skippedInScope
                    ? 'Restore skipped steps when you’re ready to keep going.'
                    : `You finished ${doneCount} ${doneCount === 1 ? 'step' : 'steps'} this session.`}
              </p>
              {error && (
                <p role="alert" className="mt-3 text-sm text-fg-2">
                  {error}
                </p>
              )}
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <Button className="bg-fg-1 text-bg-0 hover:bg-fg-2" onClick={onExit}>
                  Back
                </Button>
                {moodFiltered && (
                  <Button variant="ghost" onClick={() => queueStore.setMood('all')}>
                    Show all moods
                  </Button>
                )}
                {skippedInScope && (
                  <Button variant="ghost" onClick={() => queueStore.clearSkips()}>
                    Restore skipped steps
                  </Button>
                )}
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  )
}
