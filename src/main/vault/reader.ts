// src/main/vault/reader.ts
// VaultReader: brings ticks made in Obsidian back into the app.
//
// It watches only `<vault>/FocusForge` (never the vault root, so no event
// from Life/ can reach the process), plus a poll and a rescan on window focus
// because fs.watch misses changes on iCloud folders. A changed note is read
// through VaultFs; its own write is recognised by hash (echo suppression);
// ticks are diffed three ways against what the app last wrote, so only boxes
// the owner changed count, and applied through the locked project save with
// the `by: 'vault'` tag. My notes and owner sections are never scanned for
// ticks; a My-notes change only tells Phase 3 to rebuild the item's pack.
import path from 'path'
import type { LedgerNote } from '../../common/types'
import { withLock } from '../store/locks'
import type { Watcher } from '../sources/watch'
import { APP_VAULT_DIR } from '../sources/rules'
import type { VaultDeps, VaultGuardLike } from './deps'
import { localDay } from './deps'
import { hashText, parseNote, parseTicks } from './noteDoc'
import { applyTickChanges, diffTicks, type AppliedTick } from './ticks'
import { VaultFs, type NoteStat } from './vaultFs'
import { noticeEntry, tickLogEntries } from './vaultLog'
import { LIVE, type VaultWriter } from './writer'

const dirOf = (rel: string): string => rel.slice(0, rel.lastIndexOf('/'))
const fold = (s: string): string => s.normalize('NFC').toLowerCase()
const RESCAN_MIN_GAP_MS = 5_000

export class VaultReader {
  private watcher: Watcher | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private readonly eventTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly unknownSeen = new Map<string, string>()
  private root: { vaultRoot: string; guard: VaultGuardLike } | null = null
  private lastRescan = 0
  private stopped = true

  constructor(
    private readonly deps: VaultDeps,
    private readonly writer: VaultWriter
  ) {
    writer.ingest = (vfs, rel, text, stat) => this.ingestUnlocked(vfs, rel, text, stat)
  }

  private log(msg: string): void {
    this.deps.log?.(msg)
  }

  private now(): number {
    return this.writer.now()
  }

  /**
   * Applies the ticks in `text` (caller holds `vaultnote:<itemId>`).
   * Resolves true when project data changed.
   */
  async ingestUnlocked(vfs: VaultFs, rel: string, text: string, stat: NoteStat): Promise<boolean> {
    void vfs
    const state = await this.writer.state.load()
    const rec = state.notes[rel]
    if (!rec || rec.kind === 'about' || !LIVE.has(rec.state)) return false
    const hash = hashText(text)
    if (hash === rec.hash) {
      // Our own write (or a touch): nothing to apply.
      if (rec.mtimeMs !== stat.mtimeMs || rec.size !== stat.size) {
        await this.writer.state.update((s) => {
          const r = s.notes[rel]
          if (r && r.hash === hash) Object.assign(r, { mtimeMs: stat.mtimeMs, size: stat.size })
        })
      }
      return false
    }

    const parsed = parseNote(text)
    const ticks = parseTicks(parsed.appRegion)
    const { changes, unknown } = diffTicks(rec.checks, ticks)
    const nowMs = this.now()
    const iso = new Date(nowMs).toISOString()
    let applied: AppliedTick[] = []
    let bulk = rec.bulk ?? {}
    if (changes.length > 0) {
      const res = await this.deps.store.updateProjectData(
        rec.itemId,
        async (data) => {
          const r = applyTickChanges(data.tasks ?? [], changes, { bulk: rec.bulk, now: iso })
          bulk = r.bulk
          applied = r.applied
          if (!r.changed) return null
          const titles = r.applied.map((a) => `"${a.title}"`).join(', ')
          const note: LedgerNote = {
            section: 'Milestones & Completed Work',
            note: `${r.applied.every((a) => a.checked) ? 'Ticked' : 'Changed'} in Obsidian: ${titles}.`
          }
          return { data: { ...data, tasks: r.tasks }, notes: [note] }
        },
        { by: 'vault' }
      )
      if (res && !res.success) {
        // The save failed: keep the old base so the next pass tries again.
        this.writer.schedule(rec.itemId, 1_000)
        return false
      }
      if (!res) applied = []
    }

    const today = localDay(nowMs)
    const entries = tickLogEntries(applied, new Date(nowMs))
    const replanned = unknown.filter((id) => ticks.get(id) === true)
    for (const id of replanned) {
      entries.push(
        noticeEntry(
          new Date(nowMs),
          "A tick on a step that was re-planned wasn't applied",
          `replanned:${rel}:${id}`,
          rec.taskId
        )
      )
    }
    if (entries.length) await this.writer.logs.append(rec.itemId, entries, today)

    const myNotesHash = hashText(parsed.myNotes ?? '')
    const myNotesChanged = myNotesHash !== rec.myNotesHash
    await this.writer.state.update((s) => {
      const r = s.notes[rel]
      if (!r) return
      for (const c of changes) r.checks[c.id] = c.checked
      if (Object.keys(bulk).length) r.bulk = bulk
      else delete r.bulk
      r.hash = hash
      r.mtimeMs = stat.mtimeMs
      r.size = stat.size
      r.myNotesHash = myNotesHash
    })
    if (applied.length > 0) this.deps.notify('tasks-changed')
    if (myNotesChanged) this.deps.onMyNotesChanged?.(rec.itemId)
    if (applied.length > 0 || replanned.length > 0) this.writer.schedule(rec.itemId)
    return applied.length > 0
  }

