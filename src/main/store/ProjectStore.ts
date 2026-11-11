import fs from 'fs-extra'
import path from 'path'
import {
  LedgerNote,
  ProjectData,
  ProjectTask,
  SaveResult,
  Subtask,
  LEDGER_SECTIONS
} from '../../common/types'
import {
  ROOT_DIR,
  SYSTEM_DIR,
  REGISTRY_PATH,
  USER_PROFILE_PATH,
  ProjectSummary,
  projectDataPath,
  ledgerPath
} from './paths'
import { LedgerStore } from './LedgerStore'
import { emptyUserProfile } from './ProfileStore'
import { Backups } from './Backups'
import { withLock } from './locks'
import { writeFileAtomicSync, writeJsonAtomic, writeJsonAtomicSync } from './atomic'

export type { SaveResult }

/** Result of an in-lock mutation: the new data plus ledger notes, or null to skip saving. */
export type ProjectMutation = { data: ProjectData; notes?: LedgerNote[] } | null

function emptyLedgerContents(): string {
  return LEDGER_SECTIONS.map((section) => `## ${section}\n`).join('\n')
}

/**
 * Owns the project registry (master_index.json) and per-project
 * project_data.json files: creation, load/save, progress recompute, deletion,
 * and the nuclear reset. The ledger dependency is used only so a save can
 * append its accompanying notes in the same call (the data change and its
 * ledger record always happen together).
 */
export class ProjectStore {
  constructor(
    private ledger: LedgerStore,
    private backups: Backups = new Backups()
  ) {
    this.ensureSystemPaths()
  }

  /**
   * Build the root folders. Synchronous so the app can't try to load a folder
   * that doesn't exist yet.
   */
  ensureSystemPaths(): void {
    if (!fs.existsSync(ROOT_DIR)) fs.mkdirSync(ROOT_DIR)
    if (!fs.existsSync(SYSTEM_DIR)) fs.mkdirSync(SYSTEM_DIR)
    if (!fs.existsSync(REGISTRY_PATH)) writeJsonAtomicSync(REGISTRY_PATH, [])
    if (!fs.existsSync(USER_PROFILE_PATH))
      writeFileAtomicSync(USER_PROFILE_PATH, emptyUserProfile())
  }

  /**
   * Nuclear reset: removes the entire FlowState data directory and re-seeds it
   * to fresh-install state. ROOT_DIR is derived from app.getPath('documents'),
   * never user-supplied, so fs.remove is safe to call unconditionally.
   */
  async resetAllData(): Promise<{ success: boolean; error?: string }> {
    try {
      await fs.remove(ROOT_DIR)
      this.ensureSystemPaths()
      return { success: true }
    } catch (error) {
      console.error('Failed to reset all data:', error)
      return { success: false, error: (error as Error).message }
    }
  }

  async createProject(projectName: string): Promise<ProjectSummary> {
    // Replace anything that's not a letter or number with underscore
    const safeName = projectName.replace(/[^a-z0-9]/gi, '_')
    const projectPath = path.join(ROOT_DIR, safeName)

    fs.ensureDirSync(path.join(projectPath, 'sources'))
    fs.ensureDirSync(path.join(projectPath, '.db'))

    const initialData: ProjectData = {
      name: projectName,
      created: new Date().toISOString(),
      tasks: []
    }
    writeJsonAtomicSync(projectDataPath(safeName), initialData)
    writeFileAtomicSync(ledgerPath(safeName), emptyLedgerContents())

    const newSummary: ProjectSummary = {
      id: safeName,
      name: projectName,
      path: projectPath,
      progress: 0,
      lastActive: new Date().toISOString()
    }

    await withLock('registry', async () => {
      const registry: ProjectSummary[] = await fs.readJSON(REGISTRY_PATH)
      registry.push(newSummary)
      await writeJsonAtomic(REGISTRY_PATH, registry)
    })

    return newSummary
  }

  getProjects(): ProjectSummary[] {
    try {
      return fs.readJSONSync(REGISTRY_PATH)
    } catch {
      return []
    }
  }

