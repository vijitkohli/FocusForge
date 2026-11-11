import { useEffect, useRef, useState, type JSX } from 'react'
import { ArrowLeft, NotebookText, Play, Repeat, Repeat1, Trash2 } from 'lucide-react'
import type { ProjectTask } from 'src/common/types'
import { deadlineLabel, parseLocalDate } from '../../lib/dates'
import { Button, DateInput, Menu } from '../../ui'
import { Burndown } from './Burndown'
import { burndownData } from './burndownData'

interface TaskHeaderProps {
  task: ProjectTask
  projectName: string
  disabled: boolean
  onBack: () => void
  onPlay: () => void
  onNotes: () => void
  onDelete: () => void
  onDeadline: (deadline: string) => void
  /** Whether this task belongs to an active weekly series. */
  repeating?: boolean
  onRepeat?: () => void
  onStopRepeating?: () => void
}

export function TaskHeader({
  task,
  projectName,
  disabled,
  onBack,
  onPlay,
  onNotes,
  onDelete,
  onDeadline,
  repeating = false,
  onRepeat,
  onStopRepeating
}: TaskHeaderProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(task.deadline)
  const ended = useRef(false)
  const deadlineTrigger = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  useEffect(() => {
    if (!editing && !disabled && restoreFocus.current) {
      deadlineTrigger.current?.focus()
      restoreFocus.current = false
    }
  }, [editing, disabled])
  const items = [...task.subtasks, ...(task.prerequisites ?? [])]
  const done = items.filter((item) => item.isCompleted).length
  const percent = items.length ? (done / items.length) * 100 : 0
  const burn = burndownData(task.subtasks, task.createdAt, task.deadline)
  const commit = (): void => {
    if (ended.current) return
    ended.current = true
    setEditing(false)
    if (!disabled && parseLocalDate(draft) && draft !== task.deadline) onDeadline(draft)
  }
  return (
    <header className="space-y-5">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={ArrowLeft}
          onClick={onBack}
          disabled={disabled}
          className="min-w-0 flex-1 justify-start [&>span]:min-w-0"
        >
          <span className="truncate">{projectName}</span>
        </Button>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={NotebookText}
            onClick={onNotes}
            disabled={disabled}
          >
            Notes
          </Button>
          <Menu
            label="Task options"
            disabled={disabled}
            items={[
              ...(onRepeat
                ? [
                    {
                      id: 'repeat',
                      label: repeating ? 'Change weekly repeat…' : 'Repeat weekly…',
                      icon: Repeat,
                      onSelect: onRepeat
                    }
                  ]
                : []),
              ...(repeating && onStopRepeating
                ? [
                    {
                      id: 'stop-repeat',
                      label: 'Stop repeating',
                      icon: Repeat1,
                      onSelect: onStopRepeating
                    }
                  ]
                : []),
              { id: 'delete', label: 'Delete task', icon: Trash2, danger: true, onSelect: onDelete }
            ]}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="page-title min-w-0 flex-1 basis-64 [overflow-wrap:anywhere]">
          {task.title}
        </h1>
        <Button
          variant="primary"
          leadingIcon={Play}
          onClick={onPlay}
          disabled={disabled || task.subtasks.every((step) => step.isCompleted)}
        >
          Play next step
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-fg-2">
        {editing ? (
          <div className="w-44">
            <DateInput
              aria-label="Task deadline"
              pickerLabel="Open calendar for task deadline"
              autoFocus
              value={draft}
              disabled={disabled}
              onChange={(event) => setDraft(event.target.value)}
              onGroupBlur={commit}
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
          </div>
        ) : (
          <Button
            ref={deadlineTrigger}
            variant="ghost"
            size="sm"
            disabled={disabled}
            title="Change deadline"
            onClick={() => {
              ended.current = false
              setDraft(task.deadline)
              setEditing(true)
            }}
          >
            {deadlineLabel(task.deadline) || 'Set deadline'}
          </Button>
        )}
        <span>
          {done} / {items.length} done
        </span>
        {burn && <span>{burn.status}</span>}
        {disabled && <span role="status">Saving…</span>}
      </div>
      <div className="flex flex-wrap items-center gap-5">
        <div
          role="progressbar"
          aria-label="Task progress, including prerequisites"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          aria-valuetext={`${done} of ${items.length} done`}
          className="h-1 min-w-24 flex-1 overflow-hidden rounded-full bg-bg-2"
        >
          <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
        </div>
        {burn && <Burndown data={burn} />}
      </div>
    </header>
  )
}
