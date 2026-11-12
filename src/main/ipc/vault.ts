// src/main/ipc/vault.ts
// Electron wiring for Phase 4 vault notes: builds VaultSync from the app's
// stores, guard, settings and Phase 3 readers, and registers the vault IPC.
// The renderer gets statuses and the Dataview snippet, never note text.
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { FileSystemManager } from '../fs-manager'
import { loadSettings } from '../settings'
import { getGuard } from '../sources'
import { SYSTEM_DIR } from '../store/paths'
import type { WatchFs } from '../sources/watch'
import type { ReaderWiring } from './readers'
import type { VaultConfig } from '../vault/deps'
import { dataviewSnippet, VaultSync } from '../vault'
import type { VaultSyncStatus } from '../vault/types'

export const VAULT_STATE_DIR = path.join(SYSTEM_DIR, 'vault')

const nodeWatchFs: WatchFs = {
  watch: (p, o, cb) => fs.watch(p, { recursive: o.recursive, persistent: o.persistent }, cb)
}

function send(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args)
  }
}

/** QA-only knobs (scripts/qa-vault.mjs): shorter debounce and poll. The quiet window stays. */
export function vaultConfigFromEnv(env = process.env): {
  config: Partial<VaultConfig>
  startDelayMs: number
} {
  const n = Number(env.FOCUSFORGE_VAULT_DEBOUNCE_MS)
  if (!Number.isFinite(n) || n <= 0) return { config: {}, startDelayMs: 5_000 }
  return {
    config: {
      debounceMs: n,
      maxWaitMs: n * 10,
      pollMs: Math.max(1_000, n * 5),
      eventDebounceMs: Math.min(1_000, n)
    },
    startDelayMs: Math.min(5_000, n)
  }
}

const id = (v: unknown): string | null => (typeof v === 'string' && v && v.length < 300 ? v : null)

export function initVaultSync(deps: {
  fsManager: FileSystemManager
  readers: ReaderWiring | null
}): VaultSync {
  const { fsManager, readers } = deps
  const { config, startDelayMs } = vaultConfigFromEnv()
  let openExternal = (url: string): Promise<void> => shell.openExternal(url)

  const sync = new VaultSync({
    guard: getGuard,
    settings: async () => {
      const s = await loadSettings()
      return { vaultNotes: s.vaultNotes, vaultPath: s.vaultPath }
    },
    store: {
      getProjects: () => fsManager.getProjects(),
      loadProjectData: (pid) => fsManager.loadProjectData(pid),
      updateProjectData: (pid, mutate, tag) => fsManager.updateProjectData(pid, mutate, tag),
      setVaultNote: (pid, rel) => fsManager.setVaultNote(pid, rel),
      onSaved: (l) => fsManager.onSaved(l),
      onRegistryChanged: (l) => fsManager.onRegistryChanged(l)
    },
    readDigest: async (pid) => (readers ? readers.store.readDigest(pid) : null),
    readPack: async (pid) => (readers ? readers.store.readPack(pid) : null),
    onDigestUpdated: (cb) => (readers ? readers.service.onDigest(cb) : () => undefined),
    stateFile: path.join(VAULT_STATE_DIR, 'state.json'),
    logDir: path.join(VAULT_STATE_DIR, 'log'),
    backupDir: path.join(VAULT_STATE_DIR, 'overwritten'),
    notify: (channel) => send(channel),
    onMyNotesChanged: (pid) => {
      void readers?.service.refresh(pid, 'watch').catch(() => undefined)
    },
    // Best effort: ask iCloud to fetch an evicted note. The path already passed the guard.
    download: (abs) =>
      new Promise((resolve) => {
        execFile('brctl', ['download', abs], { timeout: 15_000 }, () => resolve())
      }),
    home: os.homedir(),
    watchFs: nodeWatchFs,
    config,
    log: (msg) => console.log(`[vault] ${msg}`)
  })

  ipcMain.handle('vault-status', (): Promise<VaultSyncStatus> => sync.status())
  ipcMain.handle(
    'vault-open-note',
    async (_e, itemId: unknown, taskId: unknown): Promise<{ ok: true } | { error: string }> => {
      const iid = id(itemId)
      if (!iid) return { error: 'Unknown item.' }
      const got = await sync.notePath(iid, id(taskId) ?? undefined)
      if ('error' in got) return got
      try {
        await openExternal(`obsidian://open?path=${encodeURIComponent(got.abs)}`)
        return { ok: true }
      } catch {
        return { error: "Obsidian didn't open. Is it installed?" }
      }
    }
  )
  ipcMain.handle('vault-sync-now', () => sync.syncNow())
  ipcMain.handle('vault-recreate-note', (_e, itemId: unknown, taskId: unknown) => {
    const iid = id(itemId)
    if (!iid) return { ok: false, error: 'Unknown item.' }
    return sync.recreate(iid, id(taskId) ?? undefined)
  })
  ipcMain.handle('vault-resume-folder', () => sync.resumeFolder())
  ipcMain.handle('vault-dataview-snippet', () => dataviewSnippet())

  // fs.watch misses changes on iCloud folders: rescan when the app comes back to the front.
  app.on('browser-window-focus', () => sync.focus())

  // QA only (scripts/qa-vault.mjs): write counts and an Open in Obsidian stub.
  if (process.env.FOCUSFORGE_QA === '1') {
    ;(globalThis as Record<string, unknown>).__ffVault = {
      sync,
      stubOpenExternal: () => {
        const opened: string[] = []
        openExternal = async (url) => {
          opened.push(url)
        }
        return opened
      }
    }
  }

  sync.start(startDelayMs)
  return sync
}
