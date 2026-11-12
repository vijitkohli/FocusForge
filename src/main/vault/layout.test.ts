import { describe, expect, it } from 'vitest'
import { vaultNotePathFor } from '../../common/workstreams'
import {
  findConflictCopies,
  findMovedNote,
  pickName,
  planNotePaths,
  type KnownNotes,
  type LayoutItem
} from './layout'

const it1 = (over: Partial<LayoutItem> = {}): LayoutItem => ({
  id: 'thesis',
  name: 'Thesis',
  category: 'Learning',
  tasks: [],
  ...over
})

describe('layout', () => {
  it('pickName tries base, then (2), (3)… case-insensitively', () => {
    expect(pickName('Week', new Set())).toBe('Week')
    expect(pickName('Week', new Set(['week']))).toBe('Week (2)')
    expect(pickName('Week', new Set(['week', 'week (2)']))).toBe('Week (3)')
  })

  it('task name collision gets (2) case-insensitively', () => {
    const plan = planNotePaths(
      [
        it1({
          tasks: [
            { id: 'a', title: 'Draft' },
            { id: 'b', title: 'draft' },
            { id: 'c', title: 'DRAFT' }
          ]
        })
      ],
      {}
    )
    expect(plan.thesis.tasks).toEqual({
      a: 'FocusForge/Learning/Thesis/Draft.md',
      b: 'FocusForge/Learning/Thesis/draft (2).md',
      c: 'FocusForge/Learning/Thesis/DRAFT (3).md'
    })
    expect(plan.thesis.note).toBe('FocusForge/Learning/Thesis/Thesis.md')
    expect(plan.thesis.note).toBe(vaultNotePathFor({ name: 'Thesis', category: 'Learning' }))
  })

  it('task named like the item gets (task)', () => {
    const plan = planNotePaths(
      [
        it1({
          tasks: [
            { id: 'a', title: 'thesis' },
            { id: 'b', title: 'Thesis (task)' }
          ]
        })
      ],
      {}
    )
    expect(plan.thesis.tasks.a).toBe('FocusForge/Learning/Thesis/thesis (task).md')
    expect(plan.thesis.tasks.b).toBe('FocusForge/Learning/Thesis/Thesis (task) (2).md')
  })

  it('Loose ends task note is Loose ends.md and sanitised names are used', () => {
    const plan = planNotePaths(
      [
        it1({
          tasks: [
            { id: 'le', title: 'Whatever', auto: 'loose-ends' },
            { id: 'x', title: 'A/B: part #1?' }
          ]
        })
      ],
      {}
    )
    expect(plan.thesis.tasks).toEqual({
      le: 'FocusForge/Learning/Thesis/Loose ends.md',
      x: 'FocusForge/Learning/Thesis/A B part 1.md'
    })
  })

  it('existing mapping kept when the title changes', () => {
    const known: KnownNotes = {
      'FocusForge/Learning/Thesis/Thesis.md': { itemId: 'thesis', kind: 'item' },
      'FocusForge/Learning/Thesis/Proposal v4.md': { itemId: 'thesis', taskId: 'a', kind: 'task' }
    }
    const plan = planNotePaths(
      [
        it1({
          tasks: [
            { id: 'b', title: 'Proposal v4' },
            { id: 'a', title: 'Proposal v5' }
          ]
        })
      ],
      known
    )
    expect(plan.thesis.tasks.a).toBe('FocusForge/Learning/Thesis/Proposal v4.md')
    expect(plan.thesis.tasks.b).toBe('FocusForge/Learning/Thesis/Proposal v4 (2).md')
    expect(plan.thesis.moveFrom).toBeUndefined()
  })

  it('item rename plans a folder move', () => {
    const known: KnownNotes = {
      'FocusForge/Learning/Thesis/Thesis.md': { itemId: 'thesis', kind: 'item' },
      'FocusForge/Learning/Thesis/Draft.md': { itemId: 'thesis', taskId: 'a', kind: 'task' }
    }
    const renamed = planNotePaths(
      [it1({ name: 'Honours thesis', tasks: [{ id: 'a', title: 'Draft' }] })],
      known
    )
    expect(renamed.thesis).toEqual({
      folder: 'FocusForge/Learning/Honours thesis',
      note: 'FocusForge/Learning/Honours thesis/Honours thesis.md',
      tasks: { a: 'FocusForge/Learning/Honours thesis/Draft.md' },
      moveFrom: 'FocusForge/Learning/Thesis'
    })
    const recat = planNotePaths([it1({ category: 'Projects' })], known)
    expect(recat.thesis.folder).toBe('FocusForge/Projects/Thesis')
    expect(recat.thesis.moveFrom).toBe('FocusForge/Learning/Thesis')
  })

  it('same-name items in one category get (2) by registry order and keep their folders', () => {
    const items = [it1({ id: 'a', name: 'Notes' }), it1({ id: 'b', name: 'notes' })]
    const plan = planNotePaths(items, {})
    expect(plan.a.folder).toBe('FocusForge/Learning/Notes')
    expect(plan.b.folder).toBe('FocusForge/Learning/notes (2)')
    expect(plan.b.note).toBe('FocusForge/Learning/notes (2)/notes (2).md')
    // b keeps its (2) folder even if a goes away
    const known: KnownNotes = { [plan.b.note]: { itemId: 'b', kind: 'item' } }
    expect(planNotePaths([items[1]], known).b).toMatchObject({
      folder: 'FocusForge/Learning/notes (2)'
    })
    expect(planNotePaths([items[1]], known).b.moveFrom).toBeUndefined()
  })

  it('Life item lands under FocusForge/Life', () => {
    const plan = planNotePaths([it1({ id: 'r', name: 'Reading', category: 'Life' })], {})
    expect(plan.r.note).toBe('FocusForge/Life/Reading/Reading.md')
    expect(Object.values(plan).every((p) => p.folder.startsWith('FocusForge/'))).toBe(true)
  })

  it('findConflictCopies flags "Thesis 2.md" but not a known "Week 2.md"', () => {
    const known = new Set(['Thesis.md', 'Week 2.md', 'Week.md', 'Draft.md'])
    expect(
      findConflictCopies(
        ['Thesis.md', 'Thesis 2.md', 'Week 2.md', 'Draft 3.md', 'Other 2.md', 'x.txt'],
        known
      )
    ).toEqual([
      { copy: 'Thesis 2.md', original: 'Thesis.md' },
      { copy: 'Draft 3.md', original: 'Draft.md' }
    ])
    expect(findConflictCopies(['thesis 2.md'], known)).toEqual([
      { copy: 'thesis 2.md', original: 'thesis.md' }
    ])
  })

  it('findMovedNote matches by ff_task frontmatter', () => {
    const candidates = [
      { rel: 'FocusForge/Learning/Other/A.md', text: '---\nff_id: other\nff_task: t1\n---\n' },
      {
        rel: 'FocusForge/Learning/Moved/Item.md',
        text: '---\nff_id: thesis\nff_note: item\n---\n'
      },
      {
        rel: 'FocusForge/Learning/Moved/Task.md',
        text: '---\nff_id: thesis\nff_task: "t1"\nff_note: task\n---\n'
      },
      { rel: 'FocusForge/Learning/Moved/Bad.md', text: 'no frontmatter' }
    ]
    expect(findMovedNote(candidates, { itemId: 'thesis', taskId: 't1' })).toBe(
      'FocusForge/Learning/Moved/Task.md'
    )
    expect(findMovedNote(candidates, { itemId: 'thesis' })).toBe(
      'FocusForge/Learning/Moved/Item.md'
    )
    expect(findMovedNote(candidates, { itemId: 'thesis', taskId: 'nope' })).toBeNull()
  })

  it('reserved paths (removed notes) are never reused by new notes or folders', () => {
    const plan = planNotePaths(
      [
        it1({ tasks: [{ id: 'n', title: 'Proposal' }] }),
        it1({ id: 'other', name: 'Old', tasks: [] })
      ],
      {},
      ['FocusForge/Learning/Thesis/Proposal.md', 'FocusForge/Learning/Old/Old.md']
    )
    expect(plan.thesis.tasks.n).toBe('FocusForge/Learning/Thesis/Proposal (2).md')
    expect(plan.other.folder).toBe('FocusForge/Learning/Old (2)')
  })
})
