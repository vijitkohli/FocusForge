// src/main/sources/activity.ts
// "When did this last change?" from names and dates only: the newest mtime of
// non-dot files (via the guard's walk) and `git log -1` when the folder is a
// repo. No file contents are read.
import { execFile } from 'child_process'
import type { PathGuard } from './guard'

export type ExecFileLike = (
  file: string,
  args: string[],
  opts: { timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean },
  cb: (err: Error | null, stdout: string | Buffer) => void
) => unknown

/** Last commit time (ms) or null on any failure: no git, not a repo, timeout. */
export function gitLastCommit(
  dir: string,
  timeoutMs = 2000,
  exec: ExecFileLike = execFile as unknown as ExecFileLike
): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      exec(
        'git',
        ['-C', dir, '-c', 'core.fsmonitor=false', 'log', '-1', '--format=%ct'],
        {
          timeout: timeoutMs,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
          windowsHide: true
        },
        (err, stdout) => {
          if (err) return resolve(null)
          const n = parseInt(String(stdout).trim(), 10)
          resolve(Number.isFinite(n) && n > 0 ? n * 1000 : null)
        }
      )
    } catch {
      resolve(null)
    }
  })
}

export interface Activity {
  lastMs: number | null
  signal: 'git' | 'files' | 'none' | 'timeout'
  truncated: boolean
}

export interface ActivityOptions {
  /** Absolute Date.now() ms for this scan. */
  deadline?: number
  signal?: AbortSignal
  maxEntries?: number
  maxDepth?: number
  git?: (dir: string) => Promise<number | null>
}

/** Newest change in a folder (or a single file's mtime). */
export async function scanActivity(
  guard: PathGuard,
  target: string,
  opts: ActivityOptions = {}
): Promise<Activity> {
  const st = await guard.statReadable(target)
  if (!st) return { lastMs: null, signal: 'none', truncated: false }
  if (!st.isDirectory()) return { lastMs: st.mtimeMs, signal: 'files', truncated: false }

  let files: number | null = null
  const gen = guard.walk(target, {
    maxDepth: opts.maxDepth ?? 4,
    maxEntries: opts.maxEntries ?? 3000,
    deadline: opts.deadline,
    signal: opts.signal,
    filesOnly: true
  })
  let stats: { truncated: boolean; reason?: string } = { truncated: false }
  for (;;) {
    const r = await gen.next()
    if (r.done) {
      stats = r.value
      break
    }
    if (r.value.name.startsWith('.')) continue // .DS_Store and friends
    if (files === null || r.value.mtimeMs > files) files = r.value.mtimeMs
  }

  let git: number | null = null
  if (!opts.signal?.aborted && (await guard.hasMarker(target, '.git'))) {
    git = await (opts.git ?? ((d) => gitLastCommit(d)))(target)
  }

  const lastMs = Math.max(files ?? -Infinity, git ?? -Infinity)
  const truncated = stats.truncated
  if (!Number.isFinite(lastMs)) {
    return {
      lastMs: null,
      signal: truncated && stats.reason !== 'entries' ? 'timeout' : 'none',
      truncated
    }
  }
  return { lastMs, signal: git !== null && git >= (files ?? 0) ? 'git' : 'files', truncated }
}
