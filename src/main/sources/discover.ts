// src/main/sources/discover.ts
// Suggests items from folder names and dates in the source roots and the
// vault's category folders. Deterministic, no model calls. Every fs access
// goes through the PathGuard. The only content read is heading lines of
// hub/list notes directly inside the split vault categories (headings.ts).
// Nothing is logged except counts.
import path from 'path'
import os from 'os'
import type { PathGuard, WalkEntry } from './guard'
import type {
  CandidateSource,
  DiscoveryCandidate,
  DiscoveryResult,
  DiscoveryRoot,
  VaultInfo
} from '../../common/discovery'
import { ACTIVE_WINDOW_DAYS } from '../../common/discovery'
import type { ProjectSummary, WorkstreamKind, WorkstreamStatus } from '../../common/types'
import {
  courseCode,
  displayNameFor,
  formatSourceRef,
  isItemCategory,
  isWorkstreamKind,
  splitSourceRef,
  withWorkstreamDefaults,
  type ItemCategory
} from '../../common/workstreams'
import { foldName, isScannableVaultCategory } from './rules'
import { assignGreedy, bestMatch, planMerges } from './match'
import { readHeadings } from './headings'
import { scanActivity, type Activity } from './activity'
import { inSlice } from './slice'

export interface DiscoverRootInput {
  /** Absolute, ~-expanded. */
  path: string
  /** As configured, e.g. '~/UNI'. */
  label: string
  category: ItemCategory
}

export interface DiscoverOptions {
  guard: PathGuard
  sourceRoots: DiscoverRootInput[]
  vault: VaultInfo
  vaultCategories: string[]
  initialActiveKeys: string[]
  /** Raw registry entries (explicit fields are told apart from defaults). */
  registry: ProjectSummary[]
  dismissedKeys: string[]
  /** First run: apply the slice to ticks and statuses. Later runs keep saved statuses. */
  firstRun: boolean
  now?: Date
  signal?: AbortSignal
  /** Whole-run budget (ms). */
  totalBudgetMs?: number
  /** Per-folder activity budget (ms). */
  perScanMs?: number
  concurrency?: number
  git?: (dir: string) => Promise<number | null>
  home?: string
}

const HUB_NOTE = /\b(hub|list|dashboard|dump|index|to ?do)\b/i
const TERM_DIR = /^\d{2}T\d$/i
const SPLIT_CATEGORIES = new Set(['learning', 'projects'])
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

interface VaultUnit {
  name: string
  vaultCategory: string
  category: ItemCategory
  source: CandidateSource
  mtime: number | null
}

interface HubNote {
  path: string
  fileName: string
  category: ItemCategory
}

interface Draft {
  key: string
  name: string
  category: ItemCategory
  /** Names this draft answers to when matching (folder names, unit names). */
  names: string[]
  sources: CandidateSource[]
  /** Folders to scan for activity. */
  scanPaths: string[]
  unitMtime: number | null
  reasons: string[]
  hasFolder: boolean
  adopted?: ProjectSummary
  activity?: Activity
}

function stem(name: string): string {
  return name.replace(/\.md$/i, '')
}

function isMd(name: string): boolean {
  return /\.md$/i.test(name)
}

/** Local calendar days from `then` to `now` (DST-safe). */
export function localDaysBetween(then: Date, now: Date): number {
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate())
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

