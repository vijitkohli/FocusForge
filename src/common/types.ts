// src/common/types.ts

export type SubtaskStatus = 'todo' | 'doing' | 'done';

const NO_FOLLOWUP_SENTINEL = 'DO NOT ASK FOLLOW UP QUESTIONS';
const MAX_TITLE_LENGTH = 80;

/**
 * Derives a clean, human-readable task title from raw user input.
 * - Strips the "DO NOT ASK FOLLOW UP QUESTIONS" sentinel (case-insensitive, tolerates trailing punctuation).
 * - Trims surrounding whitespace and trailing punctuation runs.
 * - Collapses internal newlines / multiple spaces.
 * - Truncates to MAX_TITLE_LENGTH with ellipsis.
 * Returns '' if nothing usable remains.
 */
export function cleanTaskTitle(raw: string): string {
    if (!raw) return '';
    // Strip sentinel (case-insensitive) and any trailing punctuation around it
    let s = raw.replace(new RegExp(`[.!?;:\\s]*${NO_FOLLOWUP_SENTINEL}[.!?;:\\s]*$`, 'i'), '');
    // Collapse newlines and multiple spaces
    s = s.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ');
    // Trim trailing punctuation and whitespace
    s = s.replace(/[.!?;:\s]+$/, '').trim();
    if (!s) return '';
    if (s.length > MAX_TITLE_LENGTH) return s.slice(0, MAX_TITLE_LENGTH).trimEnd() + '…';
    return s;
}

/**
 * Single source of truth for flipping a subtask's completion: keeps
 * `isCompleted` and `completedAt` in lockstep so the (scattered) completion
 * call sites - manual toggle, Start Now, AI mutation reset - can never drift.
 */
export function withCompletion<T extends { isCompleted: boolean; completedAt?: string; status?: SubtaskStatus }>(
    subtask: T,
    isCompleted: boolean
): T {
    return setSubtaskStatus(subtask, isCompleted ? 'done' : 'todo');
}

/**
 * Canonical state transition for a subtask. The Kanban board has three columns
 * (todo/doing/done) but the rest of the app keys off `isCompleted`/`completedAt`
 * (progress, streaks, burndown, getUpcomingSubtasks), so all three fields must
 * move together: done <=> isCompleted + completedAt; todo/doing <=> incomplete.
 */
export function setSubtaskStatus<T extends { isCompleted: boolean; completedAt?: string; status?: SubtaskStatus }>(
    subtask: T,
    status: SubtaskStatus
): T {
    const isCompleted = status === 'done';
    return {
        ...subtask,
        status,
        isCompleted,
        completedAt: isCompleted ? subtask.completedAt ?? new Date().toISOString() : undefined
    };
}

/** Derives a column for subtasks saved before `status` existed. */
export function deriveStatus(subtask: { isCompleted: boolean; status?: SubtaskStatus }): SubtaskStatus {
    return subtask.status ?? (subtask.isCompleted ? 'done' : 'todo');
}

/**
 * Subtask represents the smallest unit of work.
 */
export interface Subtask {
    id: string;
    title: string;
    isCompleted: boolean;
    status?: SubtaskStatus; // kanban column; derived from isCompleted when absent
    completedAt?: string; // ISO datetime, set when completed, cleared when un-completed
    difficulty?: 'easy' | 'medium' | 'hard';
    timeEstimate?: number; // in minutes
    scheduledDate?: string // YYYY-MM-DD
}

/**
 * Prerequisite: something to learn / acquire / set up BEFORE the execution
 * steps can start. Surfaced as a distinct "Before you start" phase, not mixed
 * into the flat checklist.
 */
export interface Prerequisite {
    id: string;
    title: string;
    kind?: 'learn' | 'acquire' | 'setup';
    isCompleted: boolean;
}

/**
 * Contract for python script.
 * When the AI is called, this JSON structure is expected.
 */
export interface DecompositionResult {
    originalTask: string;
    subtasks: Subtask[];
    prerequisites?: Prerequisite[];
}

/**
 * ActivityStats: aggregated completion activity across every project, for the
 * streak counter and calendar heatmap. Derived on read from subtask
 * `completedAt` timestamps - nothing extra is persisted.
 */
export interface ActivityStats {
    currentStreak: number;
    longestStreak: number;
    countsByDate: Record<string, number>; // 'YYYY-MM-DD' -> # subtasks completed that day
    totalCompleted: number;
}

/**
 * ChatMessage: a single turn in the clarification dialogue.
 */
export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

/**
 * LedgerSection: the fixed headings in a project's context_<projectId>.md ledger.
 * Every write to project state names which section it belongs under.
 */
export type LedgerSection =
    | 'Constraints & Specifications'
    | 'Document Excerpts'
    | 'Milestones & Completed Work'
    | 'Plan Adjustments';

export interface LedgerNote {
    section: LedgerSection;
    note: string;
}

/**
 * UserProfileSection: the three user-editable headings in system/user_profile.md.
 * "Projects Overview" is machine-owned (auto-regenerated on read) and is never
 * a valid target for LLM-emitted notes.
 */
export type UserProfileSection =
    | 'About Me'
    | 'Preferences'
    | 'Patterns & Friction';

export interface UserProfileNote {
    section: UserProfileSection;
    note: string;
}

/**
 * EngineResponse: what engine/main.py returns for every chat turn.
 * `data` stays null until the conversation concludes or a mutation is applied.
 * `notes` are durable facts the engine recognized this turn, to be appended
 * to context_<projectId>.md by the main process.
 */
export interface EngineResponse {
    status: 'clarifying' | 'complete' | 'updated' | 'error';
    message: string;
    data: DecompositionResult | null;
    notes?: LedgerNote[];
    userNotes?: UserProfileNote[];
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
    projectId: string;
    messages: ChatMessage[];
    deadline: string;
    depth: string;
    model: string;
    currentChecklist?: DecompositionResult;
}

/**
 * ProjectTask: The "Container" that holds the metadata AND the list of steps.
 * We use this for saving/loading from the JSON file.
 */
export interface ProjectTask {
    id: string;
    title: string;
    createdAt: string;
    deadline: string;
    status: string;
    depth: string;
    model: string;

    // Store subtask objects
    subtasks: Subtask[];

    // "Learn -> do" phase: things to acquire before the steps start
    prerequisites?: Prerequisite[];

    // The dialogue that produced this task, if any
    conversation?: ChatMessage[];
}

/**
 * Type definition (JSON structure)
 */
export interface ProjectData {
    projectId: string;
    tasks: ProjectTask[]
}

/**
 * UpcomingTask: a task flattened out of its project for the dashboard's
 * deadline view, with deadline math already computed.
 */
export interface UpcomingTask {
    projectId: string;
    projectName: string;
    taskId: string;
    taskTitle: string;
    deadline: string;
    daysRemaining: number;
    isComplete: boolean;
}

/**
 * UpcomingSubtask: an incomplete subtask flattened out across every
 * project/task, for the dashboard's mood-based suggestion view. Subtasks
 * with no `difficulty` set are treated as 'medium' when flattened.
 */
export interface UpcomingSubtask {
    projectId: string;
    projectName: string;
    taskId: string;
    taskTitle: string;
    subtaskId: string;
    subtaskTitle: string;
    difficulty: 'easy' | 'medium' | 'hard';
    timeEstimate?: number;
    scheduledDate?: string;
    deadline: string;
    daysRemaining: number;
}