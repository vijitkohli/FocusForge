// src/main/vault/writer.ts
// VaultWriter: renders item, task and About notes and writes them under
// `<vault>/FocusForge/` through VaultFs (the only module that writes to the
// vault). Pure Node; electron is wired in ipc/vault.ts.
//
// One flush per item (lock `vaultnote:<id>`), one flush at a time, at least
// `writeGapMs` between file writes. Per note: never over an iCloud
// placeholder, never recreate a note the owner deleted (unless asked), never
// write within `quietMs` of the note's last change, pick up pending ticks
// before rendering, skip the write when the bytes are the same, back up an
// owner edit of an app section to FlowState before replacing it, and land
// the write only if the file is unchanged since it was read. The vault is
// never deleted from: removed items and tasks get a final "Removed" write.
import path from 'path'
import { writeFileAtomic } from '../store/atomic'
import { withLock } from '../store/locks'
import type { ProjectData, ProjectTask, Workstream } from '../../common/types'
import { checkGate, DEFAULT_VAULT_CONFIG, localDay, localStamp } from './deps'
import type { GateResult, VaultConfig, VaultDeps, VaultGuardLike } from './deps'
import { yamlScalar } from './format'
import {
  ABOUT_NOTE_REL,
  findConflictCopies,
  findMovedNote,
  planNotePaths,
  type KnownNotes,
  type PlannedItemNotes
} from './layout'
import { composeNote, hashText, parseNote, readFrontmatterKeys, regionHash } from './noteDoc'
import { CALLOUT, removedCallout, renderAboutNote, renderItemNote, renderTaskNote } from './render'
import { SyncStateStore } from './syncState'
import type {
  NoteKind,
  NoteRecord,
  RenderedNote,
  VaultLogEntry,
  VaultSyncState,
  VaultSyncStatus
} from './types'
import { VaultFs, type NoteStat } from './vaultFs'
import {
  commitLogEntries,
  noticeEntry,
  progressLogEntries,
  saveLogEntries,
  VaultLogStore
} from './vaultLog'
import { APP_VAULT_DIR } from '../sources/rules'

/** Reader hook: applies pending ticks in `text` (caller holds `vaultnote:<id>`). */
export type IngestFn = (vfs: VaultFs, rel: string, text: string, stat: NoteStat) => Promise<boolean>

/** States whose notes are still kept in sync. */
export const LIVE: ReadonlySet<NoteRecord['state']> = new Set([
  'ok',
  'conflict',
  'error',
  'evicted'
])

const ABOUT_LOCK = 'vaultnote:\u0000about'
const MAX_SCAN_FILES = 2_000
const MAX_SCAN_READS = 300

const dirOf = (rel: string): string => rel.slice(0, rel.lastIndexOf('/'))
const baseOf = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/i, '')
const fold = (s: string): string => s.normalize('NFC').toLowerCase()

interface Target {
  kind: NoteKind
  rel: string
  taskId?: string
  title: string
  /** Item notes: the folder the app chose. */
  folder?: string
}

type ReadOutcome =
  | { skip: true }
  | { skip: false; rel: string; text: string | null; stat: NoteStat | 'absent' }

export function recordKey(itemId: string, taskId?: string): string {
  return `${itemId}/${taskId ?? ''}`
}

/** The record of an item's (or task's) note, live or deleted (not removed). */
export function findRecord(
  state: VaultSyncState,
  itemId: string,
  taskId?: string
): [string, NoteRecord] | null {
  for (const [rel, rec] of Object.entries(state.notes)) {
    if (rec.itemId !== itemId || rec.state === 'removed') continue
    if (taskId ? rec.kind === 'task' && rec.taskId === taskId : rec.kind === 'item') {
      return [rel, rec]
    }
  }
  return null
}

