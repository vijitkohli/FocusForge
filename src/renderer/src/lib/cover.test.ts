import { describe, expect, it } from 'vitest'
import { coverFor } from './cover'

describe('coverFor', () => {
  it('splits course codes and hashes the identity deterministically', () => {
    expect(coverFor('abc', 'COMP6991')).toEqual({
      hue: 'cover-5',
      band: 2,
      lines: ['COMP', '6991']
    })
    expect(coverFor('abc', 'Another name').hue).toBe('cover-5')
    expect(coverFor('abc', 'COMP6991')).toEqual(coverFor('abc', 'COMP6991'))
  })

  it('uses only the first two words, with empty and single-word fallbacks', () => {
    expect(coverFor('x', '  Personal   study plan  ').lines).toEqual(['Personal', 'study'])
    expect(coverFor('x', 'Notes').lines).toEqual(['Notes', ''])
    expect(coverFor('', '').lines).toEqual(['', ''])
    expect(coverFor('x', 'comp6991').lines).toEqual(['COMP', '6991'])
    expect(coverFor('x', 'comp 9321').lines).toEqual(['COMP', '9321'])
    expect(coverFor('x', 'comp69910').lines).toEqual(['comp69910', ''])
  })

  it('keeps long and unicode identifiers in the allowed palette and band range', () => {
    for (const id of ['x'.repeat(1000), '学习', '\uD83D\uDE00', '', 'project-42']) {
      const cover = coverFor(id, 'Project')
      expect(cover.hue).toMatch(/^cover-[1-5]$/)
      expect([0, 1, 2, 3]).toContain(cover.band)
    }
  })
})
