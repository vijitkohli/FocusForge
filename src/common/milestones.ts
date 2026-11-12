// src/common/milestones.ts
//
// Pure helpers for two-level plans (Phase 5): milestones cover the whole job,
// and only the current milestone has steps. Tasks without milestones keep the
// old behaviour everywhere (every helper falls back to the flat step list).

import {
  DecompositionResult,
  Milestone,
  Prerequisite,
  ProjectTask,
  Subtask,
  setSubtaskStatus
} from './types'
import { localDateKey } from './schedule'

type MilestoneTask = Pick<ProjectTask, 'milestones' | 'subtasks'>

/** Result of the plan-task / expand-milestone / replan-task IPC. */
export interface PlanTaskResult {
  success: boolean
  status: 'planned' | 'expanded' | 'updated' | 'clarifying' | 'error' | 'cancelled' | 'skipped'
  message: string
  question?: string
  task?: ProjectTask
  issues?: string[]
}

/** main -> renderer 'plan-status' event for background planning. */
export interface PlanStatusEvent {
  projectId: string
  taskId: string
  state: 'queued' | 'running' | 'done' | 'failed'
  message?: string
}

export function hasMilestones(t: Pick<ProjectTask, 'milestones'>): boolean {
  return Array.isArray(t.milestones) && t.milestones.length > 0
}

/** The first milestone that isn't done, in plan order. */
export function currentMilestone(t: MilestoneTask): Milestone | null {
  return (t.milestones ?? []).find((m) => m.status !== 'done') ?? null
}

export function stepsOf(t: MilestoneTask, milestoneId: string): Subtask[] {
  return (t.subtasks ?? []).filter((s) => s.milestoneId === milestoneId)
}

/**
 * Steps grouped for the task page: the current milestone's, those of finished
 * milestones, and steps without a (still existing) milestone. Steps staged for
 * a later milestone stay hidden until it becomes current.
 */
export function visibleSteps(t: MilestoneTask): {
  current: Subtask[]
  earlier: Subtask[]
  unassigned: Subtask[]
} {
  const steps = t.subtasks ?? []
  if (!hasMilestones(t)) return { current: steps, earlier: [], unassigned: [] }
  const byId = new Map((t.milestones ?? []).map((m) => [m.id, m]))
  const cur = currentMilestone(t)
  const current: Subtask[] = []
  const earlier: Subtask[] = []
  const unassigned: Subtask[] = []
  for (const s of steps) {
    const m = s.milestoneId ? byId.get(s.milestoneId) : undefined
    if (!m) unassigned.push(s)
    else if (cur && m.id === cur.id) current.push(s)
    else if (m.status === 'done') earlier.push(s)
  }
  return { current, earlier, unassigned }
}

/** Is this step currently actionable (not staged for a later part, not left over from a finished one)? */
export function isStepLive(t: MilestoneTask, step: Subtask): boolean {
  if (!hasMilestones(t) || !step.milestoneId) return true
  const m = (t.milestones ?? []).find((x) => x.id === step.milestoneId)
  if (!m) return true
  const cur = currentMilestone(t)
  return !!cur && m.id === cur.id
}

export type NextPlanAction =
  | { kind: 'none' }
  /** ≤1 incomplete step left in a full batch: stage the next milestone's steps now. */
  | { kind: 'prefetch'; milestoneId: string }
  /** Batch done but it didn't cover the milestone: write the next batch. */
  | { kind: 'continue'; milestoneId: string }
  /** Batch done and it covered the milestone: mark it done and activate the next (no model call). */
  | { kind: 'advance'; from: string; to: string | null }
  /** The current milestone has no steps yet. */
  | { kind: 'expand'; milestoneId: string }

