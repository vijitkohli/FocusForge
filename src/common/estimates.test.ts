import { describe, expect, it } from 'vitest'
import { estimateAccuracy, paceAdjustedMinutes, type EstimateSample } from './estimates'

const sample = (minutes: number, estimate: number, day: number): EstimateSample => ({
  focusSeconds: minutes * 60,
  timeEstimate: estimate,
  completedAt: `2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z`
})

describe('estimateAccuracy', () => {
  it('needs six usable samples', () => {
    expect(estimateAccuracy([1, 2, 3, 4, 5].map((d) => sample(15, 10, d)))).toBeNull()
    expect(estimateAccuracy([1, 2, 3, 4, 5, 6].map((d) => sample(15, 10, d)))).toEqual({
      ratio: 1.5,
      samples: 6
    })
  })

  it('ignores misclick sessions and steps without an estimate', () => {
    const noise = [{ ...sample(0, 10, 7), focusSeconds: 10 }, { ...sample(10, 0, 8) }]
    expect(
      estimateAccuracy([...[1, 2, 3, 4, 5].map((d) => sample(10, 10, d)), ...noise])
    ).toBeNull()
  })

  it('uses the median, so one forgotten timer does not skew it', () => {
    const steady = [1, 2, 3, 4, 5, 6].map((d) => sample(12, 10, d))
    expect(estimateAccuracy([...steady, sample(600, 10, 7)])?.ratio).toBe(1.2)
  })

  it('clamps to 0.5–3 and keeps only the latest 40 samples', () => {
    expect(estimateAccuracy([1, 2, 3, 4, 5, 6].map((d) => sample(100, 10, d)))?.ratio).toBe(3)
    expect(estimateAccuracy([1, 2, 3, 4, 5, 6].map((d) => sample(1, 10, d)))?.ratio).toBe(0.5)
    const old = Array.from({ length: 40 }, (_, i) => ({
      ...sample(30, 10, 1),
      completedAt: `2026-09-01T00:00:${String(i).padStart(2, '0')}Z`
    }))
    const recent = Array.from({ length: 40 }, () => sample(10, 10, 20))
    expect(estimateAccuracy([...old, ...recent])).toEqual({ ratio: 1, samples: 40 })
  })
})

describe('paceAdjustedMinutes', () => {
  it('scales by the ratio and defaults a missing estimate to 15', () => {
    expect(paceAdjustedMinutes(10, 1.4)).toBe(14)
    expect(paceAdjustedMinutes(undefined, null)).toBe(15)
  })
})
