import { describe, expect, it } from 'vitest'
import { blockIdFor, gapBlockId } from './format'
import { applyTickChanges, diffTicks } from './ticks'
import { done, step, task } from './testFixtures'
import type { TaskWithPlan } from './types'

const NOW = '2026-11-11T03:00:00.000Z'
const S = (t: string, s: string): string => blockIdFor('s', t, s)

function fixture(): TaskWithPlan[] {
  return [
    task('t1', 'Proposal', {
      prerequisites: [{ id: 'p1', title: 'Get PDF', isCompleted: false }],
      subtasks: [done('1', 'Read'), step('2', 'Write'), step('3', 'Send')]
    }),
    // subtask ids repeat across tasks
    task('t2', 'Pilot', { subtasks: [step('1', 'Run pilot')] }),
    task('le', 'Loose ends', {
      auto: 'loose-ends',
      deadlineKind: 'none',
      subtasks: [
        step('g1', 'Find the slot', { gapId: 'abc123' }),
        step('g2', 'Ask', { gapId: 'Odd/Id' })
      ]
    })
  ]
}

describe('ticks', () => {
  it('diff against base applies only changed blocks', () => {
    const base = { a: false, b: true, c: false }
    const parsed = new Map([
      ['a', true],
      ['b', true],
      ['c', false],
      ['zz', true]
    ])
    expect(diffTicks(base, parsed)).toEqual({
      changes: [{ id: 'a', checked: true }],
      unknown: ['zz']
    })
    // a line the owner deleted is ignored, not treated as an untick
    expect(diffTicks({ a: true }, new Map()).changes).toEqual([])
    expect(diffTicks({}, new Map([['__proto__', true]])).unknown).toEqual(['__proto__'])
  })

  it('tick in Obsidian completes the step; untick sets todo and clears completedAt', () => {
    const r = applyTickChanges(fixture(), [{ id: S('t1', '2'), checked: true }], { now: NOW })
    const s = r.tasks[0].subtasks[1]
    expect(s).toMatchObject({ isCompleted: true, status: 'done', completedAt: NOW })
    expect(r.applied).toEqual([
      { id: S('t1', '2'), kind: 'step', taskId: 't1', title: 'Write', checked: true }
    ])
    expect(r.tasks[1].subtasks[0].isCompleted).toBe(false) // same subtask id, other task
    const u = applyTickChanges(r.tasks, [{ id: S('t1', '1'), checked: false }], { now: NOW })
    const un = u.tasks[0].subtasks[0]
    expect(un.isCompleted).toBe(false)
    expect(un.status).toBe('todo')
    expect(un.completedAt).toBeUndefined()
  })

  it('unknown block ids ignored and reported', () => {
    const input = fixture()
    const r = applyTickChanges(input, [{ id: 'ff-s-0000000000', checked: true }], { now: NOW })
    expect(r.unknown).toEqual(['ff-s-0000000000'])
    expect(r.changed).toBe(false)
    expect(r.tasks).toEqual(input)
  })

  it('task tick completes remaining steps and untick reverts only those', () => {
    const t = blockIdFor('t', 't1')
    const r = applyTickChanges(fixture(), [{ id: t, checked: true }], { now: NOW })
    expect(r.tasks[0].subtasks.every((s) => s.isCompleted)).toBe(true)
    expect(r.bulk).toEqual({ [t]: ['2', '3'] })
    expect(r.tasks[0].subtasks[0].completedAt).toBe('2026-11-10T01:00:00.000Z') // untouched
    const u = applyTickChanges(r.tasks, [{ id: t, checked: false }], { bulk: r.bulk, now: NOW })
    expect(u.tasks[0].subtasks.map((s) => s.isCompleted)).toEqual([true, false, false])
    expect(u.bulk).toEqual({})
    expect(u.applied[0]).toMatchObject({ kind: 'task', checked: false, title: 'Proposal' })
  })

  it('prerequisite tick', () => {
    const p = blockIdFor('p', 't1', 'p1')
    const r = applyTickChanges(fixture(), [{ id: p, checked: true }], { now: NOW })
    expect(r.tasks[0].prerequisites![0].isCompleted).toBe(true)
    expect(r.applied).toEqual([
      { id: p, kind: 'prerequisite', taskId: 't1', title: 'Get PDF', checked: true }
    ])
    expect(fixture()[0].prerequisites![0].isCompleted).toBe(false) // input not mutated
  })

  it('ff-g tick resolves through gapId in the loose-ends task', () => {
    const r = applyTickChanges(
      fixture(),
      [
        { id: 'ff-g-abc123', checked: true },
        { id: gapBlockId('Odd/Id'), checked: true }
      ],
      { now: NOW }
    )
    expect(r.tasks[2].subtasks.map((s) => s.isCompleted)).toEqual([true, true])
    expect(r.applied.map((a) => a.kind)).toEqual(['gap', 'gap'])
    // a gapId on a task that isn't the Loose ends task doesn't resolve as ^ff-g
    const other = [task('x', 'X', { subtasks: [step('1', 'a', { gapId: 'abc123' })] })]
    expect(
      applyTickChanges(other, [{ id: 'ff-g-abc123', checked: true }], { now: NOW }).unknown
    ).toEqual(['ff-g-abc123'])
  })

  it('applying twice is a no-op', () => {
    const changes = [
      { id: S('t1', '2'), checked: true },
      { id: blockIdFor('t', 't2'), checked: true },
      { id: blockIdFor('p', 't1', 'p1'), checked: true },
      { id: 'ff-g-abc123', checked: true }
    ]
    const once = applyTickChanges(fixture(), changes, { now: NOW })
    expect(once.changed).toBe(true)
    const twice = applyTickChanges(once.tasks, changes, {
      bulk: once.bulk,
      now: '2026-12-01T00:00:00.000Z'
    })
    expect(twice.changed).toBe(false)
    expect(twice.applied).toEqual([])
    expect(twice.tasks).toEqual(once.tasks)
    expect(twice.bulk).toEqual(once.bulk)
  })
})
