import React, { useState } from 'react'
import { Subtask, SubtaskStatus, deriveStatus } from 'src/common/types'

interface KanbanBoardProps {
  subtasks: Subtask[]
  onMove: (subtaskId: string, status: SubtaskStatus) => void
}

const COLUMNS: { status: SubtaskStatus; label: string }[] = [
  { status: 'todo', label: 'To do' },
  { status: 'doing', label: 'Doing' },
  { status: 'done', label: 'Done' }
]

const DIFFICULTY_DOT: Record<string, string> = {
  easy: 'bg-easy',
  medium: 'bg-medium',
  hard: 'bg-hard'
}

/**
 * Three-column board (To do / Doing / Done) for a task's subtasks. Drag a card
 * between columns to change its state — native HTML5 drag-and-drop, no library.
 * State changes are handed up via onMove; the parent persists (with ledger note)
 * through the same path as the list-view checkbox.
 */
export function KanbanBoard({ subtasks, onMove }: KanbanBoardProps): React.JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<SubtaskStatus | null>(null)

  const drop = (status: SubtaskStatus): void => {
    if (dragId) onMove(dragId, status)
    setDragId(null)
    setOverCol(null)
  }

  return (
    <div className="grid flex-1 grid-cols-3 gap-3 overflow-y-auto pr-1">
      {COLUMNS.map((col) => {
        const items = subtasks.filter((s) => deriveStatus(s) === col.status)
        const isOver = overCol === col.status
        return (
          <div
            key={col.status}
            onDragOver={(e) => {
              e.preventDefault()
              setOverCol(col.status)
            }}
            onDragLeave={() => setOverCol((c) => (c === col.status ? null : c))}
            onDrop={() => drop(col.status)}
            className={`flex min-h-48 flex-col gap-2 rounded-lg border p-2.5 transition ${
              isOver ? 'border-accent bg-accent-soft' : 'border-border bg-surface'
            }`}
          >
            <div className="flex items-center justify-between px-1 pb-1">
              <span className="text-xs font-medium text-fg-2">{col.label}</span>
              <span className="rounded bg-bg-3 px-2 py-0.5 text-xs text-fg-3">{items.length}</span>
            </div>

            {items.length === 0 ? (
              <p className="px-1 py-6 text-center text-xs text-fg-3">Nothing here yet</p>
            ) : (
              items.map((item) => (
                <div
                  key={item.id}
                  draggable
                  onDragStart={() => setDragId(item.id)}
                  onDragEnd={() => {
                    setDragId(null)
                    setOverCol(null)
                  }}
                  className={`cursor-grab rounded-xl border border-border bg-bg-3 p-3 text-sm active:cursor-grabbing ${
                    dragId === item.id ? 'opacity-50' : ''
                  }`}
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${DIFFICULTY_DOT[item.difficulty || 'medium']}`}
                    />
                    <span className="text-xs text-fg-3">
                      {item.scheduledDate}
                      {item.timeEstimate ? ` • ${item.timeEstimate}m` : ''}
                    </span>
                  </div>
                  <p className={col.status === 'done' ? 'text-fg-3 line-through' : 'text-fg-1'}>
                    {item.title}
                  </p>
                </div>
              ))
            )}
          </div>
        )
      })}
    </div>
  )
}
