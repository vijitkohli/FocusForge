import React, { useState, useEffect, useCallback } from 'react'
import { ProjectTask, Subtask, UpcomingSubtask, withCompletion } from 'src/common/types'

/**
 * "Start Now" single-action mode. Surfaces exactly ONE next micro-step at a
 * time and hides everything else — the anti-procrastination core: starting is
 * trivial when there's only one thing on screen.
 *
 * Fully offline. The queue is reused from getUpcomingSubtasks() (incomplete
 * subtasks across all projects, soonest-first); completion reuses
 * loadProjectData/saveProjectData with a ledger note, mirroring TaskDetails so
 * context.md and project_data.json never drift.
 */
export type FocusScope =
  | { scope: 'global' }
  | { scope: 'task'; projectId: string; taskId: string }

interface FocusModeProps {
  focus: FocusScope
  onExit: () => void
  onOpenProject: (projectId: string, taskId?: string) => void
}

const DIFFICULTY_DOT: Record<string, string> = {
  easy: 'bg-easy',
  medium: 'bg-medium',
  hard: 'bg-hard'
}

function dueLabel(daysRemaining: number): string {
  if (daysRemaining < 0) return `${Math.abs(daysRemaining)}d overdue`
  if (daysRemaining === 0) return 'Due today'
  if (daysRemaining === 1) return 'Due tomorrow'
  return `${daysRemaining}d left`
}

export function FocusMode({ focus, onExit, onOpenProject }: FocusModeProps): React.JSX.Element {
  const [queue, setQueue] = useState<UpcomingSubtask[]>([])
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const [doneCount, setDoneCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const loadQueue = useCallback(async () => {
    try {
      const all = await window.api.getUpcomingSubtasks()
      const scoped =
        focus.scope === 'task' ? all.filter((s) => s.taskId === focus.taskId) : all
      setQueue(scoped)
    } catch (e) {
      console.error('Failed to load focus queue', e)
    } finally {
      setLoading(false)
    }
  }, [focus])

  useEffect(() => {
    loadQueue()
  }, [loadQueue])

  // First item in the queue not yet skipped this session.
  const current = queue.find((s) => !skipped.has(s.subtaskId)) ?? null

  const handleDone = async (): Promise<void> => {
    if (!current || saving) return
    setSaving(true)
    try {
      const file = (await window.api.loadProjectData(current.projectId)) || { tasks: [] }
      if (!file.tasks) file.tasks = []

      file.tasks = file.tasks.map((t: ProjectTask) =>
        t.id === current.taskId
          ? {
              ...t,
              subtasks: t.subtasks.map((s: Subtask) =>
                s.id === current.subtaskId ? withCompletion(s, true) : s
              )
            }
          : t
      )

      await window.api.saveProjectData(current.projectId, file, [
        {
          section: 'Milestones & Completed Work',
          note: `Completed "${current.subtaskTitle}" from Start Now.`
        }
      ])

      // Drop it from the local queue and bump momentum.
      setQueue((prev) => prev.filter((s) => s.subtaskId !== current.subtaskId))
      setDoneCount((n) => n + 1)
    } catch (e) {
      console.error('Failed to complete subtask in focus mode', e)
    } finally {
      setSaving(false)
    }
  }

  const handleSkip = (): void => {
    if (!current) return
    setSkipped((prev) => new Set(prev).add(current.subtaskId))
  }

  return (
    <div className="flex h-full flex-col">
      {/* MINIMAL HEADER */}
      <header className="flex shrink-0 items-center gap-3 px-6 py-3.5">
        <span className="text-sm font-medium text-fg-2">Start Now</span>
        {doneCount > 0 && (
          <span className="rounded-md bg-accent-soft px-2.5 py-1 text-xs text-accent">
            {doneCount} done this session
          </span>
        )}
        <button
          onClick={onExit}
          className="ml-auto text-sm text-fg-2 transition hover:text-fg-1"
        >
          Exit focus ✕
        </button>
      </header>

      <div className="flex flex-1 items-center justify-center px-6 pb-16">
        {loading ? (
          <p className="text-fg-3">Loading…</p>
        ) : current ? (
          <div className="w-full max-w-xl text-center">
            <p className="mb-6 text-sm text-fg-3">
              {current.projectName} • {current.taskTitle}
            </p>

            <h1 className="text-4xl font-semibold leading-snug tracking-tight">
              {current.subtaskTitle}
            </h1>

            <div className="mt-6 flex items-center justify-center gap-3 text-xs text-fg-2">
              <span className="inline-flex items-center gap-1.5">
                <span
                  className={`h-2 w-2 rounded-full ${DIFFICULTY_DOT[current.difficulty] || 'bg-medium'}`}
                />
                {current.difficulty}
              </span>
              {current.timeEstimate ? <span>~{current.timeEstimate} min</span> : null}
              <span>{dueLabel(current.daysRemaining)}</span>
            </div>

            <div className="mt-10 flex flex-col items-center gap-3">
              <button
                onClick={handleDone}
                disabled={saving}
                className="w-full max-w-xs rounded-xl bg-accent px-6 py-3.5 text-base font-medium text-white transition hover:bg-accent-hover disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Done ✓'}
              </button>
              <div className="flex items-center gap-5 text-sm text-fg-2">
                <button onClick={handleSkip} className="transition hover:text-fg-1">
                  Skip for now
                </button>
                <button
                  onClick={() => onOpenProject(current.projectId, current.taskId)}
                  className="transition hover:text-fg-1"
                >
                  Open full task
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="text-center">
            <p className="text-2xl font-semibold tracking-tight">Nothing queued 🎉</p>
            <p className="mt-2 text-sm text-fg-3">
              {doneCount > 0 ? `You knocked out ${doneCount} step${doneCount === 1 ? '' : 's'} — nice work.` : 'No upcoming steps right now.'}
            </p>
            <button
              onClick={onExit}
              className="mt-8 rounded-lg bg-bg-3 px-5 py-2.5 text-sm text-fg-1 transition hover:bg-bg-2"
            >
              Back
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
