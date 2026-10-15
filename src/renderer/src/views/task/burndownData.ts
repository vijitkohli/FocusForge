import type { Subtask } from '../../../../common/types'

export function burndownData(
  subtasks: Subtask[],
  createdAt: string,
  deadline: string,
  now = Date.now()
): { points: string; status: string } | null {
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
