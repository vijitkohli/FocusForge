// src/common/whatNext.fixtures.ts
// Test fixtures for "What next?": the five thin-slice items with generic step
// titles, digests with a null-date tentative due ("Week 11 (TBC)"), a Loose
// ends task, a needsPlan entry and stale overdue data. Dates are fixed around
// FIXTURE_TODAY so the picker tests are deterministic. Used by tests only.
import type { ItemNextStep } from './nextSteps'
import { nextDueOf, type DigestDues, type WhatNextSignals } from './whatNext'

export const FIXTURE_TODAY = '2026-11-11'

/** 3 pm local on FIXTURE_TODAY. */
export function fixtureNow(): Date {
  return new Date(2026, 10, 11, 15, 0, 0, 0)
}

/** An ISO timestamp `days` local days before FIXTURE_TODAY, at `hour` local time. */
export function daysAgoIso(days: number, hour = 10): string {
  return new Date(2026, 10, 11 - days, hour, 0, 0, 0).toISOString()
}

export const ITEM = {
  thesis: 'thesis',
  comp9321: 'comp9321',
  psyc1023: 'psyc1023',
  website: 'personalwebsite',
  focusforge: 'focusforge',
  old: 'oldcourse'
} as const

function step(p: Partial<ItemNextStep> & Pick<ItemNextStep, 'projectId' | 'taskId'>): ItemNextStep {
  return {
    itemKind: 'deadline',
    category: 'Learning',
    taskTitle: p.taskId,
    subtaskId: `${p.taskId}-s1`,
    title: 'Next step',
    minutes: 15,
    difficulty: 'medium',
    deadlineKind: 'hard',
    needsPlan: false,
    ...p
  }
}

export interface FixtureOptions {
  /**
   * The owner's 2026-11-11 scenario: worked on the thesis and psyc in their
   * folders today (sourceActivityAt today), now wants something different.
   */
  ownerScenario?: boolean
}

export function fixtureSteps(o: FixtureOptions = {}): ItemNextStep[] {
  const thesisTouched = o.ownerScenario ? daysAgoIso(0, 11) : daysAgoIso(3)
  const psycTouched = o.ownerScenario ? daysAgoIso(0, 13) : daysAgoIso(4)
  return [
    step({
      projectId: ITEM.comp9321,
      itemName: 'COMP9321',
      taskId: 'a3',
      taskTitle: 'Assignment 3',
      title: 'Read the spec section on the endpoints',
      deadline: '2026-11-12', // tomorrow
      origin: 'deliverable',
      lastTouchedAt: daysAgoIso(3)
    }),
    step({
      projectId: ITEM.comp9321,
      itemName: 'COMP9321',
      taskId: 'a4',
      taskTitle: 'Assignment 4',
      subtaskId: null,
      title: null,
      deadline: '2026-12-01',
      origin: 'deliverable',
      needsPlan: true,
      lastTouchedAt: daysAgoIso(3)
    }),
    step({
      projectId: ITEM.thesis,
      itemName: 'Thesis',
      taskId: 'proposal',
      taskTitle: 'Proposal v5',
      title: 'Draft the methods paragraph',
      deadline: '2026-11-20', // 9 days
      origin: 'deliverable',
      lastTouchedAt: thesisTouched
    }),
    step({
      projectId: ITEM.thesis,
      itemName: 'Thesis',
      taskId: 'presentation',
      taskTitle: 'Thesis A presentation',
      title: 'Outline the three slides',
      deadlineKind: 'tentative',
      dueWhen: 'Week 11 (TBC)',
      origin: 'deliverable',
      lastTouchedAt: thesisTouched
    }),
    step({
      // Loose ends: artificial deadline, and Phase 3 forgot deadlineKind 'none'.
      projectId: ITEM.thesis,
      itemName: 'Thesis',
      taskId: 'loose',
      taskTitle: 'Loose ends',
      taskAuto: 'loose-ends',
      title: 'Find the presentation slot',
      minutes: 5,
      difficulty: 'easy',
      deadline: '2026-11-12',
      deadlineKind: 'hard',
      scheduledDate: FIXTURE_TODAY,
      lastTouchedAt: thesisTouched
    }),
    step({
      projectId: ITEM.psyc1023,
      itemName: 'PSYC1023',
      taskId: 'report',
      taskTitle: 'Research report',
      title: 'List the rubric criteria',
      deadline: '2026-11-28', // 17 days
      origin: 'deliverable',
      lastTouchedAt: psycTouched
    }),
    step({
      projectId: ITEM.website,
      itemName: 'Personal website',
      itemKind: 'passion',
      category: 'Projects',
      taskId: 'goal',
      taskTitle: 'Personal website: next steps',
      title: 'Sketch the projects page layout',
      deadline: '2026-12-09', // rolling horizon, compatibility only
      deadlineKind: 'none',
      origin: 'goal',
      lastTouchedAt: daysAgoIso(6)
    }),
    step({
      projectId: ITEM.focusforge,
      itemName: 'FocusForge',
      itemKind: 'passion',
      category: 'Projects',
      taskId: 'goal',
      taskTitle: 'FocusForge: next steps',
      title: 'Write the picker tie-break test',
      deadline: '2026-12-09',
      deadlineKind: 'none',
      origin: 'goal',
      lastTouchedAt: daysAgoIso(2)
    }),
    step({
      // Stale overdue data: a deadline 99 days ago that nobody closed.
      projectId: ITEM.old,
      itemName: 'Old course',
      taskId: 'lab',
      taskTitle: 'Lab 2',
      title: 'Finish the lab exercises',
      deadline: '2026-08-04',
      lastTouchedAt: daysAgoIso(100)
    })
  ]
}

export const FIXTURE_DIGESTS: Record<string, DigestDues | null> = {
  [ITEM.thesis]: {
    dueDates: [
      { what: 'Thesis A presentation', date: null, when: 'Week 11 (TBC)', confidence: 'tentative' },
      { what: 'Proposal v5', date: '2026-11-20', confidence: 'confirmed' }
    ]
  },
  [ITEM.comp9321]: {
    dueDates: [
      { what: 'Assignment 2', date: '2026-10-20', confidence: 'confirmed' }, // passed
      { what: 'Assignment 3', date: '2026-11-12', confidence: 'confirmed' }
    ]
  },
  [ITEM.psyc1023]: {
    dueDates: [{ what: 'Research report', date: '2026-11-28', confidence: 'tentative' }]
  },
  [ITEM.website]: { dueDates: [] },
  [ITEM.focusforge]: null,
  [ITEM.old]: { dueDates: [{ what: 'Lab 2', date: '2026-08-04', confidence: 'confirmed' }] }
}

export function fixtureSignals(over: Partial<WhatNextSignals> = {}): WhatNextSignals {
  return {
    date: FIXTURE_TODAY,
    dues: Object.entries(FIXTURE_DIGESTS).map(([itemId, digest]) => ({
      itemId,
      nextDue: nextDueOf(digest, FIXTURE_TODAY)
    })),
    starts: {},
    skipsToday: [],
    ...over
  }
}
