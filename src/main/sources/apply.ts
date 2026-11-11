// src/main/sources/apply.ts
// Turns an approved batch from the approval screen into registry operations.
// Pure apart from guard checks. Every source ref is re-checked here: the
// renderer is never trusted to have filtered them.
import path from 'path'
import type { ApplyDiscoveryRequest } from '../../common/discovery'
import type { ProjectSummary, WorkstreamPatch } from '../../common/types'
import {
  defaultCategoryFor,
  isItemCategory,
  isWorkstreamKind,
  isWorkstreamStatus,
  splitSourceRef,
  withWorkstreamDefaults
} from '../../common/workstreams'
import type { WorkstreamOp } from '../store/ProjectStore'
import type { PathGuard } from './guard'

const CLOSED_LABEL = 'a folder that stays closed'

/** Display label for a refused source. Never names anything under Life. */
export function refusedLabel(ref: string, reason: string): string {
  if (reason === 'life') return CLOSED_LABEL
  const { path: p, heading } = splitSourceRef(typeof ref === 'string' ? ref : '')
  const base = p ? path.basename(p) : 'a source'
  return heading ? `${base} › ${heading}` : base
}

/** Guard-checks source refs; returns the readable ones (de-duplicated) and labels of the rest. */
export function filterSources(
  guard: PathGuard,
  refs: unknown
): { sources: string[]; skipped: string[] } {
  const sources: string[] = []
  const skipped: string[] = []
  if (!Array.isArray(refs)) return { sources, skipped }
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref.trim()) continue
    const d = guard.checkSource(ref)
    if (d.ok) {
      if (!sources.includes(ref)) sources.push(ref)
    } else {
      const label = refusedLabel(ref, d.reason)
      if (!skipped.includes(label)) skipped.push(label)
    }
  }
  return { sources, skipped }
}

/** Guard-checks the `sources` of a patch in place (other keys untouched). */
export function guardPatch(
  guard: PathGuard,
  patch: WorkstreamPatch
): { patch: WorkstreamPatch; skipped: string[] } {
  if (patch.sources === undefined) return { patch, skipped: [] }
  const { sources, skipped } = filterSources(guard, patch.sources)
  return { patch: { ...patch, sources }, skipped }
}

export interface ApplyPlan {
  ops: WorkstreamOp[]
  skippedSources: string[]
  dismissedKeys: string[]
}

/**
 * Approved rows -> create/update ops. Rows adopting an existing entry update
 * it; the rest are created. On the first run, existing entries the batch
 * doesn't mention are kept with status `paused` (never deleted).
 */
export function planApply(
  raw: unknown,
  ctx: { guard: PathGuard; registry: ProjectSummary[]; firstRun: boolean }
): ApplyPlan {
  const req = (raw && typeof raw === 'object' ? raw : {}) as Partial<ApplyDiscoveryRequest>
  const rows = Array.isArray(req.workstreams) ? req.workstreams : []
  const ids = new Set(ctx.registry.map((e) => e.id))
  const referenced = new Set<string>()
  const ops: WorkstreamOp[] = []
  const skippedSources: string[] = []

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const name = typeof row.name === 'string' ? row.name.trim().slice(0, 120) : ''
    if (!name) continue
    const { sources, skipped } = filterSources(ctx.guard, row.sources)
    for (const s of skipped) if (!skippedSources.includes(s)) skippedSources.push(s)
    const fields = {
      name,
      category: isItemCategory(row.category) ? row.category : defaultCategoryFor(name),
      kind: isWorkstreamKind(row.kind) ? row.kind : 'ongoing',
      status: isWorkstreamStatus(row.status) ? row.status : 'active',
      sources
    } as const
    const adopt = typeof row.adoptsProjectId === 'string' ? row.adoptsProjectId : ''
    if (adopt && ids.has(adopt)) {
      if (referenced.has(adopt)) continue
      referenced.add(adopt)
      ops.push({ op: 'update', id: adopt, patch: { ...fields } })
    } else {
      ops.push({ op: 'create', fields: { ...fields } })
    }
  }

  if (ctx.firstRun) {
    for (const e of ctx.registry) {
      if (referenced.has(e.id)) continue
      if (withWorkstreamDefaults(e).status === 'archived') continue
      ops.push({ op: 'update', id: e.id, patch: { status: 'paused' } })
    }
  }

  const dismissedKeys = Array.isArray(req.dismissedKeys)
    ? [...new Set(req.dismissedKeys.filter((k): k is string => typeof k === 'string' && !!k))]
    : []
  return { ops, skippedSources, dismissedKeys }
}
