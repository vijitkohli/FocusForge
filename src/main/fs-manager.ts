import { app } from 'electron'
import path from 'path'
import fs from 'fs-extra'
import {
  LedgerNote,
  LedgerSection,
  UserProfileNote,
  UserProfileSection,
  UpcomingTask,
  UpcomingSubtask,
  ActivityStats
} from '../common/types'

/** Local-time 'YYYY-MM-DD' for a date (so day-bucketing matches the user's calendar). */
function localDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Define file hierarchy
const ROOT_DIR = path.join(app.getPath('documents'), 'FlowState')
const SYSTEM_DIR = path.join(ROOT_DIR, 'system')
const REGISTRY_PATH = path.join(SYSTEM_DIR, 'master_index.json')
const NUDGE_LOG_PATH = path.join(SYSTEM_DIR, 'nudges.json')
const USER_PROFILE_PATH = path.join(SYSTEM_DIR, 'user_profile.md')

// How stale a project must be (days since lastActive) before it's nudge-worthy.
const NUDGE_IDLE_DAYS = 2

// Warm, never-guilty nudge copy. `{name}` is interpolated.
const NUDGE_TEMPLATES = [
  'No pressure — want to spend 10 min on "{name}"? Starting is the hard part.',
  '"{name}" is waiting whenever you are. One tiny step today is a win.',
  'Got 10 minutes? "{name}" could use a little momentum. You\'ve got this.',
  'A small start on "{name}" beats a perfect plan. Want to knock out one step?'
]

// Interface what the global registry looks like
interface ProjectSummary {
  id: string
  name: string
  path: string
  progress: number
  lastActive: string
}

// Fixed ledger sections, in the order they appear in context.md
const LEDGER_SECTIONS: LedgerSection[] = [
  'Constraints & Specifications',
  'Document Excerpts',
  'Milestones & Completed Work',
  'Plan Adjustments'
]

function emptyLedgerContents(): string {
  return LEDGER_SECTIONS.map((section) => `## ${section}\n`).join('\n')
}

// Sections whose bullet history gets trimmed for the prompt-bound read -
// append-only logs where older entries lose relevance once superseded.
const TRIMMED_SECTIONS: LedgerSection[] = ['Milestones & Completed Work', 'Plan Adjustments']
const MAX_BULLETS_PER_TRIMMED_SECTION = 15

// User-editable profile sections. "Projects Overview" is machine-owned and
// always regenerated on prompt-read, never a valid LLM note target.
const USER_PROFILE_SECTIONS: UserProfileSection[] = [
  'About Me',
  'Preferences',
  'Patterns & Friction'
]
const USER_PROFILE_TRIMMED: UserProfileSection[] = ['Patterns & Friction']
const MAX_USER_PROFILE_BULLETS = 20

function emptyUserProfile(): string {
  const editable = USER_PROFILE_SECTIONS.map((s) => `## ${s}\n`).join('\n')
  return editable + '\n## Projects Overview\n_(auto-generated — do not hand-edit)_\n'
}

function ledgerFileName(projectId: string): string {
  return `context_${projectId}.md`
}

export class FileSystemManager {
  constructor() {
    this.ensureSystemPaths()
  }

  /**
   * Build the root folders
   * Synchronous so we make sure the app does not try to load
   * a folder that does not exist
   */
  private ensureSystemPaths() {
    if (!fs.existsSync(ROOT_DIR)) fs.mkdirSync(ROOT_DIR)
    if (!fs.existsSync(SYSTEM_DIR)) fs.mkdirSync(SYSTEM_DIR)

    if (!fs.existsSync(REGISTRY_PATH)) fs.writeJSONSync(REGISTRY_PATH, [])
    if (!fs.existsSync(USER_PROFILE_PATH)) fs.writeFileSync(USER_PROFILE_PATH, emptyUserProfile())
  }

  /**
   * Nuclear reset: removes the entire FlowState data directory and re-seeds
   * it to fresh-install state (empty registry + blank user profile). The
   * ROOT_DIR path is derived from app.getPath('documents'), never user-
   * supplied, so fs.remove is safe to call unconditionally.
   */
  async resetAllData(): Promise<{ success: boolean; error?: string }> {
    try {
      await fs.remove(ROOT_DIR)
      this.ensureSystemPaths()
      return { success: true }
    } catch (error: any) {
      console.error('Failed to reset all data:', error)
      return { success: false, error: error.message }
    }
  }

