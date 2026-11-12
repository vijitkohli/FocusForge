import { describe, expect, it } from 'vitest'
import type { VaultSyncStatus } from 'src/common/vault'
import { itemNoteProblem, vaultProblems, vaultSummary } from './vaultStatus'

const base: VaultSyncStatus = {
  enabled: true,
  writable: true,
  lastSyncAt: '2026-11-12T01:00:00.000Z',
  pending: 0,
  notes: [
    { itemId: 'thesis', title: 'Thesis', state: 'ok' },
    { itemId: 'thesis', taskId: 't1', title: 'Proposal', state: 'deleted', message: 'x' },
    { itemId: 'site', title: 'Site', state: 'conflict', conflicts: 1 }
  ]
}
const now = Date.parse('2026-11-12T01:02:00.000Z')

describe('vault status copy', () => {
  it('summarises sync time and problems warmly', () => {
    expect(vaultSummary(base, now)).toBe('Synced 2 min ago · 2 notes need a look')
    expect(vaultSummary({ ...base, notes: [] }, now)).toBe('Synced 2 min ago')
    expect(vaultSummary({ ...base, lastSyncAt: null, notes: [] }, now)).toBe(
      'Getting your notes ready'
    )
  })

  it('explains why nothing is written', () => {
    expect(vaultSummary({ ...base, enabled: false, writable: false, reason: 'off' }, now)).toBe(
      'Off. Your vault is left alone.'
    )
    expect(vaultSummary({ ...base, writable: false, reason: 'no-vault' }, now)).toMatch(/Choose it/)
    expect(vaultSummary({ ...base, writable: false, reason: 'folder-removed' }, now)).toMatch(
      /paused/
    )
    expect(vaultSummary(null, now)).toBe('')
  })

  it('finds an item or task note problem', () => {
    expect(vaultProblems(base)).toHaveLength(2)
    expect(itemNoteProblem(base, 'thesis')).toBeNull()
    expect(itemNoteProblem(base, 'thesis', 't1')?.state).toBe('deleted')
    expect(itemNoteProblem(base, 'site')?.state).toBe('conflict')
  })
})
