import { describe, expect, it } from 'vitest'
import type { DiscoveryCandidate, DiscoveryResult } from '../../../common/discovery'
import type { Workstream } from '../../../common/types'
import {
  approvalReducer,
  buildApplyRequest,
  footerCounts,
  groupRows,
  initApproval,
  type ApprovalState
} from './itemApproval'

const cand = (over: Partial<DiscoveryCandidate> & { key: string }): DiscoveryCandidate => ({
  name: over.key,
  category: 'Projects',
  kind: 'passion',
  status: 'active',
  included: false,
  inSlice: false,
  recent: true,
  sources: [
    {
      path: `/home/Projects/${over.key}`,
      type: 'folder',
      label: `~/Projects/${over.key}`,
      match: 'primary',
      lastActivityAt: null
    }
  ],
  lastActivityAt: null,
  activitySignal: 'files',
  reasons: [],
  ...over
})

const result = (over: Partial<DiscoveryResult> = {}): DiscoveryResult => ({
  ranAt: '2026-11-11T00:00:00.000Z',
  vault: { path: '/home/Vault', source: 'settings', valid: true, others: [] },
  roots: [],
  candidates: [
    cand({ key: 'thesis', name: 'Thesis', category: 'Learning', included: true, inSlice: true }),
    cand({
      key: 'comp9321',
      name: 'comp9321',
      category: 'Learning',
      included: true,
      inSlice: true,
      adoptsProjectId: 'comp9321',
      suggestedName: 'COMP9321'
    }),
    cand({
      key: 'leetcode',
      name: 'leetcode',
      category: 'Learning',
      included: true,
      status: 'paused',
      adoptsProjectId: 'leetcode'
    }),
    cand({ key: 'headstart', name: 'Headstart Mentoring', recent: true }),
    cand({ key: 'comp2511', name: 'COMP2511', category: 'Learning', recent: false }),
    cand({
      key: 'focusforge',
      name: 'FocusForge',
      included: true,
      inSlice: true,
      sources: [
        {
          path: '/home/Projects/FocusForge',
          type: 'folder',
          label: '~/Projects/FocusForge',
          match: 'primary',
          lastActivityAt: null
        },
        {
          path: '/home/Vault/Projects/PROJECTS TO DO.md#FocusForge',
          type: 'vault-section',
          label: 'PROJECTS TO DO.md › FocusForge',
          match: 'section',
          heading: 'FocusForge',
          lastActivityAt: null
        }
      ]
    })
  ],
  existingUnmatched: [],
  dismissed: [cand({ key: 'old-idea', name: 'Old Idea' })],
  dismissedKeys: ['old-idea'],
  truncated: false,
  warnings: [],
  ...over
})

const init = (r = result()): ApprovalState => initApproval(r, { firstRun: true })

