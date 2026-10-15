import { describe, expect, it } from 'vitest'
import { fillToday, formatMinutes, planForToday, totalMinutes, type QueueCandidate } from './today'
import { backToBack, buildIcs, escapeText, foldLine } from './ics'

const step = (id: string, minutes?: number, scheduledDate?: string): QueueCandidate => ({
  key: id,
  projectId: 'p',
  taskId: 't',
  subtaskId: id,
  subtaskTitle: `Step ${id}`,
  projectName: 'Project',
  timeEstimate: minutes,
  scheduledDate
})
const today = '2026-10-15'

describe('fillToday', () => {
  it('fills greedily in queue order, skipping steps that would overflow', () => {
    const items = fillToday([step('a', 20), step('b', 30), step('c', 10), step('d', 5)], 35, null, {
      includeCarried: true,
      today
    })
    expect(items.map((i) => i.key)).toEqual(['a', 'c', 'd'])
    expect(totalMinutes(items)).toBe(35)
  })

  it('always takes the first step and applies the pace ratio', () => {
    expect(
      fillToday([step('long', 90), step('b', 10)], 30, null, { includeCarried: true, today }).map(
        (i) => i.key
      )
    ).toEqual(['long'])
    const paced = fillToday([step('a', 10), step('b', 10)], 30, 1.5, {
      includeCarried: true,
      today
    })
    expect(paced.map((i) => i.minutes)).toEqual([15, 15])
  })

  it('leaves carried-over steps out unless asked, and defaults missing estimates to 15', () => {
    const queue = [step('old', 10, '2026-10-10'), step('new', undefined, today)]
    expect(fillToday(queue, 60, null, { includeCarried: false, today }).map((i) => i.key)).toEqual([
      'new'
    ])
    expect(
      fillToday(queue, 60, null, { includeCarried: true, today }).map((i) => [i.key, i.minutes])
    ).toEqual([
      ['old', 10],
      ['new', 15]
    ])
  })

  it('formats durations and drops a plan from another day', () => {
    expect([formatMinutes(45), formatMinutes(60), formatMinutes(65)]).toEqual([
      '45 min',
      '1h',
      '1h 05m'
    ])
    const plan = { date: '2026-10-14', budgetMinutes: 60, includeCarried: false, items: [] }
    expect(planForToday(plan, today)).toBeNull()
    expect(planForToday({ ...plan, date: today }, today)).not.toBeNull()
  })
})

describe('ics', () => {
  it('escapes text and folds long lines at 75 octets', () => {
    expect(escapeText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne')
    const folded = foldLine('SUMMARY:' + 'é'.repeat(60))
    for (const line of folded.split('\r\n'))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    expect(
      folded
        .split('\r\n')
        .slice(1)
        .every((line) => line.startsWith(' '))
    ).toBe(true)
  })

  it('writes back-to-back floating-time events with CRLF line endings', () => {
    const events = backToBack(
      [
        { key: '["p","t","a"]', title: 'Open the doc', minutes: 5, projectName: 'COMP, 9999' },
        { key: '["p","t","b"]', title: 'Write intro', minutes: 25 }
      ],
      new Date(2026, 9, 15, 19, 0)
    )
    const ics = buildIcs(events, new Date(Date.UTC(2026, 9, 15, 8, 0, 0)))
    expect(ics.endsWith('\r\n')).toBe(true)
    expect(ics.split('\r\n')).toEqual(
      expect.arrayContaining([
        'DTSTART:20261015T190000',
        'DTEND:20261015T190500',
        'DTSTART:20261015T190500',
        'DTEND:20261015T193000',
        'SUMMARY:Open the doc',
        'DESCRIPTION:COMP\\, 9999',
        'DTSTAMP:20261015T080000Z'
      ])
    )
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2)
    expect(events[0].uid).toMatch(/^pta-\d+@focusforge$/)
  })
})