export function nextPlanAction(t: MilestoneTask): NextPlanAction {
  if (!hasMilestones(t)) return { kind: 'none' }
  const ms = t.milestones ?? []
  const cur = currentMilestone(t)
  if (!cur) return { kind: 'none' }
  const steps = stepsOf(t, cur.id)
  if (steps.length === 0) return { kind: 'expand', milestoneId: cur.id }
  const open = steps.filter((s) => !s.isCompleted)
  const partial = cur.expanded === 'partial'
  const next = ms[ms.indexOf(cur) + 1] ?? null
  if (open.length === 0) {
    if (partial) return { kind: 'continue', milestoneId: cur.id }
    return { kind: 'advance', from: cur.id, to: next ? next.id : null }
  }
  if (
    open.length <= 1 &&
    !partial &&
    next &&
    next.status !== 'done' &&
    stepsOf(t, next.id).length === 0
  ) {
    return { kind: 'prefetch', milestoneId: next.id }
  }
  return { kind: 'none' }
}

function focusMinutes(steps: Subtask[]): number {
  return Math.round(steps.reduce((sum, s) => sum + (s.focusSeconds ?? 0), 0) / 60)
}

function finish(m: Milestone, steps: Subtask[], now: Date): Milestone {
  const actual = focusMinutes(steps)
  return {
    ...m,
    status: 'done',
    completedAt: m.completedAt ?? now.toISOString(),
    ...(actual > 0 ? { actualMinutes: actual } : {})
  }
}

/** Marks the current milestone done (completedAt, actualMinutes) and activates the next one. */
export function applyAdvance<T extends MilestoneTask>(t: T, now = new Date()): T {
  const cur = currentMilestone(t)
  if (!cur) return t
  const ms = t.milestones ?? []
  const idx = ms.indexOf(cur)
  let activated = false
  const milestones = ms.map((m, i): Milestone => {
    if (i === idx) return finish(m, stepsOf(t, m.id), now)
    if (i > idx && !activated && m.status !== 'done') {
      activated = true
      return { ...m, status: 'active' }
    }
    return m
  })
  return { ...t, milestones }
}

/**
 * Manual "This part's done" (done=true) or "Not done yet" (done=false). Undoing
 * reopens the milestone as a partial batch, so the planner writes a continuation.
 */
export function setMilestoneDone<T extends MilestoneTask>(
  t: T,
  id: string,
  done: boolean,
  now = new Date()
): T {
  const ms = t.milestones ?? []
  const idx = ms.findIndex((m) => m.id === id)
  if (idx === -1) return t
  let milestones: Milestone[]
  if (done) {
    milestones = ms.map((m, i) => (i === idx ? finish(m, stepsOf(t, m.id), now) : m))
  } else {
    milestones = ms.map((m, i) => {
      if (i === idx) {
        const rest = { ...m }
        delete rest.completedAt
        delete rest.actualMinutes
        return { ...rest, status: 'active', expanded: 'partial' }
      }
      return m
    })
  }
  const curIdx = milestones.findIndex((m) => m.status !== 'done')
  milestones = milestones.map((m, i) =>
    m.status === 'done' ? m : { ...m, status: i === curIdx ? 'active' : 'todo' }
  )
  return { ...t, milestones }
}

function cleanStep(raw: Partial<Subtask>, id: string, milestoneId: string | undefined): Subtask {
  const step: Subtask = {
    id,
    title: String(raw.title ?? '').trim(),
    isCompleted: false,
    status: 'todo',
    difficulty:
      raw.difficulty === 'easy' || raw.difficulty === 'hard' || raw.difficulty === 'medium'
        ? raw.difficulty
        : 'medium'
  }
  if (typeof raw.timeEstimate === 'number' && raw.timeEstimate > 0)
    step.timeEstimate = Math.round(raw.timeEstimate)
  if (typeof raw.scheduledDate === 'string' && raw.scheduledDate)
    step.scheduledDate = raw.scheduledDate
  if (milestoneId) step.milestoneId = milestoneId
  return step
}

