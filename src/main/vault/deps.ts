// src/main/vault/deps.ts
// What the vault writer and reader need from the rest of the app, the timing
// config, and the write gate. Pure Node (electron is wired in ipc/vault.ts).
import path from 'path'
import type { ItemDigest } from '../../common/digest'
import type { AppSettings } from '../../common/models'
import type { ContextPack } from '../../common/readers'
import type { ProjectData, SaveResult, Workstream } from '../../common/types'
import type { PathGuard } from '../sources/guard'
import { expandHome } from '../sources/guard'
import type { WatchFs } from '../sources/watch'
import type {
  ProjectMutation,
  RegistryListener,
  SavedListener,
  SaveTag
} from '../store/ProjectStore'
import type { VaultWriteFs } from './vaultFs'
import type { VaultSyncStatus } from './types'

export interface VaultStoreDeps {
  getProjects(): Workstream[]
  loadProjectData(id: string): Promise<ProjectData | null>
  updateProjectData(
    id: string,
    mutate: (data: ProjectData) => Promise<ProjectMutation>,
    tag?: SaveTag
  ): Promise<SaveResult | null>
  setVaultNote(id: string, rel: string | null): Promise<boolean>
  onSaved(listener: SavedListener): () => void
  onRegistryChanged(listener: RegistryListener): () => void
}

/** The guard surface the vault code uses. */
export type VaultGuardLike = Pick<
  PathGuard,
  | 'canWrite'
  | 'check'
  | 'roots'
  | 'statReadable'
  | 'readTextPrefix'
  | 'listDir'
  | 'appVaultWritable'
>

export interface VaultDeps {
  guard(): Promise<VaultGuardLike>
  settings(): Promise<Pick<AppSettings, 'vaultNotes' | 'vaultPath'>>
  store: VaultStoreDeps
  readDigest(id: string): Promise<ItemDigest | null>
  readPack(id: string): Promise<ContextPack | null>
  /** `digest-updated(itemId)` (Phase 3 ReaderService.onDigest). */
  onDigestUpdated(cb: (itemId: string) => void): () => void
  /** `FlowState/system/vault/state.json` */
  stateFile: string
  /** `FlowState/system/vault/log` */
  logDir: string
  /** `FlowState/system/vault/overwritten` (backups of replaced owner edits). */
  backupDir: string
  /** Writes a backup file (FlowState only); defaults to an atomic write. */
  writeBackup?(absPath: string, text: string): Promise<void>
  notify(channel: 'tasks-changed' | 'vault-sync-changed'): void
  /** An item's My notes changed: Phase 3 rebuilds its pack (`readers.refresh(id, 'watch')`). */
  onMyNotesChanged?(itemId: string): void
  /** Asks iCloud to download an evicted note (`brctl download`); best effort. */
  download?(absPath: string): Promise<void>
  home?: string
  now?(): number
  /** Test seam: every vault write, rename and mkdir goes through this. */
  fsImpl?: VaultWriteFs
  watchFs?: WatchFs
  config?: Partial<VaultConfig>
  log?(msg: string): void
}

export interface VaultConfig {
  /** Per-item trailing debounce. */
  debounceMs: number
  /** A burst of saves still flushes after this long. */
  maxWaitMs: number
  /** A note modified this recently isn't rewritten (Obsidian autosaves ~2 s). */
  quietMs: number
  /** At least this long between two file writes. */
  writeGapMs: number
  /** Stat known notes and list item folders this often (fs.watch misses on iCloud). */
  pollMs: number
  /** Per-file debounce for watch events. */
  eventDebounceMs: number
  /** An evicted (iCloud placeholder) note is retried after this long. */
  evictRetryMs: number
  /** Watcher restart delay after an error. */
  watchRestartMs: number
}

export const DEFAULT_VAULT_CONFIG: VaultConfig = {
  debounceMs: 3_000,
  maxWaitMs: 30_000,
  quietMs: 5_000,
  writeGapMs: 500,
  pollMs: 60_000,
  eventDebounceMs: 1_000,
  evictRetryMs: 10 * 60_000,
  watchRestartMs: 5_000
}

export type GateResult =
  | { ok: true; vaultRoot: string; guard: VaultGuardLike }
  | { ok: false; reason: NonNullable<VaultSyncStatus['reason']> }

/**
 * The write gate (PHASE4_PLAN §2.6). All must hold or nothing is written:
 * vault notes on; vaultPath persisted in settings (an auto-detected vault
 * never gets writes); the guard's readable vault is that path (so it has
 * `.obsidian`); the guard allows `<vault>/FocusForge` (not a symlink); and
 * the folder wasn't removed by the owner.
 */
export async function checkGate(
  deps: Pick<VaultDeps, 'guard' | 'settings' | 'home'>,
  paused: boolean
): Promise<GateResult> {
  const s = await deps.settings()
  if (!s.vaultNotes) return { ok: false, reason: 'off' }
  if (!s.vaultPath) return { ok: false, reason: 'no-vault' }
  const configured = expandHome(s.vaultPath, deps.home)
  if (!path.isAbsolute(configured)) return { ok: false, reason: 'no-vault' }
  const guard = await deps.guard()
  const vault = guard.roots().vault
  if (!vault || vault !== path.resolve(configured)) return { ok: false, reason: 'no-vault' }
  if (!guard.appVaultWritable()) return { ok: false, reason: 'symlink' }
  if (paused) return { ok: false, reason: 'folder-removed' }
  return { ok: true, vaultRoot: vault, guard }
}

/** Local `YYYY-MM-DDTHH:mm` for the `updated` key. */
export function localStamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Local `YYYY-MM-DD`. */
export function localDay(ms: number): string {
  return localStamp(ms).slice(0, 10)
}
