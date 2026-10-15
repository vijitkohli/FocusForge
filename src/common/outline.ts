import type { ProjectTask } from './types'

// Course-outline import: assessments read from a PDF become unplanned tasks.

export type AssessmentKind = 'exam' | 'assignment' | 'quiz' | 'lab' | 'presentation' | 'other'

/** One graded assessment as engine/syllabus.py returns it. */
export interface OutlineAssessment {
  title: string
  dueDate: string | null
  /** The outline's own wording for timing, e.g. "Week 10 tutorial". */
  when: string
  weight: number | null
  kind: AssessmentKind
  notes: string
}

/** What reading an outline PDF returns to the renderer. */
export interface OutlineReadResult {
  fileName: string
  course?: string
  assessments?: OutlineAssessment[]
  error?: string
  cancelled?: boolean
}

/** A row in the review drawer. */
export interface OutlineCandidate extends OutlineAssessment {
  key: string
  selected: boolean
  /** A task with the same title already exists in this project. */
  existing: boolean
}

/** Stored on tasks created from an outline, so the coach can be briefed later. */
export interface AssessmentInfo {
  weight: number | null
  kind: AssessmentKind
  notes: string
  when: string
  source: string
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

export function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function isValidDateKey(value: string | null | undefined): value is string {
  if (!value || !DATE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
}

export function toCandidates(
  assessments: readonly OutlineAssessment[],
  tasks: readonly Pick<ProjectTask, 'title'>[]
): OutlineCandidate[] {
  const taken = new Set(tasks.map((task) => normaliseTitle(task.title)))
  return assessments.map((item, index) => {
    const existing = taken.has(normaliseTitle(item.title))
    return { ...item, key: `a${index}`, existing, selected: !existing }
  })
}

/** Why a selected row can't be imported yet, or null when it's fine. */
export function candidateProblem(candidate: OutlineCandidate): string | null {
  if (!candidate.selected) return null
  if (!candidate.title.trim()) return 'Give this assessment a name.'
  if (!isValidDateKey(candidate.dueDate)) return 'Pick a due date.'
  return null
}

export function assessmentTask(
  item: OutlineAssessment & { dueDate: string },
  source: string,
  id: string,
  now = new Date()
): ProjectTask {
  return {
    id,
    title: item.title.trim(),
    createdAt: now.toISOString(),
    deadline: item.dueDate,
    status: 'unplanned',
    depth: 'Brief',
    model: '',
    subtasks: [],
    prerequisites: [],
    assessment: {
      weight: item.weight,
      kind: item.kind,
      notes: item.notes,
      when: item.when,
      source
    }
  }
}

/** Adds outline tasks, skipping any whose title already exists (checked again at save time). */
export function addAssessmentTasks(
  tasks: readonly ProjectTask[],
  items: readonly (OutlineAssessment & { dueDate: string })[],
  source: string,
  newId: () => string,
  now = new Date()
): { tasks: ProjectTask[]; added: ProjectTask[] } {
  const taken = new Set(tasks.map((task) => normaliseTitle(task.title)))
  const added: ProjectTask[] = []
  for (const item of items) {
    const key = normaliseTitle(item.title)
    if (!key || taken.has(key) || !isValidDateKey(item.dueDate)) continue
    taken.add(key)
    added.push(assessmentTask(item, source, newId(), now))
  }
  return { tasks: [...tasks, ...added], added }
}

/** One ledger line listing what the outline said, so every later prompt knows the weightings. */
export function outlineLedgerNote(
  source: string,
  course: string,
  items: readonly OutlineAssessment[]
): string {
  const parts = items.map((item) => {
    const bits = [item.weight != null ? `${item.weight}%` : null, item.dueDate ?? item.when]
      .filter(Boolean)
      .join(', ')
    return bits ? `${item.title} (${bits})` : item.title
  })
  const from = course ? `${course} outline "${source}"` : `Course outline "${source}"`
  return `${from}: ${parts.join('; ')}.`
}

/** The first message Coach is prefilled with when planning an imported assessment. */
export function coachBrief(task: Pick<ProjectTask, 'title' | 'assessment'>): string {
  const info = task.assessment
  const sentences = [task.title]
  if (info?.weight != null) sentences.push(`It's worth ${info.weight}% of the course`)
  if (info?.notes) sentences.push(info.notes)
  return sentences.map((part) => part.trim().replace(/[.\s]+$/, '')).join('. ') + '.'
}

/** True for tasks imported from an outline and not planned yet. */
export function isUnplanned(task: Pick<ProjectTask, 'status' | 'subtasks'>): boolean {
  return task.status === 'unplanned' && (task.subtasks ?? []).length === 0
}