/** Appends a batch of steps for one milestone; ids never collide with existing ones. */
export function appendExpansion<T extends MilestoneTask>(
  t: T,
  milestoneId: string,
  steps: Partial<Subtask>[],
  coversRest: boolean,
  newId: () => string,
  revisedEstimate?: number
): T {
  const taken = new Set((t.subtasks ?? []).map((s) => s.id))
  const fresh = (candidate?: string): string => {
    let id = candidate && !taken.has(candidate) ? candidate : newId()
    while (taken.has(id)) id = newId()
    taken.add(id)
    return id
  }
  const added = steps
    .filter((s) => s && String(s.title ?? '').trim())
    .map((s) => cleanStep(s, fresh(), milestoneId))
  const milestones = (t.milestones ?? []).map((m) =>
    m.id === milestoneId
      ? {
          ...m,
          expanded: coversRest ? ('full' as const) : ('partial' as const),
          ...(revisedEstimate && revisedEstimate > 0
            ? { estimateMinutes: Math.round(revisedEstimate) }
            : {})
        }
      : m
  )
  return { ...t, milestones, subtasks: [...(t.subtasks ?? []), ...added] }
}

function cleanMilestones(raw: Partial<Milestone>[] | undefined, currentId?: string): Milestone[] {
  const seen = new Set<string>()
  const out: Milestone[] = []
  for (const [i, m] of (raw ?? []).entries()) {
    if (!m || !String(m.title ?? '').trim()) continue
    let id = String(m.id ?? '').trim() || `m${i + 1}`
    while (seen.has(id)) id = `${id}-${i + 1}`
    seen.add(id)
    const est = Number(m.estimateMinutes)
    out.push({
      id,
      title: String(m.title).trim(),
      estimateMinutes: Number.isFinite(est) && est > 0 ? Math.round(est) : 60,
      doneWhen: String(m.doneWhen ?? '').trim(),
      status: m.status === 'done' ? 'done' : 'todo',
      ...(m.targetDate ? { targetDate: m.targetDate } : {}),
      ...(m.completedAt ? { completedAt: m.completedAt } : {}),
      ...(m.expanded ? { expanded: m.expanded } : {}),
      ...(m.actualMinutes ? { actualMinutes: m.actualMinutes } : {})
    })
  }
  const cur =
    out.find((m) => m.id === currentId && m.status !== 'done') ??
    out.find((m) => m.status !== 'done')
  if (cur) cur.status = 'active'
  return out
}

/**
 * Builds (or rebuilds) a task from a two-level plan. `base` carries what the
 * existing task already has (id, origin, assessment, deadline, …) and wins for
 * identity fields; the plan supplies milestones, steps and prerequisites.
 */
export function planToTask(
  base: Partial<ProjectTask>,
  data: DecompositionResult,
  newId: () => string
): ProjectTask {
  const milestones = cleanMilestones(data.milestones, data.currentMilestoneId)
  const cur = milestones.find((m) => m.status === 'active')
  if (cur) cur.expanded = data.coversRest ? 'full' : 'partial'
  const ids = new Set<string>()
  const fresh = (): string => {
    let id = newId()
    while (ids.has(id)) id = newId()
    ids.add(id)
    return id
  }
  const validIds = new Set(milestones.map((m) => m.id))
  const subtasks = (data.subtasks ?? [])
    .filter((s) => s && String(s.title ?? '').trim())
    .map((s) => {
      const mid = s.milestoneId && validIds.has(s.milestoneId) ? s.milestoneId : cur?.id
      return cleanStep(s, fresh(), mid)
    })
  const prerequisites: Prerequisite[] = (data.prerequisites ?? [])
    .filter((p) => p && String(p.title ?? '').trim())
    .map((p) => ({
      id: fresh(),
      title: String(p.title).trim(),
      isCompleted: false,
      ...(p.kind ? { kind: p.kind } : {}),
      ...(typeof p.timeEstimate === 'number' ? { timeEstimate: p.timeEstimate } : {})
    }))
  const defined = Object.fromEntries(
    Object.entries(base).filter(([, v]) => v !== undefined)
  ) as Partial<ProjectTask>
  const task: ProjectTask = {
    id: newId(),
    createdAt: new Date().toISOString(),
    deadline: localDateKey(new Date()),
    depth: 'Deep',
    model: '',
    ...defined,
    title: base.title || data.originalTask || 'Untitled task',
    status: 'in-progress',
    subtasks,
    prerequisites,
    milestones
  }
  if (data.assumptions && data.assumptions.length > 0) {
    task.planAssumptions = data.assumptions.slice(0, 8)
  } else {
    delete task.planAssumptions
  }
  return task
}

