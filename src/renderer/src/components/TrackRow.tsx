import type { JSX } from 'react'
import { Play, ListMusic } from 'lucide-react'
import type { UpcomingSubtask } from 'src/common/types'
import { localDateKey } from 'src/common/schedule'
import { queueStore } from '../lib/queue'
import { dayLabel } from '../lib/dates'
import { Cover, Menu } from '../ui'

export function TrackRow({
  item,
  onOpen,
  transitionName,
  showDay = false
}: {
  item: UpcomingSubtask
  onOpen: () => void
  transitionName?: string
  showDay?: boolean
}): JSX.Element {
  const carried = item.scheduledDate && item.scheduledDate < localDateKey(new Date())
  return (
    <div className="group flex min-w-0 items-center gap-3 rounded-sm px-3 py-2.5 hover:bg-bg-2">
      <Cover projectId={item.projectId} name={item.projectName} size={32} />
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className="row-title block truncate" style={{ viewTransitionName: transitionName }}>
          {item.subtaskTitle}
        </span>
        <span className="meta block truncate text-fg-2">
          {item.projectName} · {item.taskTitle}
          {showDay && (
            <span className="text-fg-3">
              {' · '}
              {carried ? 'from ' : ''}
              {dayLabel(item.scheduledDate || item.deadline)}
            </span>
          )}
        </span>
      </button>
      <span className="meta shrink-0 text-fg-2 tabular-nums">
        {item.timeEstimate ? `${item.timeEstimate} min` : '—'}
      </span>
      <Menu
        label={`Options for ${item.subtaskTitle}`}
        items={[
          {
            id: 'next',
            label: 'Play this next',
            icon: Play,
            onSelect: () => queueStore.playNext(item)
          },
          { id: 'open', label: 'Open task', icon: ListMusic, onSelect: onOpen }
        ]}
      />
    </div>
  )
}