/** Which `## … (auto)` section an owner edit touched (for the log line). */
function changedSection(oldRegion: string, newBody: string): string {
  const split = (s: string): Map<string, string> => {
    const out = new Map<string, string>()
    let name = 'the heading'
    let buf: string[] = []
    for (const line of s.split('\n')) {
      const m = /^## +(.*?)\s*$/.exec(line)
      if (m) {
        out.set(
          name,
          buf
            .join('\n')
            .replace(/\[[ xX]\]/g, '[ ]')
            .trim()
        )
        name = m[1].replace(/\s*\(auto\)$/i, '')
        buf = []
      } else buf.push(line)
    }
    out.set(
      name,
      buf
        .join('\n')
        .replace(/\[[ xX]\]/g, '[ ]')
        .trim()
    )
    return out
  }
  const a = split(oldRegion)
  const b = split(newBody.replace(/\s+$/, ''))
  for (const [name, text] of a) if (b.get(name) !== text) return `“${name}”`
  return 'an app section'
}

export class VaultWriter {
  readonly cfg: VaultConfig
  readonly state: SyncStateStore
  readonly logs: VaultLogStore
  /** Applies ticks found in a note before it is re-rendered (set by the reader). */
  ingest: IngestFn | null = null
  /** File writes since start (QA and tests). */
  writes = 0
  /** Why the last gate check refused writes (null when writable). */
  lastReason: VaultSyncStatus['reason'] | null = null

  private readonly timers = new Map<string, { t: ReturnType<typeof setTimeout>; first: number }>()
  private chain: Promise<void> = Promise.resolve()
  private queued = 0
  private lastWriteAt = 0
  private readonly snapshots = new Map<string, ProjectData>()
  private readonly recreate = new Set<string>()
  private readonly downloaded = new Set<string>()
  private disposed = false
  /** Live gate result from the last check (logging is skipped while off). */
  enabled = false
  /** `<vault>/FocusForge` is an iCloud placeholder. */
  waitingForICloud = false

  constructor(private readonly deps: VaultDeps) {
    this.cfg = { ...DEFAULT_VAULT_CONFIG, ...(deps.config ?? {}) }
    this.state = new SyncStateStore(deps.stateFile)
    this.logs = new VaultLogStore(deps.logDir)
  }

  now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private log(msg: string): void {
    this.deps.log?.(msg)
  }

  async gate(): Promise<GateResult> {
    const st = await this.state.load()
    const g = await checkGate(this.deps, st.paused === 'folder-removed')
    this.enabled = g.ok
    this.lastReason = g.ok ? null : g.reason
    return g
  }

  /** Flushes and timers not yet run. */
  pending(): number {
    return this.timers.size + this.queued
  }

  // ---- scheduling ----

  /** Per-item trailing debounce with a max wait. */
  schedule(itemId: string, delay = this.cfg.debounceMs): void {
    if (this.disposed) return
    const now = this.now()
    const cur = this.timers.get(itemId)
    const first = cur?.first ?? now
    if (cur) clearTimeout(cur.t)
    const wait = Math.max(0, Math.min(delay, first + this.cfg.maxWaitMs - now))
    const t = setTimeout(() => {
      this.timers.delete(itemId)
      void this.flushNow(itemId)
    }, wait)
    this.timers.set(itemId, { t, first })
  }

  /** Runs one item's flush after every earlier flush (one at a time). */
  flushNow(itemId: string): Promise<void> {
    this.queued++
    const run = this.chain
      .then(() => withLock(`vaultnote:${itemId}`, () => this.flushItem(itemId)))
      .catch((e) => this.log(`Vault flush failed for an item: ${(e as Error)?.name ?? 'error'}`))
      .finally(() => {
        this.queued--
      })
    this.chain = run
    return run
  }

  /** Full pass: the About note, every item, and notes of items no longer in the app. */
  syncAll(): Promise<void> {
    this.queued++
    const run = this.chain
      .then(async () => {
        const g = await this.gate()
        if (!g.ok) return
        await withLock(ABOUT_LOCK, () => this.flushAbout())
      })
      .catch((e) => this.log(`Vault sync failed: ${(e as Error)?.name ?? 'error'}`))
      .finally(() => {
        this.queued--
      })
    this.chain = run
    const ids = new Set(this.deps.store.getProjects().map((p) => p.id))
    return run.then(async () => {
      const st = await this.state.load()
      for (const rec of Object.values(st.notes)) if (rec.itemId) ids.add(rec.itemId)
      await Promise.all([...ids].map((id) => this.flushNow(id)))
      await this.state.update((s) => {
        s.lastSyncAt = new Date(this.now()).toISOString()
      })
      this.deps.notify('vault-sync-changed')
    })
  }

