import { describe, expect, it } from 'vitest'
import { paceSentence } from './pace'

describe('paceSentence', () => {
  it('describes slow, fast and accurate estimates kindly', () => {
    expect(paceSentence(null)).toBeNull()
    expect(paceSentence({ ratio: 1.4, samples: 8 })).toBe(
      'Steps usually take you about 1.4× the estimate. New plans allow for that.'
    )
    expect(paceSentence({ ratio: 0.7, samples: 8 })).toContain('faster than estimated (about 0.7×)')
    expect(paceSentence({ ratio: 1, samples: 8 })).toBe('Your step estimates are about right.')
  })
})
