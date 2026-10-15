import type { LedgerNote, ProjectData } from 'src/common/types'

const MAX_ATTEMPTS = 3

/**
 * Load → change → save for one project, safe against concurrent writes: the
 * save carries the `rev` that was loaded, and when another write landed in
 * between (a tick during an AI adjustment, two quick edits) the main process
 * refuses it, so the change is re-applied to the fresh file. `change` must be
 * a pure function of the loaded data because it may run more than once.
 */
export async function mutateProject(
  projectId: string,
  change: (data: ProjectData) => ProjectData,
  notes?: LedgerNote[],
  failureMessage = 'The change was not saved to disk. Try again.'
): Promise<ProjectData> {
  for (let attempt = 1; ; attempt++) {
    const file = await window.api.loadProjectData(projectId)
    if (!file)
      throw new Error('The project could not be loaded. Return to the project to reload it.')
    const next = change(file)
    const result = await window.api.saveProjectData(projectId, next, notes, file.rev ?? 0)
    if (result.success) return { ...next, rev: result.rev }
    if (!result.conflict || attempt >= MAX_ATTEMPTS) {
      throw new Error(result.error || failureMessage)
    }
  }
}