  // Create project buckets
  createProject(projectName: string): ProjectSummary {
    // Replace anything that's not a letter or number with underscore
    const safeName = projectName.replace(/[^a-z0-9]/gi, '_')
    const projectPath = path.join(ROOT_DIR, safeName)

    // Build the directories
    fs.ensureDirSync(path.join(projectPath, 'sources'))
    fs.ensureDirSync(path.join(projectPath, '.db'))

    // Create the project data file (local DB)
    const initialData = {
      name: projectName,
      created: new Date().toISOString(),
      tasks: []
    }
    fs.writeJSONSync(path.join(projectPath, 'project_data.json'), initialData)

    // Create the empty, section-headed context ledger
    fs.writeFileSync(path.join(projectPath, ledgerFileName(safeName)), emptyLedgerContents())

    // Add to the global registry (for quick load)
    const newSummary: ProjectSummary = {
      id: safeName,
      name: projectName,
      path: projectPath,
      progress: 0,
      lastActive: new Date().toISOString()
    }

    // Read the main registry (master_index.json)
    const registry = fs.readJSONSync(REGISTRY_PATH)

    // Push newly made project data (summarised) to main registry
    registry.push(newSummary)
    fs.writeJSONSync(REGISTRY_PATH, registry)

    return newSummary
  }

  getProjects(): ProjectSummary[] {
    try {
      return fs.readJSONSync(REGISTRY_PATH)
    } catch {
      return []
    }
  }

  /**
   * Deletes a project entirely: its folder on disk (project_data.json,
   * the context ledger, sources, .db) and its entry in the registry.
   */
  async deleteProject(projectId: string): Promise<{ success: boolean; error?: string }> {
    const projectPath = path.join(ROOT_DIR, projectId)
    try {
      await fs.remove(projectPath)

      const registry = await fs.readJSON(REGISTRY_PATH)
      const next = registry.filter((p: ProjectSummary) => p.id !== projectId)
      await fs.writeJSON(REGISTRY_PATH, next)

      return { success: true }
    } catch (error: any) {
      console.error(`Failed to delete project ${projectId}:`, error)
      return { success: false, error: error.message }
    }
  }

