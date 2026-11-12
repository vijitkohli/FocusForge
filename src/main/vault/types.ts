// src/main/vault/types.ts
// Shapes for Phase 4 vault notes. Types only, no runtime code.
//
// The digest comes from Phase 3 (src/common/digest.ts) and the milestone,
// origin, deadlineKind, gapId and Loose-ends fields from Phase 5/3
// (src/common/types.ts); they are re-exported here under the names the vault
// modules use.
import type { ProjectTask, Subtask, Workstream } from '../../common/types'

export type {
  DigestCandidateTask,
  DigestDueDate,
  DigestSource,
  GapKind,
  ItemDigest
} from '../../common/digest'
export type { DeadlineKind, Milestone, MilestoneStatus, TaskOrigin } from '../../common/types'
import type { ItemDigest } from '../../common/digest'

/** A step as stored (carries Phase 5 `milestoneId` and Phase 3 `gapId`). */
export type PlannedSubtask = Subtask

/** A task as stored (milestones, origin, deadlineKind, auto). */
export type TaskWithPlan = ProjectTask

// ---- Phase 4's own shapes ----

export type BlockKind = 's' | 'g' | 'p' | 't' | 'm'

export type VaultLogKind =
  | 'tick'
  | 'untick'
  | 'done'
  | 'task-done'
  | 'milestone-done'
  | 'planned'
  | 'progress'
  | 'commit'
  | 'notice'

export interface VaultLogEntry {
  /** ISO */
  at: string
  /** Local YYYY-MM-DD */
  date: string
  kind: VaultLogKind
  text: string
  taskId?: string
  /** De-duplication key, e.g. `commit:<hash>`. */
  key: string
}

export type NoteKind = 'item' | 'task' | 'about'

export interface NoteRecord {
  itemId: string
  taskId?: string
  kind: NoteKind
  hash: string
  mtimeMs: number
  size: number
  /** The three-way base for ticks. */
  checks: Record<string, boolean>
  /** `^ff-t` id -> subtask ids that tick completed (Q1). */
  bulk?: Record<string, string[]>
  appRegionHash: string
  myNotesHash: string
  state: 'ok' | 'deleted' | 'evicted' | 'removed' | 'conflict' | 'error'
  conflicts?: string[]
  writtenAt: string
  /** Item notes: the folder the app chose (the note itself may have been moved by the owner). */
  folder?: string
  /** Item notes: the item status last written (Q3: paused/archived get one final status write). */
  itemStatus?: string
  /** Item or task title, for status messages. */
  title?: string
  /** Epoch ms before which an evicted note isn't retried. */
  retryAt?: number
}

export interface VaultSyncState {
  version: 1
  /** Keyed by vault-relative path (NFC). */
  notes: Record<string, NoteRecord>
  paused?: 'folder-removed'
  /** ISO time of the last completed sync pass. */
  lastSyncAt?: string
  /** Paths under FocusForge/ holding files the app didn't write: never written, never reused. */
  foreign?: string[]
}

export type { VaultSyncStatus } from '../../common/vault'

/** What a render produces; `composeNote` turns it into the file text. */
export interface RenderedNote {
  /** App-owned frontmatter keys and their YAML values, in order (`updated` is added by composeNote). */
  frontmatter: [key: string, yaml: string][]
  /** The app region: preamble and every `## … (auto)` section, '\n' line ends. */
  body: string
  /** Every tickable block id in the note and whether it is checked. */
  checks: Record<string, boolean>
  /** Duplicate block ids dropped while rendering. */
  warnings: string[]
}

export interface RenderContext {
  /** Local YYYY-MM-DD. */
  today: string
  /** For `~/…` source labels. */
  home?: string
  /** For `[[…]]` source labels of vault notes. */
  vaultRoot?: string
}

export interface ItemNoteInput extends RenderContext {
  item: Workstream
  tasks: TaskWithPlan[]
  /** taskId -> vault-relative task note path. */
  taskLinks: Record<string, string>
  digest: ItemDigest | null
  log: VaultLogEntry[]
  /** Set for the final write after the item was removed from FocusForge. */
  removedOn?: string
}

export interface TaskNoteInput extends RenderContext {
  item: Workstream
  task: TaskWithPlan
  /** Vault-relative path of the item note. */
  itemRel: string
  log: VaultLogEntry[]
  removedOn?: string
}
