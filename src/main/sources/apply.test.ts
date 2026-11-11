import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PathGuard } from './guard'
import { filterSources, guardPatch, planApply, refusedLabel } from './apply'
import type { ProjectSummary } from '../../common/types'

let tmp: string
let vault: string
let uni: string
let g: PathGuard

const entry = (id: string, extra: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id,
  name: id,
  path: `/flow/${id}`,
  progress: 0,
  lastActive: '',
  ...extra
})

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-apply-')))
  vault = path.join(tmp, 'vault')
  uni = path.join(tmp, 'uni')
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true })
  fs.mkdirSync(path.join(uni, 'thesis'), { recursive: true })
  g = new PathGuard({
    sourceRoots: [uni],
    vaultRoots: [vault],
    readableVault: vault,
    caseInsensitive: true
  })
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('apply-discovery planning', () => {
  it('re-checks every source and never names Life', () => {
    const { sources, skipped } = filterSources(g, [
      path.join(uni, 'thesis'),
      path.join(uni, 'thesis'),
      `${vault}/Projects/IDEAS TO DO.md#FocusForge`,
      `${vault}/Life/Journal/day.md`,
      `${vault}/Life/Allowed.md#Goals`,
      `${uni}/SERVICE PAT.rtf`,
      '/etc/hosts',
      'relative',
      3
    ])
    expect(sources).toEqual([
      path.join(uni, 'thesis'),
      `${vault}/Projects/IDEAS TO DO.md#FocusForge`
    ])
    expect(skipped).toEqual(['a folder that stays closed', 'SERVICE PAT.rtf', 'hosts', 'relative'])
    expect(skipped.join(' ')).not.toMatch(/Journal|Allowed|Goals/)
    expect(refusedLabel('/x/notes.md#Week 1', 'outside-roots')).toBe('notes.md › Week 1')
  })

  it('maps adopted rows to updates and new rows to creates; first run pauses the rest', () => {
    const plan = planApply(
      {
        workstreams: [
          {
            adoptsProjectId: 'comp9321',
            name: 'COMP9321',
            category: 'Learning',
            kind: 'deadline',
            status: 'active',
            sources: [path.join(uni, 'thesis'), `${vault}/Life/x.md`]
          },
          {
            adoptsProjectId: 'comp9321',
            name: 'dup',
            category: 'Learning',
            kind: 'deadline',
            status: 'active',
            sources: []
          },
          { name: 'Reading', category: 'Life', kind: 'passion', status: 'active', sources: [] },
          {
            adoptsProjectId: 'deleted',
            name: 'Ghost',
            category: 'Nope',
            kind: 'x',
            status: 'y',
            sources: []
          },
          { name: '   ', category: 'Learning', kind: 'deadline', status: 'active', sources: [] }
        ],
        dismissedKeys: ['k', 'k', 4]
      },
      {
        guard: g,
        registry: [entry('comp9321'), entry('practice'), entry('old', { status: 'archived' })],
        firstRun: true
      }
    )
    expect(plan.ops).toEqual([
      {
        op: 'update',
        id: 'comp9321',
        patch: {
          name: 'COMP9321',
          category: 'Learning',
          kind: 'deadline',
          status: 'active',
          sources: [path.join(uni, 'thesis')]
        }
      },
      {
        op: 'create',
        fields: {
          name: 'Reading',
          category: 'Life',
          kind: 'passion',
          status: 'active',
          sources: []
        }
      },
      {
        op: 'create',
        fields: {
          name: 'Ghost',
          category: 'Projects',
          kind: 'ongoing',
          status: 'active',
          sources: []
        }
      },
      { op: 'update', id: 'practice', patch: { status: 'paused' } }
    ])
    expect(plan.skippedSources).toEqual(['a folder that stays closed'])
    expect(plan.dismissedKeys).toEqual(['k'])
  })

  it('later runs leave unmentioned entries alone', () => {
    const plan = planApply(
      { workstreams: [], dismissedKeys: [] },
      {
        guard: g,
        registry: [entry('practice')],
        firstRun: false
      }
    )
    expect(plan.ops).toEqual([])
    expect(planApply(null, { guard: g, registry: [], firstRun: false }).ops).toEqual([])
  })

  it('guardPatch filters only sources', () => {
    expect(guardPatch(g, { status: 'paused' })).toEqual({
      patch: { status: 'paused' },
      skipped: []
    })
    expect(
      guardPatch(g, { name: 'x', sources: [path.join(uni, 'thesis'), `${vault}/Life`] })
    ).toEqual({
      patch: { name: 'x', sources: [path.join(uni, 'thesis')] },
      skipped: ['a folder that stays closed']
    })
  })
})
