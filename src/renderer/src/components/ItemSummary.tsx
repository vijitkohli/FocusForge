import { useEffect, useState, type JSX } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ItemDigest } from 'src/common/digest'
import { renderCitation } from 'src/common/digest'
import { formatLocalDate } from '../lib/dates'

/**
 * Collapsible "Summary" panel for an item: the digest's goal, gaps, due dates
 * and current state (its short Markdown rendered as headings, lists and paragraphs;
 * citations dimmed).
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
          <SummaryText text={digest.currentState} />
        </div>
      )}
    </section>
  )
}

const CITATION = /(\([^()]*,\s*\d{1,2}\s+[A-Z][a-z]{2}\))/g

/** Inline text: **bold** and dimmed "(source, 12 Nov)" citations. */
function Inline({ text }: { text: string }): JSX.Element {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return (
    <>
      {parts.map((part, i) => {
        if (/^\*\*[^*]+\*\*$/.test(part)) {
          return (
            <strong key={i} className="font-semibold text-fg-1">
              {part.slice(2, -2)}
            </strong>
          )
        }
        return part.split(CITATION).map((piece, j) =>
          /^\([^()]*,\s*\d{1,2}\s+[A-Z][a-z]{2}\)$/.test(piece) ? (
            <span key={`${i}-${j}`} className="text-fg-3">
              {piece}
            </span>
          ) : (
            piece
          )
        )
      })}
    </>
  )
}

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'para'; text: string }

/** The digest summary is short Markdown: headings, bullet lists and paragraphs. */
function toBlocks(md: string): Block[] {
  const blocks: Block[] = []
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd()
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const last = blocks[blocks.length - 1]
    if (heading) blocks.push({ kind: 'heading', text: heading[1] })
    else if (bullet) {
      if (last?.kind === 'list') last.items.push(bullet[1])
      else blocks.push({ kind: 'list', items: [bullet[1]] })
    } else if (line.trim()) {
      if (last?.kind === 'para') last.text += ' ' + line.trim()
      else blocks.push({ kind: 'para', text: line.trim() })
    } else if (last?.kind === 'para') blocks.push({ kind: 'para', text: '' })
  }
  return blocks.filter((b) => b.kind !== 'para' || b.text)
}

function SummaryText({ text }: { text: string }): JSX.Element {
  return (
    <div className="text-fg-2">
      {toBlocks(text).map((block, i) =>
        block.kind === 'heading' ? (
          <h4 key={i} className="mb-1.5 mt-5 text-sm font-semibold text-fg-1 first:mt-0">
            <Inline text={block.text} />
          </h4>
        ) : block.kind === 'list' ? (
          <ul key={i} className="mb-3 list-disc space-y-1 pl-5 marker:text-fg-3">
            {block.items.map((item, j) => (
              <li key={j}>
                <Inline text={item} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={i} className="mb-3 max-w-[72ch]">
            <Inline text={block.text} />
          </p>
        )
      )}
    </div>
  )
}
