import type { Milestone, Subtask } from '../../../../common/types'

/**
 * Burndown for two-level plans: y = remaining minutes of the whole job. Each
 * done step subtracts its estimate; when a milestone is completed, whatever of
 * its estimate its steps didn't cover is subtracted at its completedAt.
 */
function minutesBurndown(
  subtasks: Subtask[],
  milestones: Milestone[],
  start: number,
  end: number,
  now: number
): { points: string; status: string } | null {
  const total = milestones.reduce((sum, m) => sum + Math.max(0, m.estimateMinutes), 0)
  if (total <= 0) return null
  const span = end - start
  const xOf = (time: number): number => Math.max(0, Math.min(240, ((time - start) / span) * 240))
  const yOf = (remaining: number): number => 2 + (1 - Math.max(0, remaining) / total) * 44
  const events: { time: number; minutes: number }[] = []
  let undated = 0
  const known = new Set(milestones.map((m) => m.id))
  for (const m of milestones) {
    const steps = subtasks.filter((s) => s.milestoneId === m.id && s.isCompleted)
    let covered = 0
    for (const s of steps) {
      const mins = Math.min(s.timeEstimate ?? 0, m.estimateMinutes - covered)
      if (mins <= 0) continue
      covered += mins
      const time = s.completedAt ? new Date(s.completedAt).getTime() : NaN
      if (Number.isNaN(time)) undated += mins
      else events.push({ time, minutes: mins })
    }
    if (m.status === 'done' && covered < m.estimateMinutes) {
      const time = m.completedAt ? new Date(m.completedAt).getTime() : NaN
      if (Number.isNaN(time)) undated += m.estimateMinutes - covered
      else events.push({ time, minutes: m.estimateMinutes - covered })
    }
  }
  // Steps outside any milestone don't count against the whole-job total.
  void known
  events.sort((a, b) => a.time - b.time)
  let remaining = total - undated
  const points = [`${xOf(start)},${yOf(remaining)}`]
  for (const e of events) {
    points.push(`${xOf(e.time)},${yOf(remaining)}`)
    remaining -= e.minutes
    points.push(`${xOf(e.time)},${yOf(remaining)}`)
  }
  points.push(`${xOf(Math.min(now, end))},${yOf(remaining)}`)
  const elapsed = Math.max(0, Math.min(1, (now - start) / span))
  const behindBy = remaining - total * (1 - elapsed)
  const hours = Math.round(behindBy / 60)
  const status =
    remaining <= 0 || milestones.every((m) => m.status === 'done')
      ? 'Complete'
      : now > end
        ? 'Past due date'
        : behindBy <= 30
          ? 'On track'
          : hours >= 1
            ? `Behind by ~${hours} h`
            : `Behind by ~${Math.round(behindBy)} min`
  return { points: points.join(' '), status }
}

export function burndownData(
  subtasks: Subtask[],
  createdAt: string,
  deadline: string,
  now = Date.now(),
  milestones?: Milestone[]
): { points: string; status: string } | null {
  if (milestones && milestones.length > 0) {
    const start = new Date(createdAt).getTime()
    const end = new Date(`${deadline}T23:59:59`).getTime()
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null
    return minutesBurndown(subtasks, milestones, start, end, now)
  }
  const total = subtasks.length
  const start = new Date(createdAt).getTime()
  const end = new Date(`${deadline}T23:59:59`).getTime()
  if (!total || Number.isNaN(start) || Number.isNaN(end) || end <= start) return null
  const span = end - start
  const xOf = (time: number): number => Math.max(0, Math.min(240, ((time - start) / span) * 240))
  const yOf = (remaining: number): number => 2 + (1 - remaining / total) * 44
  const incomplete = subtasks.filter((step) => !step.isCompleted).length
  const dated = subtasks
    .filter((step) => step.isCompleted && step.completedAt)
    .map((step) => new Date(step.completedAt as string).getTime())
    .filter((time) => !Number.isNaN(time))
    .sort((a, b) => a - b)
  const legacyDone = subtasks.filter((step) => step.isCompleted && !step.completedAt).length
  let remaining = total - legacyDone
  const points = [`${xOf(start)},${yOf(remaining)}`]
  for (const time of dated) {
    points.push(`${xOf(time)},${yOf(remaining)}`)
    remaining -= 1
    points.push(`${xOf(time)},${yOf(remaining)}`)
  }
  points.push(`${xOf(Math.min(now, end))},${yOf(remaining)}`)
  const elapsed = Math.max(0, Math.min(1, (now - start) / span))
  const behindBy = incomplete - total * (1 - elapsed)
  const behind = Math.round(behindBy)
  const status =
    incomplete === 0
      ? 'Complete'
      : now > end
        ? 'Past due date'
        : behindBy <= 0.5
          ? 'On track'
          : `Behind by ~${behind} step${behind === 1 ? '' : 's'}`
  return { points: points.join(' '), status }
}
