import { useEffect, useRef, useState, type JSX } from 'react'
import { Plus } from 'lucide-react'
import type { Subtask } from 'src/common/types'
import { Button, Input } from '../../ui'
import { StepRow } from './StepRow'

interface StepListProps {
  items: Subtask[]
  disabled: boolean
  onToggle: (id: string) => void
  onEdit: (id: string, title: string) => void
  onDelete: (id: string) => void
  onSplit?: (id: string) => void
  onAdd: (title: string) => void
}

export function AddStep({
  disabled,
  onAdd
}: Pick<StepListProps, 'disabled' | 'onAdd'>): JSX.Element {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const ended = useRef(false)
  const addTrigger = useRef<HTMLButtonElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  useEffect(() => {
    if (!adding && !disabled && restoreFocus.current) {
      addTrigger.current?.focus()
      restoreFocus.current = false
    }
  }, [adding, disabled])
  const commit = (): void => {
    if (ended.current) return
    ended.current = true
    setAdding(false)
    if (!disabled && draft.trim()) {
      restoreFocus.current = true
      onAdd(draft.trim())
    }
    setDraft('')
  }
  return adding ? (
    <div className="mt-3 flex min-w-0 items-center gap-3 px-2">
      <div className="min-w-0 flex-1">
        <Input
          autoFocus
          aria-label="New step title"
          placeholder="Add a quick step…"
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => {
            if (event.relatedTarget !== addButton.current) commit()
          }}
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
              setAdding(false)
              setDraft('')
            }
          }}
        />
      </div>
      <Button
        ref={addButton}
        size="sm"
        disabled={disabled || !draft.trim()}
        onMouseDown={(event) => event.preventDefault()}
        onClick={commit}
      >
        Add
      </Button>
    </div>
  ) : (
    <Button
      ref={addTrigger}
      variant="ghost"
      leadingIcon={Plus}
      className="mt-3"
      disabled={disabled}
      onClick={() => {
        ended.current = false
        setAdding(true)
      }}
    >
      Add a step
    </Button>
  )
}

export function StepList({
  items,
  disabled,
  onToggle,
  onEdit,
  onDelete,
  onSplit,
  onAdd
}: StepListProps): JSX.Element {
  return (
    <div className="task-tracks min-w-0">
      {!items.length && (
        <p className="py-4 text-sm text-fg-2">
          No steps yet. Add a step or ask the coach to adjust this plan.
        </p>
      )}
      <ol aria-label="Steps in plan order">
        {items.map((item, index) => (
          <StepRow
            key={item.id}
            item={item}
            index={index}
            disabled={disabled}
            onToggle={onToggle}
            onEdit={onEdit}
            onDelete={onDelete}
            onSplit={onSplit}
          />
        ))}
      </ol>
      <AddStep disabled={disabled} onAdd={onAdd} />
    </div>
  )
}
