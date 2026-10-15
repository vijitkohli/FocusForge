import { useEffect, useRef, useState, type JSX } from 'react'
import { Pencil, Play, Trash2 } from 'lucide-react'
import { deriveStatus, type Subtask } from '../../../../common/types'
import { Checkbox, DayLabel, DifficultyTag, Input, Menu } from '../../ui'

interface StepRowProps {
  item: Subtask
  index: number
  disabled: boolean
  onToggle: (id: string) => void
  onEdit: (id: string, title: string) => void
  onDelete: (id: string) => void
}

export function StepRow({
  item,
  index,
  disabled,
  onToggle,
  onEdit,
  onDelete
}: StepRowProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.title)
  const ended = useRef(false)
  const titleTrigger = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  useEffect(() => {
    if (!editing && !disabled && restoreFocus.current) {
      titleTrigger.current?.focus()
      restoreFocus.current = false
    }
  }, [editing, disabled])
  const start = (): void => {
    ended.current = false
    setDraft(item.title)
    setEditing(true)
  }
  const commit = (): void => {
    if (ended.current) return
    ended.current = true
    setEditing(false)
    if (!disabled && draft.trim() && draft.trim() !== item.title) onEdit(item.id, draft.trim())
  }
  return (
    <li className="task-track rounded-sm border-b border-line px-2 py-3 hover:bg-bg-2">
      <span className="task-track-number text-sm tabular-nums text-fg-2" aria-hidden="true">
        {index + 1}
      </span>
      <Checkbox
        checked={item.isCompleted}
        disabled={disabled}
        aria-label={`Mark step ${index + 1}: ${item.title} ${item.isCompleted ? 'incomplete' : 'complete'}`}
        onChange={() => onToggle(item.id)}
      />
      <div className="min-w-0">
        {editing ? (
          <Input
            aria-label={`Edit step ${index + 1}`}
            autoFocus
            value={draft}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                restoreFocus.current = true
                commit()
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                ended.current = true
                restoreFocus.current = true
                setEditing(false)
              }
            }}
          />
        ) : (
          <button
            ref={titleTrigger}
            type="button"
            disabled={disabled}
            onClick={start}
            title="Edit step"
            className={`row-title block w-full rounded-xs text-left [overflow-wrap:anywhere] ${item.isCompleted ? 'text-fg-3 line-through' : 'text-fg-1'}`}
          >
            {deriveStatus(item) === 'doing' && (
              <Play size={14} className="mr-2 inline text-accent" aria-label="Doing" />
            )}
            {item.title}
          </button>
        )}
      </div>
      <div className="task-track-meta">
        <span className="text-[12.5px] text-fg-2">
          {item.scheduledDate ? <DayLabel date={item.scheduledDate} /> : 'Unscheduled'}
        </span>
        <span className="text-[12.5px] tabular-nums text-fg-2">
          {item.timeEstimate != null ? `${item.timeEstimate} min` : '—'}
        </span>
        <DifficultyTag difficulty={item.difficulty ?? 'medium'} />
      </div>
      <Menu
        className="task-track-menu"
        label={`Options for step ${index + 1}`}
        disabled={disabled}
        items={[
          { id: 'edit', label: 'Edit', icon: Pencil, onSelect: start },
          {
            id: 'delete',
            label: 'Delete',
            icon: Trash2,
            danger: true,
            onSelect: () => onDelete(item.id)
          }
        ]}
      />
    </li>
  )
}