  /** Resolves when no flush is queued or waiting on a timer. */
  async whenIdle(): Promise<void> {
    for (let i = 0; i < 500; i++) {
      await this.chain
      if (this.pending() === 0) return
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  dispose(): void {
    this.disposed = true
    for (const { t } of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  // ---- triggers ----

  /** Shared save hook: log what changed in the app, then re-render that item. */
  onSaved(projectId: string, data: ProjectData, byVault: boolean): void {
    const prev = this.snapshots.get(projectId) ?? null
    this.snapshots.set(projectId, data)
    if (!this.enabled) return
    const entries = saveLogEntries(prev, data, { now: new Date(this.now()), byVault })
    if (entries.length) {
      void this.logs
        .append(projectId, entries, localDay(this.now()))
        .catch(() => this.log('Vault log append failed'))
    }
    this.schedule(projectId)
  }

  /** Recreate a note the owner deleted (or that was never written). */
  async recreateNote(itemId: string, taskId?: string): Promise<void> {
    this.recreate.add(recordKey(itemId, taskId))
    await this.flushNow(itemId)
  }

  /** Settings → Recreate after the whole folder was removed: forget old records and write afresh. */
  async resumeAfterFolderRemoved(): Promise<void> {
    await this.state.update((s) => {
      delete s.paused
      s.notes = {}
    })
  }

  // ---- the flush ----

  private async vfsFor(g: GateResult & { ok: true }): Promise<VaultFs> {
    return new VaultFs(g.guard, g.vaultRoot, this.deps.fsImpl)
  }

  /**
   * False when writes must wait: the FocusForge folder is an iCloud
   * placeholder, or the owner removed it after notes were written (writes
   * pause until Settings → Recreate).
   */
  private async rootReady(
    vfs: VaultFs,
    g: { vaultRoot: string; guard: VaultGuardLike }
  ): Promise<boolean> {
    const st = await vfs.stat(APP_VAULT_DIR)
    if (st?.isDir) {
      this.waitingForICloud = false
      return true
    }
    const stub = await g.guard.statReadable(path.join(g.vaultRoot, `.${APP_VAULT_DIR}.icloud`))
    if (stub) {
      this.waitingForICloud = true
      return false
    }
    this.waitingForICloud = false
    const s = await this.state.load()
    const wrote = Object.values(s.notes).some((r) => r.state === 'ok' || r.state === 'conflict')
    if (!wrote) return true
    await this.state.update((x) => {
      x.paused = 'folder-removed'
    })
    this.enabled = false
    this.lastReason = 'folder-removed'
    this.deps.notify('vault-sync-changed')
    return false
  }

  private async flushItem(itemId: string): Promise<void> {
    const g = await this.gate()
    if (!g.ok) return
    const vfs = await this.vfsFor(g)
    if (!(await this.rootReady(vfs, g))) return
    const items = this.deps.store.getProjects()
    const item = items.find((p) => p.id === itemId)
    let state = await this.state.load()
    const mine = Object.entries(state.notes).filter(([, r]) => r.itemId === itemId)

    if (!item) {
      for (const [rel, rec] of mine) if (LIVE.has(rec.state)) await this.markRemoved(vfs, rel, rec)
      this.deps.notify('vault-sync-changed')
      return
    }
    if (item.status !== 'active') {
      await this.statusOnly(vfs, item, mine)
      return
    }
    let data = await this.deps.store.loadProjectData(itemId)
    if (!data) return
    if (!this.snapshots.has(itemId)) this.snapshots.set(itemId, data)

    const plan = this.planWithTasks(items, state, itemId, data.tasks)
    if (plan.moveFrom) await this.moveFolder(vfs, itemId, plan)
    state = await this.state.load()

    const targets: Target[] = [
      {
        kind: 'item',
        rel: findRecord(state, itemId)?.[0] ?? plan.note,
        title: item.name,
        folder: plan.folder
      },
      ...data.tasks.map((t) => ({
        kind: 'task' as const,
        taskId: t.id,
        rel: findRecord(state, itemId, t.id)?.[0] ?? plan.tasks[t.id],
        title: t.title
      }))
    ]

    // Phase A: read every note and apply pending ticks before rendering anything.
    const reads = new Map<Target, ReadOutcome>()
    let ingested = false
    for (const t of targets) {
      const r = await this.readTarget(vfs, itemId, t)
      reads.set(t, r)
      if (r.skip || r.text === null || r.stat === 'absent' || !this.ingest) continue
      const rec = (await this.state.load()).notes[r.rel]
      if (rec && hashText(r.text) !== rec.hash && (await this.ingest(vfs, r.rel, r.text, r.stat))) {
        ingested = true
      }
    }
    if (ingested) {
      data = (await this.deps.store.loadProjectData(itemId)) ?? data
      this.snapshots.set(itemId, data)
    }

    const nowMs = this.now()
    const today = localDay(nowMs)
    const digest = await this.deps.readDigest(itemId).catch(() => null)
    const pack = await this.deps.readPack(itemId).catch(() => null)
    await this.logs.append(
      itemId,
      [...commitLogEntries(pack, today), ...progressLogEntries(digest, today)],
      today
    )

    const relOf = (t: Target): string => {
      const r = reads.get(t)
      return r && !r.skip ? r.rel : t.rel
    }
    const itemRel = relOf(targets[0])
    const taskLinks: Record<string, string> = {}
    for (const t of targets.slice(1)) taskLinks[t.taskId as string] = relOf(t)
    const ctx = { today, home: this.deps.home, vaultRoot: g.vaultRoot }
    const tasksNow = data.tasks

    // Phase B: render and write.
    for (const t of targets) {
      const r = reads.get(t)
      if (!r || r.skip) continue
      const task = t.taskId ? tasksNow.find((x) => x.id === t.taskId) : undefined
      if (t.kind === 'task' && !task) continue
      const render = (log: VaultLogEntry[]): RenderedNote =>
        t.kind === 'item'
          ? renderItemNote({ ...ctx, item, tasks: tasksNow, taskLinks, digest, log })
          : renderTaskNote({ ...ctx, item, task: task as ProjectTask, itemRel, log })
      await this.writeTarget(vfs, itemId, t, r, render, item.status)
    }

    // Tasks deleted in the app: one final "Removed" write, then left alone.
    state = await this.state.load()
    const taskIds = new Set(tasksNow.map((t) => t.id))
    for (const [rel, rec] of Object.entries(state.notes)) {
      if (rec.itemId === itemId && rec.kind === 'task' && rec.taskId && !taskIds.has(rec.taskId)) {
        if (LIVE.has(rec.state)) await this.markRemoved(vfs, rel, rec)
      }
    }

    await this.conflictScan(vfs, itemId)
    this.deps.notify('vault-sync-changed')
  }

  private planWithTasks(
    items: Workstream[],
    state: VaultSyncState,
    itemId: string,
    tasks: ProjectTask[]
  ): PlannedItemNotes {
    const known: KnownNotes = {}
    const reserved: string[] = [...(state.foreign ?? [])]
    const liveTasks = new Set(tasks.map((t) => t.id))
    for (const [rel, rec] of Object.entries(state.notes)) {
      const staleTask =
        rec.itemId === itemId && rec.kind === 'task' && !!rec.taskId && !liveTasks.has(rec.taskId)
      if (rec.state === 'removed' || staleTask || !items.some((i) => i.id === rec.itemId)) {
        reserved.push(rel)
        continue
      }
      if (rec.kind === 'item') known[`${rec.folder ?? dirOf(rel)}/\u0000item.md`] = rec
      else if (rec.kind === 'task') known[rel] = rec
    }
    const live = items.filter(
      (i) =>
        i.id === itemId ||
        i.status === 'active' ||
        Object.values(state.notes).some((r) => r.itemId === i.id)
    )
    const full = planNotePaths(
      live.map((i) => ({
        id: i.id,
        name: i.name,
        category: i.category,
        tasks: i.id === itemId ? tasks.map((t) => ({ id: t.id, title: t.title, auto: t.auto })) : []
      })),
      known,
      reserved
    )
    return full[itemId]
  }

  /** App rename or recategorise: move the folder (and the item note file) inside FocusForge/. */
  private async moveFolder(vfs: VaultFs, itemId: string, plan: PlannedItemNotes): Promise<void> {
    const from = plan.moveFrom as string
    const to = plan.folder
    const st = await vfs.stat(from).catch(() => null)
    if (st?.isDir) {
      try {
        await this.pace()
        await vfs.rename(from, to)
      } catch {
        this.log('Vault folder move refused; keeping the old folder for now')
        return
      }
    }
    const oldName = baseOf(from)
    const newName = baseOf(to)
    let itemRel: string | null = null
    await this.state.update((s) => {
      for (const [rel, rec] of Object.entries(s.notes)) {
        if (rel.startsWith(`${from}/`)) {
          delete s.notes[rel]
          s.notes[`${to}${rel.slice(from.length)}`] = rec
        }
      }
      for (const [rel, rec] of Object.entries(s.notes)) {
        if (rec.itemId === itemId && rec.kind === 'item' && rec.state !== 'removed') {
          rec.folder = to
          itemRel = rel
        }
      }
    })
    if (itemRel && itemRel === `${to}/${oldName}.md` && fold(oldName) !== fold(newName)) {
      const target = `${to}/${newName}.md`
      try {
        if ((await vfs.stat(itemRel))?.isDir === false) {
          await this.pace()
          await vfs.rename(itemRel, target)
        }
        const old = itemRel as string
        await this.state.update((s) => {
          const rec = s.notes[old]
          if (rec) {
            delete s.notes[old]
            s.notes[target] = rec
          }
        })
        itemRel = target
      } catch {
        this.log('Vault note rename refused; keeping the old file name')
      }
    }
    if (itemRel) await this.deps.store.setVaultNote(itemId, itemRel)
  }

  private async setRecord(
    rel: string,
    patch: Partial<NoteRecord> & Pick<NoteRecord, 'itemId' | 'kind'>
  ): Promise<void> {
    await this.state.update((s) => {
      const empty: NoteRecord = {
        itemId: patch.itemId,
        kind: patch.kind,
        hash: '',
        mtimeMs: 0,
        size: 0,
        checks: {},
        appRegionHash: '',
        myNotesHash: '',
        state: 'ok',
        writtenAt: ''
      }
      s.notes[rel] = { ...(s.notes[rel] ?? empty), ...patch }
    })
  }

  private async readTarget(vfs: VaultFs, itemId: string, t: Target): Promise<ReadOutcome> {
    const state = await this.state.load()
    let rel = t.rel
    let rec: NoteRecord | undefined = state.notes[rel]
    const key = recordKey(itemId, t.taskId)
    const recreating = this.recreate.has(key)
    if (recreating) this.recreate.delete(key)
    const base = { itemId, kind: t.kind, title: t.title, ...(t.taskId ? { taskId: t.taskId } : {}) }
    if (rec && (rec.itemId !== itemId || rec.kind !== t.kind || rec.taskId !== t.taskId)) {
      // Another note's path (never write one note over another).
      return { skip: true }
    }

    let got: Awaited<ReturnType<VaultFs['read']>>
    try {
      got = await vfs.read(rel)
    } catch {
      // e.g. a name the guard won't read back (looks like a secret): never written blind.
      await this.setRecord(rel, { ...base, state: 'error' })
      return { skip: true }
    }

    if ('missing' in got) {
      if (got.stub) {
        await this.setRecord(rel, {
          ...base,
          state: 'evicted',
          retryAt: this.now() + this.cfg.evictRetryMs
        })
        if (!this.downloaded.has(rel) && this.deps.download) {
          this.downloaded.add(rel)
          const abs = vfs.absPath(rel)
          if (abs) void this.deps.download(abs).catch(() => undefined)
        }
        this.schedule(itemId, this.cfg.evictRetryMs)
        return { skip: true }
      }
      if (rec && rec.state === 'deleted' && !recreating) return { skip: true }
      if (rec && LIVE.has(rec.state) && !recreating) {
        const moved = await this.findMoved(vfs, itemId, t.taskId)
        if (!moved) {
          await this.setRecord(rel, { ...base, state: 'deleted' })
          return { skip: true }
        }
        await this.state.update((s) => {
          const r = s.notes[rel]
          delete s.notes[rel]
          if (r) s.notes[moved] = r
        })
        rel = moved
        rec = (await this.state.load()).notes[rel]
        try {
          got = await vfs.read(rel)
        } catch {
          return { skip: true }
        }
        if ('missing' in got || 'tooLarge' in got) return { skip: true }
      } else {
        if (recreating && rec) {
          await this.state.update((s) => {
            delete s.notes[rel]
          })
        }
        return { skip: false, rel, text: null, stat: 'absent' }
      }
    }
    if ('tooLarge' in got) {
      await this.setRecord(rel, { ...base, state: 'error' })
      return { skip: true }
    }

    if (!rec) {
      // A file the state doesn't know: adopt it only if it is this note (state was lost).
      const fm = readFrontmatterKeys(got.text)
      const ours =
        fm.ff_id === itemId &&
        (t.taskId
          ? fm.ff_task === t.taskId
          : t.kind === 'about'
            ? fm.ff_note === 'about'
            : fm.ff_note === 'item')
      if (!ours && !(t.kind === 'about' && fm.ff_note === 'about')) {
        await this.state.update((s) => {
          s.foreign = [...new Set([...(s.foreign ?? []), rel])]
        })
        this.schedule(itemId, 0)
        return { skip: true }
      }
    }
    const age = this.now() - got.stat.mtimeMs
    if (age < this.cfg.quietMs) {
      // Let the reader take the ticks now; write once the note is quiet.
      if (rec && this.ingest && hashText(got.text) !== rec.hash) {
        await this.ingest(vfs, rel, got.text, got.stat)
      }
      this.schedule(itemId, this.cfg.quietMs - age + 50)
      return { skip: true }
    }
    if (rec?.state === 'evicted') await this.setRecord(rel, { ...base, state: 'ok' })
    return { skip: false, rel, text: got.text, stat: got.stat }
  }

  private async writeTarget(
    vfs: VaultFs,
    itemId: string,
    t: Target,
    r: Extract<ReadOutcome, { skip: false }>,
    render: (log: VaultLogEntry[]) => RenderedNote,
    itemStatus?: string
  ): Promise<void> {
    const rel = r.rel
    const nowMs = this.now()
    const today = localDay(nowMs)
    const existing = r.text
    const rec = (await this.state.load()).notes[rel]
    let log = itemId ? await this.logs.read(itemId) : []
    let rendered = render(log)

    const prevUpdated = existing !== null ? readFrontmatterKeys(existing).updated : undefined
    let composed =
      existing !== null && prevUpdated ? composeNote(existing, rendered, prevUpdated) : null
    if (!composed || composed.text !== existing) {
      if (existing !== null && itemId) {
        const parsed = parseNote(existing)
        const notices: VaultLogEntry[] = []
        if (rec?.appRegionHash && regionHash(parsed.appRegion) !== rec.appRegionHash) {
          await this.backup(rel, existing, nowMs)
          notices.push(
            noticeEntry(
              new Date(nowMs),
              `FocusForge replaced your edit in ${changedSection(parsed.appRegion, rendered.body)} (a copy is kept in the app)`,
              `overwrite:${rel}:${regionHash(parsed.appRegion)}`,
              t.taskId
            )
          )
        }
        if (parsed.misplaced > 0) {
          notices.push(
            noticeEntry(
              new Date(nowMs),
              'Moved your own sections to just above My notes',
              `moved:${rel}:${hashText(parsed.unknownSections.join('\n'))}`,
              t.taskId
            )
          )
        }
        if (notices.length && (await this.logs.append(itemId, notices, today)) > 0) {
          log = await this.logs.read(itemId)
          rendered = render(log)
        }
      }
      composed = composeNote(existing, rendered, localStamp(nowMs))
    }

    const keepConflict = rec?.state === 'conflict'
    const patch = {
      itemId,
      kind: t.kind,
      title: t.title,
      ...(t.taskId ? { taskId: t.taskId } : {}),
      checks: rendered.checks,
      appRegionHash: composed.appRegionHash,
      myNotesHash: composed.myNotesHash,
      state: (keepConflict ? 'conflict' : 'ok') as NoteRecord['state'],
      ...(t.kind === 'item' ? { folder: rec?.folder ?? t.folder ?? dirOf(rel), itemStatus } : {})
    }
    if (existing !== null && composed.text === existing && r.stat !== 'absent') {
      await this.setRecord(rel, {
        ...patch,
        hash: hashText(existing),
        mtimeMs: r.stat.mtimeMs,
        size: r.stat.size
      })
      if (t.kind === 'item') await this.deps.store.setVaultNote(itemId, rel)
      return
    }

    await vfs.ensureDir(dirOf(rel))
    await this.pace()
    const res = await vfs.writeIfUnchanged(rel, composed.text, r.stat)
    this.lastWriteAt = this.now()
    if (res === 'changed') {
      // Changed while writing; the next pass (or this item's retry) picks it up.
      if (itemId) this.schedule(itemId, 1_000)
      return
    }
    this.writes++
    const st = await vfs.stat(rel)
    await this.setRecord(rel, {
      ...patch,
      hash: hashText(composed.text),
      mtimeMs: st?.mtimeMs ?? 0,
      size: st?.size ?? Buffer.byteLength(composed.text, 'utf8'),
      writtenAt: new Date(nowMs).toISOString()
    })
    if (t.kind === 'item') await this.deps.store.setVaultNote(itemId, rel)
  }

  /** Copies the owner's version to FlowState before an app section is replaced. */
  private async backup(rel: string, text: string, nowMs: number): Promise<void> {
    const segs = rel.split('/').filter((s) => s && s !== '..' && s !== '.')
    const abs = path.join(this.deps.backupDir, localDay(nowMs), ...segs)
    if (!abs.startsWith(path.resolve(this.deps.backupDir) + path.sep)) return
    if (this.deps.writeBackup) await this.deps.writeBackup(abs, text)
    else await writeFileAtomic(abs, text)
  }

  private async pace(): Promise<void> {
    const wait = this.lastWriteAt + this.cfg.writeGapMs - this.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }

  private async flushAbout(): Promise<void> {
    const g = await this.gate()
    if (!g.ok) return
    const vfs = await this.vfsFor(g)
    if (!(await this.rootReady(vfs, g))) return
    const t: Target = { kind: 'about', rel: ABOUT_NOTE_REL, title: 'About these notes' }
    const r = await this.readTarget(vfs, '', t)
    if (r.skip) return
    await this.writeTarget(vfs, '', t, r, () => renderAboutNote())
  }

  /** Paused or archived (Q3): one frontmatter `status` update on the item note, then nothing. */
  private async statusOnly(
    vfs: VaultFs,
    item: Workstream,
    mine: [string, NoteRecord][]
  ): Promise<void> {
    const found = mine.find(([, r]) => r.kind === 'item' && LIVE.has(r.state))
    if (!found) return
    const [rel, rec] = found
    if (rec.itemStatus === item.status) return
    const got = await vfs.read(rel).catch(() => null)
    if (!got || !('text' in got)) return
    if (this.now() - got.stat.mtimeMs < this.cfg.quietMs) {
      this.schedule(item.id, this.cfg.quietMs)
      return
    }
    const body = parseNote(got.text).appRegion
    const c = composeNote(
      got.text,
      { frontmatter: [['status', yamlScalar(item.status)]], body },
      localStamp(this.now())
    )
    await this.pace()
    const res = await vfs.writeIfUnchanged(rel, c.text, got.stat)
    this.lastWriteAt = this.now()
    if (res === 'changed') {
      this.schedule(item.id, 1_000)
      return
    }
    this.writes++
    const st = await vfs.stat(rel)
    await this.setRecord(rel, {
      itemId: item.id,
      kind: 'item',
      itemStatus: item.status,
      hash: hashText(c.text),
      mtimeMs: st?.mtimeMs ?? 0,
      size: st?.size ?? 0,
      writtenAt: new Date(this.now()).toISOString()
    })
  }

  /** Item or task deleted in the app: the note says so once and is never updated again. */
  private async markRemoved(vfs: VaultFs, rel: string, rec: NoteRecord): Promise<void> {
    const got = await vfs.read(rel).catch(() => null)
    if (got && 'text' in got) {
      if (this.now() - got.stat.mtimeMs < this.cfg.quietMs) {
        this.schedule(rec.itemId, this.cfg.quietMs)
        return
      }
      const parsed = parseNote(got.text)
      const date = localDay(this.now())
      const callout = removedCallout(date)
      let body = parsed.appRegion.includes(CALLOUT)
        ? parsed.appRegion.replace(CALLOUT, callout)
        : parsed.appRegion.replace(/^(# [^\n]*)/, `$1\n${callout}`)
      if (!body.includes(callout)) body = `${callout}\n\n${body}`
      const c = composeNote(
        got.text,
        { frontmatter: [['status', 'removed']], body },
        localStamp(this.now())
      )
      await this.pace()
      const res = await vfs.writeIfUnchanged(rel, c.text, got.stat)
      this.lastWriteAt = this.now()
      if (res === 'changed') {
        this.schedule(rec.itemId, 1_000)
        return
      }
      this.writes++
    }
    await this.state.update((s) => {
      const r = s.notes[rel]
      if (r) {
        r.state = 'removed'
        delete r.conflicts
      }
    })
    if (rec.kind === 'item' && this.deps.store.getProjects().some((p) => p.id === rec.itemId)) {
      await this.deps.store.setVaultNote(rec.itemId, null)
    }
  }

  /** A note the owner moved inside FocusForge/: found by its `ff_id` / `ff_task`. */
  private async findMoved(vfs: VaultFs, itemId: string, taskId?: string): Promise<string | null> {
    const state = await this.state.load()
    const known = new Set(Object.keys(state.notes).map(fold))
    const files: string[] = []
    const queue: { rel: string; depth: number }[] = [{ rel: APP_VAULT_DIR, depth: 0 }]
    let seen = 0
    while (queue.length && seen < MAX_SCAN_FILES) {
      const { rel, depth } = queue.shift() as { rel: string; depth: number }
      const entries = await vfs.listDir(rel).catch(() => [])
      for (const e of entries) {
        seen++
        if (e.icloudStub || e.name.startsWith('.')) continue
        const child = `${rel}/${e.name}`
        if (e.isDir) {
          if (depth < 5) queue.push({ rel: child, depth: depth + 1 })
        } else if (/\.md$/i.test(e.name) && !known.has(fold(child))) {
          files.push(child)
        }
      }
    }
    const candidates: { rel: string; text: string }[] = []
    for (const rel of files.slice(0, MAX_SCAN_READS)) {
      const got = await vfs.read(rel).catch(() => null)
      if (got && 'text' in got) candidates.push({ rel, text: got.text })
    }
    return findMovedNote(candidates, { itemId, ...(taskId ? { taskId } : {}) })
  }

  /** iCloud/Obsidian conflict copies next to this item's notes: reported, never merged. */
  private async conflictScan(vfs: VaultFs, itemId: string): Promise<void> {
    const state = await this.state.load()
    const folders = new Set(
      Object.entries(state.notes)
        .filter(([, r]) => r.itemId === itemId && r.state !== 'removed')
        .map(([rel]) => dirOf(rel))
    )
    const found = new Map<string, string[]>()
    for (const folder of folders) {
      const entries = await vfs.listDir(folder).catch(() => [])
      const names = entries.filter((e) => !e.isDir && !e.icloudStub).map((e) => e.name)
      const knownNames = new Set(
        Object.keys(state.notes)
          .filter((rel) => dirOf(rel) === folder)
          .map((rel) => rel.slice(folder.length + 1))
      )
      for (const c of findConflictCopies(names, knownNames)) {
        const orig = Object.keys(state.notes).find(
          (rel) => fold(rel) === fold(`${folder}/${c.original}`)
        )
        if (!orig) continue
        found.set(orig, [...(found.get(orig) ?? []), `${folder}/${c.copy}`])
      }
    }
    await this.state.update((s) => {
      for (const [rel, rec] of Object.entries(s.notes)) {
        if (rec.itemId !== itemId) continue
        const copies = found.get(rel)
        if (copies && (rec.state === 'ok' || rec.state === 'conflict')) {
          rec.state = 'conflict'
          rec.conflicts = copies.sort()
        } else if (!copies && rec.state === 'conflict') {
          rec.state = 'ok'
          delete rec.conflicts
        }
      }
    })
  }
}
