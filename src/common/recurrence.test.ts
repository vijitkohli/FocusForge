import { describe, expect, it } from 'vitest'
import {
  materialiseSeries,
  nextWeekday,
  seriesTemplate,
  startSeries,
  stopSeries,
  weekdayOf
} from './recurrence'
import type { ProjectTask } from './types'

const base: ProjectTask = {
  id: 'tmpl',
  title: 'Tutorial prep',
  createdAt: '2026-10-01T00:00:00.000Z',
  deadline: '2026-10-14', // Wednesday
  status: 'in-progress',
  depth: 'Brief',
  model: 'm',
  subtasks: [
    {
      id: 'a',
      title: 'Read the tute sheet',
      isCompleted: true,
      completedAt: 'x',
      focusSeconds: 90,
      timeEstimate: 10
    },
    { id: 'b', title: 'Attempt Q1-3', isCompleted: false, timeEstimate: 30, difficulty: 'hard' }
  ],
  prerequisites: [{ id: 'p', title: 'Install the lab tools', isCompleted: true }]
}

let n = 0
const newId = (): string => `id${++n}`

describe('weekday helpers', () => {
  it('finds the next matching weekday strictly after a date', () => {
    expect(weekdayOf('2026-10-14')).toBe(3)
    expect(nextWeekday('2026-10-14', 3)).toBe('2026-10-21')
    expect(nextWeekday('2026-10-14', 5)).toBe('2026-10-16')
  })
})

describe('materialiseSeries', () => {
  const series = startSeries(base, 3, '2026-11-30')

  it('creates the next week once it is within 7 days, with fresh steps spread over that week', () => {
    const { tasks, created } = materialiseSeries([series], '2026-10-15', newId)
    expect(created).toHaveLength(1)
    const copy = created[0]
    expect(copy).toMatchObject({
      title: 'Tutorial prep · week 2',
      deadline: '2026-10-21',
      seriesId: 'tmpl',
      prerequisites: []
    })
    expect(copy.subtasks.every((s) => !s.isCompleted && !s.completedAt && !s.focusSeconds)).toBe(
      true
    )
    expect(copy.subtasks.map((s) => s.scheduledDate)).toEqual(['2026-10-15', '2026-10-21'])
    expect(tasks[0].recurrence?.lastCreated).toBe('2026-10-21')
    expect(materialiseSeries(tasks, '2026-10-15', newId).created).toHaveLength(0)
  })

  it('waits until the next copy is within the lookahead', () => {
    expect(materialiseSeries([series], '2026-10-13', newId).created).toHaveLength(0)
  })

  it('skips weeks missed while closed, respects until, and never recreates a deleted copy', () => {
    const late = materialiseSeries([series], '2026-11-02', newId)
    expect(late.created.map((t) => [t.deadline, t.title])).toEqual([
      ['2026-11-04', 'Tutorial prep · week 4']
    ])
    const withoutCopy = late.tasks.filter((t) => !t.seriesId || t.recurrence)
    expect(materialiseSeries(withoutCopy, '2026-11-02', newId).created).toHaveLength(0)
    const ended = startSeries(base, 3, '2026-10-20')
    expect(materialiseSeries([ended], '2026-10-15', newId).created).toHaveLength(0)
  })

  it('finds and stops the series from any copy', () => {
    const { tasks, created } = materialiseSeries([series], '2026-10-15', newId)
    expect(seriesTemplate(tasks, created[0])?.id).toBe('tmpl')
    const stopped = stopSeries(tasks[0])
    expect(stopped.recurrence).toBeUndefined()
    expect(materialiseSeries([stopped], '2026-10-22', newId).created).toHaveLength(0)
  })
})
