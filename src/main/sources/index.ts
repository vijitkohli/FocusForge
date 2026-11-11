// src/main/sources/index.ts
// Electron-side wiring for the guard and discovery. Every reader of the
// owner's folders or vault (discovery now, pack/watch later) gets its guard
// from getGuard(). save-settings and vault changes call invalidateGuard().
import { app } from 'electron'
import os from 'os'
import type { AppSettings } from '../../common/models'
import type { DiscoveryCandidate, DiscoveryResult, VaultInfo } from '../../common/discovery'
import type { ProjectSummary } from '../../common/types'
import { loadSettings } from '../settings'
import { DISCOVERY_PATH, ROOT_DIR } from '../store/paths'
import { PathGuard } from './guard'
import { detectVault, readObsidianVaults } from './vault'
import { buildGuardConfig, discoverRoots } from './config'
import { discover, scanSource, type DiscoverRootInput } from './discover'
import { readDiscoveryCache, writeDiscoveryResult } from './discoveryCache'

export interface SourceContext {
  guard: PathGuard
  settings: AppSettings
  vault: VaultInfo
  roots: DiscoverRootInput[]
}

let cached: Promise<SourceContext> | null = null

async function buildContext(): Promise<SourceContext> {
  const home = os.homedir()
  const settings = await loadSettings()
  // obsidian.json is read even when vaultPath is set: every listed vault's
  // Life folder is denied, not only the configured one.
  const obsidianVaults = await readObsidianVaults(app.getPath('appData'))
  const vault = await detectVault(settings, obsidianVaults, undefined, home)
  const guard = new PathGuard(
    buildGuardConfig({ settings, obsidianVaults, vault, home, writableRoots: [ROOT_DIR] })
  )
  return { guard, settings, vault, roots: discoverRoots(settings, home) }
}

/** Guard, settings, vault and roots, built once and cached until invalidated. */
export function getSourceContext(): Promise<SourceContext> {
  if (!cached) {
    cached = buildContext()
    cached.catch(() => {
      cached = null
    })
  }
  return cached
}

export async function getGuard(): Promise<PathGuard> {
  return (await getSourceContext()).guard
}

/** Call after any settings change that can affect what is readable. */
export function invalidateGuard(): void {
  cached = null
}

/** Runs discovery against the current settings and stores the result in discovery.json. */
export async function runDiscovery(
  registry: ProjectSummary[],
  signal?: AbortSignal
): Promise<DiscoveryResult> {
  const ctx = await getSourceContext()
  const cache = await readDiscoveryCache(DISCOVERY_PATH)
  const result = await discover({
    guard: ctx.guard,
    sourceRoots: ctx.roots,
    vault: ctx.vault,
    vaultCategories: ctx.settings.vaultCategories,
    initialActiveKeys: ctx.settings.initialActiveKeys,
    registry,
    dismissedKeys: cache.dismissedKeys,
    firstRun: ctx.settings.discoveryCompletedAt === null,
    signal
  })
  await writeDiscoveryResult(DISCOVERY_PATH, result)
  return result
}

/** "Add a folder or note" for one picked path. */
export async function scanPickedSource(
  absPath: string
): Promise<{ candidate: DiscoveryCandidate } | { error: string }> {
  const ctx = await getSourceContext()
  return scanSource(ctx.guard, absPath, { roots: ctx.roots, vault: ctx.vault })
}