/** Minutes of the whole job: done milestones count fully, the active one by its done steps. */
export function milestoneMinutes(t: MilestoneTask): {
  total: number
  done: number
  remaining: number
} {
  const ms = t.milestones ?? []
  let total = 0
  let done = 0
  for (const m of ms) {
    total += m.estimateMinutes
    if (m.status === 'done') done += m.estimateMinutes
    else {
      const finished = stepsOf(t, m.id)
        .filter((s) => s.isCompleted)
        .reduce((sum, s) => sum + (s.timeEstimate ?? 0), 0)
      done += Math.min(m.estimateMinutes, finished)
    }
  }
  return { total, done, remaining: Math.max(0, total - done) }
}

/** 0–100. Minutes when the task has milestones, otherwise the old done/total step ratio. */
export function taskProgress(t: MilestoneTask): number {
  if (hasMilestones(t)) {
    const { total, done } = milestoneMinutes(t)
    return total > 0 ? Math.round((done / total) * 100) : 0
  }
  const steps = t.subtasks ?? []
  return steps.length === 0
    ? 0
    : Math.round((steps.filter((s) => s.isCompleted).length / steps.length) * 100)
}

/** Milestones whose target day has passed (local dates) and aren't done. */
export function slippedMilestones(t: MilestoneTask, today = localDateKey(new Date())): Milestone[] {
  return (t.milestones ?? []).filter(
    (m) => m.status !== 'done' && !!m.targetDate && m.targetDate < today
  )
}

function addDays(key: string, days: number): string {
  const [y, mo, d] = key.split('-').map(Number)
  return localDateKey(new Date(y, mo - 1, d + days))
}

function daysBetween(a: string, b: string): number {
  const [ya, ma, da] = a.split('-').map(Number)
  const [yb, mb, db] = b.split('-').map(Number)
  return Math.round(
    (new Date(yb, mb - 1, db).getTime() - new Date(ya, ma - 1, da).getTime()) / 86400000
  )
}

/**
 * Spreads the open milestones' target dates over today..deadline in
 * proportion to their estimates, leaving a day of buffer when there's room.
 * Done milestones keep theirs.
 */
export function redistributeMilestones(
  ms: Milestone[],
  deadline: string,
  today = localDateKey(new Date())
): Milestone[] {
  const open = ms.filter((m) => m.status !== 'done')
  if (open.length === 0) return ms
  let span = Math.max(0, daysBetween(today, deadline))
  if (span >= 2) span -= 1
  const total = open.reduce((sum, m) => sum + Math.max(1, m.estimateMinutes), 0)
  let acc = 0
  const dates = new Map<string, string>()
  for (const m of open) {
    acc += Math.max(1, m.estimateMinutes)
    dates.set(m.id, addDays(today, Math.round((span * acc) / total)))
  }
  return ms.map((m) => (dates.has(m.id) ? { ...m, targetDate: dates.get(m.id) } : m))
}

/** The step "What next?" would offer for this task, or null (no plan yet, or nothing live). */
export function nextStepForTask(t: MilestoneTask): Subtask | null {
  const steps = t.subtasks ?? []
  if (!hasMilestones(t)) return steps.find((s) => !s.isCompleted) ?? null
  const { current, unassigned } = visibleSteps(t)
  return current.find((s) => !s.isCompleted) ?? unassigned.find((s) => !s.isCompleted) ?? null
}

/** Marks steps done by id, stamping completedAt (used by "I already did X"). */
export function markStepsDone(steps: Subtask[], ids: readonly string[]): Subtask[] {
  const set = new Set(ids)
  return steps.map((s) => (set.has(s.id) && !s.isCompleted ? setSubtaskStatus(s, 'done') : s))
}
