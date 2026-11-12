// src/common/nextStep.ts
// "What's the one next step for this item?" Pure; shared by the vault item
// note (Phase 4) and "What next?" (Phase 6).
//
// Typed structurally so it works on today's ProjectTask and on the Phase 5
// shape (milestones, milestoneId, deadlineKind) without importing either.

export interface NextStepSubtask {
  id: string
  isCompleted: boolean
  milestoneId?: string
}

export interface NextStepMilestone {
  id: string
  status: string
}

export interface NextStepTask {
  id: string
  createdAt: string
  deadline: string
  deadlineKind?: 'hard' | 'tentative' | 'none'
  subtasks: NextStepSubtask[]
  milestones?: NextStepMilestone[]
}

export interface NextStep<T extends NextStepTask> {
  task: T
  step: T['subtasks'][number]
  milestone: NonNullable<T['milestones']>[number] | null
}

/** Local 'YYYY-MM-DD' of a deadline (date key or ISO), or null. */
function deadlineKey(t: NextStepTask): string | null {
  if (t.deadlineKind === 'none' || !t.deadline) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(t.deadline)) return t.deadline
  const d = new Date(t.deadline)
  if (Number.isNaN(d.getTime())) return null
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** First milestone that isn't done, in order (Phase 5's `currentMilestone`). */
export function currentMilestoneOf<M extends NextStepMilestone>(t: { milestones?: M[] }): M | null {
  return t.milestones?.find((m) => m.status !== 'done') ?? null
}

/**
 * The task's next step: the current milestone's first incomplete step, then
 * any incomplete step not tied to a known milestone. Steps staged for a later
 * milestone stay hidden. Without milestones, the first incomplete step.
 */
export function nextStepForTask<T extends NextStepTask>(t: T): NextStep<T> | null {
  const open = t.subtasks.filter((s) => !s.isCompleted)
  const ms = t.milestones ?? []
  if (ms.length === 0) return open[0] ? { task: t, step: open[0], milestone: null } : null
  const current = currentMilestoneOf(t)
  if (current) {
    const step = open.find((s) => s.milestoneId === current.id)
    if (step) return { task: t, step, milestone: current }
  }
  const known = new Set(ms.map((m) => m.id))
  const loose = open.find((s) => !s.milestoneId || !known.has(s.milestoneId))
  return loose ? { task: t, step: loose, milestone: null } : null
}

/**
 * The item's next step: the task with the earliest hard or tentative
 * deadline (local date) that has a step to do, ties broken by createdAt;
 * tasks without a deadline (including the Loose ends task, deadlineKind
 * 'none') follow, by createdAt.
 */
export function nextStepFor<T extends NextStepTask>(tasks: readonly T[]): NextStep<T> | null {
  const ordered = tasks
    .map((t, i) => ({ t, i, key: deadlineKey(t) }))
    .sort((a, b) => {
      if (a.key !== b.key) {
        if (a.key === null) return 1
        if (b.key === null) return -1
        return a.key < b.key ? -1 : 1
      }
      const c = String(a.t.createdAt).localeCompare(String(b.t.createdAt))
      return c !== 0 ? c : a.i - b.i
    })
  for (const { t } of ordered) {
    const next = nextStepForTask(t)
    if (next) return next
  }
  return null
}
