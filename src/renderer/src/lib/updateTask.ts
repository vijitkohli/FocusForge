import { LedgerNote, ProjectData, ProjectTask } from 'src/common/types'

/**
 * Single load-modify-save path for mutating one task within a project, with an
 * accompanying ledger note. Previously this read-whole-file → replace-this-task
 * → write-whole-file pattern was duplicated across TaskDetails (toggle, edit,
 * add, delete, deadline change) and FocusMode (complete-from-focus); routing
 * them all through here removes that duplication and gives a single place to
 * add concurrency safety later.
 *
 * `updater` receives the matching task and returns its replacement. If the task
 * isn't found the file is saved unchanged (the note still records the intent).
 */
export async function updateTask(
  projectId: string,
  taskId: string,
  updater: (task: ProjectTask) => ProjectTask,
  note: LedgerNote
): Promise<void> {
  const file: ProjectData = (await window.api.loadProjectData(projectId)) || { tasks: [] }
  file.tasks = (file.tasks ?? []).map((t) => (t.id === taskId ? updater(t) : t))
  await window.api.saveProjectData(projectId, file, [note])
}