function ago(days: number): string {
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

function shortDate(d: Date, now: Date): string {
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`
}

function maxOrNull(...xs: (number | null | undefined)[]): number | null {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  return v.length ? Math.max(...v) : null
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString()
}

/** Maps a vault folder name to one of the four categories (never Life for discovery). */
function itemCategoryForVault(folder: string, unitName: string): ItemCategory {
  if (isItemCategory(folder) && folder !== 'Life') return folder
  return courseCode(unitName) || /thesis/i.test(unitName) ? 'Learning' : 'Projects'
}

async function collect(
  gen: AsyncGenerator<WalkEntry, { truncated: boolean; reason?: string }>
): Promise<{ entries: WalkEntry[]; truncated: boolean }> {
  const entries: WalkEntry[] = []
  for (;;) {
    const r = await gen.next()
    if (r.done) return { entries, truncated: r.value.truncated }
    entries.push(r.value)
  }
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i])
    }
  })
  await Promise.all(workers)
}

export async function discover(opts: DiscoverOptions): Promise<DiscoveryResult> {
  const { guard } = opts
  const now = opts.now ?? new Date()
  const home = opts.home ?? os.homedir()
  const runDeadline = Date.now() + (opts.totalBudgetMs ?? 10_000)
  const perScanMs = opts.perScanMs ?? 1500
  const signal = opts.signal
  const warnings: string[] = []
  let truncated = false

  const label = (p: string): string => {
    const rel = path.relative(home, p)
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel}` : p
  }
  const vaultFold = opts.vault.valid && opts.vault.path ? guard.fold(opts.vault.path) : null

  // ---- Step 1: one folder candidate per top-level folder in each source root
  const roots: DiscoveryRoot[] = []
  const drafts: Draft[] = []
  for (const root of opts.sourceRoots) {
    const st = await guard.statReadable(root.path)
    const reachable = !!st && st.isDirectory()
    roots.push({ path: root.path, label: root.label, category: root.category, reachable })
    if (!reachable) {
      warnings.push(`Couldn't reach ${root.label}. The rest is here.`)
      continue
    }
    const listed = await guard.listDir(root.path, { deadline: runDeadline, signal })
    for (const e of listed) {
      if (!e.isDir) continue // loose files (and secrets, dropped by name) are ignored
      const key = guard.fold(e.path)
      if (key === vaultFold) continue
      drafts.push({
        key,
        name: displayNameFor(e.name),
        category: root.category,
        names: [e.name],
        sources: [
          {
            path: e.path,
            type: 'folder',
            label: label(e.path),
            match: 'primary',
            lastActivityAt: null
          }
        ],
        scanPaths: [e.path],
        unitMtime: null,
        reasons: [],
        hasFolder: true
      })
    }
  }

  // ---- Step 2: sibling merges (thesis-data -> thesis)
  const merges = planMerges(drafts.map((d) => ({ key: d.key, name: d.names[0] })))
  const byKey = new Map(drafts.map((d) => [d.key, d]))
  for (const [childKey, parentKey] of merges) {
    const child = byKey.get(childKey)
    const parent = byKey.get(parentKey)
    if (!child || !parent) continue
    parent.sources.push({ ...child.sources[0], match: 'merge' })
    parent.scanPaths.push(...child.scanPaths)
    parent.names.push(...child.names)
    parent.reasons.push(`Merged with ${child.names[0]}`)
    byKey.delete(childKey)
  }
  const pool = drafts.filter((d) => byKey.has(d.key))

  // ---- Step 3: vault units, one guarded walk per scanned category folder.
  // The vault root itself is never listed, so Life's name never even reaches memory.
  const units: VaultUnit[] = []
  const hubs: HubNote[] = []
  if (opts.vault.valid && opts.vault.path) {
    const vaultPath = opts.vault.path
    const categories = [...new Set(opts.vaultCategories.filter(isScannableVaultCategory))]
    for (const folder of categories) {
      if (signal?.aborted) break
      const dir = path.join(vaultPath, folder)
      const st = await guard.statReadable(dir)
      if (!st || !st.isDirectory()) continue
      const walked = await collect(
        guard.walk(dir, { maxDepth: 3, maxEntries: 4000, deadline: runDeadline, signal })
      )
      if (walked.truncated) truncated = true
      const rel = (e: WalkEntry): string[] => path.relative(dir, e.path).split(path.sep)
      const newestMdUnder = (folderPath: string): number | null =>
        maxOrNull(
          ...walked.entries
            .filter((e) => !e.isDir && isMd(e.name) && e.path.startsWith(folderPath + path.sep))
            .map((e) => e.mtimeMs)
        )
      const notePath = (e: WalkEntry): string => path.join(path.dirname(e.path), e.name)
      const noteUnit = (e: WalkEntry): VaultUnit => ({
        name: stem(e.name),
        vaultCategory: folder,
        category: itemCategoryForVault(folder, stem(e.name)),
        source: {
          path: notePath(e),
          type: 'vault-note',
          label: e.name,
          match: 'primary',
          lastActivityAt: iso(e.mtimeMs)
        },
        mtime: e.mtimeMs
      })
      const folderUnit = (e: WalkEntry, name: string): VaultUnit => {
        const mtime = newestMdUnder(e.path)
        return {
          name,
          vaultCategory: folder,
          category: itemCategoryForVault(folder, name),
          source: {
            path: e.path,
            type: 'vault-folder',
            label: `${e.name}/`,
            match: 'primary',
            lastActivityAt: iso(mtime)
          },
          mtime
        }
      }

      if (!SPLIT_CATEGORIES.has(foldName(folder))) {
        // Career and other categories: one unit for the whole folder.
        const mtime = maxOrNull(
          ...walked.entries.filter((e) => !e.isDir && isMd(e.name)).map((e) => e.mtimeMs)
        )
        units.push({
          name: folder,
          vaultCategory: folder,
          category: itemCategoryForVault(folder, folder),
          source: {
            path: dir,
            type: 'vault-folder',
            label: `${folder}/`,
            match: 'primary',
            lastActivityAt: iso(mtime)
          },
          mtime
        })
        continue
      }

      const termDirs = walked.entries.filter((e) => e.isDir && TERM_DIR.test(e.name))
      const isGrouping = (e: WalkEntry): boolean =>
        TERM_DIR.test(e.name) || termDirs.some((t) => t.path.startsWith(e.path + path.sep))
      for (const e of walked.entries) {
        const parts = rel(e)
        if (parts.length === 1) {
          if (!e.isDir) {
            if (!isMd(e.name)) continue
            if (HUB_NOTE.test(stem(e.name))) {
              hubs.push({
                path: notePath(e),
                fileName: e.name,
                category: itemCategoryForVault(folder, '')
              })
            } else {
              units.push(noteUnit(e))
            }
          } else if (/\shub$/i.test(e.name)) {
            units.push(folderUnit(e, e.name.replace(/\s+hub$/i, '')))
          } else if (!isGrouping(e)) {
            units.push(folderUnit(e, e.name))
          }
          continue
        }
        // Direct children of a term folder (inside a grouping folder) are units.
        const parent = path.dirname(e.path)
        const inTerm = termDirs.some((t) => t.path === parent)
        const underHub = /\shub$/i.test(parts[0])
        if (!inTerm || underHub) continue
        if (e.isDir) {
          if (!TERM_DIR.test(e.name)) units.push(folderUnit(e, e.name))
        } else if (isMd(e.name) && !HUB_NOTE.test(stem(e.name))) {
          units.push(noteUnit(e))
        }
      }
    }
  }

  // ---- Step 4: match vault units to folder candidates (each unit attaches once)
  const pairs = assignGreedy(units, pool, (u, d) => bestMatch([u.name], d.names)?.score ?? 0)
  const attached = new Set<VaultUnit>()
  const bestPerDraft = new Map<Draft, number>()
  for (const { left: u, right: d } of pairs) {
    const m = bestMatch([u.name], d.names)!
    attached.add(u)
    d.sources.push({ ...u.source, match: m.kind })
    d.names.push(u.name)
    d.unitMtime = maxOrNull(d.unitMtime, u.mtime)
    d.reasons.push(
      m.kind === 'similar'
        ? `Matched to ${u.source.label} by a similar name`
        : `Matched to ${u.source.label}`
    )
    if (m.score > (bestPerDraft.get(d) ?? 0)) {
      bestPerDraft.set(d, m.score)
      d.category = u.category // the vault's category wins: the app mirrors the vault
      if (m.kind === 'code' || m.kind === 'similar') {
        d.name = (courseCode(u.name) ?? '').toUpperCase() || d.name
      }
    }
  }
  for (const u of units) {
    if (attached.has(u)) continue
    pool.push({
      key: guard.fold(u.source.path),
      name: u.name,
      category: u.category,
      names: [u.name],
      sources: [u.source],
      scanPaths: [],
      unitMtime: u.mtime,
      reasons: [],
      hasFolder: false
    })
  }

  // ---- Step 5: list-note headings -> section sources (headings only, body dropped)
  for (const hub of hubs) {
    if (signal?.aborted) break
    const headings = await readHeadings(guard, hub.path)
    const sameCategory = pool.filter((d) => d.category === hub.category)
    const hits = assignGreedy(
      headings,
      sameCategory,
      (h, d) => bestMatch([h], [d.name, ...d.names])?.score ?? 0
    )
    for (const { left: heading, right: d } of hits) {
      d.sources.push({
        path: formatSourceRef(hub.path, heading),
        type: 'vault-section',
        label: `${hub.fileName} › ${heading}`,
        match: 'section',
        heading,
        lastActivityAt: null
      })
    }
  }

  // ---- Step 6: adopt existing FocusForge entries instead of duplicating them
  const registry = opts.registry.filter((e) => e && typeof e.id === 'string')
  const sourceKeys = (d: Draft): Set<string> =>
    new Set(d.sources.map((s) => guard.fold(splitSourceRef(s.path).path)))
  const adoptScore = (e: ProjectSummary, d: Draft): number => {
    const keys = sourceKeys(d)
    const own = (Array.isArray(e.sources) ? e.sources : []).filter((s) => typeof s === 'string')
    if (own.some((s) => keys.has(guard.fold(splitSourceRef(s).path)))) return 10
    return bestMatch([e.name, e.id].filter(Boolean), d.names.concat(d.name))?.score ?? 0
  }
  const adoptions = assignGreedy(registry, pool, adoptScore, true)
  const adoptedIds = new Set<string>()
  for (const { left: entry, right: d } of adoptions) {
    adoptedIds.add(entry.id)
    d.adopted = entry
    d.reasons.unshift('Already in FocusForge')
    const have = sourceKeys(d)
    for (const ref of Array.isArray(entry.sources) ? entry.sources : []) {
      if (typeof ref !== 'string' || !guard.checkSource(ref).ok) continue
      const { path: p, heading } = splitSourceRef(ref)
      if (have.has(guard.fold(p)) && !heading) continue
      if (d.sources.some((s) => s.path === ref)) continue
      const inVault = !!vaultFold && guard.fold(p).startsWith(vaultFold + path.sep)
      const type: CandidateSource['type'] = heading
        ? 'vault-section'
        : isMd(p)
          ? 'vault-note'
          : inVault
            ? 'vault-folder'
            : 'folder'
      if (type === 'folder') d.scanPaths.push(p)
      d.sources.push({
        path: ref,
        type,
        label: heading ? `${path.basename(p)} › ${heading}` : label(p),
        match: 'user',
        lastActivityAt: null,
        ...(heading ? { heading } : {})
      })
    }
  }
  const existingUnmatched = registry
    .filter((e) => !adoptedIds.has(e.id))
    .map((e) => withWorkstreamDefaults(e))

  // ---- Step 7: activity per candidate (bounded concurrency and time)
  const scans = pool.flatMap((d) => d.scanPaths.map((p) => ({ d, p })))
  const results = new Map<Draft, Map<string, Activity>>()
  await mapLimit(scans, opts.concurrency ?? 4, async ({ d, p }) => {
    if (signal?.aborted || Date.now() > runDeadline) {
      truncated = true
      return
    }
    const a = await scanActivity(guard, p, {
      deadline: Math.min(runDeadline, Date.now() + perScanMs),
      signal,
      git: opts.git
    })
    if (a.truncated && a.signal === 'timeout') truncated = true
    const forDraft = results.get(d) ?? new Map<string, Activity>()
    forDraft.set(p, a)
    results.set(d, forDraft)
  })
  if (signal?.aborted || Date.now() > runDeadline) truncated = true

  // ---- Step 8: defaults, reasons, dismissals
  const dismissed = new Set(opts.dismissedKeys)
  const sliceKeys = opts.initialActiveKeys
  const candidates: DiscoveryCandidate[] = []
  const hidden: DiscoveryCandidate[] = []
  for (const d of pool) {
    const perPath = results.get(d) ?? new Map<string, Activity>()
    const acts = [...perPath.values()]
    const folderMs = maxOrNull(...acts.map((a) => a.lastMs))
    const lastMs = maxOrNull(folderMs, d.unitMtime)
    const gitWon = acts.some((a) => a.signal === 'git' && a.lastMs === lastMs)
    const activitySignal: DiscoveryCandidate['activitySignal'] =
      lastMs === null
        ? acts.some((a) => a.signal === 'timeout')
          ? 'timeout'
          : 'none'
        : gitWon
          ? 'git'
          : 'files'
    const days = lastMs === null ? null : localDaysBetween(new Date(lastMs), now)
    const recent = days !== null && days <= ACTIVE_WINDOW_DAYS
    const sliced = inSlice(sliceKeys, [d.name, ...d.names])
    const raw = d.adopted
    const saved = raw ? withWorkstreamDefaults(raw) : null

    let status: WorkstreamStatus = 'active'
    if (saved) {
      status = opts.firstRun ? (sliced ? 'active' : 'paused') : saved.status
    }
    const included = !!saved || (opts.firstRun && sliced)

    const kind: WorkstreamKind =
      raw && isWorkstreamKind(raw.kind)
        ? raw.kind
        : courseCode(d.name) ||
            d.names.some((n) => courseCode(n)) ||
            /thesis|assignment|exam/i.test(d.name)
          ? 'deadline'
          : d.category === 'Projects'
            ? 'passion'
            : 'ongoing'
    const category: ItemCategory = raw && isItemCategory(raw.category) ? raw.category : d.category

    const reasons: string[] = []
    if (days !== null && lastMs !== null) {
      if (!recent) reasons.push(`Quiet since ${shortDate(new Date(lastMs), now)}`)
      else reasons.push(gitWon ? `Last commit ${ago(days)}` : `Changed ${ago(days)}`)
    }
    reasons.push(...d.reasons)
    if (saved && opts.firstRun && !sliced) {
      reasons.push("Paused for now. It's saved and ready when you are.")
    }

    const name = raw ? raw.name : d.name
    const candidate: DiscoveryCandidate = {
      key: d.key,
      name,
      ...(raw && /^[a-z]{4}\d{4}$/.test(raw.name) ? { suggestedName: raw.name.toUpperCase() } : {}),
      category,
      kind,
      status,
      included,
      inSlice: sliced,
      recent,
      sources: d.sources.map((s) =>
        s.type === 'folder' && s.match !== 'user'
          ? {
              ...s,
              lastActivityAt: iso(perPath.get(s.path)?.lastMs ?? null)
            }
          : s
      ),
      lastActivityAt: iso(lastMs),
      activitySignal,
      ...(raw ? { adoptsProjectId: raw.id } : {}),
      reasons
    }
    if (!raw && dismissed.has(d.key)) hidden.push(candidate)
    else candidates.push(candidate)
  }

  const order: ItemCategory[] = ['Learning', 'Career', 'Projects', 'Life']
  const byActivity = (a: DiscoveryCandidate, b: DiscoveryCandidate): number =>
    order.indexOf(a.category) - order.indexOf(b.category) ||
    Number(b.included) - Number(a.included) ||
    (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') ||
    a.name.localeCompare(b.name)
  candidates.sort(byActivity)
  hidden.sort(byActivity)
  if (truncated) warnings.push('I stopped early; some dates may be missing.')

  return {
    ranAt: now.toISOString(),
    vault: opts.vault,
    roots,
    candidates,
    existingUnmatched,
    dismissed: hidden,
    dismissedKeys: [...dismissed],
    truncated,
    warnings
  }
}

export interface ScanSourceOptions {
  roots: DiscoverRootInput[]
  vault: VaultInfo
  now?: Date
  home?: string
  git?: (dir: string) => Promise<number | null>
  signal?: AbortSignal
}

/** Warm, path-free refusal for a picked path the guard denies. */
export function refusalFor(reason: string, roots: DiscoverRootInput[]): string {
  if (reason === 'life') return "Your vault's Life folder stays closed. Pick something else."
  if (reason === 'secret') return "That looks like it holds secrets, so I'll leave it alone."
  const where = [...roots.map((r) => r.label), 'your vault']
    .join(', ')
    .replace(/, ([^,]*)$/, ' and $1')
  return `FocusForge only reads ${where} for now.`
}

/**
 * "Add a folder or note": one candidate for a path the owner picked. Folders
 * inside the roots or vault, or Markdown notes inside the vault.
 */
export async function scanSource(
  guard: PathGuard,
  absPath: string,
  opts: ScanSourceOptions
): Promise<{ candidate: DiscoveryCandidate } | { error: string }> {
  const d = guard.check(absPath)
  if (!d.ok) return { error: refusalFor(d.reason, opts.roots) }
  const st = await guard.statReadable(d.real)
  if (!st) return { error: "I couldn't open that. Try another folder." }
  const home = opts.home ?? os.homedir()
  const now = opts.now ?? new Date()
  const real = d.real
  const vaultPath = opts.vault.valid && opts.vault.path ? opts.vault.path : null
  const vaultCheck = vaultPath ? guard.check(vaultPath) : null
  const vaultReal = vaultCheck ? (vaultCheck.ok ? vaultCheck.real : vaultPath) : null
  const inVault =
    !!vaultReal &&
    (guard.fold(real) === guard.fold(vaultReal) ||
      guard.fold(real).startsWith(guard.fold(vaultReal) + path.sep))
  const isDir = st.isDirectory()
  if (!isDir && !(inVault && isMd(real))) {
    return { error: 'Pick a folder, or a note from your vault.' }
  }
  if (inVault && guard.fold(real) === guard.fold(vaultReal!)) {
    return { error: 'Pick a folder or note inside your vault, not the whole vault.' }
  }

  let category: ItemCategory
  const baseName = stem(path.basename(real))
  if (inVault) {
    const top = path.relative(vaultReal!, real).split(path.sep)[0]
    category = itemCategoryForVault(top, baseName)
  } else {
    const root = opts.roots
      .filter((r) => {
        const rr = guard.check(r.path)
        const rp = guard.fold(rr.ok ? rr.real : r.path)
        return guard.fold(real) === rp || guard.fold(real).startsWith(rp + path.sep)
      })
      .sort((a, b) => b.path.length - a.path.length)[0]
    category = root?.category ?? (courseCode(baseName) ? 'Learning' : 'Projects')
  }

  const act = await scanActivity(guard, real, {
    deadline: Date.now() + 1500,
    signal: opts.signal,
    git: opts.git
  })
  const days = act.lastMs === null ? null : localDaysBetween(new Date(act.lastMs), now)
  const rel = path.relative(home, real)
  const label = inVault
    ? path.basename(real) + (isDir ? '/' : '')
    : rel && !rel.startsWith('..') && !path.isAbsolute(rel)
      ? `~/${rel}`
      : real
  const name = isDir && !inVault ? displayNameFor(baseName) : baseName
  const kind: WorkstreamKind =
    courseCode(name) || /thesis|assignment|exam/i.test(name)
      ? 'deadline'
      : category === 'Projects'
        ? 'passion'
        : 'ongoing'
  return {
    candidate: {
      key: guard.fold(real),
      name,
      category,
      kind,
      status: 'active',
      included: true,
      inSlice: false,
      recent: days !== null && days <= ACTIVE_WINDOW_DAYS,
      sources: [
        {
          path: real,
          type: inVault ? (isDir ? 'vault-folder' : 'vault-note') : 'folder',
          label,
          match: 'user',
          lastActivityAt: iso(act.lastMs)
        }
      ],
      lastActivityAt: iso(act.lastMs),
      activitySignal: act.signal,
      reasons: days === null ? ['Added by you'] : [`Changed ${ago(days)}`, 'Added by you']
    }
  }
}
