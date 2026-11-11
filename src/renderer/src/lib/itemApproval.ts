// Approval screen state ("items" in the UI, workstreams in main). Pure, so the
// rules (what starts ticked, which group a row sits in, what Save sends) are
// unit-tested without a renderer.
import type {
  ApplyDiscoveryRequest,
  CandidateSource,
  DiscoveryCandidate,
  DiscoveryResult
} from '../../../common/discovery'
import type { Workstream, WorkstreamKind, WorkstreamStatus } from '../../../common/types'
import { CATEGORY_ORDER, splitSourceRef, type ItemCategory } from '../../../common/workstreams'

/** Where a row sits inside its category group. Fixed when the row is added, so ticking doesn't move it. */
export type RowSection = 'main' | 'also' | 'quiet'

export interface ItemRowState {
  key: string
  included: boolean
  name: string
  category: ItemCategory
  kind: WorkstreamKind
  status: WorkstreamStatus
  sources: CandidateSource[]
  section: RowSection
  /** Already in FocusForge: never unticked, hidden or deleted here. */
  existing: boolean
  adoptsProjectId?: string
  suggestedName?: string
  /** Added on this screen by hand (name only, sources optional). */
  manual: boolean
  reasons: string[]
  recent: boolean
}

export interface ApprovalState {
  rows: ItemRowState[]
  hidden: ItemRowState[]
  /** Keys hidden earlier and not restored (kept on Save). */
  dismissedKeys: string[]
  /** Last refusal, warm and path-free (e.g. a Life pick). */
  notice: { key?: string; message: string } | null
  manualSeq: number
}

export type ApprovalAction =
  | { type: 'toggleInclude'; key: string }
  | { type: 'rename'; key: string; name: string }
  | { type: 'setStatus'; key: string; status: WorkstreamStatus }
  | { type: 'setKind'; key: string; kind: WorkstreamKind }
  | { type: 'setCategory'; key: string; category: ItemCategory }
  | { type: 'detachSource'; key: string; path: string }
  | { type: 'attachSource'; key: string; source: CandidateSource }
  | { type: 'add'; candidate: DiscoveryCandidate }
  | { type: 'addManual'; name: string; category: ItemCategory }
  | { type: 'hide'; key: string }
  | { type: 'restore'; key: string }
  | { type: 'notice'; key?: string; message: string | null }
  /** A fresh discovery run replaces everything. */
  | { type: 'reset'; state: ApprovalState }

function sourceLabel(ref: string): string {
  const { path, heading } = splitSourceRef(ref)
  const base = path.split(/[\\/]/).filter(Boolean).pop() ?? path
  return heading ? `${base} › ${heading}` : base
}

function sourceFromRef(ref: string): CandidateSource {
  const { path, heading } = splitSourceRef(ref)
  return {
    path: ref,
    type: heading ? 'vault-section' : /\.md$/i.test(path) ? 'vault-note' : 'folder',
    label: sourceLabel(ref),
    match: 'user',
    lastActivityAt: null,
    ...(heading ? { heading } : {})
  }
}

function sectionFor(c: { included: boolean; recent: boolean }): RowSection {
  return c.included ? 'main' : c.recent ? 'also' : 'quiet'
}

export function rowFromCandidate(c: DiscoveryCandidate): ItemRowState {
  const existing = !!c.adoptsProjectId
  const included = existing || c.included
  return {
    key: c.key,
    included,
    name: c.name,
    category: c.category,
    kind: c.kind,
    status: c.status,
    sources: c.sources.map((s) => ({ ...s })),
    section: sectionFor({ included, recent: c.recent }),
    existing,
    ...(c.adoptsProjectId ? { adoptsProjectId: c.adoptsProjectId } : {}),
    ...(c.suggestedName ? { suggestedName: c.suggestedName } : {}),
    manual: false,
    reasons: [...c.reasons],
    recent: c.recent
  }
}

/** An existing registry entry nothing matched: kept, editable, never deleted. */
function rowFromExisting(w: Workstream, firstRun: boolean): ItemRowState {
  return {
    key: `existing:${w.id}`,
    included: true,
    name: w.name,
    category: w.category,
    kind: w.kind,
    status: firstRun && w.status === 'active' ? 'paused' : w.status,
    sources: w.sources.map(sourceFromRef),
    section: 'main',
    existing: true,
    adoptsProjectId: w.id,
    ...(/^[a-z]{4}\d{4}$/.test(w.name) ? { suggestedName: w.name.toUpperCase() } : {}),
    manual: false,
    reasons:
      firstRun && w.status === 'active'
        ? ['Already in FocusForge', "Paused for now. It's saved and ready when you are."]
        : ['Already in FocusForge'],
    recent: false
  }
}

export function initApproval(result: DiscoveryResult, opts: { firstRun: boolean }): ApprovalState {
  const rows = result.candidates.map(rowFromCandidate)
  const adopted = new Set(rows.map((r) => r.adoptsProjectId).filter(Boolean))
  for (const w of result.existingUnmatched) {
    if (!adopted.has(w.id)) rows.push(rowFromExisting(w, opts.firstRun))
  }
  return {
    rows,
    hidden: result.dismissed.map(rowFromCandidate).filter((r) => !r.existing),
    dismissedKeys: [...new Set(result.dismissedKeys)],
    notice: null,
    manualSeq: 0
  }
}

function patchRow(
  s: ApprovalState,
  key: string,
  fn: (r: ItemRowState) => ItemRowState
): ApprovalState {
  let hit = false
  const rows = s.rows.map((r) => {
    if (r.key !== key) return r
    hit = true
    return fn(r)
  })
  return hit ? { ...s, rows } : s
}

