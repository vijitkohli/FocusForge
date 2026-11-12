// src/main/ipc/sources.ts
// IPC for item discovery and the approval screen. Every path that comes from
// the renderer or a dialog is re-checked by the guard here. Errors are logged
// without paths.
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import os from 'os'
import path from 'path'
import type {
  ApplyDiscoveryResult,
  DiscoveryCandidate,
  DiscoveryResult,
  VaultInfo
} from '../../common/discovery'
import type { WorkstreamPatch } from '../../common/types'
import { sanitizeWorkstreamPatch } from '../../common/workstreams'
import type { FileSystemManager } from '../fs-manager'
import { saveSettings } from '../settings'
import { DISCOVERY_PATH } from '../store/paths'
import { getSourceContext, invalidateGuard, runDiscovery, scanPickedSource } from '../sources'
import { readDiscoveryCache, saveDismissedKeys } from '../sources/discoveryCache'
import { guardPatch, planApply } from '../sources/apply'
import { isVaultDir } from '../sources/vault'
import { isTooBroad } from '../sources/config'

export interface SourceHandlerDeps {
  fsManager: FileSystemManager
  /** Tells open windows to reload items (the existing 'tasks-changed' event). */
  notifyTasksChanged: () => void
  /** After a settings change that alters what is readable/writable (vault notes re-check their gate). */
  onAccessChanged?: () => void
}

/** `/Users/x/Vault` -> `~/Vault` (settings keep `~` unexpanded). */
function contractHome(p: string, home = os.homedir()): string {
  const rel = path.relative(home, p)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel}` : p
}

function skippedMessage(skipped: string[]): string {
  return `I left out ${skipped.join(', ')} because FocusForge can't read ${skipped.length === 1 ? 'it' : 'them'}.`
}

