// src/main/sources/watch.ts
// What to watch for one item, and which watch events matter.
//
// Rules (instruction.md + PHASE3_PLAN §2):
// - Folder sources get one recursive fs.watch (FSEvents on macOS) on their
//   real path. The vault root, anything above a root, `<vault>/FocusForge/`
//   and any folder that is itself an Obsidian vault are never watched
//   recursively; only named subfolders are.
// - Single notes and sections are stat-polled through the guard (a parent
//   folder watch could be the vault root and would deliver Life names).
// - Event names are filtered by pure name rules before anything happens; an
//   event only marks the item dirty and nothing is read here.
import path from 'path'
import { splitSourceRef } from '../../common/sourceRef'
import type { PathGuard } from './guard'
import {
  APP_VAULT_DIR,
  foldName,
  isLifeDirName,
  isNoiseDir,
  isSecretName,
  unwrapICloudStub
} from './rules'

export interface Watcher {
  close(): void
  on(ev: 'error', cb: (e: Error) => void): unknown
}

export interface WatchFs {
  watch(
    p: string,
    o: { recursive: boolean; persistent: boolean },
    cb: (event: string, filename: string | Buffer | null) => void
  ): Watcher
}

export interface WatchPlan {
  /** Real folder paths for one recursive watcher each. */
  recursive: string[]
  /** Note paths (no heading) to stat-poll. */
  poll: string[]
  /** Sources that can't be watched (denied, missing, too broad). */
  skipped: number
}

const TEMP_NAME = /^(\.ds_store|.*\.tmp|.*\.swp|.*\.swx|~\$.*|\.~lock.*|.*~)$/i

/**
 * Whether a watch event matters, from its root-relative name alone (no fs
 * call): 'git' for HEAD/branch moves, 'files' for content, null to ignore.
 */
export function relevantEvent(filename: string | Buffer | null): 'files' | 'git' | null {
  if (filename === null || filename === undefined) return 'files'
  const name = typeof filename === 'string' ? filename : filename.toString('utf8')
  if (!name) return 'files'
  const segs = name.split(/[\\/]+/).filter(Boolean)
  if (segs.length === 0) return 'files'
  if (segs[0] === '.git') {
    const rest = segs.slice(1).join('/')
    if (
      rest === 'HEAD' ||
      rest === 'logs/HEAD' ||
      rest.startsWith('refs/heads/') ||
      rest.startsWith('logs/refs/heads/')
    ) {
      return 'git'
    }
    return null
  }
  if (isLifeDirName(segs[0])) return null
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (isSecretName(s)) return null
    if (i < segs.length - 1 && isNoiseDir(s)) return null
  }
  const last = unwrapICloudStub(segs[segs.length - 1])
  if (TEMP_NAME.test(last)) return null
  // Dot-files and dot-dirs at the end (e.g. `.obsidian`, `.venv`) are noise too.
  if (last.startsWith('.')) return null
  return 'files'
}

/** A root (vault/source), or a folder above one: never read or watched as a whole. */
export function isRootOrAbove(guard: PathGuard, abs: string): boolean {
  const roots = guard.roots()
  const all = [...(roots.vault ? [roots.vault] : []), ...roots.source].map((r) => guard.fold(r))
  const f = guard.fold(abs)
  const prefix = f.endsWith(path.sep) ? f : f + path.sep
  return all.some((r) => r === f || r.startsWith(prefix))
}

function underAppDir(guard: PathGuard, abs: string): boolean {
  const vault = guard.roots().vault
  if (!vault) return false
  const v = guard.fold(vault)
  const f = guard.fold(abs)
  if (!f.startsWith(v + path.sep)) return false
  return foldName(f.slice(v.length + 1).split(path.sep)[0]) === foldName(APP_VAULT_DIR)
}

/** Recursive watches for folders, polls for notes; everything checked by the guard. */
export async function planWatches(guard: PathGuard, sources: string[]): Promise<WatchPlan> {
  const recursive = new Set<string>()
  const poll = new Set<string>()
  let skipped = 0
  for (const ref of sources) {
    const { path: p, heading } = splitSourceRef(ref)
    const d = guard.check(p)
    if (!d.ok || underAppDir(guard, p) || underAppDir(guard, d.real)) {
      skipped++
      continue
    }
    const st = await guard.statReadable(p)
    if (!st) {
      skipped++
      continue
    }
    if (st.isDirectory() && !heading) {
      if (
        isRootOrAbove(guard, p) ||
        isRootOrAbove(guard, d.real) ||
        (await guard.hasMarker(p, '.obsidian'))
      ) {
        skipped++
        continue
      }
      recursive.add(d.real)
    } else if (st.isFile()) {
      poll.add(d.real)
    } else {
      skipped++
    }
  }
  return { recursive: [...recursive], poll: [...poll], skipped }
}
