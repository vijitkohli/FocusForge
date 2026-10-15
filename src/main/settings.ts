import fs from 'fs-extra'
import { AppSettings, DEFAULT_SETTINGS } from '../common/models'
import { SETTINGS_PATH } from './store/paths'
import { writeJsonAtomic } from './store/atomic'
import { withLock } from './store/locks'

/** Reads settings, filling any missing/invalid field from DEFAULT_SETTINGS. */
export async function loadSettings(): Promise<AppSettings> {
  try {
    if (!(await fs.pathExists(SETTINGS_PATH))) return { ...DEFAULT_SETTINGS }
    const raw = await fs.readJSON(SETTINGS_PATH)
    return {
      chatModel:
        typeof raw.chatModel === 'string' && raw.chatModel
          ? raw.chatModel
          : DEFAULT_SETTINGS.chatModel,
      planModel: typeof raw.planModel === 'string' ? raw.planModel : DEFAULT_SETTINGS.planModel,
      aiNudges: typeof raw.aiNudges === 'boolean' ? raw.aiNudges : DEFAULT_SETTINGS.aiNudges,
      weeklyReview:
        typeof raw.weeklyReview === 'boolean' ? raw.weeklyReview : DEFAULT_SETTINGS.weeklyReview
    }
  } catch (error) {
    console.error('Failed to read settings, using defaults', error)
    return { ...DEFAULT_SETTINGS }
  }
}

/** Merges a partial update into the stored settings and returns the result. */
export function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return withLock('settings', async () => {
    const next = { ...(await loadSettings()), ...patch }
    await writeJsonAtomic(SETTINGS_PATH, next)
    return next
  })
}
