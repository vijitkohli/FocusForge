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
/** Today's skips, starts and background-plan count. Resets each local day. */
export const WHATNEXT_PATH = path.join(SYSTEM_DIR, 'whatnext.json')
/** Append-only skip log (ids and features only, no titles). Pruned to 180 days. */
export const SKIPS_LOG_PATH = path.join(SYSTEM_DIR, 'skips.jsonl')
export const REVIEWS_DIR = path.join(SYSTEM_DIR, 'reviews')
export const DISCOVERY_PATH = path.join(SYSTEM_DIR, 'discovery.json')

/** Absolute path to a project's data file. */
export function projectDataPath(projectId: string): string {
  return path.join(ROOT_DIR, projectId, 'project_data.json')
}

/** Absolute path to a project's context ledger (context_<projectId>.md). */
export function ledgerPath(projectId: string): string {
  return path.join(ROOT_DIR, projectId, `context_${projectId}.md`)
}

/** Phase 3 reader state for one item (pack, digest, history). Removed with the item folder. */
export function readerDir(projectId: string): string {
  return path.join(ROOT_DIR, projectId, 'reader')
}
export const packPath = (projectId: string): string => path.join(readerDir(projectId), 'pack.json')
export const digestPath = (projectId: string): string =>
  path.join(readerDir(projectId), 'digest.json')
/** The last few digests, for comparison (newest 5 kept). */
export const digestHistoryDir = (projectId: string): string =>
  path.join(readerDir(projectId), 'digests')
/** Extracted PDF/docx text keyed by a hash of the folded path. */
export const DOCTEXT_CACHE_DIR = path.join(SYSTEM_DIR, 'cache', 'doctext')

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
