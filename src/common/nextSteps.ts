// src/common/nextSteps.ts
// Shared with Phase 5 (planning). Phase 5's `Analytics.getNextSteps()` returns
// these; Phase 6's "What next?" picker ranks them. The core fields are
// PHASE5_PLAN §3.7 verbatim; the optional fields at the end are the Phase 6
// asks (SYNC_PLAN cross-phase contract 11). Whichever phase lands first owns
// this file and the other imports from it, so keep the two copies identical.
import type { WorkstreamKind } from './types'
import type { ItemCategory } from './workstreams'

export interface ItemNextStep {
  projectId: string
  itemKind: WorkstreamKind
  category: ItemCategory
  taskId: string
  taskTitle: string
  subtaskId: string | null
  title: string | null
  minutes?: number
  difficulty: 'easy' | 'medium' | 'hard'
  milestoneTitle?: string
  deadline?: string
  deadlineKind: 'hard' | 'tentative' | 'none'
  lastTouchedAt?: string
  needsPlan: boolean
  // Contract 11 (asks from Phase 6), all optional:
  itemName?: string
  taskAuto?: 'loose-ends'
  origin?: 'deliverable' | 'gap' | 'goal'
  scheduledDate?: string
  /** The raw `when` of the matching digest due date, e.g. "Week 11 (TBC)". */
  dueWhen?: string
}
