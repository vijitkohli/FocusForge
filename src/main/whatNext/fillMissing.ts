// src/main/whatNext/fillMissing.ts
// Queues Phase 5 plans for active items that have no next step yet.
// planQueue owns de-duplication, one-at-a-time, proxy gating and tasks-changed.
// This only decides the order and counts its own enqueues against the daily cap.
import type { ItemNextStep } from '../../common/nextSteps'
import type { ReaderStatus } from '../../common/readers'
import type { ItemDueSignal } from '../../common/whatNext'

/** How many background plans Phase 6 itself may enqueue in one local day. */
export const BACKGROUND_PLAN_DAILY_CAP = 30

export interface FillTarget {
  projectId: string
  taskId: string
}

const SKIP_STATES = new Set(['no-sources', 'error', 'waiting-ai'])

function tier(step: ItemNextStep): number {
  if (step.deadlineKind === 'hard' && step.deadline) return 0
  if (step.deadlineKind === 'tentative') return 1
  if (step.origin === 'goal') return 2
  return 3
}

/**
 * needsPlan tasks of items whose reader isn't blocked, ordered
 * confirmed soonest, then tentative, then goal, then the rest.
 */
export function planJobsFor(
  steps: readonly ItemNextStep[],
  readers: Record<string, Pick<ReaderStatus, 'state'>>,
  dues: readonly ItemDueSignal[] = []
): FillTarget[] {
  const dueDate = new Map(dues.map((d) => [d.itemId, d.nextDue?.date ?? null]))
  const jobs = steps.filter((s) => {
    if (!s.needsPlan) return false
    const state = readers[s.projectId]?.state
    return !state || !SKIP_STATES.has(state)
  })
  const when = (s: ItemNextStep): string => s.deadline || dueDate.get(s.projectId) || '9999-99-99'
  jobs.sort((a, b) => {
    const t = tier(a) - tier(b)
    if (t !== 0) return t
    const da = when(a)
    const db = when(b)
    if (da !== db) return da < db ? -1 : 1
    if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0
  })
  const seen = new Set<string>()
  const out: FillTarget[] = []
  for (const s of jobs) {
    const key = `${s.projectId}\0${s.taskId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ projectId: s.projectId, taskId: s.taskId })
  }
  return out
}

export async function fillMissing(deps: {
  getNextSteps: () => Promise<ItemNextStep[]>
  readerStatus: () => Promise<Record<string, ReaderStatus>> | Record<string, ReaderStatus>
  dues: () => Promise<ItemDueSignal[]> | ItemDueSignal[]
  enqueue: (job: FillTarget) => Promise<boolean> | boolean
  remaining: number
}): Promise<number> {
  if (deps.remaining <= 0) return 0
  const [steps, readers, dues] = await Promise.all([
    deps.getNextSteps(),
    deps.readerStatus(),
    deps.dues()
  ])
  let added = 0
  for (const job of planJobsFor(steps, readers, dues)) {
    if (added >= deps.remaining) break
    if (await deps.enqueue(job)) added += 1
  }
  return added
}
