import fs from 'fs-extra'
import path from 'path'
import {
  LedgerNote,
  ProjectData,
  ProjectTask,
  SaveResult,
  Subtask,
  Workstream,
  WorkstreamPatch,
  LEDGER_SECTIONS
} from '../../common/types'
import {
  sanitizeWorkstreamPatch,
  uniqueProjectId,
  withWorkstreamDefaults
} from '../../common/workstreams'
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
import { hasMilestones, milestoneMinutes } from '../../common/milestones'

export type { SaveResult }

export type WorkstreamOp =
  | { op: 'create'; fields: WorkstreamPatch & { name: string } }
  | { op: 'update'; id: string; patch: WorkstreamPatch }

export interface ApplyWorkstreamsResult {
  created: string[]
  updated: string[]
  failed: string[]
}

/** Result of an in-lock mutation: the new data plus ledger notes, or null to skip saving. */
export type ProjectMutation = { data: ProjectData; notes?: LedgerNote[] } | null

/**
 * Who made a save. Only 'vault' exists today (Phase 4 tick read-back), so a
 * listener can skip writing back what it just read. Distinct from ProjectTask.origin.
 */
export interface SaveTag {
  by?: 'vault'
}

/** Called after every successful project save, outside the project lock. */
export type SavedListener = (projectId: string, data: ProjectData, tag: SaveTag) => void

/** What happened to a registry entry (create, item-field update, delete). */
export type RegistryChange = 'created' | 'updated' | 'deleted'

/** Called after a registry change, outside the registry lock. */
export type RegistryListener = (projectId: string, kind: RegistryChange) => void

/**
 * Project completion 0–100. Old tasks count steps (done / total over all of
 * them, as before); tasks with milestones count minutes of the whole job, so a
 * plan with only its first part expanded doesn't look half done.
 */
