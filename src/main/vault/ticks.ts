// src/main/vault/ticks.ts
// Ticks read from a note, diffed against the last written state and applied
// to the tasks. Pure: no fs, no clocks (callers pass `now`).
import { blockIdFor, stepBlockId } from './format'
import type { TaskWithPlan } from './types'

export interface TickChange {
  id: string
  checked: boolean
}

/**
 * Three-way diff: only blocks whose state differs from the base (what the
 * app last wrote) count. Ids missing from the base (a re-planned step, a
 * pasted line) are reported, never applied. Ids missing from the note are
 * ignored (the owner deleted the line).
 */
export function diffTicks(
  base: Record<string, boolean>,
  parsed: ReadonlyMap<string, boolean>
): { changes: TickChange[]; unknown: string[] } {
  const changes: TickChange[] = []
  const unknown: string[] = []
  for (const [id, checked] of parsed) {
    if (!Object.prototype.hasOwnProperty.call(base, id)) unknown.push(id)
    else if (base[id] !== checked) changes.push({ id, checked })
  }
  return { changes, unknown }
}

export interface AppliedTick {
  id: string
  kind: 'step' | 'gap' | 'prerequisite' | 'task'
  taskId: string
  /** Step, prerequisite or task title (for the log and ledger). */
  title: string
  checked: boolean
}

export interface ApplyResult {
  tasks: TaskWithPlan[]
  /** `^ff-t` id -> subtask ids that tick completed. */
  bulk: Record<string, string[]>
  applied: AppliedTick[]
  /** Ids no task resolves any more. */
  unknown: string[]
  changed: boolean
}

type Target =
  | { kind: 'step' | 'gap'; ti: number; si: number }
  | { kind: 'prerequisite'; ti: number; pi: number }
  | { kind: 'task'; ti: number }

function indexBlocks(tasks: TaskWithPlan[]): Map<string, Target> {
  const map = new Map<string, Target>()
  tasks.forEach((t, ti) => {
    map.set(blockIdFor('t', t.id), { kind: 'task', ti })
    t.subtasks.forEach((s, si) => {
      const gap = t.auto === 'loose-ends' && !!s.gapId
      map.set(stepBlockId(t, s), { kind: gap ? 'gap' : 'step', ti, si })
    })
    ;(t.prerequisites ?? []).forEach((p, pi) => {
      map.set(blockIdFor('p', t.id, p.id), { kind: 'prerequisite', ti, pi })
    })
  })
  return map
}

function setStep<S extends { isCompleted: boolean; completedAt?: string; status?: string }>(
  s: S,
  done: boolean,
  now: string
): S {
  return done
    ? { ...s, isCompleted: true, status: 'done', completedAt: s.completedAt ?? now }
    : { ...s, isCompleted: false, status: 'todo', completedAt: undefined }
}

/**
 * Applies tick changes to a copy of the tasks.
 * - A step or Loose-ends gap (`^ff-g`, via `gapId`) is done or todo; untick clears completedAt.
 * - A prerequisite flips `isCompleted`.
 * - Ticking a task's deadline row completes its remaining steps and records
 *   them in `bulk`; unticking reverts only those (Q1).
 * Already-matching state is a no-op, so applying twice changes nothing.
 */
export function applyTickChanges(
  input: TaskWithPlan[],
  changes: TickChange[],
  opts: { bulk?: Record<string, string[]>; now: string }
): ApplyResult {
  const tasks = input.map((t) => ({
    ...t,
    subtasks: [...t.subtasks],
    ...(t.prerequisites ? { prerequisites: [...t.prerequisites] } : {})
  }))
  const bulk: Record<string, string[]> = { ...(opts.bulk ?? {}) }
  const index = indexBlocks(tasks)
  const applied: AppliedTick[] = []
  const unknown: string[] = []

  for (const ch of changes) {
    const target = index.get(ch.id)
    if (!target) {
      unknown.push(ch.id)
      continue
    }
    const t = tasks[target.ti]
    if (target.kind === 'step' || target.kind === 'gap') {
      const s = t.subtasks[target.si]
      if (s.isCompleted === ch.checked) continue
      t.subtasks[target.si] = setStep(s, ch.checked, opts.now)
      applied.push({
        id: ch.id,
        kind: target.kind,
        taskId: t.id,
        title: s.title,
        checked: ch.checked
      })
    } else if (target.kind === 'prerequisite') {
      const list = t.prerequisites ?? []
      const p = list[target.pi]
      if (!p || p.isCompleted === ch.checked) continue
      list[target.pi] = { ...p, isCompleted: ch.checked }
      applied.push({
        id: ch.id,
        kind: 'prerequisite',
        taskId: t.id,
        title: p.title,
        checked: ch.checked
      })
    } else if (ch.checked) {
      const open = t.subtasks.filter((s) => !s.isCompleted).map((s) => s.id)
      if (open.length === 0) continue
      const ids = new Set(open)
      t.subtasks = t.subtasks.map((s) => (ids.has(s.id) ? setStep(s, true, opts.now) : s))
      bulk[ch.id] = [...new Set([...(bulk[ch.id] ?? []), ...open])]
      applied.push({ id: ch.id, kind: 'task', taskId: t.id, title: t.title, checked: true })
    } else {
      const ids = new Set(bulk[ch.id] ?? [])
      delete bulk[ch.id]
      if (!t.subtasks.some((s) => ids.has(s.id) && s.isCompleted)) continue
      t.subtasks = t.subtasks.map((s) =>
        ids.has(s.id) && s.isCompleted ? setStep(s, false, opts.now) : s
      )
      applied.push({ id: ch.id, kind: 'task', taskId: t.id, title: t.title, checked: false })
    }
  }
  return { tasks, bulk, applied, unknown, changed: applied.length > 0 }
}
