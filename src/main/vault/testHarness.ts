// src/main/vault/testHarness.ts
// A temp home with a fake vault and an in-memory item store, for the vault
// writer/reader tests. Synthetic data only; everything lives in mkdtemp.
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ItemDigest } from '../../common/digest'
import type { ContextPack } from '../../common/readers'
import type { LedgerNote, ProjectData, SaveResult, Workstream } from '../../common/types'
import { withLock } from '../store/locks'
import type {
  ProjectMutation,
  RegistryListener,
  SavedListener,
  SaveTag
} from '../store/ProjectStore'
import { nodeGuardFs, PathGuard, type GuardFs } from '../sources/guard'
import type { WatchFs } from '../sources/watch'
import type { VaultConfig, VaultDeps, VaultStoreDeps } from './deps'
import { VaultSync } from './index'
import { item } from './testFixtures'
import { nodeVaultWriteFs, type VaultWriteFs } from './vaultFs'

export const FAST: Partial<VaultConfig> = {
  debounceMs: 5,
  maxWaitMs: 40,
  quietMs: 0,
  writeGapMs: 0,
  pollMs: 1e9,
  eventDebounceMs: 5,
  evictRetryMs: 1e9,
  watchRestartMs: 1e9
}

export class MemoryStore implements VaultStoreDeps {
  items: Workstream[] = []
  data = new Map<string, ProjectData>()
  ledger: { id: string; notes: LedgerNote[] }[] = []
  saves: { id: string; by?: string }[] = []
  private saved: SavedListener[] = []
  private registry: RegistryListener[] = []

  getProjects(): Workstream[] {
    return this.items.map((i) => ({ ...i }))
  }
  async loadProjectData(id: string): Promise<ProjectData | null> {
    const d = this.data.get(id)
    return d ? structuredClone(d) : null
  }
  private write(
    id: string,
    d: ProjectData,
    notes: LedgerNote[] | undefined,
    tag: SaveTag
  ): SaveResult {
    const rev = (this.data.get(id)?.rev ?? 0) + 1
    const next = { ...structuredClone(d), rev }
    this.data.set(id, next)
    if (notes?.length) this.ledger.push({ id, notes })
    this.saves.push({ id, by: tag.by })
    const ls = [...this.saved]
    queueMicrotask(() => ls.forEach((l) => l(id, next, tag)))
    return { success: true, rev }
  }
  updateProjectData(
    id: string,
    mutate: (data: ProjectData) => Promise<ProjectMutation>,
    tag: SaveTag = {}
  ): Promise<SaveResult | null> {
    return withLock(`project:${id}`, async () => {
      const d = await this.loadProjectData(id)
      if (!d) return null
      const ch = await mutate(d)
      if (!ch) return null
      return this.write(id, ch.data, ch.notes, tag)
    })
  }
  /** The renderer's path: a save with the rev it loaded. */
  saveProjectData(id: string, d: ProjectData, expectedRev?: number): Promise<SaveResult> {
    return withLock(`project:${id}`, async () => {
      if (expectedRev !== undefined && (this.data.get(id)?.rev ?? 0) !== expectedRev) {
        return { success: false, conflict: true }
      }
      return this.write(id, d, undefined, {})
    })
  }
  async setVaultNote(id: string, rel: string | null): Promise<boolean> {
    const it = this.items.find((i) => i.id === id)
    if (!it) return false
    if (rel === null) delete it.vaultNote
    else it.vaultNote = rel
    return true
  }
  onSaved(l: SavedListener): () => void {
    this.saved.push(l)
    return () => {
      this.saved = this.saved.filter((x) => x !== l)
    }
  }
  onRegistryChanged(l: RegistryListener): () => void {
    this.registry.push(l)
    return () => {
      this.registry = this.registry.filter((x) => x !== l)
    }
  }
  emitRegistry(id: string, kind: 'created' | 'updated' | 'deleted'): void {
    this.registry.forEach((l) => l(id, kind))
  }
}

export interface Harness {
  tmp: string
  home: string
  vault: string
  uni: string
  flow: string
  store: MemoryStore
  settings: { vaultNotes: boolean; vaultPath: string }
  digests: Map<string, ItemDigest>
  packs: Map<string, ContextPack>
  notified: string[]
  myNotesChanged: string[]
  downloads: string[]
  digestListeners: ((id: string) => void)[]
  sync: VaultSync
  deps: VaultDeps
  guard(): PathGuard
  abs(rel: string): string
  read(rel: string): string
  writeNote(rel: string, text: string): void
  addItem(over: Partial<Workstream>, data?: ProjectData): Workstream
  cleanup(): void
}

