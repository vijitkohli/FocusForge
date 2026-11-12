import { ActivityStats, ProjectTask, UpcomingSubtask, Workstream } from '../../common/types'
import type { ItemNextStep } from '../../common/nextSteps'
import {
  currentMilestone,
  hasMilestones,
  isStepLive,
  nextStepForTask
} from '../../common/milestones'
import { isUnplanned } from '../../common/outline'
import { EstimateAccuracy, EstimateSample, estimateAccuracy } from '../../common/estimates'
import { WeekSummary } from '../../common/review'
import { localDateKey, parseLocalDate } from './paths'
import { ProjectStore } from './ProjectStore'

/**
 * Derived, read-on-demand analytics across every project: the dashboard's
 * deadline/mood list and the streak + heatmap stats. Nothing extra is
 * persisted — everything is recomputed from the project files on each call, so
 * un-completing a step naturally drops it from the counts on the next read.
 */
export class Analytics {
  constructor(private projects: ProjectStore) {}

  /**
   * Flattens every incomplete subtask across every project/task into a single
   * deadline-sorted list. Date-only daysRemaining math.
   */
  async getUpcomingSubtasks(): Promise<UpcomingSubtask[]> {
    // Archived items drop out; paused ones keep showing steps the user added.
    const projects = this.projects.getProjects().filter((p) => p.status !== 'archived')
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const upcoming: UpcomingSubtask[] = []

    for (const project of projects) {
      const data = await this.projects.loadProjectData(project.id)
      const tasks = data?.tasks ?? []

      for (const task of tasks) {
        if (isNaN(new Date(task.deadline).getTime())) continue

        const milestones = task.milestones ?? []
        for (const subtask of task.subtasks ?? []) {
          if (subtask.isCompleted) continue
          // Two-level plans: steps staged for a later part, or left over from a
          // part marked done, aren't actionable yet.
          if (!isStepLive(task, subtask)) continue

          const dateStr = subtask.scheduledDate ?? task.deadline
          const subDate = parseLocalDate(dateStr)
          if (isNaN(subDate.getTime())) continue

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
            daysRemaining,
            ...milestoneInfo(milestones, subtask.milestoneId)
          })
        }
      }
    }

    upcoming.sort((a, b) => a.daysRemaining - b.daysRemaining)
    return upcoming
  }

  /**
   * One entry per open task of every active item, for "What next?" (Phase 6
   * ranks them). A task without a plan, or whose current part has no steps
   * yet, comes back with needsPlan so background planning can fill it.
   */
  async getNextSteps(): Promise<ItemNextStep[]> {
    const out: ItemNextStep[] = []
    for (const project of this.projects.getProjects().filter((p) => p.status === 'active')) {
      const data = await this.projects.loadProjectData(project.id)
      for (const task of data?.tasks ?? []) {
        const entry = nextStepEntry(project, task)
        if (entry) out.push(entry)
      }
    }
    return out
  }

  /**
   * Aggregates completion activity into streak + heatmap stats, derived purely
   * from subtask `completedAt` timestamps. Subtasks completed before
   * `completedAt` existed (no timestamp) are excluded from dated stats.
   */
  async getActivityStats(): Promise<ActivityStats> {
    const projects = this.projects.getProjects()
    const countsByDate: Record<string, number> = {}
    let totalCompleted = 0

    for (const project of projects) {
      const data = await this.projects.loadProjectData(project.id)
      for (const task of data?.tasks ?? []) {
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
    // starting at yesterday if today has no completions, so the streak isn't
    // shown as broken first thing in the morning.
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

  /** How long steps take in Focus versus their estimates (null until enough data). */
  async getEstimateAccuracy(): Promise<EstimateAccuracy | null> {
    const samples: EstimateSample[] = []
    for (const project of this.projects.getProjects()) {
      const data = await this.projects.loadProjectData(project.id)
      for (const task of data?.tasks ?? []) {
        for (const subtask of task.subtasks ?? []) {
          if (!subtask.isCompleted || !subtask.completedAt) continue
          if (!subtask.focusSeconds || !subtask.timeEstimate) continue
          samples.push({
            focusSeconds: subtask.focusSeconds,
            timeEstimate: subtask.timeEstimate,
            completedAt: subtask.completedAt
          })
        }
      }
    }
    return estimateAccuracy(samples)
  }

  /** Totals for the Monday–Sunday week starting `weekStart` (local YYYY-MM-DD). */
  async getWeekSummary(weekStart: string): Promise<WeekSummary> {
    const monday = parseLocalDate(weekStart)
    const sunday = new Date(monday)
    sunday.setDate(sunday.getDate() + 6)
    const weekEnd = localDateKey(sunday)
    const inWeek = (key: string): boolean => key >= weekStart && key <= weekEnd

    let stepsDone = 0
    let tasksFinished = 0
    let carriedOver = 0
    let focusSeconds = 0
    const days = new Set<string>()
    const perProject = new Map<string, number>()

    for (const project of this.projects.getProjects()) {
      const data = await this.projects.loadProjectData(project.id)
      for (const task of data?.tasks ?? []) {
        const steps = task.subtasks ?? []
        let lastDone = ''
        for (const step of steps) {
          if (!step.isCompleted) {
            const date = step.scheduledDate ?? task.deadline
            if (date && date <= weekEnd) carriedOver += 1
            continue
          }
          if (!step.completedAt) continue
          const key = localDateKey(new Date(step.completedAt))
          if (key > lastDone) lastDone = key
          if (!inWeek(key)) continue
          stepsDone += 1
          days.add(key)
          perProject.set(project.name, (perProject.get(project.name) ?? 0) + 1)
          focusSeconds += step.focusSeconds ?? 0
        }
        if (steps.length > 0 && steps.every((step) => step.isCompleted) && inWeek(lastDone)) {
          tasksFinished += 1
        }
      }
    }

    const [stats, accuracy] = await Promise.all([
      this.getActivityStats(),
      this.getEstimateAccuracy()
    ])
    const top = [...perProject.entries()].sort((a, b) => b[1] - a[1])[0]
    return {
      weekStart,
      weekEnd,
      stepsDone,
      activeDays: days.size,
      currentStreak: stats.currentStreak,
      longestStreak: stats.longestStreak,
      tasksFinished,
      carriedOver,
      topProject: top ? { name: top[0], steps: top[1] } : null,
      focusMinutes: Math.round(focusSeconds / 60),
      estimateRatio: accuracy?.ratio ?? null
    }
  }
}

function milestoneInfo(
  milestones: { id: string; title: string }[],
  id: string | undefined
): Pick<UpcomingSubtask, 'milestoneTitle' | 'milestoneIndex' | 'milestoneCount'> {
  if (!id || milestones.length === 0) return {}
  const index = milestones.findIndex((m) => m.id === id)
  if (index === -1) return {}
  return {
    milestoneTitle: milestones[index].title,
    milestoneIndex: index + 1,
    milestoneCount: milestones.length
  }
}

function latest(...isoDates: (string | undefined)[]): string | undefined {
  let best: string | undefined
  let bestTime = -Infinity
  for (const iso of isoDates) {
    if (!iso) continue
    const t = new Date(iso).getTime()
    if (!Number.isNaN(t) && t > bestTime) {
      bestTime = t
      best = iso
    }
  }
  return best
}

/** The "What next?" entry for one task, or null when the task is finished. */
export function nextStepEntry(project: Workstream, task: ProjectTask): ItemNextStep | null {
  const step = isUnplanned(task) ? null : nextStepForTask(task)
  const current = currentMilestone(task)
  const awaitingSteps = hasMilestones(task) && !!current && !step
  const needsPlan = isUnplanned(task) || awaitingSteps
  if (!step && !needsPlan) return null
  const deadlineKind = task.deadlineKind ?? 'hard'
  const lastDone = latest(...(task.subtasks ?? []).map((s) => s.completedAt))
  const auto = (task as ProjectTask & { auto?: string }).auto
  return {
    projectId: project.id,
    itemKind: project.kind,
    category: project.category,
    taskId: task.id,
    taskTitle: task.title,
    subtaskId: step?.id ?? null,
    title: step?.title ?? null,
    ...(step?.timeEstimate ? { minutes: step.timeEstimate } : {}),
    difficulty: step?.difficulty ?? 'medium',
    ...(current ? { milestoneTitle: current.title } : {}),
    ...(deadlineKind !== 'none' && task.deadline ? { deadline: task.deadline } : {}),
    deadlineKind,
    ...(latest(lastDone, project.sourceActivityAt)
      ? { lastTouchedAt: latest(lastDone, project.sourceActivityAt) }
      : {}),
    needsPlan,
    itemName: project.name,
    ...(auto === 'loose-ends' ? { taskAuto: 'loose-ends' as const } : {}),
    ...(task.origin ? { origin: task.origin.kind } : {}),
    ...(step?.scheduledDate ? { scheduledDate: step.scheduledDate } : {}),
    ...(task.assessment?.when ? { dueWhen: task.assessment.when } : {})
  }
}
