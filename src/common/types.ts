// src/common/types.ts
import type { AssessmentInfo } from './outline'
import type { Recurrence } from './recurrence'

export type SubtaskStatus = 'todo' | 'doing' | 'done'

const NO_FOLLOWUP_SENTINEL = 'DO NOT ASK FOLLOW UP QUESTIONS'
const MAX_TITLE_LENGTH = 80

/**
 * Derives a clean, human-readable task title from raw user input.
 * - Strips the "DO NOT ASK FOLLOW UP QUESTIONS" sentinel (case-insensitive, tolerates trailing punctuation).
 * - Trims surrounding whitespace and trailing punctuation runs.
 * - Collapses internal newlines / multiple spaces.
 * - Truncates to MAX_TITLE_LENGTH with ellipsis.
 * Returns '' if nothing usable remains.
 */
export function cleanTaskTitle(raw: string): string {
  if (!raw) return ''
  // Strip sentinel (case-insensitive) and any trailing punctuation around it
  let s = raw.replace(new RegExp(`[.!?;:\\s]*${NO_FOLLOWUP_SENTINEL}[.!?;:\\s]*$`, 'i'), '')
  // Collapse newlines and multiple spaces
  s = s.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ')
  // Trim trailing punctuation and whitespace
  s = s.replace(/[.!?;:\s]+$/, '').trim()
  if (!s) return ''
  if (s.length > MAX_TITLE_LENGTH) return s.slice(0, MAX_TITLE_LENGTH).trimEnd() + '…'
  return s
}

/**
 * Single source of truth for flipping a subtask's completion: keeps
 * `isCompleted` and `completedAt` in lockstep so the (scattered) completion
 * call sites - manual toggle, Start Now, AI mutation reset - can never drift.
 */
export function withCompletion<
  T extends { isCompleted: boolean; completedAt?: string; status?: SubtaskStatus }
>(subtask: T, isCompleted: boolean): T {
  return setSubtaskStatus(subtask, isCompleted ? 'done' : 'todo')
}

/**
 * Canonical state transition for a subtask. The Kanban board has three columns
 * (todo/doing/done) but the rest of the app keys off `isCompleted`/`completedAt`
 * (progress, streaks, burndown, getUpcomingSubtasks), so all three fields must
 * move together: done <=> isCompleted + completedAt; todo/doing <=> incomplete.
 */
export function setSubtaskStatus<
  T extends { isCompleted: boolean; completedAt?: string; status?: SubtaskStatus }
>(subtask: T, status: SubtaskStatus): T {
  const isCompleted = status === 'done'
  return {
    ...subtask,
    status,
    isCompleted,
    completedAt: isCompleted ? (subtask.completedAt ?? new Date().toISOString()) : undefined
  }
}

/** Derives a column for subtasks saved before `status` existed. */
export function deriveStatus(subtask: {
  isCompleted: boolean
  status?: SubtaskStatus
}): SubtaskStatus {
  return subtask.status ?? (subtask.isCompleted ? 'done' : 'todo')
}

/**
 * Subtask represents the smallest unit of work.
 */
export interface Subtask {
  id: string
  title: string
  isCompleted: boolean
  status?: SubtaskStatus // kanban column; derived from isCompleted when absent
  completedAt?: string // ISO datetime, set when completed, cleared when un-completed
  difficulty?: 'easy' | 'medium' | 'hard'
  timeEstimate?: number // in minutes
  scheduledDate?: string // YYYY-MM-DD
  focusSeconds?: number // accumulated Focus-mode time on this step
}

/**
 * Prerequisite: something to learn / acquire / set up BEFORE the execution
 * steps can start. Surfaced as a distinct "Before you start" phase, not mixed
 * into the flat checklist.
 */
export interface Prerequisite {
  id: string
  title: string
  kind?: 'learn' | 'acquire' | 'setup'
  // Minutes; prerequisites are capped small (<=15) by the execution prompt
  timeEstimate?: number
  isCompleted: boolean
}

/**
 * Contract for python script.
 * When the AI is called, this JSON structure is expected.
 */
export interface DecompositionResult {
  originalTask: string
  subtasks: Subtask[]
  prerequisites?: Prerequisite[]
}

/**
 * ActivityStats: aggregated completion activity across every project, for the
 * streak counter and calendar heatmap. Derived on read from subtask
 * `completedAt` timestamps - nothing extra is persisted.
 */
export interface ActivityStats {
  currentStreak: number
  longestStreak: number
  countsByDate: Record<string, number> // 'YYYY-MM-DD' -> # subtasks completed that day
  totalCompleted: number
}

/**
 * ChatMessage: a single turn in the clarification dialogue.
 */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * LEDGER_SECTIONS: the fixed headings in a project's context_<projectId>.md
 * ledger, in the order they appear. Single source of truth for the section
 * contract on the TS side (main process + renderer both import this).
 */