  /**
   * Deletes a single task from a project's data file, then recomputes
   * progress the same way a normal save would.
   */
  async deleteTask(
    projectId: string,
    taskId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const data = await this.loadProjectData(projectId)
      if (!data) return { success: false, error: 'Project not found' }

      data.tasks = (data.tasks ?? []).filter((t: any) => t.id !== taskId)
      return await this.saveProjectData(projectId, data)
    } catch (error: any) {
      console.error(`Failed to delete task ${taskId} from ${projectId}:`, error)
      return { success: false, error: error.message }
    }
  }

  /**
   * Saves the entire state of a project. Optional `notes` describe *why*
   * the save happened (manual edit, AI mutation, toggle, etc) so the same
   * call can append matching entries to the project's context.md ledger -
   * the data change and its ledger record always happen together.
   * Use async to prevent freezing the UI during large saves.
   */
  async saveProjectData(
    projectId: string,
    data: any,
    notes?: LedgerNote[]
  ): Promise<{ success: boolean; error?: string }> {
    // Construct file path
    const filePath = path.join(ROOT_DIR, projectId, 'project_data.json')

    try {
      await fs.outputJSON(filePath, data, { spaces: 2 })
      await this.updateProjectProgress(projectId, data)
      if (notes && notes.length > 0) {
        await this.appendLedgerNotes(projectId, notes)
      }
      return { success: true }
    } catch (error: any) {
      console.error(`Failed to save project ${projectId}:`, error)
      return { success: false, error: error.message }
    }
  }

  /**
   * Reads the full context_<projectId>.md ledger for a project, lazily
   * creating an empty one if it's missing (e.g. projects created before
   * this feature), and migrating the legacy `context.md` filename in
   * place if found.
   */
  async readContextLedger(projectId: string): Promise<string> {
    const ledgerPath = path.join(ROOT_DIR, projectId, ledgerFileName(projectId))
    try {
      const exists = await fs.pathExists(ledgerPath)
      if (!exists) {
        const legacyPath = path.join(ROOT_DIR, projectId, 'context.md')
        if (await fs.pathExists(legacyPath)) {
          await fs.move(legacyPath, ledgerPath)
          return await fs.readFile(ledgerPath, 'utf-8')
        }
        await fs.outputFile(ledgerPath, emptyLedgerContents())
        return emptyLedgerContents()
      }
      return await fs.readFile(ledgerPath, 'utf-8')
    } catch (error) {
      console.error(`Failed to read context ledger for ${projectId}:`, error)
      return emptyLedgerContents()
    }
  }

  /**
   * Overwrites a project's context ledger with user-edited contents. The
   * "View Project Context" panel is editable; this is its save path. Auto
   * appends (appendLedgerNotes) and the prompt-bound trimmed read still work
   * as long as the user keeps the `## <Section>` headings intact.
   */
  async writeContextLedger(
    projectId: string,
    contents: string
  ): Promise<{ success: boolean; error?: string }> {
    const ledgerPath = path.join(ROOT_DIR, projectId, ledgerFileName(projectId))
    try {
      await fs.outputFile(ledgerPath, contents)
      return { success: true }
    } catch (error: any) {
      console.error(`Failed to write context ledger for ${projectId}:`, error)
      return { success: false, error: error.message }
    }
  }

  /**
   * Like readContextLedger, but trims the append-only log sections down
   * to their most recent bullets before returning - this is the string
   * that actually gets sent to the LLM on every turn, so an old project's
   * ledger doesn't grow into an ever-larger prompt. The full untrimmed
   * file (via readContextLedger) is still what the "View Project Context"
   * UI viewer shows.
   */
  async readContextLedgerForPrompt(projectId: string): Promise<string> {
    const contents = await this.readContextLedger(projectId)

    let trimmed = contents
    for (const section of TRIMMED_SECTIONS) {
      const heading = `## ${section}`
      const headingIndex = trimmed.indexOf(heading)
      if (headingIndex === -1) continue

      const bodyStart = headingIndex + heading.length
      const nextHeadingIndex = trimmed.indexOf('\n## ', bodyStart)
      const bodyEnd = nextHeadingIndex === -1 ? trimmed.length : nextHeadingIndex

      const body = trimmed.slice(bodyStart, bodyEnd)
      const bullets = body.split('\n').filter((line) => line.trim().startsWith('- '))
      const kept = bullets.slice(-MAX_BULLETS_PER_TRIMMED_SECTION)

      const newBody = `\n${kept.join('\n')}${kept.length > 0 ? '\n' : ''}`
      trimmed = trimmed.slice(0, bodyStart) + newBody + trimmed.slice(bodyEnd)
    }

    return trimmed
  }

  /**
   * Appends each note under its section heading in the ledger. Sections
   * are matched by heading text; if the ledger predates a section (or is
   * malformed), the section header is added at the end before appending.
   */
  async appendLedgerNotes(projectId: string, notes: LedgerNote[]): Promise<void> {
    const ledgerPath = path.join(ROOT_DIR, projectId, ledgerFileName(projectId))
    let contents = await this.readContextLedger(projectId)

    for (const { section, note } of notes) {
      const heading = `## ${section}`
      const timestamp = new Date().toISOString().split('T')[0]
      const line = `- [${timestamp}] ${note}`

      const headingIndex = contents.indexOf(heading)
      if (headingIndex === -1) {
        contents += `\n${heading}\n${line}\n`
        continue
      }

      const insertAt = headingIndex + heading.length
      const nextHeadingIndex = contents.indexOf('\n## ', insertAt)
      const sectionEnd = nextHeadingIndex === -1 ? contents.length : nextHeadingIndex

      contents =
        contents.slice(0, sectionEnd).replace(/\n*$/, '\n') +
        `${line}\n` +
        contents.slice(sectionEnd)
    }

    await fs.outputFile(ledgerPath, contents)
  }

  // -------------------------------------------------------------------------
  // Global user profile (system/user_profile.md)
  // -------------------------------------------------------------------------

  /** Full file, lazily created on first access. */
  async readUserProfile(): Promise<string> {
    try {
      const exists = await fs.pathExists(USER_PROFILE_PATH)
      if (!exists) {
        await fs.outputFile(USER_PROFILE_PATH, emptyUserProfile())
        return emptyUserProfile()
      }
      return await fs.readFile(USER_PROFILE_PATH, 'utf-8')
    } catch (error) {
      console.error('Failed to read user profile:', error)
      return emptyUserProfile()
    }
  }

  /**
   * Overwrites the profile (from the editor). Validates that all three
   * user-editable headings are present so appendUserProfileNotes can't fail.
   */
  async writeUserProfile(contents: string): Promise<{ success: boolean; error?: string }> {
    const missing = USER_PROFILE_SECTIONS.filter((s) => !contents.includes(`## ${s}`))
    if (missing.length > 0) {
      return {
        success: false,
        error: `Missing required section(s): ${missing.map((s) => `"## ${s}"`).join(', ')}`
      }
    }
    try {
      await fs.outputFile(USER_PROFILE_PATH, contents)
      return { success: true }
    } catch (error) {
      console.error('Failed to write user profile:', error)
      return { success: false, error: String(error) }
    }
  }

  /** Appends LLM-extracted user facts under the appropriate section headings. */
  async appendUserProfileNotes(notes: UserProfileNote[]): Promise<void> {
    if (!notes || notes.length === 0) return
    let contents = await this.readUserProfile()

    for (const { section, note } of notes) {
      if (!USER_PROFILE_SECTIONS.includes(section as UserProfileSection)) continue
      const heading = `## ${section}`
      const line = `- ${note.replace(/^- /, '')}`

      const headingIndex = contents.indexOf(heading)
      if (headingIndex === -1) {
        contents += `\n${heading}\n${line}\n`
        continue
      }

      const insertAt = headingIndex + heading.length
      const nextHeadingIndex = contents.indexOf('\n## ', insertAt)
      const sectionEnd = nextHeadingIndex === -1 ? contents.length : nextHeadingIndex

      contents =
        contents.slice(0, sectionEnd).replace(/\n*$/, '\n') +
        `${line}\n` +
        contents.slice(sectionEnd)
    }

    await fs.outputFile(USER_PROFILE_PATH, contents)
  }

  /**
   * Profile variant for LLM injection: trims append-heavy sections and
   * overwrites "## Projects Overview" with a live summary from the registry.
   * This is what the engine actually receives — never grows stale.
   */
  async readUserProfileForPrompt(): Promise<string> {
    let contents = await this.readUserProfile()

    // Trim "Patterns & Friction" to latest MAX_USER_PROFILE_BULLETS bullets
    for (const section of USER_PROFILE_TRIMMED) {
      const heading = `## ${section}`
      const headingIndex = contents.indexOf(heading)
      if (headingIndex === -1) continue
      const contentStart = headingIndex + heading.length
      const nextHeadingIndex = contents.indexOf('\n## ', contentStart)
      const sectionEnd = nextHeadingIndex === -1 ? contents.length : nextHeadingIndex
      const sectionBody = contents.slice(contentStart, sectionEnd)
      const bullets = sectionBody.split('\n').filter((l) => l.startsWith('- '))
      if (bullets.length > MAX_USER_PROFILE_BULLETS) {
        const trimmed = bullets.slice(-MAX_USER_PROFILE_BULLETS).join('\n')
        contents =
          contents.slice(0, contentStart) + '\n' + trimmed + '\n' + contents.slice(sectionEnd)
      }
    }

    // Rebuild "## Projects Overview" from live registry data
    const projects = this.getProjects()
    const today = Date.now()
    const overviewLines = projects.map((p) => {
      const daysSince = Math.floor(
        (today - new Date(p.lastActive).getTime()) / (1000 * 60 * 60 * 24)
      )
      const idle = daysSince === 0 ? 'active today' : `last active ${daysSince}d ago`
      return `- ${p.name}: ${p.progress}% done, ${idle}`
    })
    const overviewBlock = `## Projects Overview\n_(auto-generated)_\n${overviewLines.join('\n')}\n`

    const overviewHeading = '## Projects Overview'
    const overviewIndex = contents.indexOf(overviewHeading)
    if (overviewIndex === -1) {
      contents = contents.trimEnd() + '\n\n' + overviewBlock
    } else {
      contents = contents.slice(0, overviewIndex) + overviewBlock
    }

    return contents
  }

  /**
   * Recalculates a project's completion progress from its subtasks
   * and syncs it (plus lastActive) into the registry.
   */
  private async updateProjectProgress(projectId: string, data: any): Promise<void> {
    const tasks = data?.tasks ?? []
    const allSubtasks = tasks.flatMap((t: any) => t.subtasks ?? [])
    const progress =
      allSubtasks.length === 0
        ? 0
        : Math.round(
            (allSubtasks.filter((s: any) => s.isCompleted).length / allSubtasks.length) * 100
          )

    const registry = await fs.readJSON(REGISTRY_PATH)
    const entry = registry.find((p: ProjectSummary) => p.id === projectId)
    if (!entry) return

    entry.progress = progress
    entry.lastActive = new Date().toISOString()
    await fs.writeJSON(REGISTRY_PATH, registry)
  }

  /**
   * Flattens every task across every project into a single list with
   * deadline math already computed, for the dashboard's deadline view.
   * Reads files on demand rather than caching a denormalized "nearest
   * deadline" field that would need to be kept in sync on every save.
   */
  async getUpcomingTasks(): Promise<UpcomingTask[]> {
    const projects = this.getProjects()
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const upcoming: UpcomingTask[] = []

    for (const project of projects) {
      const data = await this.loadProjectData(project.id)
      const tasks = data?.tasks ?? []

      for (const task of tasks) {
        const deadline = new Date(task.deadline)
        if (isNaN(deadline.getTime())) continue
        deadline.setHours(0, 0, 0, 0)

        const daysRemaining = Math.round(
          (deadline.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
        )
        const subtasks = task.subtasks ?? []
        const isComplete = subtasks.length > 0 && subtasks.every((s: any) => s.isCompleted)

        upcoming.push({
          projectId: project.id,
          projectName: project.name,
          taskId: task.id,
          taskTitle: task.title,
          deadline: task.deadline,
          daysRemaining,
          isComplete
        })
      }
    }

    upcoming.sort((a, b) => a.daysRemaining - b.daysRemaining)
    return upcoming
  }

  /**
   * Flattens every incomplete subtask across every project/task into a
   * single deadline-sorted list, for the dashboard's mood-based
   * suggestions ("how are you feeling today?"). Mirrors the same
   * read-on-demand, date-only daysRemaining math as getUpcomingTasks.
   */
  async getUpcomingSubtasks(): Promise<UpcomingSubtask[]> {
    const projects = this.getProjects()
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const upcoming: UpcomingSubtask[] = []

    for (const project of projects) {
      const data = await this.loadProjectData(project.id)
      const tasks = data?.tasks ?? []

      for (const task of tasks) {
        const taskDeadline = new Date(task.deadline)
        if (isNaN(taskDeadline.getTime())) continue

        const subtasks = task.subtasks ?? []

        for (const subtask of subtasks) {
          if (subtask.isCompleted) continue

          const dateStr = subtask.scheduledDate ?? task.deadline
          const subDate = new Date(dateStr)
          if (isNaN(subDate.getTime())) continue
          subDate.setHours(0, 0, 0, 0)

          const daysRemaining = Math.round(
            (subDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
          )

          upcoming.push({
            projectId: project.id,
            projectName: project.name,
            taskId: task.id,
            taskTitle: task.title,
            subtaskId: subtask.id,
            subtaskTitle: subtask.title,
            difficulty: subtask.difficulty ?? 'medium',
            timeEstimate: subtask.timeEstimate,
            scheduledDate: subtask.scheduledDate,
            deadline: dateStr,
            daysRemaining
          })
        }
      }
    }

    upcoming.sort((a, b) => a.daysRemaining - b.daysRemaining)
    return upcoming
  }

  /**
   * Aggregates completion activity across every project into streak +
   * heatmap stats. Derived purely from subtask `completedAt` timestamps -
   * nothing extra is persisted, so un-completing a step naturally drops its
   * day from the counts on the next read. Subtasks completed before
   * `completedAt` existed (no timestamp) are excluded from dated stats.
   */
  async getActivityStats(): Promise<ActivityStats> {
    const projects = this.getProjects()
    const countsByDate: Record<string, number> = {}
    let totalCompleted = 0

    for (const project of projects) {
      const data = await this.loadProjectData(project.id)
      const tasks = data?.tasks ?? []
      for (const task of tasks) {
        for (const subtask of task.subtasks ?? []) {
          if (!subtask.isCompleted) continue
          totalCompleted += 1
          if (!subtask.completedAt) continue
          const d = new Date(subtask.completedAt)
          if (isNaN(d.getTime())) continue
          const key = localDateKey(d)
          countsByDate[key] = (countsByDate[key] ?? 0) + 1
        }
      }
    }

    // Current streak: walk back from today; allow "today not done yet" by
    // starting at yesterday if today has no completions, so the streak
    // isn't shown as broken first thing in the morning.
    const has = (d: Date): boolean => (countsByDate[localDateKey(d)] ?? 0) > 0
    const cursor = new Date()
    cursor.setHours(0, 0, 0, 0)
    if (!has(cursor)) cursor.setDate(cursor.getDate() - 1)
    let currentStreak = 0
    while (has(cursor)) {
      currentStreak += 1
      cursor.setDate(cursor.getDate() - 1)
    }

    // Longest streak over all recorded days.
    const days = Object.keys(countsByDate).sort()
    let longestStreak = 0
    let run = 0
    let prev: Date | null = null
    for (const key of days) {
      const cur = new Date(`${key}T00:00:00`)
      if (prev) {
        const gap = Math.round((cur.getTime() - prev.getTime()) / 86400000)
        run = gap === 1 ? run + 1 : 1
      } else {
        run = 1
      }
      longestStreak = Math.max(longestStreak, run)
      prev = cur
    }

    return { currentStreak, longestStreak, countsByDate, totalCompleted }
  }

  /**
   * Decides whether to gently nudge the user, and returns the notification
   * copy if so. Supportive, never guilt-trippy. Picks ONE item (most overdue
   * step, else a stale project with open work), respects quiet hours
   * (08:00-22:00 only) and an at-most-once-per-item-per-day guard persisted in
   * system/nudges.json. Returns null when there's nothing kind to say.
   */
  async getNudge(): Promise<{ title: string; body: string } | null> {
    const hour = new Date().getHours()
    if (hour < 8 || hour >= 22) return null // quiet hours

    const upcoming = await this.getUpcomingSubtasks()
    if (upcoming.length === 0) return null

    // Per-item-per-day guard.
    const todayKey = localDateKey(new Date())
    let log: Record<string, string> = {}
    try {
      if (await fs.pathExists(NUDGE_LOG_PATH)) log = await fs.readJSON(NUDGE_LOG_PATH)
    } catch {
      log = {}
    }
    const alreadyNudged = (key: string): boolean => log[key] === todayKey

    // 1. Most overdue incomplete step (upcoming is sorted soonest-first).
    let pick: { key: string; name: string } | null = null
    const mostUrgent = upcoming[0]
    if (mostUrgent.daysRemaining < 0 && !alreadyNudged(`sub:${mostUrgent.subtaskId}`)) {
      pick = { key: `sub:${mostUrgent.subtaskId}`, name: mostUrgent.subtaskTitle }
    }

    // 2. Otherwise, a project with open work that's gone quiet.
    if (!pick) {
      const projectsWithWork = new Set(upcoming.map((s) => s.projectId))
      const registry = this.getProjects()
      const now = Date.now()
      const stale = registry
        .filter((p) => projectsWithWork.has(p.id))
        .filter((p) => (now - new Date(p.lastActive).getTime()) / 86400000 >= NUDGE_IDLE_DAYS)
        .filter((p) => !alreadyNudged(`proj:${p.id}`))
        .sort((a, b) => new Date(a.lastActive).getTime() - new Date(b.lastActive).getTime())
      if (stale.length > 0) {
        pick = { key: `proj:${stale[0].id}`, name: stale[0].name }
      }
    }

    if (!pick) return null

    // Record + persist the guard, then build the message.
    log[pick.key] = todayKey
    try {
      await fs.outputJSON(NUDGE_LOG_PATH, log)
    } catch (e) {
      console.error('Failed to write nudge log', e)
    }

    const template = NUDGE_TEMPLATES[Math.floor(Math.random() * NUDGE_TEMPLATES.length)]
    return { title: 'Flow State', body: template.replace('{name}', pick.name) }
  }

  /**
   * Loads the full project data structure
   */
  async loadProjectData(projectId: string): Promise<any> {
    const filePath = path.join(ROOT_DIR, projectId, 'project_data.json')

    try {
      // Check if file exists
      const exists = await fs.pathExists(filePath)
      if (!exists) return null
      return await fs.readJSON(filePath)
    } catch (error) {
      console.error(`Failed to load project ${projectId}:`, error)
      return null
    }
  }
}
