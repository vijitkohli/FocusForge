import { describe, expect, it } from 'vitest'
import type { ReaderStatus } from 'src/common/readers'
import { syncLabel } from './readerStatus'

const base: ReaderStatus = {
  itemId: 'thesis',
  state: 'idle',
  watching: true,
  lastPackAt: '2026-11-11T09:00:00.000Z',
  lastDigestAt: '2026-11-11T09:00:00.000Z',
  pendingSince: null,
  files: 3,
  chars: 100,
  notDownloaded: 0,
  conflicts: 0,
  skippedSources: 0
}
const NOW = Date.parse('2026-11-11T09:03:00.000Z')

describe('syncLabel', () => {
  it('maps each state to friendly copy', () => {
    expect(syncLabel(base, NOW)).toEqual({ text: 'Synced 3 min ago', tone: 'quiet' })
    expect(syncLabel({ ...base, state: 'pending' }, NOW).text).toBe('Checking for changes…')
    expect(syncLabel({ ...base, state: 'digesting' }, NOW)).toEqual({
      text: 'Summarising…',
      tone: 'busy'
    })
    expect(syncLabel({ ...base, state: 'waiting-ai' }, NOW).text).toBe(
      "Waiting for AI (it'll resume on its own)"
    )
    expect(
      syncLabel(
        {
          ...base,
          state: 'error',
          error: { code: 'auth', message: 'AI login problem in CLIProxyAPI.' }
        },
        NOW
      )
    ).toEqual({ text: 'AI login problem in CLIProxyAPI.', tone: 'warn' })
    expect(syncLabel({ ...base, lastDigestAt: null }, NOW).text).toBe('Read, not summarised yet')
    expect(syncLabel(undefined, NOW).text).toBe('')
  })
})
