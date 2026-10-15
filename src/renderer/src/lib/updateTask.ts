import type { LedgerNote, ProjectTask } from 'src/common/types'

/**
 * Single load-modify-save path for mutating one task within a project, with an
 * accompanying ledger note. Previously this read-whole-file → replace-this-task
 * → write-whole-file pattern was duplicated across TaskDetails (toggle, edit,
 * add, delete, deadline change) and FocusMode (complete-from-focus); routing
 * them all through here removes that duplication and gives a single place to
 * add concurrency safety later.
 *
 * `updater` receives the matching task and returns its replacement. Missing
 * projects/tasks and failed saves reject, without recording a successful change.
 */
export async function updateTask(
  projectId: string,
  taskId: string,
  updater: (task: ProjectTask) => ProjectTask,
  note: LedgerNote
): Promise<void> {
  const file = await window.api.loadProjectData(projectId)
  if (!file) throw new Error('The project could not be loaded. Return to the project to reload it.')
  if (!(file.tasks ?? []).some((task) => task.id === taskId)) {
    throw new Error('This task no longer exists. Return to the project to reload it.')
  }
  file.tasks = file.tasks.map((task) => (task.id === taskId ? updater(task) : task))
  const result = await window.api.saveProjectData(projectId, file, [note])
  if (!result.success) {
    throw new Error(result.error || 'The task change was not saved to disk. Try again.')
  }
}
