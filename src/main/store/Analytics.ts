import { ActivityStats, UpcomingSubtask } from '../../common/types'
import { localDateKey } from './paths'
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
    const projects = this.projects.getProjects()
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const upcoming: UpcomingSubtask[] = []

    for (const project of projects) {
      const data = await this.projects.loadProjectData(project.id)
      const tasks = data?.tasks ?? []

      for (const task of tasks) {
        if (isNaN(new Date(task.deadline).getTime())) continue

        for (const subtask of task.subtasks ?? []) {
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
}
