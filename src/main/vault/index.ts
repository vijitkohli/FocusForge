// src/main/vault/index.ts
// VaultSync: the vault-notes facade. Wires the writer and reader to the app's
// triggers (project saves, registry changes, digest-updated, startup, focus,
// Sync now) and answers the UI (status, Open in Obsidian, Recreate) and
// Phase 3 (My-notes refs). Pure Node; electron lives in ipc/vault.ts.
import path from 'path'
import { formatSourceRef } from '../../common/sourceRef'
import type { VaultDeps } from './deps'
import { dataviewSnippet } from './render'
import { VaultReader } from './reader'
import type { NoteRecord, VaultSyncStatus } from './types'
import { VaultFs } from './vaultFs'
import { findRecord, LIVE, VaultWriter } from './writer'

export { dataviewSnippet }
export type { VaultDeps } from './deps'

const MESSAGES: Partial<Record<NoteRecord['state'] | 'waiting', (title: string) => string>> = {
  conflict: (t) => `Obsidian has two copies of ${t}. Open both and keep one.`,
  deleted: () => 'You removed this note in Obsidian. Recreate it?',
  waiting: () => 'Waiting for iCloud to download this note.',
  error: () => "FocusForge can't read this note back, so it's left alone."
}

export class VaultSync {
  readonly writer: VaultWriter
  readonly reader: VaultReader
  private offs: (() => void)[] = []
  private startTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: VaultDeps) {
    this.writer = new VaultWriter(deps)
    this.reader = new VaultReader(deps, this.writer)
  }

  /** Subscribes to the app's triggers; the first full pass runs after `delayMs`. */
  start(delayMs = 5_000): void {
    this.stop()
    const { store } = this.deps
    this.offs.push(
      store.onSaved((id, data, tag) => this.writer.onSaved(id, data, tag.by === 'vault')),
      store.onRegistryChanged((id) => {
        if (this.writer.enabled) this.writer.schedule(id)
      }),
      this.deps.onDigestUpdated((id) => {
        if (this.writer.enabled) this.writer.schedule(id)
      })
    )
    this.startTimer = setTimeout(() => {
      this.startTimer = null
      void this.restart()
    }, delayMs)
  }

  /** Re-evaluates the write gate (after a settings change): watch and sync, or stand down. */
  async restart(): Promise<void> {
    const g = await this.writer.gate()
    if (!g.ok) {
      this.reader.stop()
      this.deps.notify('vault-sync-changed')
      return
    }
    this.reader.start(g)
    await this.writer.syncAll()
  }

  stop(): void {
    for (const off of this.offs) off()
    this.offs = []
    if (this.startTimer) clearTimeout(this.startTimer)
    this.startTimer = null
    this.reader.stop()
  }

  dispose(): void {
    this.stop()
    this.writer.dispose()
  }

  /** "Sync now": a full pass plus a read-back rescan. */
  async syncNow(): Promise<void> {
    const g = await this.writer.gate()
    if (!g.ok) {
      this.deps.notify('vault-sync-changed')
      return
    }
    if (!this.reader.watching()) this.reader.start(g)
    await this.reader.rescan(true)
    await this.writer.syncAll()
  }

  /** Window focus: a throttled rescan (fs.watch misses on iCloud). */
  focus(): void {
    void this.reader.rescan(false).catch(() => undefined)
  }

  async status(): Promise<VaultSyncStatus> {
    const settings = await this.deps.settings()
    const g = await this.writer.gate()
    const st = await this.writer.state.load()
    const notes: VaultSyncStatus['notes'] = []
    for (const rec of Object.values(st.notes)) {
      if (rec.kind === 'about' || rec.state === 'removed') continue
      const state = rec.state === 'evicted' ? 'waiting' : rec.state
      const title = rec.title ?? (rec.kind === 'item' ? 'this item' : 'this task')
      const msg = MESSAGES[state]?.(title)
      notes.push({
        itemId: rec.itemId,
        ...(rec.taskId ? { taskId: rec.taskId } : {}),
        title,
        state,
        ...(rec.conflicts?.length ? { conflicts: rec.conflicts.length } : {}),
        ...(msg ? { message: msg } : {})
      })
    }
    return {
      enabled: settings.vaultNotes,
      writable: g.ok,
      ...(g.ok ? {} : { reason: g.reason }),
      lastSyncAt: st.lastSyncAt ?? null,
      pending: this.writer.pending(),
      ...(this.writer.waitingForICloud ? { waitingForFolder: true } : {}),
      notes
    }
  }

  /**
   * Phase 3 hook: `<abs note>#My notes` for the item note and each task note
   * still in sync. Virtual pack sources, never stored in the registry.
   */
  async myNotesRefs(itemId: string): Promise<string[]> {
    const g = await this.writer.gate()
    if (!g.ok) return []
    const st = await this.writer.state.load()
    return Object.entries(st.notes)
      .filter(
        ([, r]) =>
          r.itemId === itemId &&
          (r.kind === 'item' || r.kind === 'task') &&
          (r.state === 'ok' || r.state === 'conflict')
      )
      .sort(([a, ra], [b, rb]) =>
        ra.kind === rb.kind ? a.localeCompare(b) : ra.kind === 'item' ? -1 : 1
      )
      .map(([rel]) => formatSourceRef(path.join(g.vaultRoot, ...rel.split('/')), 'My notes'))
  }

  /** Absolute path of an item's (or task's) note for Open in Obsidian; flushes first if unwritten. */
  async notePath(itemId: string, taskId?: string): Promise<{ abs: string } | { error: string }> {
    const g = await this.writer.gate()
    if (!g.ok) return { error: 'Vault notes are off. Turn them on in Settings.' }
    let found = findRecord(await this.writer.state.load(), itemId, taskId)
    if (!found || (found[1].state !== 'deleted' && !LIVE.has(found[1].state))) {
      await this.writer.flushNow(itemId)
      found = findRecord(await this.writer.state.load(), itemId, taskId)
    }
    if (!found) return { error: "This note isn't written yet. Try again in a moment." }
    if (found[1].state === 'deleted') {
      return { error: 'You removed this note in Obsidian. Recreate it first.' }
    }
    const abs = new VaultFs(g.guard, g.vaultRoot, this.deps.fsImpl).absPath(found[0])
    return abs ? { abs } : { error: "This note can't be opened." }
  }

  async recreate(itemId: string, taskId?: string): Promise<{ ok: boolean; error?: string }> {
    const g = await this.writer.gate()
    if (!g.ok) return { ok: false, error: 'Vault notes are off.' }
    await this.writer.recreateNote(itemId, taskId)
    const found = findRecord(await this.writer.state.load(), itemId, taskId)
    return found && found[1].state === 'ok'
      ? { ok: true }
      : { ok: false, error: "Couldn't recreate the note. Try again in a moment." }
  }

  /** Settings → Recreate after the FocusForge folder was removed. */
  async resumeFolder(): Promise<void> {
    await this.writer.resumeAfterFolderRemoved()
    await this.restart()
  }
}
