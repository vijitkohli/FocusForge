// src/common/itemTasks.ts
//
// Item-level planning (PHASE5 §3.6, amended by SYNC_PLAN contract 4): due-dated
// deliverables in an item's digest become real tasks, and a passion/ongoing
// item with no deliverable gets one goal task. Gaps are NOT created here
// (Phase 3's "Loose ends" owns them). New tasks reuse the outline-import shape
// (status 'unplanned' + assessment) and are then auto-planned (D8).

import type { ItemDigest, DigestDueDate } from './digest'
import type { ProjectTask, Workstream } from './types'
import { AssessmentKind, assessmentTask, isValidDateKey, normaliseTitle } from './outline'
import { localDateKey } from './schedule'

const DELIVERABLE_KINDS = new Set(['assignment', 'exam', 'presentation', 'quiz', 'lab', 'report'])
export const TENTATIVE_DEFAULT_DAYS = 14 // D6: no term calendar known
export const GOAL_HORIZON_DAYS = 28 // D7

export type TaskPatch = { taskId: string; patch: Partial<ProjectTask> }

function addDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number)
  return localDateKey(new Date(y, m - 1, d + days))
}

function assessmentKind(kind: DigestDueDate['kind']): AssessmentKind {
  if (kind === 'report') return 'assignment'
  return kind && kind !== 'other' ? kind : 'other'
}

export function deliverableKey(what: string): string {
  return `deliverable:${normaliseTitle(what)}`
}

export const GOAL_KEY = 'goal'

/** Is this a digest due date that should become its own task? */
export function isDeliverable(d: DigestDueDate): boolean {
  return !!d.what?.trim() && !!d.kind && DELIVERABLE_KINDS.has(d.kind)
}

export function tasksFromDigest(
  digest: Pick<ItemDigest, 'dueDates'>,
  item: Pick<Workstream, 'id' | 'name' | 'kind'>,
  existing: readonly ProjectTask[],
  dismissed: readonly string[],
  today: string,
  newId: () => string,
  now = new Date()
): { add: ProjectTask[]; update: TaskPatch[] } {
  const add: ProjectTask[] = []
  const update: TaskPatch[] = []
  const skip = new Set(dismissed)
  const titles = new Set(existing.map((t) => normaliseTitle(t.title)))
  const byKey = new Map(existing.filter((t) => t.origin).map((t) => [t.origin!.key, t]))

  for (const due of digest.dueDates ?? []) {
    if (!isDeliverable(due)) continue
    const key = deliverableKey(due.what)
    if (skip.has(key)) continue
    const dated = isValidDateKey(due.date) ? due.date : null
    const deadlineKind = due.confidence === 'tentative' || !dated ? 'tentative' : 'hard'
    const prior = byKey.get(key)
    if (prior) {
      // A due date that firmed up or moved: patch it (the next plan run re-fits the plan).
      if (dated && (prior.deadline !== dated || (prior.deadlineKind ?? 'hard') !== deadlineKind)) {
        update.push({ taskId: prior.id, patch: { deadline: dated, deadlineKind } })
      }
      continue
    }
    if (titles.has(normaliseTitle(due.what))) continue // e.g. already imported from the outline
    titles.add(normaliseTitle(due.what))
    const source = due.sources?.[0]?.label ?? 'digest'
    const task = assessmentTask(
      {
        title: due.what,
        dueDate: dated ?? addDays(today, TENTATIVE_DEFAULT_DAYS),
        when: due.when ?? '',
        weight: typeof due.weight === 'number' ? due.weight : null,
        kind: assessmentKind(due.kind),
        notes: ''
      },
      source,
      newId(),
      now
    )
    add.push({
      ...task,
      depth: 'Deep',
      deadlineKind,
      scope: 'deliverable',
      origin: { kind: 'deliverable', key, source }
    })
  }

  const openDeliverable = [...existing, ...add].some(
    (t) =>
      (t.origin?.kind === 'deliverable' || !!t.assessment) &&
      !(t.subtasks.length > 0 && t.subtasks.every((s) => s.isCompleted))
  )
  const hasGoal = existing.some((t) => t.origin?.kind === 'goal')
  if (
    (item.kind === 'passion' || item.kind === 'ongoing') &&
    !openDeliverable &&
    !hasGoal &&
    !skip.has(GOAL_KEY)
  ) {
    add.push({
      id: newId(),
      title: `${item.name}: next steps`,
      createdAt: now.toISOString(),
      deadline: addDays(today, GOAL_HORIZON_DAYS), // rolling horizon, kept for compatibility
      deadlineKind: 'none',
      scope: 'goal',
      status: 'unplanned',
      depth: 'Deep',
      model: '',
      subtasks: [],
      prerequisites: [],
      origin: { kind: 'goal', key: GOAL_KEY, source: 'item' }
    })
  }
  return { add, update }
}

/** Records a deleted auto-created task so it never comes back (D1). */
export function withDismissed(
  dismissed: readonly string[] | undefined,
  task: ProjectTask | undefined
): string[] {
  const list = [...(dismissed ?? [])]
  if (task?.origin && !list.includes(task.origin.key)) list.push(task.origin.key)
  return list
}
