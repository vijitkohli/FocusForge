import { useEffect, useState } from 'react'

export const SLOW_AFTER_MS = 15_000

/**
 * True once `active` has been on for `delayMs` without `progress` changing
 * (e.g. no new streamed token). Resets whenever progress moves or work stops.
 */
export function useSlowSignal(
  active: boolean,
  progress: unknown,
  delayMs = SLOW_AFTER_MS
): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!active) return
    const timer = setTimeout(() => setSlow(true), delayMs)
    return () => {
      clearTimeout(timer)
      setSlow(false)
    }
  }, [active, progress, delayMs])
  return active && slow
}
