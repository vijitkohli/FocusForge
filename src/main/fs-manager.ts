import {
  ActivityStats,
  LedgerNote,
  ProjectData,
  UpcomingSubtask,
  UserProfileNote
} from '../common/types'
import { ProjectSummary } from './store/paths'
import { EstimateAccuracy } from '../common/estimates'
import { LedgerStore } from './store/LedgerStore'
import { ProfileStore } from './store/ProfileStore'
import { ProjectStore } from './store/ProjectStore'
import { Analytics } from './store/Analytics'
import { Nudger } from './store/Nudger'
import { Backups } from './store/Backups'
import { TodayStore } from './store/TodayStore'
import { TodayPlan } from '../common/today'
import { WeekSummary, WeeklyReview } from '../common/review'
import { Reviews } from './store/Reviews'
import { SaveResult, ProjectMutation } from './store/ProjectStore'

/**
 * Thin facade over the FlowState data stores. The IPC layer in index.ts keeps
 * calling `fsManager.*` unchanged; each method delegates to the store that owns
 * that responsibility:
 *   - ProjectStore  — registry + project_data.json + progress + lifecycle
 *   - LedgerStore   — per-project context_<projectId>.md ledger
 *   - ProfileStore  — global system/user_profile.md
 *   - Analytics     — cross-project upcoming subtasks + streak/heatmap stats
 *   - Nudger        — supportive procrastination nudges
 */
export class FileSystemManager {
  private ledger = new LedgerStore()
  private backups = new Backups()
  private projects = new ProjectStore(this.ledger, this.backups)
  private profile = new ProfileStore(() => this.projects.getProjects())
  private analytics = new Analytics(this.projects)
  private nudger = new Nudger(this.projects, this.analytics)
  private today = new TodayStore()
  private reviews = new Reviews()

  // --- Projects / registry / project data ---
  createProject(projectName: string): Promise<ProjectSummary> {
    return this.projects.createProject(projectName)
  }
  getProjects(): ProjectSummary[] {
    return this.projects.getProjects()
  }
  deleteProject(projectId: string): Promise<{ success: boolean; error?: string }> {
    return this.projects.deleteProject(projectId)
  }
  deleteTask(projectId: string, taskId: string): Promise<SaveResult> {
    return this.projects.deleteTask(projectId, taskId)
  }
  saveProjectData(
    projectId: string,
    data: ProjectData,
    notes?: LedgerNote[],
    expectedRev?: number
  ): Promise<SaveResult> {
    return this.projects.saveProjectData(projectId, data, notes, expectedRev)
  }
  updateProjectData(
    projectId: string,
    mutate: (data: ProjectData) => Promise<ProjectMutation>
  ): Promise<SaveResult | null> {
    return this.projects.updateProjectData(projectId, mutate)
  }
  getWeekSummary(weekStart: string): Promise<WeekSummary> {
    return this.analytics.getWeekSummary(weekStart)
  }
  listReviews(): Promise<WeeklyReview[]> {
    return this.reviews.list()
  }
  hasReview(weekStart: string): Promise<boolean> {
    return this.reviews.has(weekStart)
  }
  saveReview(review: WeeklyReview): Promise<void> {
    return this.reviews.save(review)
  }
  getTodayPlan(): Promise<TodayPlan | null> {
    return this.today.get()
  }
  saveTodayPlan(plan: TodayPlan | null): Promise<TodayPlan | null> {
    return this.today.save(plan)
  }
  pruneBackups(): Promise<void> {
    return this.backups.prune()
  }
  loadProjectData(projectId: string): Promise<ProjectData | null> {
    return this.projects.loadProjectData(projectId)
  }
  resetAllData(): Promise<{ success: boolean; error?: string }> {
    return this.projects.resetAllData()
  }

  // --- Context ledger ---
  readContextLedger(projectId: string): Promise<string> {
    return this.ledger.readContextLedger(projectId)
  }
  writeContextLedger(
    projectId: string,
    contents: string
  ): Promise<{ success: boolean; error?: string }> {
    return this.ledger.writeContextLedger(projectId, contents)
  }
  readContextLedgerForPrompt(projectId: string): Promise<string> {
    return this.ledger.readContextLedgerForPrompt(projectId)
  }
  appendLedgerNotes(projectId: string, notes: LedgerNote[]): Promise<void> {
    return this.ledger.appendLedgerNotes(projectId, notes)
  }

  // --- Global user profile ---
  readUserProfile(): Promise<string> {
    return this.profile.readUserProfile()
  }
  writeUserProfile(contents: string): Promise<{ success: boolean; error?: string }> {
    return this.profile.writeUserProfile(contents)
  }
  appendUserProfileNotes(notes: UserProfileNote[]): Promise<void> {
    return this.profile.appendUserProfileNotes(notes)
  }
  readUserProfileForPrompt(): Promise<string> {
    return this.profile.readUserProfileForPrompt()
  }

  // --- Derived analytics ---
  getUpcomingSubtasks(): Promise<UpcomingSubtask[]> {
    return this.analytics.getUpcomingSubtasks()
  }
  getActivityStats(): Promise<ActivityStats> {
    return this.analytics.getActivityStats()
  }
  getEstimateAccuracy(): Promise<EstimateAccuracy | null> {
    return this.analytics.getEstimateAccuracy()
  }

  // --- Nudges ---
  getNudge(): Promise<{
    title: string
    body: string
    subject: string
    reason: 'overdue' | 'idle'
  } | null> {
    return this.nudger.getNudge()
  }
}
