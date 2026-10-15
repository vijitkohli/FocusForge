// src/common/merge.ts
//
// Pure (Electron-free) merge of an AI-restructured checklist onto the user's
// existing progress. The engine's mutation phase returns a full replacement
// list; without this, every tick, completedAt timestamp and kanban column the
// user had would be reset - and since streaks/heatmap/burndown are derived
// from completedAt, that history would be silently erased too.

import { Prerequisite, Subtask, deriveStatus, setSubtaskStatus } from './types'

export interface ChecklistState {
  subtasks: Subtask[]
  prerequisites?: Prerequisite[]
}

/** The AI's replacement list: completion fields, if present, are ignored. */
export interface IncomingChecklist {
  subtasks: Partial<Subtask>[]
  prerequisites?: Partial<Prerequisite>[]
}

export interface MergeChecklistOptions {
  /**
   * Allow completed items the AI omitted to actually disappear. Only set this
   * when the user explicitly asked to remove finished work; otherwise they
   * are restored (see `restoredSubtasks`).
   */
  allowDropCompleted?: boolean
  /** Id factory for genuinely new items (injectable for deterministic tests). */
  makeId?: (index: number) => string
}

export interface MergeChecklistResult {
  subtasks: Subtask[]
  prerequisites: Prerequisite[]
  /** Completed subtasks the AI dropped that were re-inserted to keep history. */
  restoredSubtasks: Subtask[]
  /** Completed prerequisites the AI dropped that were re-inserted. */
  restoredPrerequisites: Prerequisite[]
}

