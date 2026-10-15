// How long steps really take versus their estimates, from Focus-session time.

/** Fewer samples than this and the ratio is too noisy to show or use. */
export const MIN_ESTIMATE_SAMPLES = 6
/** Only the most recent completed steps count, so the ratio tracks current habits. */
export const MAX_ESTIMATE_SAMPLES = 40
/** Focus time below this on a step is treated as a misclick, not a session. */
export const MIN_FOCUS_SECONDS = 30

export interface EstimateSample {
  focusSeconds: number
  timeEstimate: number
  completedAt: string
}

export interface EstimateAccuracy {
  /** Median actual/estimate, clamped to 0.5–3 and rounded to 0.1. */
  ratio: number
  samples: number
}

/**
 * Median of actual/estimate over the most recent samples. Returns null until
 * there are MIN_ESTIMATE_SAMPLES usable ones. The median (not the mean) keeps
 * one forgotten-timer session from skewing every future plan.
 */
export function estimateAccuracy(samples: readonly EstimateSample[]): EstimateAccuracy | null {
  const usable = samples
    .filter((s) => s.focusSeconds >= MIN_FOCUS_SECONDS && s.timeEstimate > 0)
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
    .slice(0, MAX_ESTIMATE_SAMPLES)
  if (usable.length < MIN_ESTIMATE_SAMPLES) return null
  const ratios = usable.map((s) => s.focusSeconds / 60 / s.timeEstimate).sort((a, b) => a - b)
  const mid = Math.floor(ratios.length / 2)
  const median = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2
  const clamped = Math.min(3, Math.max(0.5, median))
  return { ratio: Math.round(clamped * 10) / 10, samples: usable.length }
}

/** Minutes a step will likely take for this student (used to fill a day's time budget). */
export function paceAdjustedMinutes(estimate: number | undefined, ratio: number | null): number {
  const base = estimate && estimate > 0 ? estimate : 15
  return Math.round(base * (ratio ?? 1))
}
