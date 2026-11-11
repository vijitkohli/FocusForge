// src/main/sources/discoveryCache.ts
// system/discovery.json: the last discovery result (paths only, never file
// contents, never anything the guard denies) plus the hidden suggestion keys.
// The file path is passed in so this stays electron-free and testable.
import fs from 'fs-extra'
import type { DiscoveryResult } from '../../common/discovery'
import { writeJsonAtomic } from '../store/atomic'
import { withLock } from '../store/locks'

export interface DiscoveryCacheFile {
  version: 1
  ranAt: string | null
  result: DiscoveryResult | null
  dismissedKeys: string[]
}

const EMPTY: DiscoveryCacheFile = { version: 1, ranAt: null, result: null, dismissedKeys: [] }

function normalize(raw: unknown): DiscoveryCacheFile {
  if (!raw || typeof raw !== 'object') return { ...EMPTY, dismissedKeys: [] }
  const r = raw as Record<string, unknown>
  const result =
    r.result &&
    typeof r.result === 'object' &&
    Array.isArray((r.result as DiscoveryResult).candidates)
      ? (r.result as DiscoveryResult)
      : null
  return {
    version: 1,
    ranAt: typeof r.ranAt === 'string' ? r.ranAt : null,
    result,
    dismissedKeys: Array.isArray(r.dismissedKeys)
      ? r.dismissedKeys.filter((k): k is string => typeof k === 'string')
      : []
  }
}

export async function readDiscoveryCache(file: string): Promise<DiscoveryCacheFile> {
  try {
    if (!(await fs.pathExists(file))) return { ...EMPTY, dismissedKeys: [] }
    return normalize(await fs.readJSON(file))
  } catch {
    return { ...EMPTY, dismissedKeys: [] }
  }
}

/** Stores a fresh result, keeping the dismissed keys already on disk. */
export function writeDiscoveryResult(file: string, result: DiscoveryResult): Promise<void> {
  return withLock('discovery', async () => {
    const current = await readDiscoveryCache(file)
    const next: DiscoveryCacheFile = {
      version: 1,
      ranAt: result.ranAt,
      result: { ...result, dismissedKeys: current.dismissedKeys },
      dismissedKeys: current.dismissedKeys
    }
    await writeJsonAtomic(file, next)
  })
}

/** Replaces the hidden suggestion keys. */
export function saveDismissedKeys(file: string, keys: string[]): Promise<void> {
  return withLock('discovery', async () => {
    const current = await readDiscoveryCache(file)
    const dismissedKeys = [...new Set(keys.filter((k) => typeof k === 'string' && k))]
    await writeJsonAtomic(file, {
      ...current,
      result: current.result ? { ...current.result, dismissedKeys } : null,
      dismissedKeys
    })
  })
}
