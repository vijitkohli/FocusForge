import { useEffect, useId, useState, type JSX } from 'react'
import { Sparkles } from 'lucide-react'
import type { WeeklyReview } from 'src/common/review'
import { formatLocalDate } from '../lib/dates'

function weekLabel(review: WeeklyReview): string {
  return `${formatLocalDate(review.summary.weekStart)} – ${formatLocalDate(review.summary.weekEnd)}`
}

function Facts({ review }: { review: WeeklyReview }): JSX.Element {
  const { summary } = review
  const facts = [
    `${summary.stepsDone} ${summary.stepsDone === 1 ? 'step' : 'steps'}`,
    `${summary.activeDays} active ${summary.activeDays === 1 ? 'day' : 'days'}`,
    summary.focusMinutes > 0 ? `${summary.focusMinutes} min in Focus` : null,
    summary.tasksFinished > 0
      ? `${summary.tasksFinished} ${summary.tasksFinished === 1 ? 'task' : 'tasks'} finished`
      : null
  ].filter(Boolean)
  return <p className="meta text-fg-3">{facts.join(' · ')}</p>
}

/** History's "Your week": the latest weekly review, with earlier ones folded away. */
export function WeeklyReviewCard(): JSX.Element | null {
  const [reviews, setReviews] = useState<WeeklyReview[]>([])
  const [version, setVersion] = useState(0)
  const id = useId()

  useEffect(() => window.api.onReviewsChanged(() => setVersion((value) => value + 1)), [])
  useEffect(() => {
    let cancelled = false
    window.api.listReviews().then(
      (list) => {
        if (!cancelled) setReviews(list)
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [version])

  const [latest, ...earlier] = reviews
  if (!latest) return null

  return (
    <section aria-labelledby={`${id}-title`} className="rounded-md bg-bg-2 p-5">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={`${id}-title`} className="section-title flex items-center gap-2">
          <Sparkles size={18} strokeWidth={1.75} aria-hidden="true" className="text-fg-2" />
          Your week
        </h2>
        <p className="meta text-fg-3">{weekLabel(latest)}</p>
      </div>
      <p className="max-w-[72ch] text-[15px] leading-[1.55] text-fg-1">{latest.text}</p>
      <p className="mt-3 max-w-[72ch] text-sm leading-[1.55] text-fg-2">
        <span className="font-semibold text-fg-1">Try this week: </span>
        {latest.suggestion}
      </p>
      <div className="mt-3">
        <Facts review={latest} />
      </div>
      {earlier.length > 0 && (
        <details className="mt-4 border-t border-line pt-3">
          <summary className="cursor-pointer text-sm text-fg-2 hover:text-fg-1">
            Earlier weeks ({earlier.length})
          </summary>
          <ul className="mt-3 space-y-4">
            {earlier.map((review) => (
              <li key={review.weekStart} className="space-y-1">
                <p className="meta text-fg-3">{weekLabel(review)}</p>
                <p className="max-w-[72ch] text-sm leading-[1.55] text-fg-2">{review.text}</p>
                <p className="max-w-[72ch] text-sm leading-[1.55] text-fg-3">{review.suggestion}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