export function makeHarness(
  opts: {
    config?: Partial<VaultConfig>
    fsImpl?: VaultWriteFs
    guardFs?: GuardFs
    watchFs?: WatchFs
    appVaultWrite?: boolean
    lifeCanary?: boolean
  } = {}
): Harness {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-vaultsync-'))
  const home = path.join(tmp, 'home')
  const vault = path.join(home, 'vault')
  const uni = path.join(home, 'uni')
  const flow = path.join(tmp, 'flowstate')
  const put = (p: string, text: string): void => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, text)
  }
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true })
  put(path.join(vault, 'Life', 'canary.md'), 'LIFE CANARY')
  put(path.join(vault, 'Learning', 'Thesis Hub', 'Thesis.md'), '# Thesis hub\n')
  put(path.join(uni, 'thesis', 'CONTEXT.md'), '# Thesis\n')
  fs.mkdirSync(flow, { recursive: true })
  if (opts.lifeCanary) {
    fs.chmodSync(path.join(vault, 'Life', 'canary.md'), 0o000)
    fs.chmodSync(path.join(vault, 'Life'), 0o000)
  }

  const store = new MemoryStore()
  const settings = { vaultNotes: true, vaultPath: vault }
  const digests = new Map<string, ItemDigest>()
  const packs = new Map<string, ContextPack>()
  const notified: string[] = []
  const myNotesChanged: string[] = []
  const downloads: string[] = []
  const digestListeners: ((id: string) => void)[] = []
  const guard = (): PathGuard =>
    new PathGuard({
      sourceRoots: [uni],
      vaultRoots: [vault],
      readableVault: vault,
      writableRoots: [flow],
      caseInsensitive: true,
      appVaultWrite: opts.appVaultWrite ?? settings.vaultNotes,
      fsImpl: opts.guardFs ?? nodeGuardFs
    })
  const deps: VaultDeps = {
    guard: async () => guard(),
    settings: async () => ({ ...settings }),
    store,
    readDigest: async (id) => digests.get(id) ?? null,
    readPack: async (id) => packs.get(id) ?? null,
    onDigestUpdated: (cb) => {
      digestListeners.push(cb)
      return () => undefined
    },
    stateFile: path.join(flow, 'system', 'vault', 'state.json'),
    logDir: path.join(flow, 'system', 'vault', 'log'),
    backupDir: path.join(flow, 'system', 'vault', 'overwritten'),
    notify: (c) => notified.push(c),
    onMyNotesChanged: (id) => myNotesChanged.push(id),
    download: async (abs) => {
      downloads.push(abs)
    },
    home,
    fsImpl: opts.fsImpl ?? nodeVaultWriteFs,
    watchFs: opts.watchFs,
    config: { ...FAST, ...(opts.config ?? {}) }
  }
  const sync = new VaultSync(deps)
  const abs = (rel: string): string => path.join(vault, ...rel.split('/'))
  return {
    tmp,
    home,
    vault,
    uni,
    flow,
    store,
    settings,
    digests,
    packs,
    notified,
    myNotesChanged,
    downloads,
    digestListeners,
    sync,
    deps,
    guard,
    abs,
    read: (rel) => fs.readFileSync(abs(rel), 'utf8'),
    writeNote: (rel, text) => put(abs(rel), text),
    addItem(over, data) {
      const it = item({ path: path.join(flow, over.id ?? 'thesis'), ...over })
      store.items.push(it)
      store.data.set(it.id, data ?? { tasks: [], rev: 0 })
      return it
    },
    cleanup() {
      sync.dispose()
      if (opts.lifeCanary) {
        try {
          fs.chmodSync(path.join(vault, 'Life'), 0o755)
          fs.chmodSync(path.join(vault, 'Life', 'canary.md'), 0o644)
        } catch {
          // best effort
        }
      }
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
}

/** Waits until the writer is idle (all debounced flushes ran). */
export async function settle(h: Harness): Promise<void> {
  await new Promise((r) => setTimeout(r, 20))
  await h.sync.writer.whenIdle()
}
