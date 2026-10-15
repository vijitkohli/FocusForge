import { MIN_FOCUS_SECONDS } from 'src/common/estimates'
import { focusTimer } from './focusTimer'
import { updateTask } from './updateTask'

/**
 * Adds a finished Focus session to its step's `focusSeconds`, which feeds the
 * "steps take you about N× the estimate" figure. Best-effort: a step deleted
 * meanwhile, or a failed write, only loses that session's time.
 */
export async function recordFocusSession(key: string, seconds: number): Promise<void> {
  if (seconds < MIN_FOCUS_SECONDS) return
  let ids: unknown
  try {
    ids = JSON.parse(key)
  } catch {
    return
  }
  if (!Array.isArray(ids) || ids.length !== 3 || !ids.every((id) => typeof id === 'string')) return
  const [projectId, taskId, subtaskId] = ids as [string, string, string]
  try {
    await updateTask(projectId, taskId, (task) => ({
      ...task,
      subtasks: task.subtasks.map((step) =>
        step.id === subtaskId ? { ...step, focusSeconds: (step.focusSeconds ?? 0) + seconds } : step
      )
    }))
  } catch (error) {
    console.error('Could not record focus time', error)
  }
}

let stop: (() => void) | null = null

/** Starts recording sessions once per app (idempotent). */
export function startFocusLog(): void {
  if (stop) return
  stop = focusTimer.onSessionEnd((key, seconds) => void recordFocusSession(key, seconds))
}
