// src/main/vault/testFixtures.ts
// Builders for the vault-note unit tests. Synthetic data only.
import type { Workstream } from '../../common/types'
import type { ItemDigest, Milestone, PlannedSubtask, TaskWithPlan } from './types'

export function step(
  id: string,
  title: string,
  over: Partial<PlannedSubtask> = {}
): PlannedSubtask {
  return { id, title, isCompleted: false, timeEstimate: 10, ...over }
}

export function done(
  id: string,
  title: string,
  over: Partial<PlannedSubtask> = {}
): PlannedSubtask {
  return step(id, title, {
    isCompleted: true,
    status: 'done',
    completedAt: '2026-11-10T01:00:00.000Z',
    ...over
  })
}

export function milestone(id: string, title: string, over: Partial<Milestone> = {}): Milestone {
  return { id, title, estimateMinutes: 60, doneWhen: '', status: 'todo', ...over }
}

export function task(id: string, title: string, over: Partial<TaskWithPlan> = {}): TaskWithPlan {
  return {
    id,
    title,
    createdAt: '2026-11-01T00:00:00.000Z',
    deadline: '2026-11-20',
    status: 'active',
    depth: 'standard',
    model: 'test',
    subtasks: [],
    ...over
  }
}

export function item(over: Partial<Workstream> = {}): Workstream {
  return {
    id: 'thesis',
    name: 'Thesis',
    path: '/data/thesis',
    progress: 0,
    lastActive: '2026-11-11T00:00:00.000Z',
    category: 'Learning',
    kind: 'deadline',
    status: 'active',
    sources: [],
    ...over
  }
}

export function digest(over: Partial<ItemDigest> = {}): ItemDigest {
  return {
    version: 1,
    itemId: 'thesis',
    generatedAt: '2026-11-11T00:00:00.000Z',
    model: 'test',
    mode: 'full',
    incrementalSinceFull: 0,
    packFingerprint: 'fp',
    promptVersion: 1,
    goal: 'Submit a defensible thesis by 2026-12-05.',
    currentState: '### Where things stand\nPilot v2 ran with 12 tasks (status.md, 10 Nov)',
    openItems: [],
    dueDates: [],
    recentProgress: [],
    candidateTasks: [],
    constraints: [],
    suggestedKind: null,
    warnings: [],
    ...over
  }
}