describe('itemApproval', () => {
  it('starts only included suggestions ticked and sorts others into also/quiet', () => {
    const s = init()
    const groups = groupRows(s.rows)
    expect(groups.map((g) => g.category)).toEqual(['Learning', 'Career', 'Projects', 'Life'])
    const learning = groups[0]
    expect(learning.main.map((r) => r.key)).toEqual(['thesis', 'comp9321', 'leetcode'])
    expect(learning.quiet.map((r) => r.key)).toEqual(['comp2511'])
    expect(learning.activeCount).toBe(2)
    const projects = groups[2]
    expect(projects.also.map((r) => r.key)).toEqual(['headstart'])
    expect(projects.also[0].included).toBe(false)
    expect(s.hidden.map((r) => r.key)).toEqual(['old-idea'])
  })

  it('active count in the footer', () => {
    const s = init()
    expect(footerCounts(s)).toEqual({ total: 4, active: 3 })
    const ticked = approvalReducer(s, { type: 'toggleInclude', key: 'headstart' })
    expect(footerCounts(ticked)).toEqual({ total: 5, active: 4 })
    const paused = approvalReducer(ticked, {
      type: 'setStatus',
      key: 'headstart',
      status: 'paused'
    })
    expect(footerCounts(paused)).toEqual({ total: 5, active: 3 })
  })

  it('ticking a row keeps it in place', () => {
    const s = approvalReducer(init(), { type: 'toggleInclude', key: 'comp2511' })
    expect(groupRows(s.rows)[0].quiet.map((r) => r.key)).toEqual(['comp2511'])
  })

  it('existing entries cannot be unticked or hidden', () => {
    let s = approvalReducer(init(), { type: 'toggleInclude', key: 'leetcode' })
    s = approvalReducer(s, { type: 'hide', key: 'leetcode' })
    expect(s.rows.find((r) => r.key === 'leetcode')?.included).toBe(true)
  })

  it('buildApplyRequest maps adopted to updates, skips unticked and keeps section refs', () => {
    const req = buildApplyRequest(init())
    expect(req.workstreams.map((w) => w.name)).toEqual([
      'Thesis',
      'comp9321',
      'leetcode',
      'FocusForge'
    ])
    expect(req.workstreams.find((w) => w.name === 'comp9321')?.adoptsProjectId).toBe('comp9321')
    expect(req.workstreams.find((w) => w.name === 'leetcode')?.status).toBe('paused')
    expect(req.workstreams.find((w) => w.name === 'FocusForge')?.sources).toContain(
      '/home/Vault/Projects/PROJECTS TO DO.md#FocusForge'
    )
    expect(req.dismissedKeys).toEqual(['old-idea'])
  })

  it('addManual Life item builds a create op with no sources', () => {
    const s = approvalReducer(init(), { type: 'addManual', name: '  Reading ', category: 'Life' })
    const life = groupRows(s.rows)[3]
    expect(life.main.map((r) => r.name)).toEqual(['Reading'])
    expect(life.activeCount).toBe(1)
    const op = buildApplyRequest(s).workstreams.find((w) => w.name === 'Reading')
    expect(op).toEqual({
      name: 'Reading',
      category: 'Life',
      kind: 'passion',
      status: 'active',
      sources: []
    })
    expect(approvalReducer(s, { type: 'addManual', name: '   ', category: 'Life' })).toBe(s)
  })

  it('setCategory moves the row between groups', () => {
    const s = approvalReducer(init(), { type: 'setCategory', key: 'thesis', category: 'Projects' })
    const groups = groupRows(s.rows)
    expect(groups[0].main.some((r) => r.key === 'thesis')).toBe(false)
    expect(groups[2].main.some((r) => r.key === 'thesis')).toBe(true)
    expect(buildApplyRequest(s).workstreams.find((w) => w.name === 'Thesis')?.category).toBe(
      'Projects'
    )
  })

  it('detachSource works on section refs; attachSource refuses duplicates', () => {
    const ref = '/home/Vault/Projects/PROJECTS TO DO.md#FocusForge'
    let s = approvalReducer(init(), { type: 'detachSource', key: 'focusforge', path: ref })
    expect(s.rows.find((r) => r.key === 'focusforge')?.sources.map((x) => x.path)).toEqual([
      '/home/Projects/FocusForge'
    ])
    s = approvalReducer(s, { type: 'addManual', name: 'Reading', category: 'Life' })
    const source = {
      path: '/home/Projects/thesis',
      type: 'folder' as const,
      label: '~/Projects/thesis',
      match: 'user' as const,
      lastActivityAt: null
    }
    const dup = approvalReducer(s, { type: 'attachSource', key: 'manual:1', source })
    expect(dup.notice?.message).toBe("That's already part of Thesis.")
    const fresh = { ...source, path: '/home/Projects/garden' }
    const ok = approvalReducer(s, { type: 'attachSource', key: 'manual:1', source: fresh })
    expect(ok.rows.find((r) => r.key === 'manual:1')?.sources).toHaveLength(1)
    // A source of an unticked suggestion can still be attached.
    const unticked = { ...source, path: '/home/Projects/headstart' }
    const ok2 = approvalReducer(s, { type: 'attachSource', key: 'manual:1', source: unticked })
    expect(ok2.notice).toBeNull()
    expect(ok2.rows.find((r) => r.key === 'manual:1')?.sources).toHaveLength(1)
  })

  it('hide and restore round-trip with dismissed keys', () => {
    let s = approvalReducer(init(), { type: 'hide', key: 'headstart' })
    expect(s.rows.some((r) => r.key === 'headstart')).toBe(false)
    expect(buildApplyRequest(s).dismissedKeys).toEqual(['old-idea', 'headstart'])
    s = approvalReducer(s, { type: 'restore', key: 'old-idea' })
    expect(s.rows.find((r) => r.key === 'old-idea')?.section).toBe('also')
    expect(buildApplyRequest(s).dismissedKeys).toEqual(['headstart'])
  })

  it('add de-dupes by key or path and ticks the existing row', () => {
    const s = approvalReducer(init(), {
      type: 'add',
      candidate: cand({ key: 'other-key', sources: init().rows[3].sources })
    })
    expect(s.rows).toHaveLength(init().rows.length)
    expect(s.rows.find((r) => r.key === 'headstart')?.included).toBe(true)
    const added = approvalReducer(init(), {
      type: 'add',
      candidate: cand({ key: 'garden', included: false, recent: false })
    })
    const row = added.rows.find((r) => r.key === 'garden')
    expect(row?.included).toBe(true)
    expect(row?.section).toBe('main')
  })

  it('existing unmatched entries are kept and paused on the first run', () => {
    const w: Workstream = {
      id: 'old_notes',
      name: 'Old notes',
      path: '/data/old_notes',
      progress: 0,
      lastActive: '',
      category: 'Projects',
      kind: 'ongoing',
      status: 'active',
      sources: []
    }
    const first = initApproval(result({ existingUnmatched: [w] }), { firstRun: true })
    const row = first.rows.find((r) => r.adoptsProjectId === 'old_notes')
    expect(row?.status).toBe('paused')
    expect(row?.existing).toBe(true)
    const later = initApproval(result({ existingUnmatched: [w] }), { firstRun: false })
    expect(later.rows.find((r) => r.adoptsProjectId === 'old_notes')?.status).toBe('active')
  })
})
