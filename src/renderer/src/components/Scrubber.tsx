import type { JSX } from 'react'
import { useFocusTimer } from '../lib/focusTimer'

function clock(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds))
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
}
export function Scrubber({
  stepKey,
  estimateMinutes = 15
}: {
  stepKey: string
  estimateMinutes?: number
}): JSX.Element {
  const timer = useFocusTimer()
  const elapsed = timer.subtaskId === stepKey ? timer.elapsed : 0
  const estimate = Math.max(1, estimateMinutes) * 60
  const over = elapsed > estimate
  return (
    <div className="w-full">
      <div
        role="progressbar"
        aria-label="Session elapsed time"
        aria-valuemin={0}
        aria-valuemax={estimate}
        aria-valuenow={Math.min(elapsed, estimate)}
        aria-valuetext={
          over
            ? `${clock(elapsed)} elapsed; taking longer is fine`
            : `${clock(elapsed)} of ${clock(estimate)}`
        }
        className={`relative h-1.5 overflow-hidden rounded-full ${over ? 'bg-accent-soft' : 'bg-bg-3'}`}
      >
        {over ? (
          <span className="scrubber-overflow absolute top-0 h-full w-0.5 bg-accent" />
        ) : (
          <span
            className="block h-full rounded-full bg-accent"
            style={{ width: `${Math.min(100, (elapsed / estimate) * 100)}%` }}
          />
        )}
      </div>
      <p className="meta mt-2 text-right text-fg-2 tabular-nums">
        {over
          ? `+${clock(elapsed - estimate)} · taking longer is fine`
          : `${clock(elapsed)} / ${clock(estimate)}`}
      </p>
    </div>
  )
}
