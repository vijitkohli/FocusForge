import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Subtask, cleanTaskTitle, deriveStatus, setSubtaskStatus, withCompletion } from './types'

const NOW = new Date('2026-10-15T09:30:00.000Z')

function subtask(overrides: Partial<Subtask> = {}): Subtask {
    return { id: '1', title: 'Write intro', isCompleted: false, ...overrides }
}

describe('cleanTaskTitle', () => {
    it('returns empty string for empty input', () => {
        expect(cleanTaskTitle('')).toBe('')
    })

    it('strips the no-follow-up sentinel case-insensitively, with surrounding punctuation', () => {
        expect(cleanTaskTitle('Essay on the cold war. DO NOT ASK FOLLOW UP QUESTIONS')).toBe('Essay on the cold war')
        expect(cleanTaskTitle('clean my room do not ask follow up questions.')).toBe('clean my room')
        expect(cleanTaskTitle('Lab report!! Do Not Ask Follow Up Questions!?  ')).toBe('Lab report')
    })

    it('leaves the sentinel alone when it is not at the end', () => {
        expect(cleanTaskTitle('DO NOT ASK FOLLOW UP QUESTIONS about the essay')).toBe(
            'DO NOT ASK FOLLOW UP QUESTIONS about the essay'
        )
    })

    it('collapses newlines and repeated whitespace', () => {
        expect(cleanTaskTitle('Finish\n\nCOMP1511   assignment\r\n1')).toBe('Finish COMP1511 assignment 1')
    })

    it('trims trailing punctuation and whitespace', () => {
        expect(cleanTaskTitle('  Reply to supervisor...?!  ')).toBe('Reply to supervisor')
    })

    it('returns empty when only the sentinel/punctuation remains', () => {
        expect(cleanTaskTitle('DO NOT ASK FOLLOW UP QUESTIONS')).toBe('')
        expect(cleanTaskTitle('...')).toBe('')
    })

    it('truncates to 80 chars with an ellipsis', () => {
        const long = 'a'.repeat(100)
        const out = cleanTaskTitle(long)
        expect(out).toBe('a'.repeat(80) + '…')
    })

    it('does not leave trailing whitespace before the ellipsis', () => {
        const raw = 'x'.repeat(79) + ' ' + 'y'.repeat(20)
        expect(cleanTaskTitle(raw)).toBe('x'.repeat(79) + '…')
    })

    it('keeps titles of exactly 80 chars untouched', () => {
        const exact = 'b'.repeat(80)
        expect(cleanTaskTitle(exact)).toBe(exact)
    })
})

describe('setSubtaskStatus', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(NOW)
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('done sets isCompleted and stamps completedAt with now', () => {
        const out = setSubtaskStatus(subtask(), 'done')
        expect(out).toMatchObject({ status: 'done', isCompleted: true, completedAt: NOW.toISOString() })
    })

    it('done keeps an existing completedAt (no re-stamping history)', () => {
        const earlier = '2026-10-01T10:00:00.000Z'
        const out = setSubtaskStatus(subtask({ isCompleted: true, completedAt: earlier }), 'done')
        expect(out.completedAt).toBe(earlier)
    })

    it.each(['todo', 'doing'] as const)('%s clears completion', (status) => {
        const out = setSubtaskStatus(subtask({ isCompleted: true, completedAt: NOW.toISOString(), status: 'done' }), status)
        expect(out.status).toBe(status)
        expect(out.isCompleted).toBe(false)
        expect(out.completedAt).toBeUndefined()
    })

    it('does not mutate the input and preserves other fields', () => {
        const input = subtask({ difficulty: 'hard', timeEstimate: 10, scheduledDate: '2026-10-16' })
        const snapshot = { ...input }
        const out = setSubtaskStatus(input, 'done')
        expect(input).toEqual(snapshot)
        expect(out).not.toBe(input)
        expect(out).toMatchObject({ id: '1', title: 'Write intro', difficulty: 'hard', timeEstimate: 10, scheduledDate: '2026-10-16' })
    })
})

describe('withCompletion', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(NOW)
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('true maps to done with a timestamp', () => {
        expect(withCompletion(subtask(), true)).toMatchObject({ status: 'done', isCompleted: true, completedAt: NOW.toISOString() })
    })

    it('false maps to todo (even from doing) and clears completedAt', () => {
        const out = withCompletion(subtask({ status: 'doing' }), false)
        expect(out).toMatchObject({ status: 'todo', isCompleted: false })
        expect(out.completedAt).toBeUndefined()
    })

    it('toggling off and on re-stamps with the new time', () => {
        const done = withCompletion(subtask(), true)
        const undone = withCompletion(done, false)
        vi.setSystemTime(new Date('2026-10-16T01:00:00.000Z'))
        const redone = withCompletion(undone, true)
        expect(redone.completedAt).toBe('2026-10-16T01:00:00.000Z')
    })
})

describe('deriveStatus', () => {
    it('prefers an explicit status', () => {
        expect(deriveStatus({ isCompleted: false, status: 'doing' })).toBe('doing')
    })

    it('falls back to isCompleted for legacy subtasks', () => {
        expect(deriveStatus({ isCompleted: true })).toBe('done')
        expect(deriveStatus({ isCompleted: false })).toBe('todo')
    })
})
