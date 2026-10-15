import { afterEach, describe, expect, it, vi } from 'vitest'
import { Subtask } from './types'
import { localDateKey, overdueSubtasks, redistributeSchedule, rescheduleOverdue } from './schedule'

const TODAY = '2026-10-15'

function step(id: string, scheduledDate: string, overrides: Partial<Subtask> = {}): Subtask {
    return { id, title: `Step ${id}`, isCompleted: false, scheduledDate, timeEstimate: 20, ...overrides }
}

const dates = (items: Subtask[]): Record<string, string | undefined> =>
    Object.fromEntries(items.map((s) => [s.id, s.scheduledDate]))

afterEach(() => {
    vi.useRealTimers()
})

describe('localDateKey', () => {
    it('uses the local calendar day, not UTC (00:30 in Sydney is still today)', () => {
        const d = new Date(2026, 9, 15, 0, 30)
        expect(localDateKey(d)).toBe('2026-10-15')
        expect(d.toISOString().startsWith('2026-10-14')).toBe(true)
    })
})

describe('overdueSubtasks', () => {
    it('returns incomplete steps dated before today only', () => {
        const items = [
            step('done-late', '2026-10-10', { isCompleted: true }),
            step('late', '2026-10-14'),
            step('today', TODAY),
            step('undated', '')
        ]
        expect(overdueSubtasks(items, TODAY).map((s) => s.id)).toEqual(['late'])
    })
})

describe('rescheduleOverdue', () => {
    const plan = (): Subtask[] => [
        step('1', '2026-10-10', { isCompleted: true }),
        step('2', '2026-10-11'),
        step('3', '2026-10-12'),
        step('4', '2026-10-13', { timeEstimate: 45 }),
        step('5', '2026-10-17'),
        step('6', '2026-10-19')
    ]

    it('is a no-op when nothing is overdue', () => {
        const items = [step('a', TODAY), step('b', '2026-10-16')]
        const out = rescheduleOverdue(items, '2026-10-20', TODAY)
        expect(out.moved).toBe(0)
        expect(out.subtasks).toBe(items)
    })

    it('moves overdue steps from today onward, keeping order and a daily budget', () => {
        const out = rescheduleOverdue(plan(), '2026-10-20', TODAY)
        expect(out.moved).toBe(3)
        // 125 remaining min over 6 days -> 60 min/day budget: 2+3 fit today, 4 (45 min) spills to tomorrow.
        expect(dates(out.subtasks)).toEqual({
            1: '2026-10-10',
            2: TODAY,
            3: TODAY,
            4: '2026-10-16',
            5: '2026-10-17',
            6: '2026-10-19'
        })
    })

    it('never touches completed or future steps', () => {
        const before = plan()
        const out = rescheduleOverdue(before, '2026-10-20', TODAY)
        for (const id of ['1', '5', '6']) {
            expect(out.subtasks.find((s) => s.id === id)).toBe(before.find((s) => s.id === id))
        }
    })

    it('puts everything on today when today is the deadline', () => {
        const out = rescheduleOverdue(plan(), TODAY, TODAY)
        expect(['2', '3', '4'].map((id) => out.subtasks.find((s) => s.id === id)?.scheduledDate)).toEqual([
            TODAY,
            TODAY,
            TODAY
        ])
    })

    it('spreads over the next few days instead of piling onto today when the deadline has passed', () => {
        const out = rescheduleOverdue(plan(), '2026-10-14', TODAY)
        const moved = ['2', '3', '4'].map((id) => out.subtasks.find((s) => s.id === id)?.scheduledDate as string)
        expect(moved.every((d) => d >= TODAY)).toBe(true)
        expect(new Set(moved).size).toBeGreaterThan(1)
    })

    it('treats a missing estimate as 15 minutes', () => {
        const items = [step('a', '2026-10-01', { timeEstimate: undefined }), step('b', '2026-10-02', { timeEstimate: undefined })]
        const out = rescheduleOverdue(items, '2026-10-16', TODAY)
        expect(dates(out.subtasks)).toEqual({ a: TODAY, b: TODAY })
    })
})

describe('redistributeSchedule', () => {
    it('spreads incomplete steps evenly from today to the deadline, leaving completed ones alone', () => {
        const items = [
            step('done', '2026-10-01', { isCompleted: true }),
            step('a', '2026-10-01'),
            step('b', '2026-10-01'),
            step('c', '2026-10-01')
        ]
        expect(dates(redistributeSchedule(items, '2026-10-19', TODAY))).toEqual({
            done: '2026-10-01',
            a: TODAY,
            b: '2026-10-17',
            c: '2026-10-19'
        })
    })

    it('does not schedule past a deadline of today', () => {
        const out = redistributeSchedule([step('a', '2026-10-01'), step('b', '2026-10-01')], TODAY, TODAY)
        expect(out.map((s) => s.scheduledDate)).toEqual([TODAY, TODAY])
    })

    it('defaults "today" to the local date', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 9, 15, 0, 30)) // 00:30 local = previous day in UTC
        const out = redistributeSchedule([step('a', '2026-10-01')], '2026-10-15')
        expect(out[0].scheduledDate).toBe('2026-10-15')
    })
})