export function projectProgress(tasks: ProjectTask[]): number {
  if (!tasks.some((t) => hasMilestones(t))) {
    const allSubtasks: Subtask[] = tasks.flatMap((t: ProjectTask) => t.subtasks ?? [])
    return allSubtasks.length === 0
      ? 0
      : Math.round((allSubtasks.filter((s) => s.isCompleted).length / allSubtasks.length) * 100)
  }
  let total = 0
  let done = 0
  for (const t of tasks) {
    if (hasMilestones(t)) {
      const m = milestoneMinutes(t)
      total += m.total
      done += m.done
    } else {
      for (const s of t.subtasks ?? []) {
        const mins = s.timeEstimate ?? 15
        total += mins
        if (s.isCompleted) done += mins
      }
    }
  }
  return total > 0 ? Math.round((done / total) * 100) : 0
}

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
  private savedListeners: SavedListener[] = []
  private registryListeners: RegistryListener[] = []

  constructor(
    private ledger: LedgerStore,
    private backups: Backups = new Backups()
  ) {
    this.ensureSystemPaths()
  }

  /**
   * Shared save hook (SYNC_PLAN contract 10): one listener list for every
   * consumer (Phase 5 rolling expansion, Phase 4 vault notes). Returns an
   * unsubscribe function.
   */
  onSaved(listener: SavedListener): () => void {
    this.savedListeners.push(listener)
    return () => {
      this.savedListeners = this.savedListeners.filter((l) => l !== listener)
    }
  }

  private emitSaved(projectId: string, data: ProjectData, tag: SaveTag): void {
    if (this.savedListeners.length === 0) return
    const listeners = [...this.savedListeners]
    // Outside the project lock, so a listener may save again.
    queueMicrotask(() => {
      for (const l of listeners) {
        try {
          l(projectId, data, tag)
        } catch (err) {
          console.error('Save listener failed', err)
        }
      }
    })
  }

  /**
   * Registry hook (Phase 4): fires after an item is created, its item fields
   * change (name, category, kind, status, sources) or it is deleted. Progress
   * and activity bumps don't fire it (a save already did), and neither does
   * setVaultNote. Returns an unsubscribe function.
   */
  onRegistryChanged(listener: RegistryListener): () => void {
    this.registryListeners.push(listener)
    return () => {
      this.registryListeners = this.registryListeners.filter((l) => l !== listener)
    }
  }

  private emitRegistry(projectId: string, kind: RegistryChange): void {
    if (this.registryListeners.length === 0) return
    const listeners = [...this.registryListeners]
    queueMicrotask(() => {
      for (const l of listeners) {
        try {
          l(projectId, kind)
        } catch (err) {
          console.error('Registry listener failed', err)
        }
      }
    })
  }

  /**
   * Records (or clears, with null) the vault-relative path of an item's note
   * (Phase 4), under the registry lock. Doesn't fire onRegistryChanged.
   */
  async setVaultNote(projectId: string, rel: string | null): Promise<boolean> {
    return withLock('registry', async () => {
      const registry: ProjectSummary[] = await fs.readJSON(REGISTRY_PATH)
      const entry = registry.find((p) => p.id === projectId)
      if (!entry) return false
      if ((entry.vaultNote ?? null) === rel) return true
      if (rel === null) delete entry.vaultNote
      else entry.vaultNote = rel
      await writeJsonAtomic(REGISTRY_PATH, registry)
      return true
    })
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

  /**
   * Creates a project (item). The id is unique against the registry and any
   * existing folder, so a second "Thesis" gets `Thesis_2` instead of
   * overwriting the first. `fields` are the item fields to store explicitly;
   * anything left out is filled by withWorkstreamDefaults on read.
   */
  async createProject(projectName: string, fields: WorkstreamPatch = {}): Promise<Workstream> {
    const patch = sanitizeWorkstreamPatch(fields)
    const name = (typeof projectName === 'string' && projectName.trim()) || patch.name || 'Untitled'

    const summary = await withLock('registry', async () => {
      const registry: ProjectSummary[] = await fs.readJSON(REGISTRY_PATH)
      const taken = new Set(registry.map((p) => p.id))
      let id = uniqueProjectId(name, taken)
      while (fs.existsSync(path.join(ROOT_DIR, id))) {
        taken.add(id)
        id = uniqueProjectId(name, taken)
      }
      const projectPath = path.join(ROOT_DIR, id)

      fs.ensureDirSync(path.join(projectPath, 'sources'))
      fs.ensureDirSync(path.join(projectPath, '.db'))
      const initialData: ProjectData = {
        name,
        created: new Date().toISOString(),
        tasks: []
      }
      writeJsonAtomicSync(projectDataPath(id), initialData)
      writeFileAtomicSync(ledgerPath(id), emptyLedgerContents())

      const newSummary: ProjectSummary = {
        id,
        name,
        path: projectPath,
        progress: 0,
        lastActive: new Date().toISOString(),
        ...(patch.category ? { category: patch.category } : {}),
        ...(patch.kind ? { kind: patch.kind } : {}),
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.sources ? { sources: patch.sources } : {})
      }
      registry.push(newSummary)
      await writeJsonAtomic(REGISTRY_PATH, registry)
      return newSummary
    })

    this.emitRegistry(summary.id, 'created')
    return withWorkstreamDefaults(summary)
  }

  /** Registry entries with the item fields filled in. The file itself is not rewritten. */
  getProjects(): Workstream[] {
    try {
      const registry = fs.readJSONSync(REGISTRY_PATH)
      return Array.isArray(registry) ? registry.map(withWorkstreamDefaults) : []
    } catch {
      return []
    }
  }

  /** Registry entries exactly as stored (discovery tells saved fields from defaults). */
  getRegistryEntries(): ProjectSummary[] {
    try {
      const registry = fs.readJSONSync(REGISTRY_PATH)
      return Array.isArray(registry) ? registry : []
    } catch {
      return []
    }
  }

  /**
   * Patches only the item fields present in `patch`, under the registry lock.
   * Sources must already have passed the guard (the IPC layer checks them).
   * A rename also updates project_data.json's name (bumping its rev), outside
   * the registry lock to respect lock order.
   */
  async updateWorkstream(
    projectId: string,
    rawPatch: WorkstreamPatch
  ): Promise<{ success: boolean; error?: string }> {
    const patch = sanitizeWorkstreamPatch(rawPatch)
    let renamed = false
    try {
      const found = await withLock('registry', async () => {
        const registry: ProjectSummary[] = await fs.readJSON(REGISTRY_PATH)
        const entry = registry.find((p) => p.id === projectId)
        if (!entry) return false
        if (patch.name !== undefined && patch.name !== entry.name) {
          entry.name = patch.name
          renamed = true
        }
        if (patch.category !== undefined) entry.category = patch.category
        if (patch.kind !== undefined) entry.kind = patch.kind
        if (patch.status !== undefined) entry.status = patch.status
        if (patch.sources !== undefined) entry.sources = patch.sources
        await writeJsonAtomic(REGISTRY_PATH, registry)
        return true
      })
      if (!found) return { success: false, error: 'not-found' }
      if (renamed && patch.name) {
        const name = patch.name
        await this.updateProjectData(projectId, async (data) =>
          data.name === name ? null : { data: { ...data, name } }
        )
      }
      this.emitRegistry(projectId, 'updated')
      return { success: true }
    } catch (error) {
      console.error(`Failed to update item ${projectId}:`, error)
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * Records the newest change seen in an item's sources (Phase 3 readers).
   * Only ever moves the date forward; under the registry lock.
   */
  async setSourceActivity(projectId: string, iso: string): Promise<void> {
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) return
    const next = new Date(t).toISOString()
    await withLock('registry', async () => {
      const registry: ProjectSummary[] = await fs.readJSON(REGISTRY_PATH)
      const entry = registry.find((p) => p.id === projectId)
      if (!entry) return
      const cur = entry.sourceActivityAt ? Date.parse(entry.sourceActivityAt) : NaN
      if (Number.isFinite(cur) && cur >= t) return
      entry.sourceActivityAt = next
      await writeJsonAtomic(REGISTRY_PATH, registry)
    })
  }

  /**
   * Applies an approved batch: creates run one by one, updates patch only the
   * given keys. Nothing is ever deleted here.
   */
  async applyWorkstreams(ops: WorkstreamOp[]): Promise<ApplyWorkstreamsResult> {
    const result: ApplyWorkstreamsResult = { created: [], updated: [], failed: [] }
    for (const op of ops) {
      try {
        if (op.op === 'create') {
          const ws = await this.createProject(op.fields.name ?? '', op.fields)
          result.created.push(ws.id)
        } else {
          const r = await this.updateWorkstream(op.id, op.patch)
          if (r.success) result.updated.push(op.id)
          else result.failed.push(op.id)
        }
      } catch (error) {
        console.error('Failed to apply an item change:', error)
        result.failed.push(op.op === 'create' ? (op.fields.name ?? '') : op.id)
      }
    }
    return result
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
      this.emitRegistry(projectId, 'deleted')
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
    expectedRev?: number,
    tag: SaveTag = {}
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
        return await this.writeUnlocked(projectId, data, notes, tag)
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
    mutate: (data: ProjectData) => Promise<ProjectMutation>,
    tag: SaveTag = {}
  ): Promise<SaveResult | null> {
    return withLock(`project:${projectId}`, async () => {
      const data = await this.loadProjectData(projectId)
      if (!data) return null
      const change = await mutate(data)
      if (!change) return null
      try {
        return await this.writeUnlocked(projectId, change.data, change.notes, tag)
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
    notes?: LedgerNote[],
    tag: SaveTag = {}
  ): Promise<SaveResult> {
    await this.backups.snapshotBeforeSave(projectId)
    const current = await this.loadProjectData(projectId)
    const rev = (current?.rev ?? 0) + 1
    await writeJsonAtomic(projectDataPath(projectId), { ...data, rev })
    await this.updateProjectProgress(projectId, data)
    if (notes && notes.length > 0) {
      await this.ledger.appendLedgerNotes(projectId, notes)
    }
    this.emitSaved(projectId, { ...data, rev }, tag)
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
    const progress = projectProgress(data?.tasks ?? [])

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
