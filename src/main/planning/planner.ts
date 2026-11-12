// src/main/planning/planner.ts
//
// App side of two-level planning: builds the engine payload for a task
// (context pack + digest, ledger, profile, pace, siblings, existing plan),
// runs plan / expand / replan, and saves the result under the project lock.
// Electron-free: everything it touches comes in through PlannerDeps, so it is
// unit-tested with stubs.

import type {
  DeadlineKind,
  LedgerNote,
  ProjectData,
  ProjectTask,
  Workstream
} from '../../common/types'
import type { SaveTag } from '../store/ProjectStore'
import type { ProjectMutation } from '../store/ProjectStore'
import type { PackSource } from './packSource'
import {
  PlanTaskResult,
  appendExpansion,
  currentMilestone,
  hasMilestones,
  milestoneMinutes,
  planToTask,
  stepsOf
} from '../../common/milestones'
import { mergePlan } from '../../common/merge'
import { localDateKey } from '../../common/schedule'

export type PlanMode = 'plan' | 'expand' | 'replan'

export const PLAN_TIMEOUT_MS: Record<PlanMode, number> = {
  plan: 180_000,
  replan: 180_000,
  expand: 90_000
}

export interface PlannerDeps {
  loadProjectData(projectId: string): Promise<ProjectData | null>
  updateProjectData(
    projectId: string,
    mutate: (data: ProjectData) => Promise<ProjectMutation>,
    tag?: SaveTag
  ): Promise<{ success: boolean; error?: string } | null>
  getProject(projectId: string): Workstream | undefined
  packSource: PackSource
  readLedger(projectId: string): Promise<string>
  readProfile(): Promise<string>
  planModel(): Promise<string>
  estimateRatio(): Promise<number | undefined>
  /** Runs engine/main.py with the payload; rejects on timeout/cancel. */
  runEngine(payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>
  newId(): string
  today?(): string
}

export interface RunPlanOptions {
  answer?: string
  request?: string
  milestoneId?: string
}

function remainingMinutes(t: ProjectTask): number {
  if (hasMilestones(t)) return milestoneMinutes(t).remaining
  return (t.subtasks ?? [])
    .filter((s) => !s.isCompleted)
    .reduce((sum, s) => sum + (s.timeEstimate ?? 0), 0)
}

export function existingPlanFor(task: ProjectTask): Record<string, unknown> {
  return {
    milestones: (task.milestones ?? []).map((m) => ({
      id: m.id,
      title: m.title,
      estimateMinutes: m.estimateMinutes,
      doneWhen: m.doneWhen,
      status: m.status,
      ...(m.targetDate ? { targetDate: m.targetDate } : {}),
      ...(m.expanded ? { expanded: m.expanded } : {})
    })),
    subtasks: (task.subtasks ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      status: s.isCompleted ? 'done' : 'todo',
      ...(s.timeEstimate ? { timeEstimate: s.timeEstimate } : {}),
      ...(s.scheduledDate ? { scheduledDate: s.scheduledDate } : {}),
      ...(s.milestoneId ? { milestoneId: s.milestoneId } : {}),
      ...(s.focusSeconds ? { focusMinutes: Math.round(s.focusSeconds / 60) } : {})
    })),
    prerequisites: (task.prerequisites ?? []).map((p) => ({
      id: p.id,
      title: p.title,
      kind: p.kind,
      status: p.isCompleted ? 'done' : 'todo'
    }))
  }
}

export async function buildPlanPayload(
  deps: PlannerDeps,
  projectId: string,
  taskId: string,
  mode: PlanMode,
  opts: RunPlanOptions = {}
): Promise<{ payload: Record<string, unknown>; task: ProjectTask } | null> {
  const data = await deps.loadProjectData(projectId)
  const task = data?.tasks.find((t) => t.id === taskId)
  if (!data || !task) return null
  const item = deps.getProject(projectId)
  const [bundle, contextLedger, userProfile, planModel, estimateRatio] = await Promise.all([
    deps.packSource.getContextPack(projectId),
    deps.readLedger(projectId),
    deps.readProfile(),
    deps.planModel(),
    deps.estimateRatio()
  ])
  const deadlineKind: DeadlineKind = task.deadlineKind ?? 'hard'
  const payload: Record<string, unknown> = {
    mode,
    planModel,
    model: planModel,
    today: deps.today ? deps.today() : localDateKey(new Date()),
    item: {
      id: projectId,
      name: item?.name ?? data.name ?? projectId,
      category: item?.category,
      kind: item?.kind ?? 'deadline'
    },
    task: {
      id: task.id,
      title: task.title,
      deadline: deadlineKind === 'none' ? null : task.deadline,
      deadlineKind,
      scope: task.scope ?? (task.origin?.kind === 'goal' ? 'goal' : 'deliverable'),
      assessment: task.assessment ?? null
    },
    siblings: data.tasks
      .filter((t) => t.id !== taskId && remainingMinutes(t) > 0)
      .map((t) => ({
        title: t.title,
        deadline: t.deadline,
        remainingMinutes: remainingMinutes(t)
      })),
    contextPack: bundle
      ? {
          text: bundle.text,
          files: bundle.pack.files.map((f) => ({ id: f.id, label: f.label, kind: f.kind })),
          git: bundle.pack.git.map((g) => ({ id: g.id, label: g.label })),
          index: bundle.pack.index
        }
      : null,
    digest: bundle?.digest ?? null,
    contextLedger,
    userProfile,
    ...(estimateRatio ? { estimateRatio } : {})
  }
  if (mode !== 'plan' || hasMilestones(task)) payload.existingPlan = existingPlanFor(task)
  if (mode === 'expand') payload.milestoneId = opts.milestoneId ?? currentMilestone(task)?.id
  if (opts.request) payload.request = opts.request
  if (opts.answer) payload.messages = [{ role: 'user', content: opts.answer }]
  return { payload, task }
}

