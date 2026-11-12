// src/common/looseEnds.ts
// Gaps from an item's digest become steps of one auto task per item,
// "Loose ends" (owner requirement; PHASE3 Q1 default; cross-phase contract 4).
// Pure: the caller saves the result through the normal project save path.
//
// Rules:
// - at most MAX_OPEN_GAPS open gap steps are visible; the rest wait in the
//   digest and are added as slots free up (so gaps don't recreate overwhelm);
// - a gap id is added once and recorded in `seen`; a step the owner deleted
//   (id in `seen`, missing from the task) is never re-added;
// - a gap the digest no longer reports is removed only if untouched (todo,
//   no focus time); completed ones stay;
// - the task's deadline is artificial: `deadlineKind: 'none'`.
import type { LedgerNote, ProjectTask, Subtask } from './types'
import type { DigestCandidateTask } from './digest'
import { isIsoDate } from './digest'

export const LOOSE_ENDS_TITLE = 'Loose ends'
export const MAX_OPEN_GAPS = 3

export interface MergeLooseEndsOptions {
  /** Today, local YYYY-MM-DD. */
  today: string
  newId: () => string
  /** Earliest dated due date in the digest (YYYY-MM-DD), if any. */
  earliestDue?: string | null
  model?: string
  now?: Date
}

export interface MergeLooseEndsResult {
  tasks: ProjectTask[]
  seen: string[]
  added: string[]
  removed: number
  notes: LedgerNote[]
  changed: boolean
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(y, m - 1, d + n)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
}

/** "Find the Week 11 slot (thesis/CONTEXT.md)": the step title ends with its citation. */
export function gapStepTitle(c: Pick<DigestCandidateTask, 'title' | 'sources'>): string {
  const label = c.sources[0]?.label
  const title = c.title.trim()
  return label && !title.endsWith(`(${label})`) ? `${title} (${label})` : title
}

const isOpen = (s: Subtask): boolean => !s.isCompleted
const untouched = (s: Subtask): boolean =>
  !s.isCompleted && (s.status ?? 'todo') === 'todo' && !s.focusSeconds

/** The Loose ends task's deadline: the earliest upcoming due date, else a week from today. */
export function looseEndsDeadline(today: string, earliestDue?: string | null): string {
  return earliestDue && isIsoDate(earliestDue) && earliestDue >= today
    ? earliestDue
    : addDays(today, 7)
}

export function mergeLooseEnds(
  tasks: readonly ProjectTask[],
  candidates: readonly DigestCandidateTask[],
  seen: readonly string[],
  o: MergeLooseEndsOptions
): MergeLooseEndsResult {
  const seenSet = new Set(seen)
  const byId = new Map(candidates.map((c) => [c.id, c]))
  const out = tasks.map((t) => ({ ...t }))
  let idx = out.findIndex((t) => t.auto === 'loose-ends')
  let task: ProjectTask | null =
    idx >= 0 ? { ...out[idx], subtasks: [...(out[idx].subtasks ?? [])] } : null
  let removed = 0
  let changed = false
  const added: string[] = []
  const notes: LedgerNote[] = []

  if (task) {
    // Drop vanished gaps nobody touched; refresh untouched titles.
    const kept: Subtask[] = []
    for (const s of task.subtasks) {
      if (!s.gapId) {
        kept.push(s)
        continue
      }
      const c = byId.get(s.gapId)
      if (!c && untouched(s)) {
        removed++
        seenSet.delete(s.gapId) // auto-removed, not deleted by the owner: may return later
        changed = true
        continue
      }
      if (c && untouched(s)) {
        const title = gapStepTitle(c)
        if (s.title !== title || s.timeEstimate !== c.minutes) {
          kept.push({ ...s, title, timeEstimate: c.minutes })
          changed = true
          continue
        }
      }
      kept.push(s)
    }
    task.subtasks = kept
  }

  const present = new Set((task?.subtasks ?? []).map((s) => s.gapId).filter(Boolean) as string[])
  let open = (task?.subtasks ?? []).filter((s) => s.gapId && isOpen(s)).length
  for (const c of candidates) {
    if (open >= MAX_OPEN_GAPS) break
    if (present.has(c.id)) continue
    if (seenSet.has(c.id)) continue // the owner deleted it: never comes back
    if (!task) {
      task = {
        id: o.newId(),
        title: LOOSE_ENDS_TITLE,
        createdAt: (o.now ?? new Date()).toISOString(),
        deadline: looseEndsDeadline(o.today, o.earliestDue),
        status: 'in-progress',
        depth: 'Brief',
        model: o.model ?? '',
        subtasks: [],
        auto: 'loose-ends',
        deadlineKind: 'none'
      }
      idx = -1
    }
    task.subtasks.push({
      id: `gap-${c.id}`,
      title: gapStepTitle(c),
      isCompleted: false,
      status: 'todo',
      difficulty: 'easy',
      timeEstimate: c.minutes,
      gapId: c.id
    })
    seenSet.add(c.id)
    present.add(c.id)
    added.push(c.id)
    open++
    changed = true
    notes.push({ section: 'Constraints & Specifications', note: `Gap: ${gapStepTitle(c)}` })
  }

  if (task) {
    const deadline = looseEndsDeadline(o.today, o.earliestDue)
    if (task.deadline !== deadline || task.deadlineKind !== 'none') {
      task.deadline = deadline
      task.deadlineKind = 'none'
      changed = true
    }
    if (task.subtasks.length === 0) {
      if (idx >= 0) {
        out.splice(idx, 1)
        changed = true
      }
    } else if (idx >= 0) {
      out[idx] = task
    } else {
      out.push(task)
    }
  }

  return { tasks: out, seen: [...seenSet], added, removed, notes, changed }
}

/** The earliest dated, upcoming due date in a digest's list. */
export function earliestDueDate(
  dueDates: readonly { date: string | null }[],
  today: string
): string | null {
  const dates = dueDates
    .map((d) => d.date)
    .filter((d): d is string => !!d && isIsoDate(d) && d >= today)
    .sort()
  return dates[0] ?? null
}
