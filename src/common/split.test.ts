import { describe, expect, it } from 'vitest'
import { normaliseSplit, spliceSplit, type SplitPart } from './split'
import type { Subtask } from './types'

const parent: Subtask = {
  id: 's2',
  title: 'Write the introduction',
  isCompleted: false,
  timeEstimate: 20,
  difficulty: 'hard',
  scheduledDate: '2026-10-16',
  focusSeconds: 300
}

describe('normaliseSplit', () => {
  it('cleans parts, caps the first at 5 easy minutes and keeps at most 3', () => {
    const parts = normaliseSplit(parent, [
      { title: ' Open the doc ', timeEstimate: 8.4, difficulty: 'hard' },
      { title: 'Write the hook sentence', timeEstimate: 6, difficulty: 'weird' },
      { title: 'Draft the thesis line', timeEstimate: 0 },
      { title: 'Extra', timeEstimate: 5 }
    ])
    expect(parts).toEqual([
      { title: 'Open the doc', timeEstimate: 5, difficulty: 'easy' },
      { title: 'Write the hook sentence', timeEstimate: 6, difficulty: 'medium' },
      { title: 'Draft the thesis line', timeEstimate: 1, difficulty: 'medium' }
    ])
  })

  it('rejects too few parts, junk, and a restated parent', () => {
    expect(normaliseSplit(parent, null)).toContain("didn't suggest")
    expect(normaliseSplit(parent, [{ title: 'Only one' }, { title: '' }, 'x'])).toContain(
      "couldn't make"
    )
    expect(
      normaliseSplit(parent, [{ title: 'Open the doc' }, { title: 'write the Introduction.' }])
    ).toContain('repeated')
  })
})

describe('spliceSplit', () => {
  const parts: SplitPart[] = [
    { title: 'Open the doc', timeEstimate: 3, difficulty: 'easy' },
    { title: 'Write one sentence', timeEstimate: 10, difficulty: 'medium' }
  ]
  let n = 0
  const newId = (): string => `split-${++n}`

  it('replaces the step in place, inheriting the date and moving focus time', () => {
    const before: Subtask = { id: 's1', title: 'Before', isCompleted: true }
    const after: Subtask = { id: 's3', title: 'After', isCompleted: false }
    const result = spliceSplit([before, parent, after], 's2', parts, newId)
    if (typeof result === 'string') throw new Error(result)
    expect(result.subtasks.map((s) => s.id)).toEqual(['s1', 'split-1', 'split-2', 's3'])
    expect(result.created[0]).toMatchObject({
      title: 'Open the doc',
      scheduledDate: '2026-10-16',
      focusSeconds: 300,
      status: 'todo',
      isCompleted: false
    })
    expect(result.created[1].focusSeconds).toBeUndefined()
  })

  it('refuses a missing or completed step', () => {
    expect(spliceSplit([parent], 'nope', parts, newId)).toContain('no longer exists')
    expect(spliceSplit([{ ...parent, isCompleted: true }], 's2', parts, newId)).toContain(
      'already done'
    )
  })
})
