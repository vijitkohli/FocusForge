import type { LedgerNote, ProjectTask } from 'src/common/types'
import { updateTask } from '../../lib/updateTask'

export type TaskChange = (task: ProjectTask) => ProjectTask

/** Read back the saved task to verify it matches the intended change. */
export async function persistTaskChange(
  projectId: string,
  taskId: string,
  change: TaskChange,
  note: LedgerNote
): Promise<ProjectTask> {
  let expected: ProjectTask | undefined
  await updateTask(
    projectId,
    taskId,
    (current) => {
      expected = change(current)
      return expected
    },
    note
  )
  if (!expected) throw new Error('This task no longer exists. Return to the project to reload it.')
  const project = await window.api.loadProjectData(projectId)
  const saved = project?.tasks.find((task) => task.id === taskId)
  if (!saved || JSON.stringify(saved) !== JSON.stringify(expected)) {
    throw new Error('The task change was not saved to disk. Try again.')
  }
  return saved
}
