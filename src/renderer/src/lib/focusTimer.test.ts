import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FocusTimerStore } from './focusTimer'

let timer: FocusTimerStore
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
  timer = (await import('./focusTimer')).focusTimer
})
afterEach(() => {
  timer.reset()
  vi.useRealTimers()
})

describe('focus timer', () => {
  it('starts only on Play and accumulates actual elapsed time through pause/resume', () => {
    timer.setStep('a', 15)
    vi.advanceTimersByTime(5000)
    expect(timer.getSnapshot()).toMatchObject({ elapsed: 0, running: false })
    timer.play()
    timer.play()
    vi.advanceTimersByTime(1250)
    timer.pause()
    expect(timer.getSnapshot()).toMatchObject({ elapsed: 1, running: false })
    vi.advanceTimersByTime(10000)
    timer.play()
    vi.advanceTimersByTime(750)
    expect(timer.getSnapshot().elapsed).toBe(2)
    timer.reset()
    expect(timer.getSnapshot()).toMatchObject({ subtaskId: 'a', elapsed: 0, running: false })
  })

  it('continues with no mounted subscribers and preserves the same identity', () => {
    timer.setStep('a', 1)
    const listener = vi.fn()
    const unsubscribe = timer.subscribe(listener)
    timer.play()
    unsubscribe()
    listener.mockClear()
    vi.advanceTimersByTime(65000)
    const nextReader = vi.fn()
    timer.subscribe(nextReader)
    timer.setStep('a', 2)
    expect(timer.getSnapshot()).toMatchObject({
      subtaskId: 'a',
      estimateMinutes: 2,
      elapsed: 65,
      running: true
    })
    expect(listener).not.toHaveBeenCalled()
    expect(nextReader).toHaveBeenCalled()
    expect(timer.getSnapshot()).toBe(timer.getSnapshot())
  })

  it('resets and pauses on identity changes, including an empty queue', () => {
    timer.setStep('a')
    timer.play()
    vi.advanceTimersByTime(4000)
    timer.setStep('b', 10)
    expect(timer.getSnapshot()).toEqual({
      subtaskId: 'b',
      estimateMinutes: 10,
      elapsed: 0,
      running: false
    })
    vi.advanceTimersByTime(4000)
    expect(timer.getSnapshot().elapsed).toBe(0)
    timer.setStep(null)
    timer.play()
    expect(timer.getSnapshot().running).toBe(false)
  })

  it('uses a safe estimate for missing or invalid estimates', () => {
    for (const estimate of [0, -1, NaN, Infinity, undefined]) {
      timer.setStep('a', estimate)
      expect(timer.getSnapshot().estimateMinutes).toBe(15)
    }
  })
})
