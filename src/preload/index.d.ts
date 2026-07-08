import { ElectronAPI } from '@electron-toolkit/preload'
import {
  ChatTurnPayload,
  DecompositionResult,
  EngineResponse,
  LedgerNote,
  Subtask,
  Prerequisite,
  UpcomingTask,
  UpcomingSubtask,
  ActivityStats
} from '../common/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      sendChatMessage: (payload: ChatTurnPayload) => Promise<EngineResponse>
      onChatStream: (callback: (text: string) => void) => () => void
      selectAndExtractDocument: (
        projectId: string,
        taskTitle: string
      ) => Promise<{ fileName: string; error?: string } | null>
      updateChecklist: (
        projectId: string,
        taskId: string,
        request: string,
        currentChecklist: DecompositionResult,
        deadline: string,
        depth: string,
        model: string
      ) => Promise<{
        success: boolean
        message: string
        subtasks?: Subtask[]
        prerequisites?: Prerequisite[]
      }>

      getProjects: () => Promise<any[]>
      createProject: (name: string) => Promise<any>

      saveProjectData: (
        projectId: string,
        data: any,
        notes?: LedgerNote[]
      ) => Promise<{ success: boolean; error?: string }>
      loadProjectData: (projectId: string) => Promise<any>
      deleteProject: (projectId: string) => Promise<{ success: boolean; error?: string }>
      deleteTask: (
        projectId: string,
        taskId: string
      ) => Promise<{ success: boolean; error?: string }>

      readContextLedger: (projectId: string) => Promise<string>
      saveContextLedger: (
        projectId: string,
        contents: string
      ) => Promise<{ success: boolean; error?: string }>
      readUserProfile: () => Promise<string>
      saveUserProfile: (contents: string) => Promise<{ success: boolean; error?: string }>
      resetAllData: () => Promise<{ success: boolean; error?: string; canceled?: boolean }>
      getUpcomingTasks: () => Promise<UpcomingTask[]>
      getUpcomingSubtasks: () => Promise<UpcomingSubtask[]>
      getActivityStats: () => Promise<ActivityStats>
      onOpenFocus: (callback: () => void) => () => void
    }
  }
}