  /**
   * Deletes a project entirely: its folder on disk (project_data.json, the
   * context ledger, sources, .db) and its entry in the registry.
   */
  async deleteProject(projectId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await withLock(`project:${projectId}`, async () => {
        await fs.remove(path.join(ROOT_DIR, projectId))
        await withLock('registry', async () => {
          const registry: ProjectSummary[] = await fs.readJSON(REGISTRY_PATH)
          await writeJsonAtomic(
            REGISTRY_PATH,
            registry.filter((p) => p.id !== projectId)
          )
        })
      })
      return { success: true }
    } catch (error) {
      console.error(`Failed to delete project ${projectId}:`, error)
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * Deletes a single task from a project's data file, then recomputes progress
   * the same way a normal save would.
   */
  async deleteTask(projectId: string, taskId: string): Promise<SaveResult> {
    try {
      const result = await this.updateProjectData(projectId, async (data) => ({
        data: { ...data, tasks: (data.tasks ?? []).filter((t) => t.id !== taskId) }
      }))
      return result ?? { success: false, error: 'Project not found' }
    } catch (error) {
      console.error(`Failed to delete task ${taskId} from ${projectId}:`, error)
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * Saves the entire state of a project. Optional `notes` describe *why* the
   * save happened so the same call appends matching entries to the project's
   * context ledger — the data change and its ledger record always happen
   * together. With `expectedRev`, the save is refused (`conflict: true`) if
   * another write landed since the caller loaded the data; callers reload and
   * re-apply their change. Every save bumps `rev`.
   */
  saveProjectData(
    projectId: string,
    data: ProjectData,
    notes?: LedgerNote[],
    expectedRev?: number
  ): Promise<SaveResult> {
    return withLock(`project:${projectId}`, async () => {
      try {
        if (expectedRev !== undefined) {
          const current = await this.loadProjectData(projectId)
          if ((current?.rev ?? 0) !== expectedRev) {
            return {
              success: false,
              conflict: true,
              error: 'This project changed while you were editing. Try again.'
            }
          }
        }
        return await this.writeUnlocked(projectId, data, notes)
      } catch (error) {
        console.error(`Failed to save project ${projectId}:`, error)
        return { success: false, error: (error as Error).message }
      }
    })
  }

  /**
   * Load → mutate → save under the project lock, for main-process changes
   * (AI plan merges, splits, deletes) that must not interleave with renderer
   * saves. Resolves null when the project doesn't exist or `mutate` returns null.
   */
  updateProjectData(
    projectId: string,
    mutate: (data: ProjectData) => Promise<ProjectMutation>
  ): Promise<SaveResult | null> {
    return withLock(`project:${projectId}`, async () => {
      const data = await this.loadProjectData(projectId)
      if (!data) return null
      const change = await mutate(data)
      if (!change) return null
      try {
        return await this.writeUnlocked(projectId, change.data, change.notes)
      } catch (error) {
        console.error(`Failed to save project ${projectId}:`, error)
        return { success: false, error: (error as Error).message }
      }
    })
  }

  /** Caller holds `project:<id>`. */
  private async writeUnlocked(
    projectId: string,
    data: ProjectData,
    notes?: LedgerNote[]
  ): Promise<SaveResult> {
    await this.backups.snapshotBeforeSave(projectId)
    const current = await this.loadProjectData(projectId)
    const rev = (current?.rev ?? 0) + 1
    await writeJsonAtomic(projectDataPath(projectId), { ...data, rev })
    await this.updateProjectProgress(projectId, data)
    if (notes && notes.length > 0) {
      await this.ledger.appendLedgerNotes(projectId, notes)
    }
    return { success: true, rev }
  }

  /** Loads the full project data structure, or null if it doesn't exist. */
  async loadProjectData(projectId: string): Promise<ProjectData | null> {
    const filePath = projectDataPath(projectId)
    try {
      if (!(await fs.pathExists(filePath))) return null
      return await fs.readJSON(filePath)
    } catch (error) {
      console.error(`Failed to load project ${projectId}:`, error)
      return null
    }
  }

  /**
   * Recalculates a project's completion progress from its subtasks and syncs it
   * (plus lastActive) into the registry.
   */
  private async updateProjectProgress(projectId: string, data: ProjectData): Promise<void> {
    const tasks = data?.tasks ?? []
    const allSubtasks: Subtask[] = tasks.flatMap((t: ProjectTask) => t.subtasks ?? [])
    const progress =
      allSubtasks.length === 0
        ? 0
        : Math.round((allSubtasks.filter((s) => s.isCompleted).length / allSubtasks.length) * 100)

    await withLock('registry', async () => {
      const registry: ProjectSummary[] = await fs.readJSON(REGISTRY_PATH)
      const entry = registry.find((p) => p.id === projectId)
      if (!entry) return

      entry.progress = progress
      entry.lastActive = new Date().toISOString()
      await writeJsonAtomic(REGISTRY_PATH, registry)
    })
  }
}
