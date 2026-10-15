import type { JSX } from 'react'
import type { Prerequisite } from 'src/common/types'
import { Checkbox } from '../../ui'

const KINDS = { learn: 'Learn', acquire: 'Get', setup: 'Set up' }

export function Prerequisites({
  items,
  disabled,
  onToggle
}: {
  items: Prerequisite[]
  disabled: boolean
  onToggle: (id: string) => void
}): JSX.Element | null {
  if (!items.length) return null
  return (
    <section aria-labelledby="prerequisites-title">
      <h2 id="prerequisites-title" className="section-title mb-3">
        Before you start
      </h2>
      <ul>
        {items.map((item) => (
          <li
            key={item.id}
            className="flex min-w-0 items-center gap-3 rounded-sm px-3 py-3 hover:bg-bg-2"
          >
            <Checkbox
              checked={item.isCompleted}
              disabled={disabled}
              aria-label={`Mark ${item.title} ${item.isCompleted ? 'incomplete' : 'complete'}`}
              onChange={() => onToggle(item.id)}
            />
            <span className="w-12 shrink-0 text-[12.5px] text-fg-2">
              {item.kind ? KINDS[item.kind] : 'Prep'}
            </span>
            <span
              className={`min-w-0 flex-1 text-sm [overflow-wrap:anywhere] ${item.isCompleted ? 'text-fg-3 line-through' : 'text-fg-1'}`}
            >
              {item.title}
            </span>
            {item.timeEstimate != null && (
              <span className="shrink-0 text-[12.5px] tabular-nums text-fg-2">
                {item.timeEstimate} min
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
