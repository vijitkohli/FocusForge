import { useEffect, useRef, useState, type JSX } from 'react'
import { deriveStatus, type Subtask, type SubtaskStatus } from '../../../common/types'
import { DayLabel, DifficultyTag, Menu } from '../ui'

interface KanbanBoardProps {
  subtasks: Subtask[]
  onMove: (subtaskId: string, status: SubtaskStatus) => void
  disabled?: boolean
}

const COLUMNS: { status: SubtaskStatus; label: string }[] = [
  { status: 'todo', label: 'To do' },
  { status: 'doing', label: 'Doing' },
  { status: 'done', label: 'Done' }
]

export function KanbanBoard({ subtasks, onMove, disabled = false }: KanbanBoardProps): JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<SubtaskStatus | null>(null)
  const cardActions = useRef(new Map<string, HTMLDivElement>())
  const pendingFocus = useRef<{ id: string; status: SubtaskStatus } | null>(null)
  useEffect(() => {
    const target = pendingFocus.current
    if (!target || disabled) return
    const step = subtasks.find((item) => item.id === target.id)
    if (step && deriveStatus(step) === target.status) {
      cardActions.current
        .get(target.id)
        ?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
        ?.focus()
    }
    pendingFocus.current = null
  }, [subtasks, disabled])
  const clearDrag = (): void => {
    setDragId(null)
    setOverCol(null)
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 bg-bg-1 sm:grid-cols-3">
      {COLUMNS.map((column) => {
        const items = subtasks.filter((step) => deriveStatus(step) === column.status)
        return (
          <section
            key={column.status}
            aria-label={`${column.label}, ${items.length} steps`}
            onDragOver={(event) => {
              if (disabled || !dragId) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setOverCol(column.status)
            }}
            onDragLeave={(event) => {
              if (
                event.relatedTarget instanceof Node &&
                event.currentTarget.contains(event.relatedTarget)
              )
                return
              setOverCol((current) => (current === column.status ? null : current))
            }}
            onDrop={(event) => {
              event.preventDefault()
              const target = subtasks.find((step) => step.id === dragId)
              if (!disabled && target && deriveStatus(target) !== column.status) {
                pendingFocus.current = { id: target.id, status: column.status }
                onMove(target.id, column.status)
              }
              clearDrag()
            }}
            className={`min-h-40 min-w-0 rounded-md p-3 ${overCol === column.status && !disabled ? 'bg-accent-soft' : 'bg-bg-2'}`}
          >
            <h3 className="mb-3 text-sm font-semibold text-fg-2">
              {column.label} <span className="ml-1 tabular-nums">{items.length}</span>
            </h3>
            {!items.length && (
              <p className="py-6 text-center text-[12.5px] text-fg-2">Nothing here yet</p>
            )}
            <ul className="space-y-2">
              {items.map((item) => (
                <li
                  key={item.id}
                  draggable={!disabled}
                  onDragStart={(event) => {
                    if (disabled) {
                      event.preventDefault()
                      return
                    }
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', item.id)
                    setDragId(item.id)
                  }}
                  onDragEnd={clearDrag}
                  className={`min-w-0 rounded-md bg-bg-3 p-3 ${disabled ? '' : 'cursor-grab active:cursor-grabbing'} ${dragId === item.id ? 'opacity-50' : ''}`}
                >
                  <div className="mb-2 flex min-w-0 items-start gap-2">
                    <p
                      className={`row-title min-w-0 flex-1 [overflow-wrap:anywhere] ${column.status === 'done' ? 'text-fg-2 line-through' : 'text-fg-1'}`}
                    >
                      {item.title}
                    </p>
                    <Menu
                      ref={(element) => {
                        if (element) cardActions.current.set(item.id, element)
                        else cardActions.current.delete(item.id)
                      }}
                      label={`Move ${item.title}`}
                      disabled={disabled}
                      items={COLUMNS.map((destination) => ({
                        id: destination.status,
                        label: `Move to ${destination.label}`,
                        disabled: destination.status === column.status,
                        onSelect: () => {
                          pendingFocus.current = { id: item.id, status: destination.status }
                          onMove(item.id, destination.status)
                        }
                      }))}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12.5px] text-fg-2">
                    {item.scheduledDate && <DayLabel date={item.scheduledDate} />}
                    {item.timeEstimate != null && (
                      <span className="tabular-nums">{item.timeEstimate} min</span>
                    )}
                    <DifficultyTag difficulty={item.difficulty ?? 'medium'} />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
