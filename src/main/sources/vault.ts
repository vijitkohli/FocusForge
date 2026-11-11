// src/main/sources/vault.ts
// Finds the Obsidian vault. Reads only Obsidian's own app config
// (`<appData>/obsidian/obsidian.json`) and single lstats of candidate vault
// folders and their `.obsidian` child. Pure Node; appData and fs are passed in.
import nodeFs from 'fs'
import os from 'os'
import path from 'path'
import type { VaultInfo } from '../../common/discovery'
import { expandHome, type StatsLike } from './guard'

export interface VaultFs {
  readFile(p: string): Promise<string>
  lstat(p: string): Promise<StatsLike>
  stat(p: string): Promise<StatsLike>
}

export const nodeVaultFs: VaultFs = {
  readFile: (p) => nodeFs.promises.readFile(p, 'utf8'),
  lstat: (p) => nodeFs.promises.lstat(p),
  stat: (p) => nodeFs.promises.stat(p)
}

export interface ObsidianVault {
  path: string
  open: boolean
  ts: number
}

export function obsidianConfigPath(appDataDir: string): string {
  return path.join(appDataDir, 'obsidian', 'obsidian.json')
}

/** Vaults listed in obsidian.json. [] when the file is missing or malformed. */
export async function readObsidianVaults(
  appDataDir: string,
  fsImpl: VaultFs = nodeVaultFs
): Promise<ObsidianVault[]> {
  try {
    const raw = JSON.parse(await fsImpl.readFile(obsidianConfigPath(appDataDir)))
    const vaults = raw && typeof raw === 'object' ? raw.vaults : null
    if (!vaults || typeof vaults !== 'object') return []
    const out: ObsidianVault[] = []
    for (const v of Object.values(vaults as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const { path: p, open, ts } = v as Record<string, unknown>
      if (typeof p !== 'string' || !path.isAbsolute(p)) continue
      out.push({ path: p, open: open === true, ts: typeof ts === 'number' ? ts : 0 })
    }
    return out
  } catch {
    return []
  }
}

/** The filesystem root, the home folder and anything above it can never be a vault. */
function tooBroad(p: string, home: string): boolean {
  const r = path.resolve(p)
  const h = path.resolve(home)
  return path.parse(r).root === r || r === h || h.startsWith(r + path.sep)
}

/** True when `p` is a directory with a `.obsidian` folder in it. */
export async function isVaultDir(
  p: string,
  fsImpl: VaultFs = nodeVaultFs,
  home = os.homedir()
): Promise<boolean> {
  if (!p || !path.isAbsolute(p) || tooBroad(p, home)) return false
  try {
    if (!(await fsImpl.stat(p)).isDirectory()) return false
    return (await fsImpl.lstat(path.join(p, '.obsidian'))).isDirectory()
  } catch {
    return false
  }
}

/**
 * 1. settings.vaultPath when set (if it's no longer a vault, the result is
 *    invalid rather than silently switching to another vault);
 * 2. otherwise obsidian.json: the open vault, else the newest, that exists;
 * 3. otherwise none.
 */
export async function detectVault(
  settings: { vaultPath: string },
  obsidianVaults: ObsidianVault[],
  fsImpl: VaultFs = nodeVaultFs,
  home = os.homedir()
): Promise<VaultInfo> {
  const valid: string[] = []
  const ordered = [...obsidianVaults].sort((a, b) => Number(b.open) - Number(a.open) || b.ts - a.ts)
  for (const v of ordered) if (await isVaultDir(v.path, fsImpl, home)) valid.push(v.path)

  const configured = settings.vaultPath ? expandHome(settings.vaultPath, home) : ''
  if (configured) {
    const ok = path.isAbsolute(configured) && (await isVaultDir(configured, fsImpl, home))
    const same = (p: string): boolean => path.resolve(p) === path.resolve(configured)
    return {
      path: path.isAbsolute(configured) ? path.resolve(configured) : null,
      source: 'settings',
      valid: ok,
      others: valid.filter((p) => !same(p))
    }
  }
  if (valid.length > 0) {
    return { path: valid[0], source: 'obsidian', valid: true, others: valid.slice(1) }
  }
  return { path: null, source: 'none', valid: false, others: [] }
}
