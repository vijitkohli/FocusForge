import type { JSX } from 'react'
import { SkipForward } from 'lucide-react'
import { focusTimer } from '../lib/focusTimer'
import { queueKey, queueStore, useQueue } from '../lib/queue'
import { Button, Cover, IconButton, PlayButton, Skeleton } from '../ui'

export interface MiniPlayerProps {
  onOpenFocus: () => void
  onOpenLibrary: () => void
}

export function MiniPlayer({ onOpenFocus, onOpenLibrary }: MiniPlayerProps): JSX.Element {
  const { current, loading, loaded, error } = useQueue()

  const play = (): void => {
    // Read at activation time so Skip and Play always use the same shared front item.
    const step = queueStore.getSnapshot().current
    if (!step) return
    focusTimer.setStep(queueKey(step), step.timeEstimate)
    focusTimer.play()
    onOpenFocus()
  }

  return (
    <section
      aria-label="Mini player"
      aria-busy={loading}
      className="flex h-16 shrink-0 items-center gap-4 border-t border-line bg-bg-0 px-8"
    >
      {current ? (
        <>
          <Cover projectId={current.projectId} name={current.projectName} size={40} decorative />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold" title={current.subtaskTitle}>
              {current.subtaskTitle}
            </p>
            <p className="truncate text-xs text-fg-2">{current.projectName}</p>
          </div>
          <span className="shrink-0 text-xs text-fg-2 tabular-nums">
            {Number.isFinite(current.timeEstimate) && (current.timeEstimate ?? 0) > 0
              ? current.timeEstimate
              : 15}{' '}
            min
          </span>
          <PlayButton size={36} label="Play next step in Focus" onClick={play} />
          <IconButton
            size={36}
            label="Skip in queue"
            icon={SkipForward}
            onClick={() => {
              const step = queueStore.getSnapshot().current
              if (step) queueStore.skip(step)
            }}
          />
        </>
      ) : loading || (!loaded && !error) ? (
        <>
          <Skeleton width={40} height={40} />
          <Skeleton width="40%" height={16} />
          <span role="status" className="sr-only">
            Loading queue
          </span>
        </>
      ) : error ? (
        <>
          <p role="status" className="min-w-0 flex-1 text-sm text-fg-2">
            Could not load the queue.
          </p>
          <Button size="sm" onClick={() => void queueStore.refresh().catch(() => {})}>
            Retry
          </Button>
        </>
      ) : (
        <>
          <p className="min-w-0 flex-1 text-sm text-fg-2">
            Nothing queued. Plan something with the coach.
          </p>
          <Button size="sm" onClick={onOpenLibrary}>
            New task
          </Button>
        </>
      )}
    </section>
  )
}
