// src/main/sources/git.ts
// `git log` for a source folder that is a repo root. Runs git as a read-only
// subprocess (instruction.md allows `git log`): no optional locks, no
// fsmonitor, no prompts, no author or email in the output. Changed-file names
// that are noise or secrets are dropped before anything leaves this module.
import { execFile } from 'child_process'
import type { GitCommit } from '../../common/readers'
import type { PathGuard } from './guard'
import { isNoiseDir, isSecretName } from './rules'

export interface GitRunOptions {
  env: NodeJS.ProcessEnv
  timeout: number
  maxBuffer: number
}

/** Runs `git <args>` and resolves stdout; rejects on error, timeout or non-zero exit. */
export type GitRunner = (args: string[], o: GitRunOptions) => Promise<string>

export const defaultGitRunner: GitRunner = (args, o) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { env: o.env, timeout: o.timeout, maxBuffer: o.maxBuffer, windowsHide: true },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(String(stdout))
      }
    )
  })

export const GIT_ENV_OVERRIDES = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C'
} as const

export const MAX_FILES_PER_COMMIT = 20

export interface GitLogOptions {
  limit?: number
  timeoutMs?: number
  runner?: GitRunner
}

export type GitLogFn = (
  guard: PathGuard,
  dir: string,
  o?: GitLogOptions
) => Promise<GitCommit[] | null>

/** Keeps a changed path only when no segment is noise or a secret name. */
export function keepChangedFile(p: string): boolean {
  const segs = p.split('/').filter(Boolean)
  if (segs.length === 0) return false
  return !segs.some((s, i) => isSecretName(s) || (i < segs.length - 1 && isNoiseDir(s)))
}

/** Parses `%x1e%h%x1f%ad%x1f%s` records followed by `--name-only` lines. */
export function parseGitLog(out: string): GitCommit[] {
  const commits: GitCommit[] = []
  for (const rec of out.split('\x1e')) {
    if (!rec.trim()) continue
    const lines = rec.split('\n')
    const [hash, date, ...subject] = lines[0].split('\x1f')
    if (!hash || !date) continue
    const all = lines
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter(keepChangedFile)
    const files = all.slice(0, MAX_FILES_PER_COMMIT)
    if (all.length > MAX_FILES_PER_COMMIT) files.push(`+${all.length - MAX_FILES_PER_COMMIT} more`)
    commits.push({
      hash: hash.trim(),
      date: date.trim(),
      subject: subject.join('\x1f').trim(),
      files
    })
  }
  return commits
}

/** The last `limit` commits of a repo-root source folder, or null when git can't answer. */
export const gitLog: GitLogFn = async (guard, dir, o = {}) => {
  const d = guard.check(dir)
  if (!d.ok || !(await guard.hasMarker(dir, '.git'))) return null
  const limit = Math.max(1, Math.min(200, o.limit ?? 50))
  const args = [
    '-C',
    d.real,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'log.showSignature=false',
    '--no-pager',
    'log',
    '-n',
    String(limit),
    '--no-renames',
    '--date=iso-strict',
    '--pretty=format:%x1e%h%x1f%ad%x1f%s',
    '--name-only'
  ]
  try {
    const out = await (o.runner ?? defaultGitRunner)(args, {
      env: { ...process.env, ...GIT_ENV_OVERRIDES },
      timeout: o.timeoutMs ?? 5000,
      maxBuffer: 2 * 1024 * 1024
    })
    return parseGitLog(out)
  } catch {
    return null
  }
}
