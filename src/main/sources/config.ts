// src/main/sources/config.ts
// Settings + obsidian.json -> guard config and discovery roots. Pure.
import path from 'path'
import type { AppSettings } from '../../common/models'
import type { VaultInfo } from '../../common/discovery'
import { expandHome, type GuardConfig } from './guard'
import { LIFE_ALLOWLIST } from './rules'
import type { ObsidianVault } from './vault'
import type { DiscoverRootInput } from './discover'

/** The filesystem root, the home folder and anything above it are never readable roots. */
export function isTooBroad(p: string, home: string): boolean {
  const r = path.resolve(p)
  const h = path.resolve(home)
  return path.parse(r).root === r || r === h || h.startsWith(r + path.sep)
}

/** settings.sourceRoots, ~-expanded; relative or too-broad entries are dropped. */
export function discoverRoots(settings: AppSettings, home: string): DiscoverRootInput[] {
  return settings.sourceRoots
    .map((r) => ({
      path: path.resolve(expandHome(r.path, home)),
      label: r.path,
      category: r.category
    }))
    .filter((r) => path.isAbsolute(expandHome(r.label, home)) && !isTooBroad(r.path, home))
}

export function buildGuardConfig(input: {
  settings: AppSettings
  obsidianVaults: ObsidianVault[]
  vault: VaultInfo
  home: string
  writableRoots: string[]
}): GuardConfig {
  const { settings, obsidianVaults, vault, home } = input
  const configured = settings.vaultPath ? expandHome(settings.vaultPath, home) : ''
  const denyLife = [
    ...obsidianVaults.map((v) => v.path),
    ...(configured && path.isAbsolute(configured) ? [configured] : []),
    ...(vault.path ? [vault.path] : []),
    ...vault.others
  ]
  const readable =
    vault.valid && vault.path && !isTooBroad(vault.path, home) ? path.resolve(vault.path) : null
  return {
    sourceRoots: discoverRoots(settings, home).map((r) => r.path),
    vaultRoots: [...new Set(denyLife.map((p) => path.resolve(p)))],
    readableVault: readable,
    writableRoots: input.writableRoots,
    lifeAllowlist: LIFE_ALLOWLIST
  }
}
