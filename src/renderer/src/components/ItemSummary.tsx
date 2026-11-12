import { useEffect, useState, type JSX } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ItemDigest } from 'src/common/digest'
import { renderCitation } from 'src/common/digest'
import { formatLocalDate } from '../lib/dates'

/**
 * Collapsible "Summary" panel for an item: the digest's goal, gaps, due dates
 * and current state (Markdown shown as plain text; citations are labels).
 */
export function ItemSummary({ itemId }: { itemId: string }): JSX.Element | null {
  const [digest, setDigest] = useState<ItemDigest | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void window.api.getItemDigest(itemId).then(
        (d) => {
          if (!cancelled) setDigest(d)
        },
        () => undefined
      )
    }
    load()
    const off = window.api.onDigestUpdated((id) => {
      if (id === itemId) load()
    })
    return () => {
      cancelled = true
      off()
    }
  }, [itemId])

  if (!digest) return null
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section aria-label="Summary" className="rounded-md border border-line">
      <button
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Chevron size={16} strokeWidth={1.75} aria-hidden="true" className="text-fg-3" />
        <span className="text-[15px] font-[550]">Summary</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{digest.goal}</span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-line px-4 py-4 text-[13.5px] leading-[1.5]">
          {digest.dueDates.length > 0 && (
            <div>
              <h3 className="mb-1 text-[12.5px] text-fg-3">Due dates</h3>
              <ul className="space-y-0.5">
                {digest.dueDates.map((d, i) => (
                  <li key={i}>
                    {d.what} · {d.date ? formatLocalDate(d.date) : (d.when ?? 'date unknown')}
                    {d.confidence === 'tentative' && ' (tentative)'}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {digest.candidateTasks.length > 0 && (
            <div>
              <h3 className="mb-1 text-[12.5px] text-fg-3">Gaps to check</h3>
              <ul className="space-y-0.5">
                {digest.candidateTasks.map((t) => (
                  <li key={t.id}>
                    {t.title}{' '}
                    <span className="text-fg-3">
                      {t.sources[0] && renderCitation(t.sources[0])}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {digest.constraints?.length > 0 && (
            <div>
              <h3 className="mb-1 text-[12.5px] text-fg-3">Rules that bind plans</h3>
              <ul className="space-y-0.5">
                {digest.constraints.map((c, i) => (
                  <li key={i}>{c.text}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="whitespace-pre-wrap text-fg-2">{digest.currentState}</div>
        </div>
      )}
    </section>
  )
}