export function approvalReducer(s: ApprovalState, a: ApprovalAction): ApprovalState {
  switch (a.type) {
    case 'toggleInclude':
      return patchRow(s, a.key, (r) => (r.existing ? r : { ...r, included: !r.included }))
    case 'rename': {
      const name = a.name.trim().slice(0, 120)
      return name ? patchRow(s, a.key, (r) => ({ ...r, name })) : s
    }
    case 'setStatus':
      return patchRow(s, a.key, (r) => ({ ...r, status: a.status }))
    case 'setKind':
      return patchRow(s, a.key, (r) => ({ ...r, kind: a.kind }))
    case 'setCategory':
      return patchRow(s, a.key, (r) => ({ ...r, category: a.category }))
    case 'detachSource':
      return patchRow(s, a.key, (r) => ({
        ...r,
        sources: r.sources.filter((x) => x.path !== a.path)
      }))
    case 'attachSource': {
      // Refused only when a ticked row already has it (unticked suggestions are never created).
      const owner = s.rows.find(
        (r) => (r.included || r.key === a.key) && r.sources.some((x) => x.path === a.source.path)
      )
      if (owner) {
        return {
          ...s,
          notice: {
            key: a.key,
            message:
              owner.key === a.key
                ? 'That one is already attached.'
                : `That's already part of ${owner.name}.`
          }
        }
      }
      return {
        ...patchRow(s, a.key, (r) => ({ ...r, sources: [...r.sources, { ...a.source }] })),
        notice: null
      }
    }
    case 'add': {
      const c = a.candidate
      const known = s.rows.find(
        (r) => r.key === c.key || r.sources.some((x) => c.sources.some((y) => y.path === x.path))
      )
      if (known) {
        // Already listed: tick it rather than duplicating it.
        return {
          ...patchRow(s, known.key, (r) => ({ ...r, included: true })),
          notice: { key: known.key, message: `That's already here as ${known.name}. I ticked it.` }
        }
      }
      const restored = s.hidden.some((r) => r.key === c.key)
      const row: ItemRowState = { ...rowFromCandidate({ ...c, included: true }), section: 'main' }
      return {
        ...s,
        rows: [...s.rows, row],
        hidden: restored ? s.hidden.filter((r) => r.key !== c.key) : s.hidden,
        dismissedKeys: s.dismissedKeys.filter((k) => k !== c.key),
        notice: null
      }
    }
    case 'addManual': {
      const name = a.name.trim().slice(0, 120)
      if (!name) return s
      const seq = s.manualSeq + 1
      const row: ItemRowState = {
        key: `manual:${seq}`,
        included: true,
        name,
        category: a.category,
        kind: a.category === 'Life' || a.category === 'Projects' ? 'passion' : 'ongoing',
        status: 'active',
        sources: [],
        section: 'main',
        existing: false,
        manual: true,
        reasons: ['Added by you'],
        recent: true
      }
      return { ...s, rows: [...s.rows, row], manualSeq: seq, notice: null }
    }
    case 'hide': {
      const row = s.rows.find((r) => r.key === a.key)
      if (!row || row.existing) return s
      return {
        ...s,
        rows: s.rows.filter((r) => r.key !== a.key),
        // Hand-added rows have no stable key worth remembering.
        hidden: row.manual ? s.hidden : [...s.hidden, { ...row, included: false }],
        dismissedKeys:
          row.manual || s.dismissedKeys.includes(row.key)
            ? s.dismissedKeys
            : [...s.dismissedKeys, row.key]
      }
    }
    case 'restore': {
      const row = s.hidden.find((r) => r.key === a.key)
      if (!row) return s
      return {
        ...s,
        hidden: s.hidden.filter((r) => r.key !== a.key),
        rows: [...s.rows, { ...row, section: sectionFor(row) }],
        dismissedKeys: s.dismissedKeys.filter((k) => k !== a.key)
      }
    }
    case 'notice':
      return { ...s, notice: a.message ? { key: a.key, message: a.message } : null }
    case 'reset':
      return a.state
  }
}

export interface CategoryGroup {
  category: ItemCategory
  main: ItemRowState[]
  also: ItemRowState[]
  quiet: ItemRowState[]
  /** Ticked rows that will be active after Save. */
  activeCount: number
}

/** Rows grouped in Learning, Career, Projects, Life order (every group present). */
export function groupRows(rows: ItemRowState[]): CategoryGroup[] {
  return CATEGORY_ORDER.map((category) => {
    const inGroup = rows.filter((r) => r.category === category)
    return {
      category,
      main: inGroup.filter((r) => r.section === 'main'),
      also: inGroup.filter((r) => r.section === 'also'),
      quiet: inGroup.filter((r) => r.section === 'quiet'),
      activeCount: inGroup.filter((r) => r.included && r.status === 'active').length
    }
  })
}

/** Footer numbers: "Save {total} items · {active} active". */
export function footerCounts(s: ApprovalState): { total: number; active: number } {
  const ticked = s.rows.filter((r) => r.included)
  return { total: ticked.length, active: ticked.filter((r) => r.status === 'active').length }
}

/** Ticked rows become create/update requests; unticked suggestions are never created. */
export function buildApplyRequest(s: ApprovalState): ApplyDiscoveryRequest {
  return {
    workstreams: s.rows
      .filter((r) => r.included && r.name.trim())
      .map((r) => ({
        ...(r.manual ? {} : { key: r.key }),
        ...(r.adoptsProjectId ? { adoptsProjectId: r.adoptsProjectId } : {}),
        name: r.name.trim(),
        category: r.category,
        kind: r.kind,
        status: r.status,
        sources: r.sources.map((x) => x.path)
      })),
    dismissedKeys: [...new Set(s.dismissedKeys)]
  }
}
