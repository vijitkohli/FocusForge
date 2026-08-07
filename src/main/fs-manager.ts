import {
  ActivityStats,
  LedgerNote,
  ProjectData,
  UpcomingSubtask,
  UserProfileNote
} from '../common/types'
import { ProjectSummary } from './store/paths'
import { LedgerStore } from './store/LedgerStore'
import { ProfileStore } from './store/ProfileStore'
import { ProjectStore } from './store/ProjectStore'
import { Analytics } from './store/Analytics'
import { Nudger } from './store/Nudger'

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
  private projects = new ProjectStore(this.ledger)
  private profile = new ProfileStore(() => this.projects.getProjects())
  private analytics = new Analytics(this.projects)
  private nudger = new Nudger(this.projects, this.analytics)

  // --- Projects / registry / project data ---
  createProject(projectName: string): ProjectSummary {
    return this.projects.createProject(projectName)
  }
  getProjects(): ProjectSummary[] {
    return this.projects.getProjects()
  }
  deleteProject(projectId: string): Promise<{ success: boolean; error?: string }> {
    return this.projects.deleteProject(projectId)
  }
  deleteTask(projectId: string, taskId: string): Promise<{ success: boolean; error?: string }> {
    return this.projects.deleteTask(projectId, taskId)
  }
  saveProjectData(
    projectId: string,
    data: ProjectData,
    notes?: LedgerNote[]
  ): Promise<{ success: boolean; error?: string }> {
    return this.projects.saveProjectData(projectId, data, notes)
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

  // --- Nudges ---
  getNudge(): Promise<{ title: string; body: string } | null> {
    return this.nudger.getNudge()
  }
}
