import fs from 'fs-extra'
import { AppSettings, DEFAULT_SETTINGS, SourceRoot } from '../common/models'
import { SETTINGS_PATH } from './store/paths'
import { writeJsonAtomic } from './store/atomic'
import { withLock } from './store/locks'
import { isScannableVaultCategory } from './sources/rules'

/** A fresh copy of the defaults (no shared arrays). */
export function defaultSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    sourceRoots: DEFAULT_SETTINGS.sourceRoots.map((r) => ({ ...r })),
    vaultCategories: [...DEFAULT_SETTINGS.vaultCategories],
    initialActiveKeys: [...DEFAULT_SETTINGS.initialActiveKeys]
  }
}

const ROOT_CATEGORIES = new Set(['Learning', 'Career', 'Projects'])

/** Every entry must be `{ path: non-empty string, category: Learning|Career|Projects }`, else defaults. */
function validSourceRoots(raw: unknown): SourceRoot[] | null {
  if (!Array.isArray(raw)) return null
  const out: SourceRoot[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') return null
    const { path, category } = r as Record<string, unknown>
    if (typeof path !== 'string' || !path.trim() || path.includes('\0')) return null
    if (typeof category !== 'string' || !ROOT_CATEGORIES.has(category)) return null
    out.push({ path: path.trim(), category: category as SourceRoot['category'] })
  }
  return out
}

/**
 * Top-level vault folder names to scan. Life (any case, iCloud copies) is
 * stripped as a second line of defence behind the guard, as are the app's own
 * folder, Obsidian config and anything that isn't a single plain folder name.
 */
export function cleanVaultCategories(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const names = raw.filter((x): x is string => typeof x === 'string').map((x) => x.trim())
  return [...new Set(names.filter(isScannableVaultCategory))]
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

/** Validates a parsed settings.json, filling any missing/invalid field from the defaults. */
export function normalizeSettings(raw: unknown): AppSettings {
  const d = defaultSettings()
  if (!raw || typeof raw !== 'object') return d
  const r = raw as Record<string, unknown>
  return {
    chatModel: typeof r.chatModel === 'string' && r.chatModel ? r.chatModel : d.chatModel,
    planModel: typeof r.planModel === 'string' ? r.planModel : d.planModel,
    aiNudges: typeof r.aiNudges === 'boolean' ? r.aiNudges : d.aiNudges,
    weeklyReview: typeof r.weeklyReview === 'boolean' ? r.weeklyReview : d.weeklyReview,
    vaultPath:
      typeof r.vaultPath === 'string' && !r.vaultPath.includes('\0')
        ? r.vaultPath.trim()
        : d.vaultPath,
    sourceRoots: validSourceRoots(r.sourceRoots) ?? d.sourceRoots,
    vaultCategories: cleanVaultCategories(r.vaultCategories) ?? d.vaultCategories,
    initialActiveKeys: Array.isArray(r.initialActiveKeys)
      ? r.initialActiveKeys
          .filter((x): x is string => typeof x === 'string')
          .map((x) =>
            x
              .normalize('NFC')
              .toLowerCase()
              .replace(/[^a-z0-9]/g, '')
          )
          .filter(Boolean)
      : d.initialActiveKeys,
    discoveryCompletedAt: stringOrNull(r.discoveryCompletedAt),
    discoveryDismissedAt: stringOrNull(r.discoveryDismissedAt),
    vaultNotes: typeof r.vaultNotes === 'boolean' ? r.vaultNotes : d.vaultNotes,
    digestModel:
      typeof r.digestModel === 'string' && r.digestModel.trim() && !r.digestModel.includes('\0')
        ? r.digestModel.trim()
        : d.digestModel,
    readersEnabled: typeof r.readersEnabled === 'boolean' ? r.readersEnabled : d.readersEnabled
  }
}

/** Reads settings, filling any missing/invalid field from DEFAULT_SETTINGS. */
export async function loadSettings(): Promise<AppSettings> {
  try {
    if (!(await fs.pathExists(SETTINGS_PATH))) return defaultSettings()
    return normalizeSettings(await fs.readJSON(SETTINGS_PATH))
  } catch (error) {
    console.error('Failed to read settings, using defaults', error)
    return defaultSettings()
  }
}

/** Settings a renderer patch may never change: they decide what FocusForge can read. */
const MAIN_ONLY_KEYS = ['vaultPath', 'sourceRoots', 'vaultCategories'] as const

/** Drops access-widening keys from an untrusted (renderer) settings patch. */
export function sanitizeRendererSettingsPatch(patch: unknown): Partial<AppSettings> {
  if (!patch || typeof patch !== 'object') return {}
  const out = { ...(patch as Record<string, unknown>) }
  for (const k of MAIN_ONLY_KEYS) delete out[k]
  // A malformed toggle would normalise to the default (on): keep the stored value instead.
  if ('vaultNotes' in out && typeof out.vaultNotes !== 'boolean') delete out.vaultNotes
  return out as Partial<AppSettings>
}

/** Merges a partial update into the stored settings and returns the result. */
export function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return withLock('settings', async () => {
    const next = normalizeSettings({ ...(await loadSettings()), ...patch })
    await writeJsonAtomic(SETTINGS_PATH, next)
    return next
  })
}
