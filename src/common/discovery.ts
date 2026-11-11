// src/common/discovery.ts
// Shapes shared by discovery (main), the IPC layer and the approval screen.
// Paths only: nothing here ever carries file contents, and nothing denied by
// the path guard is ever put in these objects.
import type { Workstream, WorkstreamKind, WorkstreamStatus } from './types'
import type { ItemCategory } from './workstreams'

export interface CandidateSource {
  /** Absolute (real) path, or `<note>.md#<heading>` for a section. */
  path: string
  type: 'folder' | 'vault-note' | 'vault-folder' | 'vault-section'
  /** Short display label: '~/UNI/thesis', 'Thesis.md', 'IDEAS TO DO.md › FocusForge'. */
  label: string
  /**
   * How it got attached: primary (the candidate's own folder/note), code
   * (same course code), exact (same normalised name), similar (course code one
   * letter off), tokens (name words match), merge (sibling folder), section
   * (a heading in a list note), user (added by hand or kept from a saved item).
   */
  match: 'primary' | 'exact' | 'code' | 'similar' | 'tokens' | 'merge' | 'user' | 'section'
  lastActivityAt: string | null
  heading?: string
}

export interface DiscoveryCandidate {
  /** Stable: folded real path of the primary source. */
  key: string
  name: string
  /** Offered when an adopted entry's name is a bare lowercase course code. */
  suggestedName?: string
  category: ItemCategory
  kind: WorkstreamKind
  status: WorkstreamStatus
  /**
   * Starts ticked. True for the first-run slice and for existing entries
   * (which are never deleted); every other suggestion starts unticked and is
   * never created unless the owner ticks it.
   */
  included: boolean
  /** In the first-run slice (settings.initialActiveKeys). */
  inSlice: boolean
  /** Changed within ACTIVE_WINDOW_DAYS ("Also found") vs older ("Quiet for a while"). */
  recent: boolean
  sources: CandidateSource[]
  lastActivityAt: string | null
  activitySignal: 'git' | 'files' | 'none' | 'timeout'
  /** Existing registry entry this becomes. */
  adoptsProjectId?: string
  /** Short and warm: 'Changed 3 days ago', 'Matched to PSYC1023.md by a similar name'. */
  reasons: string[]
}

export interface VaultInfo {
  path: string | null
  source: 'settings' | 'obsidian' | 'none'
  valid: boolean
  /** Other vaults from obsidian.json (deny-Life roots, not readable). */
  others: string[]
}

export interface DiscoveryRoot {
  path: string
  label: string
  category: ItemCategory
  reachable: boolean
}

export interface DiscoveryResult {
  ranAt: string
  vault: VaultInfo
  roots: DiscoveryRoot[]
  candidates: DiscoveryCandidate[]
  /** Registry entries nothing matched (shown, editable, never deleted). */
  existingUnmatched: Workstream[]
  /** Hidden suggestions, kept so the screen can offer Restore. */
  dismissed: DiscoveryCandidate[]
  dismissedKeys: string[]
  truncated: boolean
  /** Warm and path-free for anything private, e.g. "Couldn't reach ~/UNI. The rest is here." */
  warnings: string[]
}

export interface ApprovedWorkstream {
  key?: string
  adoptsProjectId?: string
  name: string
  category: ItemCategory
  kind: WorkstreamKind
  status: WorkstreamStatus
  /** Source refs as shown (`path` or `path.md#heading`); main re-checks each one. */
  sources: string[]
}

export interface ApplyDiscoveryRequest {
  workstreams: ApprovedWorkstream[]
  dismissedKeys: string[]
}

export interface ApplyDiscoveryResult {
  success: boolean
  created: string[]
  updated: string[]
  /** Labels of sources that were dropped because FocusForge can't read them. */
  skippedSources?: string[]
  error?: string
}

/** Suggestions older than this (local days) go under "Quiet for a while". */
export const ACTIVE_WINDOW_DAYS = 45
