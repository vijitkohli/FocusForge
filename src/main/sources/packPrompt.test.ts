import { describe, expect, it } from 'vitest'
import { DEFAULT_PACK_BUDGET, type ContextPack, type PackFile } from '../../common/readers'
import {
  fileHeader,
  packBasis,
  packFingerprint,
  packToDigestInput,
  packToPromptText,
  renderGitText,
  resolveCitation
} from './packPrompt'

const day = (iso: string): number => new Date(`${iso}T12:00:00`).getTime()

function file(id: string, label: string, text: string, over: Partial<PackFile> = {}): PackFile {
  return {
    id,
    label,
    ref: `/abs/secret/${label}`,
    kind: 'doc',
    mtimeMs: day('2026-11-10'),
    size: text.length,
    hash: `h-${id}-${text.length}`,
    chars: text.length,
    truncated: false,
    redactions: 0,
    changed: false,
    text,
    ...over
  }
}

const commits = [
  { hash: 'ccc3333', date: '2026-11-10T09:00:00+11:00', subject: 'third', files: ['a.md'] },
  { hash: 'bbb2222', date: '2026-11-09T09:00:00+11:00', subject: 'second', files: [] },
  { hash: 'aaa1111', date: '2026-11-01T09:00:00+11:00', subject: 'first', files: [] }
]

function makePack(files: PackFile[]): ContextPack {
  return {
    version: 1,
    itemId: 'thesis',
    builtAt: '2026-11-11T00:00:00.000Z',
    budget: DEFAULT_PACK_BUDGET,
    totalChars: 0,
    truncated: false,
    sources: [],
    files,
    git: [
      { id: 'G1', label: 'git:thesis', head: 'ccc3333', commits, text: renderGitText(commits) }
    ],
    index: [
      { label: 'thesis/old.md', date: '2026-01-01' },
      { label: 'thesis/x.md', date: '2026-01-02', note: 'not-downloaded' }
    ],
    seen: {},
    activityAt: null,
    notDownloaded: 1,
    conflicts: 0,
    fingerprint: ''
  }
}

const pack = makePack([
  file('F1', 'thesis/CONTEXT.md', 'context body', { kind: 'context' }),
  file('F2', 'thesis/notes.md', 'notes body', { truncated: true }),
  file('F3', 'vault:Learning/Thesis Hub/Thesis.md', 'vault body', {
    kind: 'vault',
    mtimeMs: day('2026-11-03')
  })
])

describe('packPrompt', () => {
  it('file blocks carry id, label, kind and date', () => {
    const text = packToPromptText(pack)
    expect(text).toContain(
      '=== FILE F1: thesis/CONTEXT.md (context, modified 2026-11-10) ===\ncontext body\n=== END F1 ==='
    )
    expect(text).toContain(
      '=== FILE F3: vault:Learning/Thesis Hub/Thesis.md (vault, modified 2026-11-03) ==='
    )
    expect(text).toContain('=== GIT G1: git:thesis ===\n2026-11-10 ccc3333 third\n    a.md')
    expect(text).toContain(
      '=== INDEX (files not shown) ===\nthesis/old.md · 2026-01-01\nthesis/x.md · 2026-01-02 · not downloaded'
    )
    expect(text).not.toContain('/abs/secret')
    expect(fileHeader(pack.files[1])).toBe(
      '=== FILE F2: thesis/notes.md (doc, modified 2026-11-10) ==='
    )
  })

  it('incremental input includes CONTEXT, changed files and new commits only', () => {
    const basis = packBasis(pack)
    basis.files['thesis/notes.md'] = 'old-hash'
    basis.git['git:thesis'] = 'bbb2222'
    const input = packToDigestInput(pack, { mode: 'incremental', basis })
    expect(input.files.map((f) => [f.id, f.changed])).toEqual([
      ['F1', false],
      ['F2', true]
    ])
    expect(input.git).toEqual([
      { id: 'G1', label: 'git:thesis', text: '2026-11-10 ccc3333 third\n    a.md' }
    ])
    expect(input.changedIds).toEqual(['F2', 'G1'])
    expect(input.sentIds).toEqual(['F1', 'F2', 'G1'])
    const full = packToDigestInput(pack, { mode: 'full', basis })
    expect(full.files).toHaveLength(3)
    expect(full.git[0].text).toContain('first')
    // nothing new in git -> no git block
    basis.git['git:thesis'] = 'ccc3333'
    expect(packToDigestInput(pack, { mode: 'incremental', basis }).git).toEqual([])
  })

  it('respects maxChars', () => {
    const big = makePack(
      Array.from({ length: 10 }, (_, i) =>
        file(`F${i + 1}`, `thesis/f${i}.md`, `${i}`.repeat(20_000))
      )
    )
    const text = packToPromptText(big, { maxChars: 50_000 })
    expect(text.length).toBeLessThanOrEqual(50_000)
    expect(text).toContain('=== FILE F1:')
    expect(text).toContain('=== INDEX (files not shown) ===')
    expect(text).toContain('thesis/f9.md · 2026-11-10')
    expect(packToDigestInput(big, { mode: 'full', maxChars: 50_000 }).files).toHaveLength(2)
  })

  it('resolveCitation maps ids to label and local date', () => {
    expect(resolveCitation(pack, 'F3')).toEqual({
      label: 'vault:Learning/Thesis Hub/Thesis.md',
      date: '2026-11-03'
    })
    expect(resolveCitation(pack, 'G1')).toEqual({ label: 'git:thesis', date: '2026-11-10' })
    expect(resolveCitation(pack, 'F9')).toBeNull()
  })

  it('fingerprint changes only when content or git head changes', () => {
    const a = packFingerprint(pack)
    const reordered = makePack([...pack.files].reverse())
    expect(packFingerprint(reordered)).toBe(a)
    const touched = makePack(
      pack.files.map((f) => ({ ...f, mtimeMs: f.mtimeMs + 1000, changed: true }))
    )
    expect(packFingerprint(touched)).toBe(a)
    const edited = makePack(pack.files.map((f, i) => (i === 0 ? { ...f, hash: 'new' } : f)))
    expect(packFingerprint(edited)).not.toBe(a)
    const moved = { ...pack, git: [{ ...pack.git[0], head: 'ddd4444' }] }
    expect(packFingerprint(moved)).not.toBe(a)
  })
})
