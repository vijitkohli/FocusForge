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
  SaveResult,
  Workstream,
  WorkstreamPatch,
  SplitStepResult
} from '../common/types'
import { AppSettings } from '../common/models'
import type { PlanStatusEvent, PlanTaskResult } from '../common/milestones'
import type { ItemNextStep } from '../common/nextSteps'

interface PlanQueueStatusView {
  state: 'idle' | 'running' | 'paused'
  queued: number
  current: string | null
}
import {
  ApplyDiscoveryRequest,
  ApplyDiscoveryResult,
  DiscoveryCandidate,
  DiscoveryResult,
  VaultInfo
} from '../common/discovery'
import { EstimateAccuracy } from '../common/estimates'
import { OutlineAssessment, OutlineReadResult } from '../common/outline'
import { TodayPlan } from '../common/today'
import { WeeklyReview } from '../common/review'
import type { ReaderStatus, RefreshResult } from '../common/readers'
import type { ItemDigest } from '../common/digest'
import type { VaultSyncStatus } from '../common/vault'
import type { ProxyHealthView, SkipEvent, SkipReason, WhatNextSignals } from '../common/whatNext'

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
      cancelPlan: () => Promise<void>
      planTask: (projectId: string, taskId: string, answer?: string) => Promise<PlanTaskResult>
      expandMilestone: (
        projectId: string,
        taskId: string,
        milestoneId?: string
      ) => Promise<PlanTaskResult>
      replanTask: (projectId: string, taskId: string, request?: string) => Promise<PlanTaskResult>
      syncItemTasks: (
        projectId: string
      ) => Promise<{ added: number; updated: number; error?: string }>
      getNextSteps: () => Promise<ItemNextStep[]>
      getWhatNextSignals: () => Promise<WhatNextSignals>
      recordSkip: (event: SkipEvent) => Promise<boolean>
      updateSkipReason: (at: string, reason: SkipReason, undone?: boolean) => Promise<void>
      markTouched: (itemId: string) => Promise<void>
      clearTodaySkips: () => Promise<void>
      getProxyHealth: () => Promise<ProxyHealthView>
      onProxyHealth: (callback: (health: ProxyHealthView) => void) => () => void
      getPlanQueueStatus: () => Promise<PlanQueueStatusView | null>
      onPlanStatus: (callback: (event: PlanStatusEvent) => void) => () => void
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

      getProjects: () => Promise<Workstream[]>
      createProject: (name: string, fields?: WorkstreamPatch) => Promise<Workstream>

      discoverWorkstreams: () => Promise<DiscoveryResult>
      cancelDiscovery: () => Promise<void>
      getLastDiscovery: () => Promise<DiscoveryResult | null>
      addSourceViaDialog: () => Promise<
        { candidate: DiscoveryCandidate } | { error: string } | null
      >
      applyDiscovery: (req: ApplyDiscoveryRequest) => Promise<ApplyDiscoveryResult>
      updateWorkstream: (
        id: string,
        patch: WorkstreamPatch
      ) => Promise<{ success: boolean; error?: string }>
      getVaultInfo: () => Promise<VaultInfo>
      chooseVaultFolder: () => Promise<{ vault: VaultInfo } | { error: string } | null>

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
      getReaderStatus: () => Promise<Record<string, ReaderStatus>>
      refreshItem: (itemId: string) => Promise<RefreshResult>
      refreshAllItems: () => Promise<void>
      cancelItemRefresh: (itemId: string) => Promise<void>
      getItemDigest: (itemId: string) => Promise<ItemDigest | null>
      onReaderStatus: (callback: (all: Record<string, ReaderStatus>) => void) => () => void
      onDigestUpdated: (callback: (itemId: string) => void) => () => void
      getVaultStatus: () => Promise<VaultSyncStatus>
      openInObsidian: (itemId: string, taskId?: string) => Promise<{ ok: true } | { error: string }>
      syncVaultNow: () => Promise<void>
      recreateVaultNote: (
        itemId: string,
        taskId?: string
      ) => Promise<{ ok: boolean; error?: string }>
      resumeVaultFolder: () => Promise<void>
      getDataviewSnippet: () => Promise<string>
      onVaultSyncChanged: (callback: () => void) => () => void
    }
  }
}
