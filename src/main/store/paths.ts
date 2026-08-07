import { app } from 'electron'
import path from 'path'

/**
 * On-disk layout for all FlowState data. Everything lives under the user's
 * Documents folder; the path is derived from app.getPath('documents') and is
 * never user-supplied, so destructive ops (fs.remove) are safe to call.
 */
export const ROOT_DIR = path.join(app.getPath('documents'), 'FlowState')
export const SYSTEM_DIR = path.join(ROOT_DIR, 'system')
export const REGISTRY_PATH = path.join(SYSTEM_DIR, 'master_index.json')
export const NUDGE_LOG_PATH = path.join(SYSTEM_DIR, 'nudges.json')
export const USER_PROFILE_PATH = path.join(SYSTEM_DIR, 'user_profile.md')

/** Absolute path to a project's data file. */
export function projectDataPath(projectId: string): string {
  return path.join(ROOT_DIR, projectId, 'project_data.json')
}

/** Absolute path to a project's context ledger (context_<projectId>.md). */
export function ledgerPath(projectId: string): string {
  return path.join(ROOT_DIR, projectId, `context_${projectId}.md`)
}

/** Legacy ledger filename (pre per-project rename), migrated in place on read. */
export function legacyLedgerPath(projectId: string): string {
  return path.join(ROOT_DIR, projectId, 'context.md')
}

/** Registry entry: the summarized project record kept in master_index.json. */
export interface ProjectSummary {
  id: string
  name: string
  path: string
  progress: number
  lastActive: string
}

/** Local-time 'YYYY-MM-DD' for a date (so day-bucketing matches the user's calendar). */
export function localDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