function hoursLabel(minutes: number): string {
  return minutes >= 120 ? `~${Math.round(minutes / 60)} h` : `~${minutes} min`
}

/**
 * Runs one planning call and saves it. Expansions are skipped (status
 * 'skipped') when the target milestone already got open steps meanwhile, so a
 * duplicate background job never doubles a batch.
 */
export async function runPlan(
  deps: PlannerDeps,
  projectId: string,
  taskId: string,
  mode: PlanMode,
  opts: RunPlanOptions = {}
): Promise<PlanTaskResult> {
  const built = await buildPlanPayload(deps, projectId, taskId, mode, opts)
  if (!built) return { success: false, status: 'error', message: 'This task no longer exists.' }
  if (mode === 'replan' && !hasMilestones(built.task)) {
    return {
      success: false,
      status: 'error',
      message: 'This task has no milestone plan to re-plan.'
    }
  }
  const response = await deps.runEngine(built.payload, PLAN_TIMEOUT_MS[mode])
  const status = response.status
  const message = typeof response.message === 'string' ? response.message : ''
  if (status === 'clarifying') {
    return { success: false, status: 'clarifying', message, question: message }
  }
  const data = response.data as Record<string, unknown> | null
  const expected = mode === 'plan' ? 'complete' : mode === 'expand' ? 'expanded' : 'updated'
  if (status !== expected || !data) {
    return { success: false, status: 'error', message: message || "The plan couldn't be made." }
  }
  const validation = (response.validation ?? {}) as { issues?: { msg?: string; fixed?: boolean }[] }
  const issues = (validation.issues ?? [])
    .filter((i) => !i.fixed && i.msg)
    .map((i) => String(i.msg))
    .slice(0, 6)

  let saved: ProjectTask | undefined
  let skipped = false
  const result = await deps.updateProjectData(projectId, async (file) => {
    const idx = file.tasks.findIndex((t) => t.id === taskId)
    if (idx === -1) return null
    const task = file.tasks[idx]
    const notes: LedgerNote[] = []
    let next: ProjectTask
    if (mode === 'expand') {
      const mid = String(built.payload.milestoneId ?? '')
      const ms = task.milestones?.find((m) => m.id === mid)
      if (!ms || ms.status === 'done' || stepsOf(task, mid).some((s) => !s.isCompleted)) {
        skipped = true
        return null
      }
      next = appendExpansion(
        task,
        mid,
        (data.subtasks as never[]) ?? [],
        data.coversRest === true,
        deps.newId,
        typeof data.estimateMinutes === 'number' ? data.estimateMinutes : undefined
      )
      notes.push({ section: 'Plan Adjustments', note: `Added the next steps for "${ms.title}".` })
    } else if (mode === 'plan' && !hasMilestones(task) && (task.subtasks ?? []).length === 0) {
      next = planToTask(task, data as never, deps.newId)
      const total = milestoneMinutes(next).total
      notes.push({
        section: 'Plan Adjustments',
        note: `Planned "${task.title}" in ${next.milestones?.length ?? 0} parts (${hoursLabel(total)}).`
      })
    } else {
      const merged = mergePlan(
        {
          subtasks: task.subtasks ?? [],
          prerequisites: task.prerequisites ?? [],
          milestones: task.milestones ?? []
        },
        {
          milestones: (data.milestones as never[]) ?? [],
          subtasks: (data.subtasks as never[]) ?? [],
          prerequisites: (data.prerequisites as never[]) ?? []
        }
      )
      const milestones = merged.milestones.map((m) =>
        m.status === 'active'
          ? { ...m, expanded: data.coversRest ? ('full' as const) : ('partial' as const) }
          : m
      )
      next = {
        ...task,
        status: task.status === 'unplanned' ? 'in-progress' : task.status,
        milestones,
        subtasks: merged.subtasks,
        prerequisites: merged.prerequisites
      }
      const restored = [...merged.restoredSubtasks, ...merged.restoredMilestones]
      if (restored.length > 0) {
        notes.push({
          section: 'Plan Adjustments',
          note: `Kept completed item(s) the AI dropped: ${restored.map((r) => `"${r.title}"`).join(', ')}.`
        })
      }
      notes.push({
        section: 'Plan Adjustments',
        note: opts.request
          ? `Request: "${opts.request}" -> re-planned the rest (${hoursLabel(milestoneMinutes(next).remaining)} left).`
          : `Re-planned the rest of "${task.title}" (${hoursLabel(milestoneMinutes(next).remaining)} left).`
      })
    }
    if (Array.isArray(data.assumptions) && data.assumptions.length > 0 && mode !== 'expand') {
      next.planAssumptions = (data.assumptions as unknown[]).map(String).slice(0, 8)
    }
    if (issues.length > 0) next.planIssues = issues
    else delete next.planIssues
    file.tasks[idx] = next
    saved = next
    return { data: file, notes }
  })
  if (skipped) return { success: true, status: 'skipped', message: 'Already up to date.' }
  if (!result?.success || !saved) {
    return {
      success: false,
      status: 'error',
      message: result?.error || "The plan couldn't be saved."
    }
  }
  const statusOut = mode === 'plan' ? 'planned' : mode === 'expand' ? 'expanded' : 'updated'
  return { success: true, status: statusOut, message, task: saved, issues }
}
