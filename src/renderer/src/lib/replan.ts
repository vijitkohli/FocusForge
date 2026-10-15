import { localDateKey, rescheduleOverdue } from '../../../common/schedule'
import type { LedgerNote } from '../../../common/types'
import { queueStore } from './queue'
import { updateTask } from './updateTask'

export async function replanAllOverdue(): Promise<number> {
  const today = localDateKey(new Date())
  const upcoming = await window.api.getUpcomingSubtasks()
  const tasks = new Map<string, { projectId: string; taskId: string }>()
  for (const item of upcoming) {
    if (!item.scheduledDate || item.scheduledDate >= today) continue
    tasks.set(JSON.stringify([item.projectId, item.taskId]), item)
  }
  let total = 0
  // Sequential load-modify-save prevents tasks in the same project overwriting each other.
  for (const { projectId, taskId } of tasks.values()) {
    const note: LedgerNote = {
      section: 'Plan Adjustments',
      note: 'Re-planned 0 overdue steps forward from today.'
    }
    let moved = 0
    await updateTask(
      projectId,
      taskId,
      (task) => {
        const result = rescheduleOverdue(task.subtasks, task.deadline, today)
        moved = result.moved
        note.note = `Re-planned ${moved} overdue steps forward from today.`
        return { ...task, subtasks: result.subtasks }
      },
      note
    )
    total += moved
  }
  await queueStore.refresh()
  return total
}
