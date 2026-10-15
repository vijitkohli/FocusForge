import { ElectronAPI } from '@electron-toolkit/preload'
import {
  ChatTurnPayload,
  DecompositionResult,
  EngineResponse,
  LedgerNote,
  ProjectData,
  Subtask,
  Prerequisite,
  UpcomingSubtask,
  ActivityStats,
  ProjectSummary,
  SaveResult,
  SplitStepResult
} from '../common/types'
import { AppSettings } from '../common/models'
import { EstimateAccuracy } from '../common/estimates'
import { OutlineAssessment, OutlineReadResult } from '../common/outline'
import { TodayPlan } from '../common/today'
import { WeeklyReview } from '../common/review'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      sendChatMessage: (payload: ChatTurnPayload) => Promise<EngineResponse>
      onChatStream: (callback: (text: string) => void) => () => void
      cancelChatTurn: () => Promise<void>
      cancelPlanAdjustment: () => Promise<void>
      cancelSplitStep: () => Promise<void>
      cancelCourseOutline: () => Promise<void>
      readCourseOutline: () => Promise<OutlineReadResult | null>
      importAssessments: (
        projectId: string,
        source: string,
        course: string,
        items: (OutlineAssessment & { dueDate: string })[]
      ) => Promise<{ success: boolean; added: number; error?: string }>
      splitStep: (projectId: string, taskId: string, subtaskId: string) => Promise<SplitStepResult>
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
        cancelled?: boolean
        subtasks?: Subtask[]
        prerequisites?: Prerequisite[]
      }>

      getProjects: () => Promise<ProjectSummary[]>
      createProject: (name: string) => Promise<ProjectSummary>

      saveProjectData: (
        projectId: string,
        data: ProjectData,
        notes?: LedgerNote[],
        expectedRev?: number
      ) => Promise<SaveResult>
      loadProjectData: (projectId: string) => Promise<ProjectData | null>
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
      getUpcomingSubtasks: () => Promise<UpcomingSubtask[]>
      getActivityStats: () => Promise<ActivityStats>
      getEstimateAccuracy: () => Promise<EstimateAccuracy | null>
      getSettings: () => Promise<AppSettings>
      openBackupsFolder: () => Promise<{ success: boolean; error?: string }>
      setRecurrence: (
        projectId: string,
        taskId: string,
        weekday: number | null,
        until: string
      ) => Promise<{ success: boolean; error?: string }>
      onTasksChanged: (callback: () => void) => () => void
      listReviews: () => Promise<WeeklyReview[]>
      onReviewsChanged: (callback: () => void) => () => void
      onOpenHistory: (callback: () => void) => () => void
      getTodayPlan: () => Promise<TodayPlan | null>
      saveTodayPlan: (plan: TodayPlan | null) => Promise<TodayPlan | null>
      saveCalendarFile: (
        fileName: string,
        contents: string
      ) => Promise<{ saved: boolean; filePath?: string }>
      saveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
      onOpenFocus: (callback: () => void) => () => void
    }
  }
}
