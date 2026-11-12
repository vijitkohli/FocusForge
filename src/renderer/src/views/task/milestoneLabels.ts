import type { ProjectTask } from '../../../../common/types'
import { milestoneMinutes } from '../../../../common/milestones'

/** "~25 min", "~3.5 h", "~19 h" */
export function durationLabel(minutes: number): string {
  if (minutes < 60) return `~${Math.max(5, Math.round(minutes / 5) * 5)} min`
  const hours = minutes / 60
  return hours < 10 ? `~${Math.round(hours * 2) / 2} h` : `~${Math.round(hours)} h`
}

/** "The whole job · ~19 h · 2 of 5 parts done" */
export function milestoneSummary(task: Pick<ProjectTask, 'milestones' | 'subtasks'>): string {
  const ms = task.milestones ?? []
  const done = ms.filter((m) => m.status === 'done').length
  const parts = `${ms.length} part${ms.length === 1 ? '' : 's'}`
  return `The whole job · ${durationLabel(milestoneMinutes(task).total)} · ${done} of ${parts} done`
}
