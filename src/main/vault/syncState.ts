// src/main/vault/syncState.ts
// The vault sync state (`FlowState/system/vault/state.json`): one record per
// note the app wrote, keyed by vault-relative path (NFC). It is the three-way
// base for ticks and remembers chosen paths, deletions and conflicts. Lives in
// FlowState, never in the vault. Pure Node (the path is passed in).
import fs from 'fs-extra'
import { writeJsonAtomic } from '../store/atomic'
import { withLock } from '../store/locks'
import type { NoteRecord, VaultSyncState } from './types'

const STATES: ReadonlySet<NoteRecord['state']> = new Set([
  'ok',
  'deleted',
  'evicted',
  'removed',
  'conflict',
  'error'
])

export function emptySyncState(): VaultSyncState {
  return { version: 1, notes: {} }
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function boolMap(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (!v || typeof v !== 'object') return out
  for (const [k, b] of Object.entries(v as Record<string, unknown>)) {
    if (typeof b === 'boolean') out[k] = b
  }
  return out
}

function listMap(v: unknown): Record<string, string[]> | undefined {
  if (!v || typeof v !== 'object') return undefined
  const out: Record<string, string[]> = {}
  for (const [k, l] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(l)) out[k] = l.filter(isStr)
  }
  return Object.keys(out).length ? out : undefined
}

function normalizeRecord(raw: unknown): NoteRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kind = r.kind === 'item' || r.kind === 'task' || r.kind === 'about' ? r.kind : null
  if (!kind || !isStr(r.itemId)) return null
  const state = STATES.has(r.state as NoteRecord['state']) ? (r.state as NoteRecord['state']) : 'ok'
  const rec: NoteRecord = {
    itemId: r.itemId,
    kind,
    hash: isStr(r.hash) ? r.hash : '',
    mtimeMs: isNum(r.mtimeMs) ? r.mtimeMs : 0,
    size: isNum(r.size) ? r.size : 0,
    checks: boolMap(r.checks),
    appRegionHash: isStr(r.appRegionHash) ? r.appRegionHash : '',
    myNotesHash: isStr(r.myNotesHash) ? r.myNotesHash : '',
    state,
    writtenAt: isStr(r.writtenAt) ? r.writtenAt : ''
  }
  if (isStr(r.taskId)) rec.taskId = r.taskId
  const bulk = listMap(r.bulk)
  if (bulk) rec.bulk = bulk
  if (Array.isArray(r.conflicts)) rec.conflicts = r.conflicts.filter(isStr)
  if (isStr(r.folder)) rec.folder = r.folder
  if (isStr(r.itemStatus)) rec.itemStatus = r.itemStatus
  if (isStr(r.title)) rec.title = r.title
  if (isNum(r.retryAt)) rec.retryAt = r.retryAt
  return rec
}

/** Validates a parsed state.json; anything malformed is dropped, never guessed. */
export function normalizeSyncState(raw: unknown): VaultSyncState {
  const out = emptySyncState()
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  if (r.notes && typeof r.notes === 'object') {
    for (const [rel, rec] of Object.entries(r.notes as Record<string, unknown>)) {
      const n = normalizeRecord(rec)
      if (n) out.notes[rel.normalize('NFC')] = n
    }
  }
  if (r.paused === 'folder-removed') out.paused = 'folder-removed'
  if (isStr(r.lastSyncAt)) out.lastSyncAt = r.lastSyncAt
  if (Array.isArray(r.foreign)) out.foreign = r.foreign.filter(isStr).map((x) => x.normalize('NFC'))
  return out
}

/** Load and locked update of state.json (lock key `vaultstate`). */
export class SyncStateStore {
  constructor(private readonly file: string) {}

  async load(): Promise<VaultSyncState> {
    try {
      if (!(await fs.pathExists(this.file))) return emptySyncState()
      return normalizeSyncState(await fs.readJSON(this.file))
    } catch {
      return emptySyncState()
    }
  }

  /**
   * Read-modify-write under `vaultstate`. `fn` mutates the state in place
   * and may return a value; the file is rewritten only when it changed.
   */
  update<T>(fn: (s: VaultSyncState) => T): Promise<T> {
    return withLock('vaultstate', async () => {
      const state = await this.load()
      const before = JSON.stringify(state)
      const out = fn(state)
      if (JSON.stringify(state) !== before) await writeJsonAtomic(this.file, state)
      return out
    })
  }
}
