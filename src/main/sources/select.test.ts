import { describe, expect, it } from 'vitest'
import { DEFAULT_PACK_BUDGET } from '../../common/readers'
import { allocateBudget, classifyFile, rankCandidates, type Candidate } from './select'

const NOW = new Date('2026-11-11T12:00:00').getTime()
const DAY = 86_400_000

function cand(key: string, over: Partial<Candidate> = {}): Candidate {
  const ext = key.slice(key.lastIndexOf('.')).toLowerCase()
  return {
    key,
    kind: 'doc',
    tier: 5,
    size: 1000,
    mtimeMs: NOW - DAY,
    depth: 1,
    changed: false,
    ext,
    ...over
  }
}

describe('classifyFile', () => {
  it('CONTEXT.md at a source root is tier 0', () => {
    expect(classifyFile('CONTEXT.md', { inVault: false, depth: 0 })).toEqual({
      kind: 'context',
      tier: 0
    })
    expect(classifyFile('sub/CONTEXT.md', { inVault: false, depth: 1 })).toEqual({
      kind: 'doc',
      tier: 5
    })
  })

  it('agent files at depth<=2 are tier 2; deep README drops to tier 5', () => {
    for (const n of [
      'CLAUDE.md',
      'AGENTS.md',
      'handoff-2026.md',
      'HANDOFF.md',
      'todo.md',
      'plan_v2.md',
      'PROJECT_SUMMARY.md',
      'status.md'
    ]) {
      expect(classifyFile(n, { inVault: false, depth: 0 })).toEqual({ kind: 'agent', tier: 2 })
    }
    expect(classifyFile('a/b/todo.md', { inVault: false, depth: 2 })).toEqual({
      kind: 'agent',
      tier: 2
    })
    expect(classifyFile('a/b/c/todo.md', { inVault: false, depth: 3 })).toEqual({
      kind: 'doc',
      tier: 5
    })
    expect(classifyFile('README.md', { inVault: false, depth: 0 })).toEqual({
      kind: 'agent',
      tier: 2
    })
    expect(classifyFile('a/b/README.md', { inVault: false, depth: 2 })).toEqual({
      kind: 'doc',
      tier: 5
    })
  })

  it('briefs need the name pattern; other PDFs are index-only', () => {
    expect(classifyFile('ass1/spec.pdf', { inVault: false, depth: 1 })).toEqual({
      kind: 'brief',
      tier: 4
    })
    expect(classifyFile('Marking Rubric.pdf', { inVault: false, depth: 0 })).toEqual({
      kind: 'brief',
      tier: 4
    })
    expect(classifyFile('a/b/c/d/spec.pdf', { inVault: false, depth: 4 })).toBeNull()
    expect(classifyFile('lecture3.pdf', { inVault: false, depth: 0 })).toBeNull()
    expect(classifyFile('draft.docx', { inVault: false, depth: 0 })).toEqual({
      kind: 'docx',
      tier: 5
    })
    expect(classifyFile('brief.docx', { inVault: false, depth: 0 })).toEqual({
      kind: 'brief',
      tier: 4
    })
    expect(classifyFile('ass1.ipynb', { inVault: false, depth: 0 })).toEqual({
      kind: 'notebook',
      tier: 5
    })
    expect(classifyFile('main.py', { inVault: false, depth: 0 })).toBeNull()
    expect(classifyFile('Thesis.md', { inVault: true, depth: 0 })).toEqual({
      kind: 'vault',
      tier: 1
    })
  })
})

describe('rank and allocate', () => {
  it('ranking puts changed then newest first', () => {
    const ranked = rankCandidates(
      [
        cand('old.md', { mtimeMs: NOW - 40 * DAY }),
        cand('new.md', { mtimeMs: NOW - 2 * DAY }),
        cand('changed.md', { mtimeMs: NOW - 60 * DAY, changed: true }),
        cand('CONTEXT.md', { tier: 0, kind: 'context', mtimeMs: NOW - 90 * DAY }),
        cand('mid.md', { mtimeMs: NOW - 20 * DAY })
      ],
      NOW
    )
    expect(ranked.map((c) => c.key)).toEqual([
      'CONTEXT.md',
      'changed.md',
      'new.md',
      'mid.md',
      'old.md'
    ])
  })

  it('allocateBudget respects 120K, 30K per file and 80 files', () => {
    const many = Array.from({ length: 100 }, (_, i) => cand(`f${i}.md`, { size: 50_000 }))
    const { take, skip } = allocateBudget(many, DEFAULT_PACK_BUDGET, 0)
    expect(take.every((t) => t.chars <= 30_000)).toBe(true)
    expect(take.reduce((s, t) => s + t.chars, 0)).toBeLessThanOrEqual(120_000)
    expect(take.length + skip.length).toBe(100)
    const small = Array.from({ length: 100 }, (_, i) => cand(`s${i}.md`, { size: 100 }))
    expect(allocateBudget(small, DEFAULT_PACK_BUDGET, 0).take).toHaveLength(80)
  })

  it('reserved slices for vault, git and briefs; unused reserve flows down', () => {
    const list = rankCandidates(
      [
        cand('v1.md', { tier: 1, kind: 'vault', size: 40_000 }),
        cand('v2.md', { tier: 1, kind: 'vault', size: 40_000 }),
        cand('v3.md', { tier: 1, kind: 'vault', size: 40_000 }),
        cand('spec.pdf', { tier: 4, kind: 'brief', size: 15_000 }),
        ...Array.from({ length: 10 }, (_, i) => cand(`d${i}.md`, { size: 30_000 }))
      ],
      NOW
    )
    const { take } = allocateBudget(list, DEFAULT_PACK_BUDGET, 12_000)
    const by = Object.fromEntries(take.map((t) => [t.key, t.chars]))
    expect(by['v1.md']).toBe(15_000)
    expect(by['v2.md']).toBe(15_000)
    expect(by['v3.md']).toBeUndefined() // vault slice (30K) used up
    expect(by['spec.pdf']).toBe(15_000)
    const docs = take.filter((t) => t.key.startsWith('d')).reduce((s, t) => s + t.chars, 0)
    // 120K - 12K git - 30K vault - 15K brief (only 15K of the 30K brief slice was needed)
    expect(docs).toBe(63_000)
    // Without git or vault the docs get the space.
    const { take: t2 } = allocateBudget(
      rankCandidates(
        list.filter((c) => c.tier === 5),
        NOW
      ),
      DEFAULT_PACK_BUDGET,
      0
    )
    expect(t2.reduce((s, t) => s + t.chars, 0)).toBe(120_000)
  })

  it('docx capped at 3 newest and PDFs at 6', () => {
    const docx = Array.from({ length: 5 }, (_, i) =>
      cand(`draft${i}.docx`, { kind: 'docx', size: 15_000, mtimeMs: NOW - i * DAY })
    )
    const { take } = allocateBudget(rankCandidates(docx, NOW), DEFAULT_PACK_BUDGET, 0)
    expect(take.map((t) => t.key)).toEqual(['draft0.docx', 'draft1.docx', 'draft2.docx'])
    const pdfs = Array.from({ length: 8 }, (_, i) =>
      cand(`spec${i}.pdf`, { tier: 4, kind: 'brief', size: 2_000 })
    )
    expect(allocateBudget(pdfs, DEFAULT_PACK_BUDGET, 0).take).toHaveLength(6)
  })
})
