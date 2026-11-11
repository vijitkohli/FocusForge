import { describe, expect, it } from 'vitest'
import {
  CATEGORIES,
  courseCode,
  displayNameFor,
  formatSourceRef,
  groupByCategory,
  sanitizeWorkstreamPatch,
  splitSourceRef,
  uniqueProjectId,
  vaultNotePathFor,
  withWorkstreamDefaults
} from './workstreams'
import type { ProjectSummary } from './types'

const base = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: 'x',
  name: 'x',
  path: '/tmp/x',
  progress: 0,
  lastActive: '2026-11-01T00:00:00.000Z',
  ...over
})

describe('withWorkstreamDefaults', () => {
  it('fills defaults and keeps other fields', () => {
    const ws = withWorkstreamDefaults(base({ name: 'Garden planner', progress: 40 }))
    expect(ws).toMatchObject({
      category: 'Projects',
      kind: 'ongoing',
      status: 'active',
      sources: [],
      progress: 40
    })
  })

  it('coerces invalid values', () => {
    const raw = {
      ...base(),
      category: 'Other',
      kind: 'urgent',
      status: 'deleted',
      sources: ['/a', 3, '', '/a']
    } as unknown as ProjectSummary
    expect(withWorkstreamDefaults(raw)).toMatchObject({
      category: 'Projects',
      kind: 'ongoing',
      status: 'active',
      sources: ['/a']
    })
  })

  it('category defaults to Learning for course codes and thesis, else Projects', () => {
    expect(withWorkstreamDefaults(base({ name: 'comp9321' })).category).toBe('Learning')
    expect(withWorkstreamDefaults(base({ name: 'MATH1131 notes' })).category).toBe('Learning')
    expect(withWorkstreamDefaults(base({ name: 'Honours Thesis' })).category).toBe('Learning')
    expect(withWorkstreamDefaults(base({ name: 'practice' })).category).toBe('Projects')
    expect(withWorkstreamDefaults(base({ name: 'x', category: 'Life' })).category).toBe('Life')
  })
})

describe('helpers', () => {
  it('courseCode', () => {
    expect(courseCode('COMP9321 - Course Notes')).toBe('comp9321')
    expect(courseCode('comp9321_ass2')).toBe('comp9321')
    expect(courseCode('PSYC 1023')).toBe('psyc1023')
    expect(courseCode('thesis2024')).toBeNull()
    expect(courseCode('comp93210')).toBeNull()
    expect(courseCode('Practice')).toBeNull()
  })

  it('displayNameFor', () => {
    expect(displayNameFor('comp9321')).toBe('COMP9321')
    expect(displayNameFor('garden-planner')).toBe('Garden Planner')
    expect(displayNameFor('personal_website')).toBe('Personal Website')
    expect(displayNameFor('thesis')).toBe('Thesis')
    expect(displayNameFor('FocusForge')).toBe('FocusForge')
    expect(displayNameFor('comp9321-ass2')).toBe('COMP9321 Ass2')
  })

  it('uniqueProjectId', () => {
    expect(uniqueProjectId('Thesis', new Set())).toBe('Thesis')
    expect(uniqueProjectId('Thesis', new Set(['Thesis']))).toBe('Thesis_2')
    expect(uniqueProjectId('thesis', new Set(['Thesis', 'thesis_2']))).toBe('thesis_3')
    expect(uniqueProjectId('My item!', new Set())).toBe('My_item_')
    expect(uniqueProjectId('', new Set())).toBe('item')
  })

  it('groupByCategory order', () => {
    const groups = groupByCategory([
      base({ id: 'a', name: 'Reading', category: 'Life' }),
      base({ id: 'b', name: 'comp9321' }),
      base({ id: 'c', name: 'Garden' }),
      base({ id: 'd', name: 'CV', category: 'Career' })
    ])
    expect(groups.map((g) => g.category)).toEqual([...CATEGORIES])
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([['b'], ['d'], ['c'], ['a']])
  })

  it('splitSourceRef/formatSourceRef round-trip', () => {
    const ref = formatSourceRef('/v/Projects/IDEAS TO DO.md', 'FocusForge')
    expect(ref).toBe('/v/Projects/IDEAS TO DO.md#FocusForge')
    expect(splitSourceRef(ref)).toEqual({
      path: '/v/Projects/IDEAS TO DO.md',
      heading: 'FocusForge'
    })
    expect(splitSourceRef('/a/b#c/notes.md#Week 1 #2')).toEqual({
      path: '/a/b#c/notes.md',
      heading: 'Week 1 #2'
    })
    expect(splitSourceRef('/a/folder')).toEqual({ path: '/a/folder' })
    expect(splitSourceRef('/a/x.md#')).toEqual({ path: '/a/x.md' })
    expect(formatSourceRef('/a/folder', 'x')).toBe('/a/folder')
    expect(formatSourceRef('/a/x.md', '  ')).toBe('/a/x.md')
  })

  it('vaultNotePathFor Life item is FocusForge/Life/...', () => {
    expect(vaultNotePathFor({ name: 'Reading', category: 'Life' })).toBe(
      'FocusForge/Life/Reading/Reading.md'
    )
    expect(vaultNotePathFor({ name: 'comp9321' })).toBe('FocusForge/Learning/comp9321/comp9321.md')
    expect(vaultNotePathFor({ name: '../x/y', category: 'Projects' })).toBe(
      'FocusForge/Projects/x y/x y.md'
    )
  })

  it('sanitizeWorkstreamPatch keeps only valid keys', () => {
    expect(
      sanitizeWorkstreamPatch({
        name: '  New  ',
        category: 'Other',
        kind: 'passion',
        status: 'nope',
        sources: ['/a', '/a', 1, ' '],
        path: '/etc'
      })
    ).toEqual({ name: 'New', kind: 'passion', sources: ['/a'] })
    expect(sanitizeWorkstreamPatch(null)).toEqual({})
  })
})
