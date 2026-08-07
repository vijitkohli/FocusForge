import React, { useState } from 'react'
import {
  LedgerNote,
  Prerequisite,
  ProjectTask,
  Subtask,
  SubtaskStatus,
  setSubtaskStatus,
  withCompletion
} from 'src/common/types'
import { KanbanBoard } from './KanbanBoard'
import { updateTask } from '../lib/updateTask'

interface TaskDetailProps {
  task: ProjectTask
  projectId: string
  onBack: () => void
  onStartFocus: () => void
}

let nextLocalId = 1

/**
 * Tiny dependency-free burndown sparkline: ideal line (total -> 0 across
 * created -> deadline) vs actual remaining derived from subtask completedAt
 * timestamps, plus an on-track / behind label. Subtasks completed before
 * completedAt existed (no timestamp) are folded in at the start so the curve
 * still ends at the true current remaining.
 */
function Burndown({
  subtasks,
  createdAt,
  deadline
}: {
  subtasks: Subtask[]
  createdAt: string
  deadline: string
}): React.JSX.Element | null {
  const total = subtasks.length
  const start = new Date(createdAt).getTime()
  const end = new Date(`${deadline}T23:59:59`).getTime()
  const now = Date.now()
  if (total === 0 || isNaN(start) || isNaN(end) || end <= start) return null

  const span = end - start
  const xOf = (t: number): number => Math.max(0, Math.min(100, ((t - start) / span) * 100))
  const yOf = (remaining: number): number => (1 - remaining / total) * 30

  const incomplete = subtasks.filter((s) => !s.isCompleted).length
  const dated = subtasks
    .filter((s) => s.isCompleted && s.completedAt)
    .map((s) => new Date(s.completedAt as string).getTime())
    .filter((t) => !isNaN(t))
    .sort((a, b) => a - b)
  const legacyDone = subtasks.filter((s) => s.isCompleted && !s.completedAt).length

  // Build the actual step line: start with legacy-completed folded in at t0.
  let remaining = total - legacyDone
  const pts: string[] = [`${xOf(start)},${yOf(remaining)}`]
  for (const t of dated) {
    pts.push(`${xOf(t)},${yOf(remaining)}`)
    remaining -= 1
    pts.push(`${xOf(t)},${yOf(remaining)}`)
  }
  pts.push(`${xOf(Math.min(now, end))},${yOf(remaining)}`)

  // On-track vs behind, comparing actual remaining to the ideal line today.
  const elapsedFrac = Math.max(0, Math.min(1, (now - start) / span))
  const idealRemaining = total * (1 - elapsedFrac)
  const behindBy = incomplete - idealRemaining

  let status: { text: string; cls: string }
  if (incomplete === 0) status = { text: 'Complete 🎉', cls: 'text-easy' }
  else if (now > end) status = { text: 'Overdue', cls: 'text-hard' }
  else if (behindBy <= 0.5) status = { text: 'On track', cls: 'text-easy' }
  else
    status = {
      text: `Behind by ~${Math.round(behindBy)} step${Math.round(behindBy) === 1 ? '' : 's'}`,
      cls: 'text-medium'
    }

  return (
    <div className="mt-3 flex items-center gap-3">
      <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-10 flex-1">
        {/* ideal */}
        <line
          x1="0"
          y1={yOf(total)}
          x2="100"
          y2={yOf(0)}
          stroke="currentColor"
          className="text-fg-3"
          strokeWidth="0.5"
          strokeDasharray="2 2"
        />
        {/* actual */}
        <polyline
          points={pts.join(' ')}
          fill="none"
          stroke="currentColor"
          className="text-accent"
          strokeWidth="1.2"
        />
      </svg>
      <span className={`shrink-0 text-xs font-medium ${status.cls}`}>{status.text}</span>
    </div>
  )
}

const DIFFICULTY_BORDER: Record<string, string> = {
  easy: 'border-l-easy',
  medium: 'border-l-medium',
  hard: 'border-l-hard'
}

