import type { EstimateAccuracy } from '../../../common/estimates'

/** Friendly sentence for an estimate ratio, or null when there isn't enough data. */
export function paceSentence(accuracy: EstimateAccuracy | null): string | null {
  if (!accuracy) return null
  const ratio = accuracy.ratio.toFixed(1)
  if (accuracy.ratio >= 1.15)
    return `Steps usually take you about ${ratio}× the estimate. New plans allow for that.`
  if (accuracy.ratio <= 0.85)
    return `You usually finish steps faster than estimated (about ${ratio}×). New plans allow for that.`
  return 'Your step estimates are about right.'
}
