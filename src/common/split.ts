import type { Subtask } from './types'

// "Stuck?": one step replaced by 2–3 smaller ones the engine suggests.

export const MAX_FIRST_SPLIT_MINUTES = 5

export interface SplitPart {
  title: string
  timeEstimate: number
  difficulty: 'easy' | 'medium' | 'hard'
}

const DIFFICULTIES = new Set(['easy', 'medium', 'hard'])

function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Validates the engine's suggested parts for `parent`. Returns the cleaned
 * parts, or an error string the UI can show. Lenient where it can repair
 * (keeps the first 3, rounds and floors minutes, caps the first step at 5) and
 * strict where it can't (fewer than 2 usable parts, or a part that just
 * restates the stuck step).
 */
export function normaliseSplit(parent: Subtask, raw: unknown): SplitPart[] | string {
  if (!Array.isArray(raw)) return "The coach didn't suggest any smaller steps. Try again."
  const parts: SplitPart[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { title, timeEstimate, difficulty } = item as Record<string, unknown>
    if (typeof title !== 'string' || !title.trim()) continue
    const minutes =
      typeof timeEstimate === 'number' && Number.isFinite(timeEstimate) ? timeEstimate : 10
    parts.push({
      title: title.trim(),
      timeEstimate: Math.max(1, Math.round(minutes)),
      difficulty:
        typeof difficulty === 'string' && DIFFICULTIES.has(difficulty)
          ? (difficulty as SplitPart['difficulty'])
          : 'medium'
    })
  }
  const kept = parts.slice(0, 3)
  if (kept.length < 2) return "The coach couldn't make this step smaller. Try again."
  const parentTitle = normaliseTitle(parent.title)
  if (kept.some((part) => normaliseTitle(part.title) === parentTitle)) {
    return 'The coach repeated the same step instead of splitting it. Try again.'
  }
  kept[0] = {
    ...kept[0],
    timeEstimate: Math.min(kept[0].timeEstimate, MAX_FIRST_SPLIT_MINUTES),
    difficulty: 'easy'
  }
  return kept
}

/**
 * Replaces `parentId` with the parts, in place. New steps inherit the parent's
 * scheduled date; Focus time already spent moves to the first new step.
 * Returns an error string when the step is gone or already done.
 */
export function spliceSplit(
  subtasks: readonly Subtask[],
  parentId: string,
  parts: readonly SplitPart[],
  newId: () => string
): { subtasks: Subtask[]; created: Subtask[] } | string {
  const index = subtasks.findIndex((step) => step.id === parentId)
  if (index === -1) return 'This step no longer exists. Reload the plan and try again.'
  const parent = subtasks[index]
  if (parent.isCompleted) return 'This step is already done, so there is nothing to split.'
  const created: Subtask[] = parts.map((part, i) => ({
    id: newId(),
    title: part.title,
    isCompleted: false,
    status: 'todo',
    difficulty: part.difficulty,
    timeEstimate: part.timeEstimate,
    ...(parent.scheduledDate ? { scheduledDate: parent.scheduledDate } : {}),
    ...(i === 0 && parent.focusSeconds ? { focusSeconds: parent.focusSeconds } : {})
  }))
  return {
    subtasks: [...subtasks.slice(0, index), ...created, ...subtasks.slice(index + 1)],
    created
  }
}
