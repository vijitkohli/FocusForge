// Vault notes (Phase 4) status for the renderer: one shared subscription to
// `vault-sync-changed`, plus the warm, short copy each state shows. Never paths.
import { useEffect, useSyncExternalStore } from 'react'
import type { VaultSyncStatus } from 'src/common/vault'

export type VaultNote = VaultSyncStatus['notes'][number]

function ago(iso: string, nowMs: number): string {
  const ms = nowMs - Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const min = Math.max(0, Math.round(ms / 60_000))
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return `${d} ${d === 1 ? 'day' : 'days'} ago`
}

/** Notes that need the owner's attention (conflict, deleted, waiting on iCloud, unreadable). */
export function vaultProblems(s: VaultSyncStatus | null): VaultNote[] {
  return (s?.notes ?? []).filter((n) => n.state !== 'ok' && n.state !== 'removed')
}

/** One line for Settings: "Synced 2 min ago · 1 note needs a look". */
export function vaultSummary(s: VaultSyncStatus | null, nowMs: number): string {
  if (!s) return ''
  if (!s.enabled) return 'Off. Your vault is left alone.'
  if (!s.writable) {
    switch (s.reason) {
      case 'no-vault':
        return 'Waiting for your vault. Choose it above and save your items first.'
      case 'folder-removed':
        return 'The FocusForge folder was removed from your vault, so notes are paused.'
      case 'symlink':
        return "The FocusForge folder in your vault is a link, so FocusForge won't write there."
      default:
        return 'Paused.'
    }
  }
  if (s.waitingForFolder) return 'Waiting for iCloud to download the FocusForge folder.'
  const parts: string[] = []
  parts.push(s.lastSyncAt ? `Synced ${ago(s.lastSyncAt, nowMs)}` : 'Getting your notes ready')
  const n = vaultProblems(s).length
  if (n > 0) parts.push(`${n} ${n === 1 ? 'note needs' : 'notes need'} a look`)
  return parts.join(' · ')
}

/** The item's own note problem, if any (shown as one line on the item page). */
export function itemNoteProblem(
  s: VaultSyncStatus | null,
  itemId: string,
  taskId?: string
): VaultNote | null {
  return (
    vaultProblems(s).find(
      (n) => n.itemId === itemId && (taskId ? n.taskId === taskId : !n.taskId)
    ) ?? null
  )
}

// ---- one shared subscription ----

let current: VaultSyncStatus | null = null
const listeners = new Set<() => void>()
let unsubscribe: (() => void) | null = null
let inflight: Promise<void> | null = null

function emit(): void {
  for (const l of listeners) l()
}

export function refreshVaultStatus(): Promise<void> {
  if (inflight) return inflight
  inflight = window.api
    .getVaultStatus()
    .then((s) => {
      current = s
      emit()
    })
    .catch(() => undefined)
    .finally(() => {
      inflight = null
    })
  return inflight
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  if (!unsubscribe) {
    const offs = [
      window.api.onVaultSyncChanged(() => void refreshVaultStatus()),
      window.api.onTasksChanged(() => void refreshVaultStatus())
    ]
    unsubscribe = () => offs.forEach((off) => off())
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0 && unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
  }
}

/** Live vault-notes status (null until the first load). */
export function useVaultStatus(): VaultSyncStatus | null {
  const s = useSyncExternalStore(subscribe, () => current)
  useEffect(() => {
    void refreshVaultStatus()
  }, [])
  return s
}
