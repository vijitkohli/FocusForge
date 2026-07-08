import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { ChatTurnPayload, DecompositionResult, LedgerNote } from '../common/types'

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

  createProject: (name: string) => ipcRenderer.invoke('create-project', name),

  saveProjectData: (projectId: string, data: any, notes?: LedgerNote[]) =>
    ipcRenderer.invoke('save-project-data', projectId, data, notes),

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

  // Tasks across every project, flattened and deadline-sorted, for the
  // dashboard's deadline view
  getUpcomingTasks: () => ipcRenderer.invoke('get-upcoming-tasks'),

  // Incomplete subtasks across every project, flattened and deadline-sorted,
  // for the dashboard's "how are you feeling today?" mood suggestions
  getUpcomingSubtasks: () => ipcRenderer.invoke('get-upcoming-subtasks'),

  // Completion activity across all projects: streak counts + per-day heatmap
  getActivityStats: () => ipcRenderer.invoke('get-activity-stats'),

  // Fired when the user clicks a procrastination nudge notification - the
  // renderer should jump into Start Now. Returns an unsubscribe function.
  onOpenFocus: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('open-focus', listener)
    return () => ipcRenderer.removeListener('open-focus', listener)
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