export function TaskDetail({
  task,
  projectId,
  onBack,
  onStartFocus
}: TaskDetailProps): React.JSX.Element {
  // Local state to manage checkboxes visually
  const [subtasks, setSubtasks] = useState<Subtask[]>(task.subtasks)
  const [prerequisites, setPrerequisites] = useState<Prerequisite[]>(task.prerequisites ?? [])
  const [saving, setSaving] = useState(false)
  const [view, setView] = useState<'list' | 'board'>('list')

  // --- Deadline editing state ---
  const [deadline, setDeadline] = useState(task.deadline)
  const [editingDeadline, setEditingDeadline] = useState(false)

  // --- Inline manual editing state ---
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [newStepText, setNewStepText] = useState('')

  // --- AI mutation chat state ---
  const [mutationRequest, setMutationRequest] = useState('')
  const [mutating, setMutating] = useState(false)
  const [mutationMessage, setMutationMessage] = useState<string | null>(null)

  /**
   * Every manual change (toggle/add/edit/delete) goes through here: update
   * the visible list, then persist the whole task back to disk with a note
   * describing what happened, so context.md and project_data.json always
   * change together. No engine call - fully usable offline.
   */
  const persistSubtasks = async (updated: Subtask[], note: LedgerNote) => {
    setSubtasks(updated)
    setSaving(true)
    try {
      await updateTask(projectId, task.id, (t) => ({ ...t, subtasks: updated }), note)
    } catch (error) {
      console.error('Failed to save subtask change', error)
    } finally {
      setSaving(false)
    }
  }

  /** Same write-with-ledger-note path as subtasks, for the prerequisite phase. */
  const persistPrerequisites = async (updated: Prerequisite[], note: LedgerNote) => {
    setPrerequisites(updated)
    setSaving(true)
    try {
      await updateTask(projectId, task.id, (t) => ({ ...t, prerequisites: updated }), note)
    } catch (error) {
      console.error('Failed to save prerequisite change', error)
    } finally {
      setSaving(false)
    }
  }

  const togglePrerequisite = (id: string) => {
    const target = prerequisites.find((p) => p.id === id)
    const updated = prerequisites.map((p) =>
      p.id === id ? { ...p, isCompleted: !p.isCompleted } : p
    )
    persistPrerequisites(updated, {
      section: 'Milestones & Completed Work',
      note: `Prerequisite "${target?.title}" marked ${target?.isCompleted ? 'incomplete' : 'complete'}.`
    })
  }

  /**
   * Proportionally re-spreads incomplete subtasks' scheduledDate across
   * today -> newDeadline (same shape as the AI's original distribution),
   * so changing the deadline doesn't leave stale dates past/before it.
   * Completed subtasks keep their original date - they're done.
   */
  const redistributeSchedule = (items: Subtask[], newDeadline: string): Subtask[] => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const end = new Date(newDeadline)
    end.setHours(0, 0, 0, 0)

    const incomplete = items.filter((s) => !s.isCompleted)
    const totalDays = Math.max(
      1,
      Math.round((end.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
    )

    let i = 0
    return items.map((s) => {
      if (s.isCompleted) return s
      const slot =
        incomplete.length <= 1 ? totalDays : Math.round((i / (incomplete.length - 1)) * totalDays)
      i += 1
      const scheduled = new Date(today)
      scheduled.setDate(scheduled.getDate() + Math.min(slot, totalDays))
      return { ...s, scheduledDate: scheduled.toISOString().split('T')[0] }
    })
  }

  const commitDeadlineChange = async (): Promise<void> => {
    setEditingDeadline(false)
    if (deadline === task.deadline) return

    const rescheduled = redistributeSchedule(subtasks, deadline)
    setSubtasks(rescheduled)
    setSaving(true)
    try {
      await updateTask(projectId, task.id, (t) => ({ ...t, deadline, subtasks: rescheduled }), {
        section: 'Plan Adjustments',
        note: `Deadline changed from ${task.deadline} to ${deadline}; remaining steps rescheduled.`
      })
      task.deadline = deadline
    } catch (error) {
      console.error('Failed to save deadline change', error)
    } finally {
      setSaving(false)
    }
  }

  const toggleSubtask = (id: string) => {
    const target = subtasks.find((s) => s.id === id)
    const updated = subtasks.map((s) => (s.id === id ? withCompletion(s, !s.isCompleted) : s))
    persistSubtasks(updated, {
      section: 'Milestones & Completed Work',
      note: `Marked "${target?.title}" as ${target?.isCompleted ? 'incomplete' : 'complete'}.`
    })
  }

  const moveSubtask = (id: string, status: SubtaskStatus) => {
    const target = subtasks.find((s) => s.id === id)
    if (!target || target.status === status) return
    const updated = subtasks.map((s) => (s.id === id ? setSubtaskStatus(s, status) : s))
    persistSubtasks(updated, {
      section: 'Milestones & Completed Work',
      note: `Moved "${target.title}" to ${status === 'todo' ? 'To do' : status === 'doing' ? 'Doing' : 'Done'}.`
    })
  }

  const startEditing = (subtask: Subtask) => {
    setEditingId(subtask.id)
    setEditText(subtask.title)
  }

  const commitEdit = () => {
    if (!editingId) return
    const target = subtasks.find((s) => s.id === editingId)
    const trimmed = editText.trim()

    if (target && trimmed && trimmed !== target.title) {
      const updated = subtasks.map((s) => (s.id === editingId ? { ...s, title: trimmed } : s))
      persistSubtasks(updated, {
        section: 'Milestones & Completed Work',
        note: `Manually edited subtask: "${target.title}" -> "${trimmed}".`
      })
    }
    setEditingId(null)
    setEditText('')
  }

  const deleteSubtask = (id: string) => {
    const target = subtasks.find((s) => s.id === id)
    const updated = subtasks.filter((s) => s.id !== id)
    persistSubtasks(updated, {
      section: 'Milestones & Completed Work',
      note: `Manually deleted subtask: "${target?.title}".`
    })
  }

  const addSubtask = () => {
    const trimmed = newStepText.trim()
    if (!trimmed) return

    const newSubtask: Subtask = {
      id: `manual-${Date.now()}-${nextLocalId++}`,
      title: trimmed,
      isCompleted: false
    }
    const updated = [...subtasks, newSubtask]
    persistSubtasks(updated, {
      section: 'Milestones & Completed Work',
      note: `Manually added subtask: "${trimmed}".`
    })
    setNewStepText('')
  }

  const handleMutate = async (): Promise<void> => {
    const request = mutationRequest.trim()
    if (!request || mutating) return

    setMutating(true)
    setMutationMessage(null)
    try {
      const result = await window.api.updateChecklist(
        projectId,
        task.id,
        request,
        { originalTask: task.title, subtasks, prerequisites },
        deadline,
        task.depth,
        task.model
      )

      if (result.success && result.subtasks) {
        setSubtasks(result.subtasks)
        setPrerequisites(result.prerequisites ?? [])
      }
      setMutationMessage(result.message)
      setMutationRequest('')
    } catch (error) {
      console.error('Failed to mutate checklist', error)
      setMutationMessage('Something went wrong adjusting the plan.')
    } finally {
      setMutating(false)
    }
  }

  // Prerequisites count toward one honest progress number alongside subtasks.
  const allItems = subtasks.length + prerequisites.length
  const completedCount =
    subtasks.filter((s) => s.isCompleted).length + prerequisites.filter((p) => p.isCompleted).length
  const pct = allItems === 0 ? 0 : Math.round((completedCount / allItems) * 100)

  return (
    <div className="flex h-full flex-col">
      {/* HEADER */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-3.5">
        <button onClick={onBack} className="text-sm text-fg-2 transition hover:text-fg-1">
          ← Workspace
        </button>
        <span className="text-fg-3">/</span>
        <span className="text-sm text-fg-2">
          {saving ? 'Saving…' : `${completedCount}/${allItems} complete`}
        </span>
        <button
          onClick={onStartFocus}
          title="Focus on the next step"
          className="ml-auto rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:bg-accent-hover"
        >
          ▶ Focus next step
        </button>
        <div>
          {editingDeadline ? (
            <input
              type="date"
              value={deadline}
              autoFocus
              onChange={(e) => setDeadline(e.target.value)}
              onBlur={commitDeadlineChange}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitDeadlineChange()
              }}
              className="rounded-md border border-border bg-bg-3 px-3 py-1.5 text-xs text-fg-1 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          ) : (
            <button
              onClick={() => setEditingDeadline(true)}
              title="Change deadline"
              className="rounded-md border border-border px-3 py-1.5 text-xs text-fg-2 transition hover:border-border-strong hover:text-fg-1"
            >
              📅 Due {deadline}
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-1 justify-center overflow-y-auto">
        <div className="flex min-h-full w-full max-w-3xl flex-col gap-5 px-6 py-6">
          <div className="shrink-0">
            <h1 className="text-3xl font-semibold tracking-tight">{task.title}</h1>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-bg-2">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <Burndown subtasks={subtasks} createdAt={task.createdAt} deadline={deadline} />
          </div>

          {/* PREREQUISITES — learn / acquire / set up before the steps */}
          {prerequisites.length > 0 && (
            <div className="shrink-0 rounded-xl border border-accent/30 bg-accent-soft p-4">
              <p className="mb-2 text-sm font-medium text-accent">Before you start</p>
              <div className="flex flex-col gap-1.5">
                {prerequisites.map((p) => (
                  <label key={p.id} className="flex cursor-pointer items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      checked={p.isCompleted}
                      onChange={() => togglePrerequisite(p.id)}
                      className="h-4 w-4 shrink-0 cursor-pointer accent-accent"
                    />
                    <span className="text-xs uppercase tracking-wide text-fg-3">
                      {p.kind ?? 'prep'}
                    </span>
                    <span className={p.isCompleted ? 'text-fg-3 line-through' : 'text-fg-1'}>
                      {p.title}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* VIEW TOGGLE */}
          <div className="flex shrink-0 items-center gap-1 self-start rounded-md border border-border bg-surface p-1">
            {(['list', 'board'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded px-4 py-1.5 text-xs font-medium capitalize transition ${
                  view === v ? 'bg-accent text-white' : 'text-fg-2 hover:text-fg-1'
                }`}
              >
                {v}
              </button>
            ))}
          </div>

          {view === 'board' ? (
            <KanbanBoard subtasks={subtasks} onMove={moveSubtask} />
          ) : (
            /* SUBTASK LIST */
            <div className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto pr-1">
              {subtasks.map((item) => (
                <div
                  key={item.id}
                  className={`group flex items-center gap-3 rounded-r-xl border-l-4 bg-surface px-4 py-3 ${
                    DIFFICULTY_BORDER[item.difficulty || 'medium']
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={item.isCompleted}
                    onChange={() => toggleSubtask(item.id)}
                    className="h-5 w-5 shrink-0 cursor-pointer accent-accent"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-fg-3">
                      {item.scheduledDate}
                      {item.timeEstimate ? ` • ${item.timeEstimate} min` : ''}
                    </p>
                    {editingId === item.id ? (
                      <input
                        value={editText}
                        autoFocus
                        onChange={(e) => setEditText(e.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEdit()
                        }}
                        className="mt-0.5 w-full rounded-md border border-border bg-bg-3 px-2 py-1 text-sm text-fg-1 focus:border-accent focus:outline-none"
                      />
                    ) : (
                      <p
                        onClick={() => startEditing(item)}
                        title="Click to edit"
                        className={`cursor-text font-medium ${item.isCompleted ? 'text-fg-3 line-through' : ''}`}
                      >
                        {item.title}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => deleteSubtask(item.id)}
                    title="Delete this step"
                    className="shrink-0 rounded p-1 text-fg-3 opacity-0 transition hover:bg-hard/10 hover:text-hard group-hover:opacity-100"
                  >
                    ✕
                  </button>
                </div>
              ))}

              {/* MANUAL ADD */}
              <div className="mt-1 flex items-center gap-2 rounded-2xl glass p-2">
                <input
                  type="text"
                  value={newStepText}
                  onChange={(e) => setNewStepText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addSubtask()
                  }}
                  placeholder="Add a quick step…"
                  className="flex-1 bg-transparent px-2 text-sm text-fg-1 placeholder:text-fg-3 focus:outline-none"
                />
                <button
                  onClick={addSubtask}
                  disabled={!newStepText.trim()}
                  className="rounded-md bg-accent px-5 py-2 text-sm font-medium text-white transition hover:bg-accent-hover disabled:opacity-50"
                >
                  Add
                </button>
              </div>
            </div>
          )}

          {/* AI-DRIVEN PLAN ADJUSTMENT */}
          <div className="shrink-0 border-t border-border py-4">
            <p className="mb-2 text-sm font-medium text-fg-2">Ask the AI to adjust this plan</p>
            {mutationMessage && (
              <div className="mb-2 rounded-md bg-accent-soft px-3 py-2 text-xs text-accent">
                {mutationMessage}
              </div>
            )}
            <div className="flex items-center gap-2 rounded-2xl glass p-2">
              <input
                type="text"
                value={mutationRequest}
                onChange={(e) => setMutationRequest(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleMutate()
                }}
                placeholder="e.g. make this shorter, expand step 3, push everything back a day"
                disabled={mutating}
                className="flex-1 bg-transparent px-2 text-sm text-fg-1 placeholder:text-fg-3 focus:outline-none"
              />
              <button
                onClick={handleMutate}
                disabled={mutating || !mutationRequest.trim()}
                className="rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white transition hover:bg-accent-hover disabled:opacity-50"
              >
                {mutating ? 'Thinking…' : 'Adjust'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
