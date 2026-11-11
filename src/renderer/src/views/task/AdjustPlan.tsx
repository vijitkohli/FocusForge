import type { JSX } from 'react'
import { Square } from 'lucide-react'
import { Button, Input } from '../../ui'
import { useSlowSignal } from '../../lib/slowSignal'

interface AdjustPlanProps {
  request: string
  message: string | null
  disabled: boolean
  adjusting: boolean
  onChange: (request: string) => void
  onAdjust: () => void
  onStop: () => void
}

export function AdjustPlan({
  request,
  message,
  disabled,
  adjusting,
  onChange,
  onAdjust,
  onStop
}: AdjustPlanProps): JSX.Element {
  const slow = useSlowSignal(adjusting, null)
  return (
    <section aria-labelledby="adjust-plan-title" className="space-y-3 border-t border-line pt-6">
      <h2 id="adjust-plan-title" className="section-title">
        Change this plan
      </h2>
      <form
        className="flex min-w-0 flex-wrap items-center gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          onAdjust()
        }}
      >
        <div className="min-w-0 flex-1 basis-64">
          <Input
            aria-label="How should the plan change?"
            value={request}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            placeholder="e.g. make this shorter, split step 3, push everything back a day"
          />
        </div>
        {adjusting ? (
          <Button variant="secondary" leadingIcon={Square} onClick={onStop}>
            Stop
          </Button>
        ) : (
          <Button type="submit" variant="secondary" disabled={disabled || !request.trim()}>
            Adjust
          </Button>
        )}
      </form>
      {adjusting && (
        <p role="status" className="text-sm text-fg-3">
          {slow
            ? 'Adjusting your plan… bigger plans take a little longer.'
            : 'Adjusting your plan…'}
        </p>
      )}
      {message && (
        <p
          role="status"
          className="rounded-md bg-bg-2 p-3 text-sm whitespace-pre-wrap [overflow-wrap:anywhere] text-fg-2"
        >
          {message}
        </p>
      )}
    </section>
  )
}
