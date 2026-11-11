import type { LedgerNote, ProjectTask } from 'src/common/types'
import { mutateProject } from './mutateProject'

/**
 * Single load-modify-save path for mutating one task within a project, with an
 * accompanying ledger note. Every task edit (toggle, edit, add, delete,
 * deadline change, complete-from-focus) routes through here; concurrency
 * safety comes from mutateProject's revision check and retry.
 *
 * `updater` receives the matching task and returns its replacement. It may run
 * more than once if a concurrent save forces a retry. Missing projects/tasks
 * and failed saves reject, without recording a successful change.
 */
export async function updateTask(
  projectId: string,
  taskId: string,
  updater: (task: ProjectTask) => ProjectTask,
  note?: LedgerNote
): Promise<void> {
  await mutateProject(
    projectId,
    (file) => {
      if (!(file.tasks ?? []).some((task) => task.id === taskId)) {
        throw new Error('This task no longer exists. Return to the project to reload it.')
      }
      return {
        ...file,
        tasks: file.tasks.map((task) => (task.id === taskId ? updater(task) : task))
      }
    },
    note ? [note] : undefined,
    'The task change was not saved to disk. Try again.'
  )
}