/** Case/whitespace/punctuation-insensitive title key for fallback matching. */
export function normalizeTitle(title: string | undefined): string {
  return (title ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * Loose "is this still the same step" check, used before letting an id match
 * carry a COMPLETED state: models sometimes renumber ("1".."5") so a reused
 * id can point at a brand-new step. Overlap of word sets relative to the
 * shorter title, so light edits ("Write intro" -> "Write the intro section")
 * still pass. Titles naming different numbers ("Q1" vs "Q2"/"Q10", "Part 2"
 * vs "Part 3") are never similar - numbered sibling steps share most words.
 */
function titlesSimilar(a: string | undefined, b: string | undefined): boolean {
  const na = normalizeTitle(a)
  const nb = normalizeTitle(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const numbers = (s: string): string => (s.match(/\d+/g) ?? []).join(',')
  if (numbers(na) !== numbers(nb)) return false
  const wa = new Set(na.split(' '))
  const wb = new Set(nb.split(' '))
  let shared = 0
  for (const w of wa) if (wb.has(w)) shared += 1
  // Whole-word containment (one title's words all appear in the other) or majority overlap.
  return shared === Math.min(wa.size, wb.size) || shared / Math.min(wa.size, wb.size) >= 0.5
}

/**
 * Pairs each incoming item with at most one previous item: by id first
 * (guarded by title similarity when the previous item is completed), then by
 * normalized title among the still-unclaimed previous items.
 */
function pairItems<
  P extends { id: string; title: string; isCompleted: boolean },
  I extends { id?: string; title?: string }
>(previous: P[], incoming: I[]): { matches: (P | undefined)[]; claimed: Set<P> } {
  const claimed = new Set<P>()
  const byId = new Map(previous.map((p) => [p.id, p]))
  const matches: (P | undefined)[] = incoming.map((item) => {
    const old = item.id != null ? byId.get(String(item.id)) : undefined
    if (!old || claimed.has(old)) return undefined
    if (old.isCompleted && !titlesSimilar(old.title, item.title)) return undefined
    claimed.add(old)
    return old
  })
  incoming.forEach((item, i) => {
    if (matches[i]) return
    const key = normalizeTitle(item.title)
    if (!key) return
    const old = previous.find((p) => !claimed.has(p) && normalizeTitle(p.title) === key)
    if (old) {
      claimed.add(old)
      matches[i] = old
    }
  })
  return { matches, claimed }
}

/**
 * Merges the AI's replacement checklist onto the previous task state.
 *
 * Rules:
 * - Matched + previously completed: the old item is kept verbatim (title,
 *   completedAt, schedule) - finished work is history, not plan.
 * - Matched + incomplete: the AI's edited fields win, but the kanban status
 *   (todo/doing) carries over.
 * - Unmatched: a genuinely new item - always starts 'todo' (any completion
 *   the model echoed back is ignored) and gets a fresh id if its id is
 *   missing or collides with an existing one.
 * - Completed items the AI dropped are re-inserted at the front (in original
 *   order) unless `allowDropCompleted`: streaks/heatmap are derived from
 *   subtask completedAt, so dropping a done subtask would erase that day's
 *   activity. Incomplete items the AI dropped are removed as requested.
 */
export function mergeChecklist(
  previous: ChecklistState,
  incoming: IncomingChecklist,
  options: MergeChecklistOptions = {}
): MergeChecklistResult {
  const stamp = Date.now()
  const makeId = options.makeId ?? ((i: number) => `ai-${stamp}-${i}`)
  let nextNew = 0

  const prevSubtasks = previous.subtasks ?? []
  const prevPrereqs = previous.prerequisites ?? []
  const usedIds = new Set<string>([
    ...prevSubtasks.map((s) => s.id),
    ...prevPrereqs.map((p) => p.id)
  ])
  const assignedIds = new Set<string>()
  const freshId = (candidate: unknown): string => {
    let id = candidate != null && String(candidate).trim() ? String(candidate) : ''
    while (!id || usedIds.has(id) || assignedIds.has(id)) id = makeId(nextNew++)
    assignedIds.add(id)
    return id
  }

  // --- Subtasks ---
  const inSubtasks = (incoming.subtasks ?? []).filter((s) => s && normalizeTitle(s.title))
  const sub = pairItems(prevSubtasks, inSubtasks)
  const merged: Subtask[] = inSubtasks.map((item, i) => {
    const old = sub.matches[i]
    // Strip completion fields the model may have echoed back.
    const fields: Partial<Subtask> = { ...item }
    delete fields.isCompleted
    delete fields.completedAt
    delete fields.status
    if (old) {
      assignedIds.add(old.id)
      const status = deriveStatus(old)
      // No setSubtaskStatus for 'done': it would stamp a legacy
      // (pre-completedAt) item with today's date and fake a streak day.
      if (status === 'done') return { ...old, status: 'done', isCompleted: true }
      return setSubtaskStatus({ ...old, ...fields, id: old.id } as Subtask, status)
    }
    return setSubtaskStatus(
      { ...fields, title: String(fields.title), id: freshId(fields.id) } as Subtask,
      'todo'
    )
  })

  const restoredSubtasks = options.allowDropCompleted
    ? []
    : prevSubtasks.filter((s) => !sub.claimed.has(s) && deriveStatus(s) === 'done')

  // --- Prerequisites (no completedAt; just isCompleted) ---
  const inPrereqs = (incoming.prerequisites ?? []).filter((p) => p && normalizeTitle(p.title))
  const pre = pairItems(prevPrereqs, inPrereqs)
  const mergedPrereqs: Prerequisite[] = inPrereqs.map((item, i) => {
    const old = pre.matches[i]
    const fields: Partial<Prerequisite> = { ...item }
    delete fields.isCompleted
    if (old) {
      assignedIds.add(old.id)
      return old.isCompleted ? { ...old } : { ...old, ...fields, id: old.id, isCompleted: false }
    }
    return {
      ...fields,
      title: String(fields.title),
      id: freshId(fields.id),
      isCompleted: false
    } as Prerequisite
  })

  const restoredPrerequisites = options.allowDropCompleted
    ? []
    : prevPrereqs.filter((p) => !pre.claimed.has(p) && p.isCompleted)

  return {
    subtasks: [...restoredSubtasks, ...merged],
    prerequisites: [...restoredPrerequisites, ...mergedPrereqs],
    restoredSubtasks,
    restoredPrerequisites
  }
}

/**
 * Heuristic for "the user explicitly asked to remove finished work", which
 * is the only case where `allowDropCompleted` should be set.
 */
export function requestsRemovingCompleted(request: string): boolean {
  return /\b(remove|delete|drop|clear|hide|get rid of)\b.{0,30}\b(done|completed?|finished|ticked|checked)\b/i.test(
    request ?? ''
  )
}