export const LEDGER_SECTIONS = [
  'Constraints & Specifications',
  'Document Excerpts',
  'Milestones & Completed Work',
  'Plan Adjustments'
] as const

/**
 * LedgerSection: one of the fixed ledger headings. Every write to project
 * state names which section it belongs under.
 */
export type LedgerSection = (typeof LEDGER_SECTIONS)[number]

export interface LedgerNote {
  section: LedgerSection
  note: string
}

/**
 * USER_PROFILE_SECTIONS: the three user-editable headings in
 * system/user_profile.md. "Projects Overview" is machine-owned
 * (auto-regenerated on read) and is never a valid target for LLM-emitted notes,
 * so it is deliberately not part of this list.
 */
export const USER_PROFILE_SECTIONS = ['About Me', 'Preferences', 'Patterns & Friction'] as const

/**
 * UserProfileSection: one of the three user-editable profile headings.
 */
export type UserProfileSection = (typeof USER_PROFILE_SECTIONS)[number]

export interface UserProfileNote {
  section: UserProfileSection
  note: string
}

/**
 * EngineResponse: what engine/main.py returns for every chat turn.
 * `data` stays null until the conversation concludes or a mutation is applied.
 * `notes` are durable facts the engine recognized this turn, to be appended
 * to context_<projectId>.md by the main process.
 */
export interface EngineResponse {
  // 'cancelled': the user pressed Stop; nothing was generated or saved.
  status: 'clarifying' | 'complete' | 'updated' | 'error' | 'cancelled'
  message: string
  data: DecompositionResult | null
  notes?: LedgerNote[]
  userNotes?: UserProfileNote[]
}

/**
 * ChatTurnPayload: what the renderer sends to the engine for every turn.
 * The main process reads context_<projectId>.md for `projectId` and injects it
 * server-side - the renderer never carries ledger content itself.
 * `currentChecklist` being present switches the engine into mutation mode:
 * the message is treated as a request to adjust an existing plan rather
 * than as part of initial intake.
 */
export interface ChatTurnPayload {
  projectId: string
  messages: ChatMessage[]
  deadline: string
  depth: string
  model: string
  currentChecklist?: DecompositionResult
}

/**
 * ProjectTask: The "Container" that holds the metadata AND the list of steps.
 * We use this for saving/loading from the JSON file.
 */
export interface ProjectTask {
  id: string
  title: string
  createdAt: string
  deadline: string
  status: string
  depth: string
  model: string

  // Store subtask objects
  subtasks: Subtask[]

  // "Learn -> do" phase: things to acquire before the steps start
  prerequisites?: Prerequisite[]

  // The dialogue that produced this task, if any
  conversation?: ChatMessage[]

  // Set on tasks imported from a course outline (status 'unplanned' until planned)
  assessment?: AssessmentInfo

  // Weekly series: the template carries `recurrence`; every task in the series
  // (template included) shares `seriesId`.
  recurrence?: Recurrence
  seriesId?: string
}

/**
 * ProjectData: the on-disk shape of a project's project_data.json.
 * `lastModel` remembers the model last used in this project so the workspace
 * dropdown can default to it (falling back to the most recent task's model,
 * then the user's chat model from settings).
 */
export interface ProjectData {
  name?: string
  created?: string
  tasks: ProjectTask[]
  lastModel?: string
  // Save counter, bumped by the main process on every write. Renderer
  // load-modify-save paths send back the rev they loaded so a concurrent
  // write is detected instead of silently overwritten. Absent = 0.
  rev?: number
}

/** Result of the "Stuck?" split: the new steps that replaced the stuck one. */
export interface SplitStepResult {
  success: boolean
  message: string
  cancelled?: boolean
  created?: Subtask[]
}

/** Registry entry: the summarized project record kept in master_index.json. */
export interface ProjectSummary {
  id: string
  name: string
  path: string
  progress: number
  lastActive: string
}

/** Result of a project save; `conflict` means reload and re-apply the change. */
export interface SaveResult {
  success: boolean
  error?: string
  conflict?: boolean
  rev?: number
}

/**
 * UpcomingSubtask: an incomplete subtask flattened out across every
 * project/task, for the dashboard's mood-based suggestion view. Subtasks
 * with no `difficulty` set are treated as 'medium' when flattened.
 */
export interface UpcomingSubtask {
  projectId: string
  projectName: string
  taskId: string
  taskTitle: string
  subtaskId: string
  subtaskTitle: string
  difficulty: 'easy' | 'medium' | 'hard'
  timeEstimate?: number
  scheduledDate?: string
  deadline: string
  daysRemaining: number
}
