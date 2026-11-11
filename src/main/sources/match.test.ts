import { describe, expect, it } from 'vitest'
import {
  assignGreedy,
  bestMatch,
  courseCode,
  matchNames,
  normalizeKey,
  planMerges,
  similarCode,
  tokens
} from './match'
import { inSlice } from './slice'

describe('normalisation', () => {
  it('normalizeKey strips extension, hub suffix and course title', () => {
    expect(normalizeKey('COMP9321 - Course Notes.md')).toBe('comp9321')
    expect(normalizeKey('Thesis Hub')).toBe('thesis')
    expect(normalizeKey('personal-website')).toBe('personalwebsite')
    expect(normalizeKey('Personal Web Notes.md')).toBe('personalwebnotes')
    expect(normalizeKey('Café Notes')).toBe('cafénotes')
  })

  it('courseCode finds comp9321 in "COMP9321 - Course Notes"', () => {
    expect(courseCode('COMP9321 - Course Notes')).toBe('comp9321')
  })

  it('tokens split words and camelCase and drop stopwords', () => {
    expect(tokens('The Art of Code.md')).toEqual(['art', 'code'])
    expect(tokens('FocusForge')).toEqual(['focus', 'forge'])
    expect(tokens('garden-planner')).toEqual(['garden', 'planner'])
  })

  it('similarCode allows one substitution or one adjacent swap', () => {
    expect(similarCode('pscy1023', 'psyc1023')).toBe(true)
    expect(similarCode('psyc1022', 'psyc1023')).toBe(false)
    expect(similarCode('math1023', 'mafh1023')).toBe(true)
    expect(similarCode('abcd1023', 'badc1023')).toBe(false)
  })
})

describe('matching', () => {
  it('matches course note to folder by code', () => {
    expect(matchNames('COMP9321 - Course Notes', 'comp9321')?.kind).toBe('code')
  })

  it('matches Thesis Hub to thesis exactly', () => {
    expect(matchNames('Thesis Hub', 'thesis')?.kind).toBe('exact')
  })

  it('matches PSYC1023 to pscy1023 as similar', () => {
    expect(matchNames('PSYC1023', 'pscy1023')?.kind).toBe('similar')
  })

  it('matches Garden Planner Website to garden-planner by tokens', () => {
    expect(matchNames('Garden Planner Website', 'garden-planner')?.kind).toBe('tokens')
  })

  it('matches Personal Web Notes to personal-website by token prefix', () => {
    expect(matchNames('Personal Web Notes', 'personal-website')?.kind).toBe('tokens')
  })

  it('does not match archive-personal to Personal Web Notes', () => {
    expect(matchNames('Personal Web Notes', 'archive-personal')).toBeNull()
  })

  it('does not cross-match math6441/math6443/math6445', () => {
    expect(matchNames('math6441', 'math6443')).toBeNull()
    expect(matchNames('MATH6445 - Topic', 'math6441')).toBeNull()
  })

  it('needs one strong word', () => {
    expect(matchNames('web', 'website')).toBeNull()
    expect(matchNames('Ideas', 'ideas-app')?.kind).toBe('tokens')
  })

  it('merges thesis-data into thesis', () => {
    const m = planMerges([
      { key: 'a', name: 'thesis' },
      { key: 'b', name: 'thesis-data' },
      { key: 'c', name: 'thesis-data_old' },
      { key: 'd', name: 'archive-personal' },
      { key: 'e', name: 'personal-website' }
    ])
    expect([...m.entries()].sort()).toEqual([
      ['b', 'a'],
      ['c', 'a']
    ])
  })

  it('each vault unit attaches to at most one candidate', () => {
    const units = ['Thesis Hub', 'Thesis']
    const folders = [['thesis'], ['thesis-notes', 'thesis']]
    const pairs = assignGreedy(units, folders, (u, f) => bestMatch([u], f)?.score ?? 0)
    expect(pairs).toHaveLength(2)
    expect(new Set(pairs.map((p) => p.left)).size).toBe(2)
  })

  it('exclusive assignment pairs one to one', () => {
    const pairs = assignGreedy(['comp9321', 'COMP9321'], ['comp9321'], () => 1, true)
    expect(pairs).toHaveLength(1)
  })

  it('attaches a list-note heading to the matching project as a section source', () => {
    const headings = ['FocusForge', 'Something Else']
    const candidates = [['FocusForge'], ['garden-planner']]
    const hits = assignGreedy(headings, candidates, (h, c) => bestMatch([h], c)?.score ?? 0)
    expect(hits.map((h) => [h.left, h.right[0]])).toEqual([['FocusForge', 'FocusForge']])
  })

  it('ignores headings that match nothing', () => {
    const hits = assignGreedy(
      ['Random Idea', 'Weekly'],
      [['FocusForge'], ['thesis']],
      (h, c) => bestMatch([h], c)?.score ?? 0
    )
    expect(hits).toEqual([])
  })
})

describe('slice', () => {
  it('matches keys and course codes', () => {
    const keys = ['thesis', 'comp9321', 'psyc1023', 'personalwebsite', 'focusforge']
    expect(inSlice(keys, ['Thesis'])).toBe(true)
    expect(inSlice(keys, ['COMP9321 - Course Notes'])).toBe(true)
    expect(inSlice(keys, ['Personal Website'])).toBe(true)
    expect(inSlice(keys, ['pscy1023'])).toBe(false)
    expect(inSlice(keys, ['pscy1023', 'PSYC1023'])).toBe(true)
    expect(inSlice(keys, ['Garden Planner'])).toBe(false)
    expect(inSlice([], ['Thesis'])).toBe(false)
  })
})
