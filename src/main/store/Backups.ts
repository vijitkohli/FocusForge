import fs from 'fs-extra'
import path from 'path'
import {
  BACKUP_DIR,
  REGISTRY_PATH,
  SETTINGS_PATH,
  USER_PROFILE_PATH,
  ledgerPath,
  localDateKey,
  projectDataPath
} from './paths'

export const BACKUP_KEEP_DAYS = 14
const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/

async function copyIfPresent(source: string, target: string): Promise<void> {
  if (await fs.pathExists(source)) await fs.copy(source, target, { overwrite: false })
}

/**
 * Daily safety copies under system/backups/<YYYY-MM-DD>/. The first save of a
 * project on a given local day copies its files as they were BEFORE that save,
 * so each folder holds the state at the start of that day. Best-effort: a
 * failed backup is logged and never blocks the save it precedes.
 */
export class Backups {
  async snapshotBeforeSave(projectId: string, now = new Date()): Promise<void> {
    try {
      const day = path.join(BACKUP_DIR, localDateKey(now))
      const projectDir = path.join(day, projectId)
      if (!(await fs.pathExists(projectDir))) {
        await copyIfPresent(projectDataPath(projectId), path.join(projectDir, 'project_data.json'))
        await copyIfPresent(ledgerPath(projectId), path.join(projectDir, `context_${projectId}.md`))
        await fs.ensureDir(projectDir)
      }
      const systemDir = path.join(day, 'system')
      if (!(await fs.pathExists(systemDir))) {
        for (const file of [REGISTRY_PATH, USER_PROFILE_PATH, SETTINGS_PATH]) {
          await copyIfPresent(file, path.join(systemDir, path.basename(file)))
        }
        await fs.ensureDir(systemDir)
      }
    } catch (error) {
      console.error(`Backup before saving ${projectId} failed`, error)
    }
  }

  /** Removes day folders older than BACKUP_KEEP_DAYS (today counts as day 1). */
  async prune(now = new Date()): Promise<void> {
    try {
      if (!(await fs.pathExists(BACKUP_DIR))) return
      const cutoff = new Date(now)
      cutoff.setDate(cutoff.getDate() - (BACKUP_KEEP_DAYS - 1))
      const cutoffKey = localDateKey(cutoff)
      for (const name of await fs.readdir(BACKUP_DIR)) {
        if (DAY_FOLDER.test(name) && name < cutoffKey) await fs.remove(path.join(BACKUP_DIR, name))
      }
    } catch (error) {
      console.error('Pruning old backups failed', error)
    }
  }
}
