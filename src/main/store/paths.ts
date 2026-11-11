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
export const SETTINGS_PATH = path.join(SYSTEM_DIR, 'settings.json')
export const BACKUP_DIR = path.join(SYSTEM_DIR, 'backups')
export const TODAY_PLAN_PATH = path.join(SYSTEM_DIR, 'today.json')
export const REVIEWS_DIR = path.join(SYSTEM_DIR, 'reviews')

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

export type { ProjectSummary } from '../../common/types'

/** Local-time 'YYYY-MM-DD' for a date (so day-bucketing matches the user's calendar). */
export function localDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Parses a deadline/scheduledDate as LOCAL midnight. `new Date('YYYY-MM-DD')`
 * is UTC midnight, which lands on the previous local day west of UTC.
 */
export function parseLocalDate(value: string): Date {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value)
  d.setHours(0, 0, 0, 0)
  return d
}