export function registerSourceHandlers({
  fsManager,
  notifyTasksChanged,
  onAccessChanged
}: SourceHandlerDeps): void {
  const inflight = new Map<
    number,
    { controller: AbortController; promise: Promise<DiscoveryResult> }
  >()

  ipcMain.handle('discover-workstreams', (event): Promise<DiscoveryResult> => {
    const id = event.sender.id
    const running = inflight.get(id)
    if (running) return running.promise
    const controller = new AbortController()
    const promise = runDiscovery(fsManager.getRegistryEntries(), controller.signal)
      .catch((error: unknown) => {
        console.error('Discovery failed:', (error as Error)?.name ?? 'error')
        throw new Error('discovery-failed')
      })
      .finally(() => inflight.delete(id))
    inflight.set(id, { controller, promise })
    return promise
  })

  ipcMain.handle('cancel-discovery', (event) => {
    inflight.get(event.sender.id)?.controller.abort()
  })

  ipcMain.handle('get-last-discovery', async (): Promise<DiscoveryResult | null> => {
    const cache = await readDiscoveryCache(DISCOVERY_PATH)
    if (!cache.result) return null
    const { guard } = await getSourceContext()
    const registry = fsManager.getProjects()
    const ids = new Set(registry.map((p) => p.id))
    // Re-check every stored source against the current rules and registry.
    const clean = (c: DiscoveryCandidate): DiscoveryCandidate => {
      const next = { ...c, sources: c.sources.filter((s) => guard.checkSource(s.path).ok) }
      if (next.adoptsProjectId && !ids.has(next.adoptsProjectId)) delete next.adoptsProjectId
      return next
    }
    const candidates = cache.result.candidates.map(clean)
    const adopted = new Set(candidates.map((c) => c.adoptsProjectId).filter(Boolean))
    return {
      ...cache.result,
      candidates,
      dismissed: (cache.result.dismissed ?? []).map(clean),
      dismissedKeys: cache.dismissedKeys,
      existingUnmatched: registry.filter((p) => !adopted.has(p.id))
    }
  })

  ipcMain.handle(
    'add-source-via-dialog',
    async (
      event: IpcMainInvokeEvent
    ): Promise<{ candidate: DiscoveryCandidate } | { error: string } | null> => {
      const ctx = await getSourceContext()
      const win = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        title: 'Add a folder or note',
        properties: ['openDirectory', 'openFile'],
        filters: [{ name: 'Notes', extensions: ['md'] }],
        defaultPath: ctx.roots[0]?.path ?? ctx.vault.path ?? undefined
      }
      const picked = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (picked.canceled || picked.filePaths.length === 0) return null
      return scanPickedSource(picked.filePaths[0])
    }
  )

  ipcMain.handle('apply-discovery', async (_event, req: unknown): Promise<ApplyDiscoveryResult> => {
    try {
      const ctx = await getSourceContext()
      const firstRun = ctx.settings.discoveryCompletedAt === null
      const plan = planApply(req, {
        guard: ctx.guard,
        registry: fsManager.getRegistryEntries(),
        firstRun
      })
      const applied = await fsManager.applyWorkstreams(plan.ops)
      await saveDismissedKeys(DISCOVERY_PATH, plan.dismissedKeys)

      const settingsPatch: { discoveryCompletedAt?: string; vaultPath?: string } = {}
      if (firstRun) settingsPatch.discoveryCompletedAt = new Date().toISOString()
      // Pin the detected vault so it never drifts to another vault later.
      if (ctx.vault.source === 'obsidian' && ctx.vault.valid && ctx.vault.path) {
        settingsPatch.vaultPath = contractHome(ctx.vault.path)
      }
      if (Object.keys(settingsPatch).length > 0) {
        await saveSettings(settingsPatch)
        invalidateGuard()
        onAccessChanged?.()
      }
      notifyTasksChanged()
      const failed = applied.failed.length > 0
      return {
        success: !failed,
        created: applied.created,
        updated: applied.updated.filter((id, i, all) => all.indexOf(id) === i),
        ...(plan.skippedSources.length ? { skippedSources: plan.skippedSources } : {}),
        ...(failed
          ? { error: "Some items couldn't be saved. Everything else is in." }
          : plan.skippedSources.length
            ? { error: skippedMessage(plan.skippedSources) }
            : {})
      }
    } catch (error) {
      console.error('Saving items failed:', (error as Error)?.name ?? 'error')
      return {
        success: false,
        created: [],
        updated: [],
        error: "I couldn't save your items. Nothing was deleted; try again."
      }
    }
  })

  ipcMain.handle(
    'update-workstream',
    async (
      _event,
      id: unknown,
      rawPatch: unknown
    ): Promise<{ success: boolean; error?: string }> => {
      if (typeof id !== 'string' || !id) return { success: false, error: 'not-found' }
      const { guard } = await getSourceContext()
      const { patch, skipped } = guardPatch(guard, sanitizeWorkstreamPatch(rawPatch))
      const result = await fsManager.updateWorkstream(id, patch)
      if (result.success) notifyTasksChanged()
      if (result.success && skipped.length) {
        return { success: true, error: skippedMessage(skipped) }
      }
      return result
    }
  )

  ipcMain.handle('get-vault-info', async (): Promise<VaultInfo> => {
    return (await getSourceContext()).vault
  })

  ipcMain.handle(
    'choose-vault-folder',
    async (event: IpcMainInvokeEvent): Promise<{ vault: VaultInfo } | { error: string } | null> => {
      const ctx = await getSourceContext()
      const win = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        title: 'Choose your Obsidian vault',
        properties: ['openDirectory'],
        defaultPath: ctx.vault.path ?? os.homedir()
      }
      const picked = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (picked.canceled || picked.filePaths.length === 0) return null
      const chosen = path.resolve(picked.filePaths[0])
      const d = ctx.guard.check(path.join(chosen, '.obsidian'))
      if (!d.ok && d.reason === 'life') {
        return { error: "Your vault's Life folder stays closed. Pick something else." }
      }
      if (isTooBroad(chosen, os.homedir()) || !(await isVaultDir(chosen))) {
        return { error: "That folder isn't an Obsidian vault. Pick the one with your notes." }
      }
      await saveSettings({ vaultPath: contractHome(chosen) })
      invalidateGuard()
      onAccessChanged?.()
      return { vault: (await getSourceContext()).vault }
    }
  )
}

/** create-project's optional item fields, with sources guard-checked. */
export async function guardedCreateFields(raw: unknown): Promise<WorkstreamPatch> {
  const patch = sanitizeWorkstreamPatch(raw)
  if (patch.sources === undefined) return patch
  const { guard } = await getSourceContext()
  return guardPatch(guard, patch).patch
}
