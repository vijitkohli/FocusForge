// src/common/vault.ts
// Vault-notes status shared by main (Phase 4 VaultSync) and the renderer
// (Open in Obsidian, the Settings "Vault notes" block). Types only.

/** A note's sync state; `waiting` is an iCloud placeholder (evicted). */
export type VaultNoteState = 'ok' | 'deleted' | 'removed' | 'conflict' | 'error' | 'waiting'

export interface VaultSyncStatus {
  /** settings.vaultNotes */
  enabled: boolean
  /** The write gate holds right now. */
  writable: boolean
  reason?: 'off' | 'no-vault' | 'folder-removed' | 'symlink'
  lastSyncAt: string | null
  pending: number
  /** `<vault>/FocusForge` itself is an iCloud placeholder. */
  waitingForFolder?: boolean
  notes: {
    itemId: string
    taskId?: string
    title: string
    state: VaultNoteState
    conflicts?: number
    message?: string
  }[]
}
