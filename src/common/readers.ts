// src/common/readers.ts
// Shared shapes for Phase 3 readers: the per-item context pack (the stored
// format every later phase reads), its budget, and the reader status the
// renderer sees. No Node imports, so the renderer can import types from here.
//
// Privacy: `PackFile.ref` / `PackSourceStatus.ref` are absolute local paths
// and never leave the main process. Everything sent to a model or shown in
// the UI uses `label`, which is relative (`thesis/CONTEXT.md`,
// `vault:Projects/Ideas.md#FocusForge`) and never contains the vault's folder
// name or the home folder.

export const PACK_VERSION = 1

export interface PackBudget {
  /** Total excerpt characters per item. */
  maxChars: number
  /** Per-file excerpt cap (head + tail kept when cut). */
  perFileChars: number
  /** Files with content per item. */
  maxFiles: number
  gitCommits: number
  /** Reserved for git blocks. */
  gitChars: number
  /** Reserved for vault notes and sections. */
  vaultChars: number
  /** Reserved for briefs (spec/brief/rubric PDFs and docx). */
  briefChars: number
  /** The "files not shown" index. */
  indexChars: number
  /** Total bytes read from disk per build (cached excerpts don't count). */
  maxReadBytesPerBuild: number
}

export const DEFAULT_PACK_BUDGET: PackBudget = {
  maxChars: 120_000,
  perFileChars: 30_000,
  maxFiles: 80,
  gitCommits: 50,
  gitChars: 12_000,
  vaultChars: 30_000,
  briefChars: 30_000,
  indexChars: 8_000,
  maxReadBytesPerBuild: 8 * 1024 * 1024
}

export type PackFileKind =
  | 'context'
  | 'vault'
  | 'agent'
  | 'brief'
  | 'doc'
  | 'notebook'
  | 'docx'
  | 'pdf'

export interface PackFile {
  /** 'F1'…, stable within one pack, ordered by tier. */
  id: string
  /** Model-safe display path. Never absolute, never the vault's folder name, never $HOME. */
  label: string
  /** Absolute path or source ref. Local only: never sent to a model or the renderer. */
  ref: string
  kind: PackFileKind
  mtimeMs: number
  size: number
  /** sha256 of the text read (or of the extracted doc text). */
  hash: string
  chars: number
  truncated: boolean
  redactions: number
  /** Changed since the previous pack. */
  changed: boolean
  /** Excerpt: redacted and header-escaped. */
  text: string
}

export interface GitCommit {
  hash: string
  /** ISO date from git (author date). */
  date: string
  subject: string
  files: string[]
}

export interface PackGit {
  /** 'G1'… */
  id: string
  /** 'git:<folder name>' */
  label: string
  /** Newest commit hash ('' when the repo has none). */
  head: string
  commits: GitCommit[]
  text: string
}

export type SourceState =
  | 'ok'
  | 'denied'
  | 'missing'
  | 'section-missing'
  | 'too-broad'
  | 'empty'
  | 'git-unavailable'

export interface PackSourceStatus {
  /** Local only (absolute path or section ref). */
  ref: string
  state: SourceState
  /** The guard's deny reason, when denied. */
  reason?: string
  files: number
  /** True for refs added at build time (Phase 4's My notes), never stored in the registry. */
  virtual?: boolean
}

export type PackIndexNote = 'not-downloaded' | 'too-large' | 'binary' | 'unsupported'

export interface PackIndexEntry {
  label: string
  /** Local YYYY-MM-DD of the file's mtime. */
  date: string
  note?: PackIndexNote
}

export interface ContextPack {
  version: typeof PACK_VERSION
  itemId: string
  builtAt: string
  budget: PackBudget
  totalChars: number
  truncated: boolean
  sources: PackSourceStatus[]
  files: PackFile[]
  git: PackGit[]
  index: PackIndexEntry[]
  /** Files that didn't get content, so a change to them can still promote them. Keyed by label. */
  seen: Record<string, { mtimeMs: number; size: number }>
  /** Newest walked mtime or commit date (ISO), or null. */
  activityAt: string | null
  notDownloaded: number
  conflicts: number
  fingerprint: string
}

export type ReaderState =
  | 'idle'
  | 'pending'
  | 'reading'
  | 'queued'
  | 'digesting'
  | 'waiting-ai'
  | 'error'
  | 'off'
  | 'no-sources'

export type ReaderErrorCode =
  | 'source-missing'
  | 'all-denied'
  | 'auth'
  | 'invalid'
  | 'timeout'
  | 'model-error'
  | 'internal'

export interface ReaderStatus {
  itemId: string
  state: ReaderState
  watching: boolean
  lastPackAt: string | null
  lastDigestAt: string | null
  pendingSince: string | null
  files: number
  chars: number
  notDownloaded: number
  conflicts: number
  skippedSources: number
  /** Friendly copy only; never paths or content. */
  error?: { code: ReaderErrorCode; message: string }
}

/** Friendly copy for each error code (no paths, no content). */
export const READER_ERROR_COPY: Record<ReaderErrorCode, string> = {
  'source-missing': "A source folder or note can't be found. It'll retry on its own.",
  'all-denied': "FocusForge isn't allowed to read any of this item's sources.",
  auth: 'AI login problem in CLIProxyAPI.',
  invalid: "The summary didn't come out right. The last good one is kept.",
  timeout: 'The summary took too long. It will try again later.',
  'model-error': "The AI couldn't write a summary this time. It will try again later.",
  internal: "Something went wrong while reading this item's sources."
}

/** Result of `refresh-item`. */
export interface RefreshResult {
  queued: boolean
  reason?: 'not-found' | 'no-sources' | 'disabled'
}