  // ---- watching ----

  start(g: { vaultRoot: string; guard: VaultGuardLike }): void {
    this.stop()
    this.stopped = false
    this.root = g
    this.startWatcher()
    this.pollTimer = setInterval(() => void this.rescan(true), this.writer.cfg.pollMs)
  }

  stop(): void {
    this.stopped = true
    this.watcher?.close()
    this.watcher = null
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    for (const t of this.eventTimers.values()) clearTimeout(t)
    this.eventTimers.clear()
  }

  /** True while a watcher is open (QA/tests). */
  watching(): boolean {
    return this.watcher !== null
  }

  private startWatcher(): void {
    const g = this.root
    if (!g || !this.deps.watchFs || this.stopped) return
    const dir = path.join(g.vaultRoot, APP_VAULT_DIR)
    // Only FocusForge/ itself, after the guard agrees; never the vault root.
    if (!g.guard.check(dir).ok) return
    try {
      const w = this.deps.watchFs.watch(dir, { recursive: true, persistent: false }, (_ev, name) =>
        this.onEvent(name)
      )
      w.on('error', () => this.restartWatcher())
      this.watcher = w
    } catch {
      this.restartWatcher()
    }
  }

  private restartWatcher(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.stopped || this.restartTimer) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.startWatcher()
    }, this.writer.cfg.watchRestartMs)
  }

  /** A watch event: name rules first, then a per-file debounce. Nothing is read here. */
  private onEvent(name: string | Buffer | null): void {
    if (this.stopped) return
    if (name === null) {
      void this.rescan(false)
      return
    }
    const segs = String(name)
      .normalize('NFC')
      .split(/[\\/]+/)
    if (segs.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return
    if (!/\.md$/i.test(segs[segs.length - 1])) return
    const rel = `${APP_VAULT_DIR}/${segs.join('/')}`
    const prev = this.eventTimers.get(rel)
    if (prev) clearTimeout(prev)
    this.eventTimers.set(
      rel,
      setTimeout(() => {
        this.eventTimers.delete(rel)
        void this.handleChange(rel).catch(() => this.log('Vault read-back failed'))
      }, this.writer.cfg.eventDebounceMs)
    )
  }

  /** One note changed (or appeared, or went away). */
  async handleChange(rel: string): Promise<void> {
    const state = await this.writer.state.load()
    const key = Object.keys(state.notes).find((k) => fold(k) === fold(rel))
    const rec = key ? state.notes[key] : undefined
    if (!rec || !key) {
      // Unknown file: a conflict copy or a moved note. Re-check the owning item.
      const owner = Object.entries(state.notes).find(
        ([k, r]) => r.itemId && fold(dirOf(k)) === fold(dirOf(rel))
      )
      if (owner) this.writer.schedule(owner[1].itemId)
      return
    }
    if (rec.kind === 'about' || !LIVE.has(rec.state)) return
    const g = await this.writer.gate()
    if (!g.ok) return
    const vfs = new VaultFs(g.guard, g.vaultRoot, this.deps.fsImpl)
    await withLock(`vaultnote:${rec.itemId}`, async () => {
      const got = await vfs.read(key).catch(() => null)
      if (!got) return
      if (!('text' in got)) {
        this.writer.schedule(rec.itemId)
        return
      }
      await this.ingestUnlocked(vfs, key, got.text, got.stat)
    })
  }

  /**
   * Poll / focus rescan: stat every known note (a changed one is read back,
   * a missing one makes its item re-check), retry evicted notes, and list
   * item folders for new unknown files (conflict copies).
   */
  async rescan(force: boolean): Promise<void> {
    if (this.stopped) return
    const now = this.now()
    if (!force && now - this.lastRescan < RESCAN_MIN_GAP_MS) return
    this.lastRescan = now
    const g = await this.writer.gate()
    if (!g.ok) return
    const vfs = new VaultFs(g.guard, g.vaultRoot, this.deps.fsImpl)
    const state = await this.writer.state.load()
    const folders = new Map<string, string>()
    for (const [rel, rec] of Object.entries(state.notes)) {
      if (rec.kind === 'about' || !LIVE.has(rec.state)) continue
      folders.set(dirOf(rel), rec.itemId)
      if (rec.state === 'evicted') {
        if (now >= (rec.retryAt ?? 0)) this.writer.schedule(rec.itemId, 0)
        continue
      }
      const st = await vfs.stat(rel).catch(() => null)
      if (!st || st.isDir) {
        this.writer.schedule(rec.itemId, 0)
        continue
      }
      if (st.mtimeMs !== rec.mtimeMs || st.size !== rec.size) await this.handleChange(rel)
    }
    const known = new Set([...Object.keys(state.notes), ...(state.foreign ?? [])].map(fold))
    for (const [folder, itemId] of folders) {
      const entries = await vfs.listDir(folder).catch(() => [])
      const unknown = entries
        .filter((e) => !e.isDir && !e.icloudStub && /\.md$/i.test(e.name))
        .map((e) => `${folder}/${e.name}`)
        .filter((rel) => !known.has(fold(rel)))
        .sort()
        .join('\n')
      if ((this.unknownSeen.get(folder) ?? '') !== unknown) {
        this.unknownSeen.set(folder, unknown)
        this.writer.schedule(itemId, 0)
      }
    }
  }
}
