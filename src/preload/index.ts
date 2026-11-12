import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import {
  ChatTurnPayload,
  DecompositionResult,
  LedgerNote,
  ProjectData,
  WorkstreamPatch
} from '../common/types'
import type { ApplyDiscoveryRequest } from '../common/discovery'
import { AppSettings } from '../common/models'
import type { OutlineAssessment } from '../common/outline'
import type { TodayPlan } from '../common/today'
import type { ReaderStatus } from '../common/readers'
import type { PlanStatusEvent } from '../common/milestones'
import type { ProxyHealthView, SkipEvent, SkipReason } from '../common/whatNext'

// Custom APIs for renderer
const api = {
  // Sends the full conversation + scheduling controls for one chat turn.
  // The main process reads context_<projectId>.md server-side - the renderer never
  // carries ledger content itself.
  sendChatMessage: (payload: ChatTurnPayload) => {
    return ipcRenderer.invoke('chat-turn', payload)
  },

  // Live tokens for the in-progress clarifying question. The promise from
  // sendChatMessage still resolves with the final EngineResponse. Returns an
  // unsubscribe function.
  onChatStream: (callback: (text: string) => void) => {
    const listener = (_e: unknown, text: string): void => callback(text)
    ipcRenderer.on('chat-stream', listener)
    return () => ipcRenderer.removeListener('chat-stream', listener)
  },

  // Stop buttons: kill this window's in-flight coach turn or plan adjustment.
  // The pending call then resolves as cancelled.
  cancelChatTurn: () => ipcRenderer.invoke('cancel-engine-call', 'chat'),
  cancelPlanAdjustment: () => ipcRenderer.invoke('cancel-engine-call', 'adjust'),
  cancelSplitStep: () => ipcRenderer.invoke('cancel-engine-call', 'split'),
  cancelCourseOutline: () => ipcRenderer.invoke('cancel-engine-call', 'outline'),
  cancelPlan: () => ipcRenderer.invoke('cancel-engine-call', 'plan'),

  // Two-level planning: whole-job milestones + steps for the current one
  planTask: (projectId: string, taskId: string, answer?: string) =>
    ipcRenderer.invoke('plan-task', projectId, taskId, answer),
  expandMilestone: (projectId: string, taskId: string, milestoneId?: string) =>
    ipcRenderer.invoke('expand-milestone', projectId, taskId, milestoneId),
  replanTask: (projectId: string, taskId: string, request?: string) =>
    ipcRenderer.invoke('replan-task', projectId, taskId, request),
  syncItemTasks: (projectId: string) => ipcRenderer.invoke('sync-item-tasks', projectId),
  getNextSteps: () => ipcRenderer.invoke('get-next-steps'),
  getWhatNextSignals: () => ipcRenderer.invoke('get-what-next-signals'),
  recordSkip: (event: SkipEvent) => ipcRenderer.invoke('record-skip', event),
  updateSkipReason: (at: string, reason: SkipReason, undone?: boolean) =>
    ipcRenderer.invoke('update-skip-reason', at, reason, undone),
  markTouched: (itemId: string) => ipcRenderer.invoke('mark-touched', itemId),
  clearTodaySkips: () => ipcRenderer.invoke('clear-today-skips'),
  getProxyHealth: () => ipcRenderer.invoke('get-proxy-health'),
  onProxyHealth: (callback: (health: ProxyHealthView) => void) => {
    const listener = (_e: unknown, health: ProxyHealthView): void => callback(health)
    ipcRenderer.on('proxy-health', listener)
    return () => ipcRenderer.removeListener('proxy-health', listener)
  },
  getPlanQueueStatus: () => ipcRenderer.invoke('get-plan-queue-status'),
  onPlanStatus: (callback: (event: PlanStatusEvent) => void) => {
    const listener = (_e: unknown, event: PlanStatusEvent): void => callback(event)
    ipcRenderer.on('plan-status', listener)
    return () => ipcRenderer.removeListener('plan-status', listener)
  },

  // Course outline import: pick + read a PDF (resolves null if the picker is
  // closed), then save the assessments the user confirmed as unplanned tasks.
  readCourseOutline: () => ipcRenderer.invoke('read-course-outline'),
  importAssessments: (
    projectId: string,
    source: string,
    course: string,
    items: (OutlineAssessment & { dueDate: string })[]
  ) => ipcRenderer.invoke('import-assessments', projectId, source, course, items),

  // "Stuck?": replaces one step with 2-3 smaller ones suggested by the coach
  splitStep: (projectId: string, taskId: string, subtaskId: string) =>
    ipcRenderer.invoke('split-step', projectId, taskId, subtaskId),

  // Opens a native file picker, extracts text, and persists it straight
  // into the project's context_<projectId>.md ledger (no ephemeral one-turn context)
  selectAndExtractDocument: (projectId: string, taskTitle: string) =>
    ipcRenderer.invoke('select-and-extract-document', projectId, taskTitle),

  // Asks the AI to reshape an existing checklist ("make this shorter", etc)
  updateChecklist: (
    projectId: string,
    taskId: string,
    request: string,
    currentChecklist: DecompositionResult,
    deadline: string,
    depth: string,
    model: string
  ) =>
    ipcRenderer.invoke(
      'update-checklist',
      projectId,
      taskId,
      request,
      currentChecklist,
      deadline,
      depth,
      model
    ),

  getProjects: () => ipcRenderer.invoke('get-projects'),

  // `fields` (optional): item category/kind/status/sources for the new project
  createProject: (name: string, fields?: WorkstreamPatch) =>
    ipcRenderer.invoke('create-project', name, fields),

  // --- Items: discovery and approval (names and dates only; main re-checks every path)
  // Looks through the source folders and vault; one run per window at a time
  discoverWorkstreams: () => ipcRenderer.invoke('discover-workstreams'),
  // Stops a running discovery; it resolves with what was found so far
  cancelDiscovery: () => ipcRenderer.invoke('cancel-discovery'),
  // The last stored result (null before the first run)
  getLastDiscovery: () => ipcRenderer.invoke('get-last-discovery'),
  // "Add a folder or note": native picker, then one suggestion (null if cancelled)
  addSourceViaDialog: () => ipcRenderer.invoke('add-source-via-dialog'),
  // Saves the approved items and hidden suggestions
  applyDiscovery: (req: ApplyDiscoveryRequest) => ipcRenderer.invoke('apply-discovery', req),
  // Changes an item's name, category, kind, status or sources
  updateWorkstream: (id: string, patch: WorkstreamPatch) =>
    ipcRenderer.invoke('update-workstream', id, patch),
  getVaultInfo: () => ipcRenderer.invoke('get-vault-info'),
  // Folder picker for the Obsidian vault (null if cancelled)
  chooseVaultFolder: () => ipcRenderer.invoke('choose-vault-folder'),

  // `expectedRev` (the rev you loaded) makes the save fail with `conflict: true`
  // instead of overwriting a write that landed in between.
  saveProjectData: (
    projectId: string,
    data: ProjectData,
    notes?: LedgerNote[],
    expectedRev?: number
  ) => ipcRenderer.invoke('save-project-data', projectId, data, notes, expectedRev),

  loadProjectData: (projectId: string) => ipcRenderer.invoke('load-project-data', projectId),

  deleteProject: (projectId: string) => ipcRenderer.invoke('delete-project', projectId),

  deleteTask: (projectId: string, taskId: string) =>
    ipcRenderer.invoke('delete-task', projectId, taskId),

  // Read a project's combined context_<projectId>.md ledger (full, untrimmed)
  readContextLedger: (projectId: string) => ipcRenderer.invoke('read-context-ledger', projectId),

  // Overwrite the ledger with user-edited contents (editable context panel)
  saveContextLedger: (projectId: string, contents: string) =>
    ipcRenderer.invoke('save-context-ledger', projectId, contents),

  // Read the global user profile (full, untrimmed — for the editor)
  readUserProfile: () => ipcRenderer.invoke('read-user-profile'),

  // Overwrite the global user profile with user-edited contents
  saveUserProfile: (contents: string) => ipcRenderer.invoke('save-user-profile', contents),

  // Nuclear reset: removes all projects, context ledgers, and the user profile.
  // Shows a native confirm dialog before wiping — returns { canceled: true } if
  // the user backs out, { success: true } on completion.
  resetAllData: () => ipcRenderer.invoke('reset-all-data'),

  // Incomplete subtasks across every project, flattened and deadline-sorted,
  // for the dashboard's "how are you feeling today?" mood suggestions
  getUpcomingSubtasks: () => ipcRenderer.invoke('get-upcoming-subtasks'),

  // Completion activity across all projects: streak counts + per-day heatmap
  getActivityStats: () => ipcRenderer.invoke('get-activity-stats'),

  // Median Focus time vs estimate across recent steps (null until enough data)
  getEstimateAccuracy: () => ipcRenderer.invoke('get-estimate-accuracy'),

  // Persisted app settings (model choices, AI nudges) in system/settings.json
  getSettings: () => ipcRenderer.invoke('get-settings'),

  // Repeat a task weekly (weekday 0-6 until a date) or stop (weekday null)
  setRecurrence: (projectId: string, taskId: string, weekday: number | null, until: string) =>
    ipcRenderer.invoke('set-recurrence', projectId, taskId, weekday, until),

  // Background changes to tasks (e.g. a weekly copy was created): reload views
  onTasksChanged: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('tasks-changed', listener)
    return () => ipcRenderer.removeListener('tasks-changed', listener)
  },

  // Weekly reviews, newest first
  listReviews: () => ipcRenderer.invoke('list-reviews'),

  // A new weekly review was written; History reloads the card
  onReviewsChanged: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('reviews-changed', listener)
    return () => ipcRenderer.removeListener('reviews-changed', listener)
  },

  // The weekly-review notification was clicked: show History
  onOpenHistory: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('open-history', listener)
    return () => ipcRenderer.removeListener('open-history', listener)
  },

  // "Plan today" set for the current local day (null when none or from another day)
  getTodayPlan: () => ipcRenderer.invoke('get-today-plan'),
  saveTodayPlan: (plan: TodayPlan | null) => ipcRenderer.invoke('save-today-plan', plan),

  // Save dialog for an .ics file built in the renderer
  saveCalendarFile: (fileName: string, contents: string) =>
    ipcRenderer.invoke('save-calendar-file', fileName, contents),

  // Reveals system/backups (daily snapshots) in Finder
  openBackupsFolder: () => ipcRenderer.invoke('open-backups-folder'),

  // Merges a partial update into the stored settings; resolves with the result
  saveSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke('save-settings', patch),

  // Fired when the user clicks a procrastination nudge notification - the
  // renderer should jump into Start Now. Returns an unsubscribe function.
  onOpenFocus: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('open-focus', listener)
    return () => ipcRenderer.removeListener('open-focus', listener)
  },

  // Phase 3 readers: per-item sync status, manual refresh and the item summary.
  // Statuses and digests only; pack text and paths never reach the renderer.
  getReaderStatus: () => ipcRenderer.invoke('get-reader-status'),
  refreshItem: (itemId: string) => ipcRenderer.invoke('refresh-item', itemId),
  refreshAllItems: () => ipcRenderer.invoke('refresh-all-items'),
  cancelItemRefresh: (itemId: string) => ipcRenderer.invoke('cancel-item-refresh', itemId),
  getItemDigest: (itemId: string) => ipcRenderer.invoke('get-item-digest', itemId),
  onReaderStatus: (callback: (all: Record<string, ReaderStatus>) => void) => {
    const listener = (_e: unknown, all: Record<string, ReaderStatus>): void => callback(all)
    ipcRenderer.on('reader-status', listener)
    return () => ipcRenderer.removeListener('reader-status', listener)
  },
  // A new digest was saved for an item (`digest-updated(itemId)`).
  onDigestUpdated: (callback: (itemId: string) => void) => {
    const listener = (_e: unknown, itemId: string): void => callback(itemId)
    ipcRenderer.on('digest-updated', listener)
    return () => ipcRenderer.removeListener('digest-updated', listener)
  },
  // Phase 4 vault notes: status, Open in Obsidian, Sync now, Recreate. Statuses only, never note text.
  getVaultStatus: () => ipcRenderer.invoke('vault-status'),
  openInObsidian: (itemId: string, taskId?: string) =>
    ipcRenderer.invoke('vault-open-note', itemId, taskId),
  syncVaultNow: () => ipcRenderer.invoke('vault-sync-now'),
  recreateVaultNote: (itemId: string, taskId?: string) =>
    ipcRenderer.invoke('vault-recreate-note', itemId, taskId),
  resumeVaultFolder: () => ipcRenderer.invoke('vault-resume-folder'),
  getDataviewSnippet: () => ipcRenderer.invoke('vault-dataview-snippet'),
  onVaultSyncChanged: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('vault-sync-changed', listener)
    return () => ipcRenderer.removeListener('vault-sync-changed', listener)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
