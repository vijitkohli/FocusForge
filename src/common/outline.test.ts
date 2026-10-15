import { describe, expect, it } from 'vitest'
import {
  addAssessmentTasks,
  candidateProblem,
  coachBrief,
  isUnplanned,
  isValidDateKey,
  outlineLedgerNote,
  toCandidates,
  type OutlineAssessment
} from './outline'
import type { ProjectTask } from './types'

const a1: OutlineAssessment = {
  title: 'Assignment 1: ER design',
  dueDate: '2026-10-16',
  when: 'Friday 16 October',
  weight: 15,
  kind: 'assignment',
  notes: 'Individual; PDF, max 6 pages.'
}
const exam: OutlineAssessment = {
  title: 'Final exam',
  dueDate: null,
  when: 'Exam period',
  weight: 40,
  kind: 'exam',
  notes: ''
}
const existing = { title: 'assignment 1 - ER design!' } as ProjectTask

describe('toCandidates / candidateProblem', () => {
  it('unticks assessments that already exist as tasks', () => {
    const rows = toCandidates([a1, exam], [existing])
    expect(rows.map((r) => [r.existing, r.selected])).toEqual([
      [true, false],
      [false, true]
    ])
  })

  it('needs a real date and a name for selected rows only', () => {
    const [, examRow] = toCandidates([a1, exam], [])
    expect(candidateProblem(examRow)).toBe('Pick a due date.')
    expect(candidateProblem({ ...examRow, selected: false })).toBeNull()
    expect(candidateProblem({ ...examRow, dueDate: '2026-02-30' })).toBe('Pick a due date.')
    expect(candidateProblem({ ...examRow, dueDate: '2026-11-30', title: ' ' })).toBe(
      'Give this assessment a name.'
    )
    expect(candidateProblem({ ...examRow, dueDate: '2026-11-30' })).toBeNull()
  })

  it('validates calendar dates', () => {
    expect(isValidDateKey('2026-12-31')).toBe(true)
    expect(isValidDateKey('2026-13-01')).toBe(false)
    expect(isValidDateKey('16/10/2026')).toBe(false)
    expect(isValidDateKey(null)).toBe(false)
  })
})

describe('addAssessmentTasks', () => {
  it('creates unplanned tasks, skipping duplicates and undated items', () => {
    let n = 0
    const now = new Date(2026, 9, 15, 9)
    const { tasks, added } = addAssessmentTasks(
      [existing],
      [
        { ...a1, dueDate: '2026-10-16' },
        { ...exam, title: 'Final exam', dueDate: '2026-11-30' },
        { ...exam, title: 'final  EXAM', dueDate: '2026-11-30' },
        { ...exam, title: 'No date', dueDate: '' }
      ],
      'outline.pdf',
      () => `id${++n}`,
      now
    )
    expect(added).toHaveLength(1)
    expect(tasks).toHaveLength(2)
    expect(added[0]).toMatchObject({
      id: 'id1',
      title: 'Final exam',
      deadline: '2026-11-30',
      status: 'unplanned',
      subtasks: [],
      assessment: { weight: 40, kind: 'exam', source: 'outline.pdf' }
    })
    expect(isUnplanned(added[0])).toBe(true)
    expect(
      isUnplanned({ ...added[0], subtasks: [{ id: 's', title: 's', isCompleted: false }] })
    ).toBe(false)
  })
})

describe('outline text', () => {
  it('summarises the outline for the ledger', () => {
    expect(outlineLedgerNote('outline.pdf', 'COMP9999 Data Systems', [a1, exam])).toBe(
      'COMP9999 Data Systems outline "outline.pdf": Assignment 1: ER design (15%, 2026-10-16); Final exam (40%, Exam period).'
    )
  })

  it('briefs the coach in full sentences', () => {
    expect(
      coachBrief({
        title: 'Assignment 1: ER design',
        assessment: { ...a1, source: 'x.pdf' }
      })
    ).toBe("Assignment 1: ER design. It's worth 15% of the course. Individual; PDF, max 6 pages.")
    expect(coachBrief({ title: 'Quiz' })).toBe('Quiz.')
  })
})
