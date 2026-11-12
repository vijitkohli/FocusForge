import { describe, expect, it } from 'vitest'
import {
  candidateId,
  digestCore,
  isIsoDate,
  normalizeDigest,
  renderCitation,
  type ItemDigest,
  type NormalizeMeta
} from './digest'
import { DEFAULT_PACK_BUDGET, type ContextPack, type PackFile } from './readers'

const day = (iso: string): number => new Date(`${iso}T12:00:00`).getTime()

function file(id: string, label: string, text: string, date = '2026-11-10'): PackFile {
  return {
    id,
    label,
    ref: `/abs/${label}`,
    kind: 'context',
    mtimeMs: day(date),
    size: text.length,
    hash: id,
    chars: text.length,
    truncated: false,
    redactions: 0,
    changed: true,
    text
  }
}

const pack: ContextPack = {
  version: 1,
  itemId: 'thesis',
  builtAt: '2026-11-11T00:00:00.000Z',
  budget: DEFAULT_PACK_BUDGET,
  totalChars: 0,
  truncated: false,
  sources: [],
  files: [
    file('F1', 'thesis/CONTEXT.md', 'Week 11 presentation date TBC.\nProposal v5 is out of date.'),
    file('F2', 'thesis/research/status.md', 'Pilot run done.', '2026-11-03')
  ],
  git: [
    {
      id: 'G1',
      label: 'git:thesis',
      head: 'abc1234',
      commits: [
        { hash: 'abc1234', date: '2026-11-09T10:00:00+11:00', subject: 'add study', files: [] }
      ],
      text: '2026-11-09 abc1234 add study'
    }
  ],
  index: [],
  seen: {},
  activityAt: null,
  notDownloaded: 0,
  conflicts: 0,
  fingerprint: 'fp1'
}

const meta = (previous: ItemDigest | null = null): NormalizeMeta => ({
  itemId: 'thesis',
  model: 'cliproxy/gemini-3-flash',
  generatedAt: '2026-11-11T00:00:00.000Z',
  mode: 'full',
  incrementalSinceFull: 0,
  previous
})

const base = {
  goal: 'Finish the thesis',
  currentState: '### Overview\nPilot done [F2]. Presentation pending [F1, G1]. Ghost [F9].'
}

describe('normalizeDigest', () => {
  it('drops entries with unknown citations', () => {
    const { digest, warnings } = normalizeDigest(
      {
        ...base,
        openItems: [
          { text: 'Good', status: 'todo', sources: ['F1'] },
          { text: 'Bad', status: 'todo', sources: ['F9'] },
          { text: 'None', status: 'todo', sources: [] }
        ]
      },
      pack,
      meta()
    )
    expect(digest?.openItems.map((o) => o.text)).toEqual(['Good'])
    expect(digest?.openItems[0].sources).toEqual([
      { label: 'thesis/CONTEXT.md', date: '2026-11-10' }
    ])
    expect(warnings.some((w) => w.includes('2 entries'))).toBe(true)
  })

  it('accepts labels as citations (carried over from previous)', () => {
    const { digest } = normalizeDigest(
      { ...base, openItems: [{ text: 'x', sources: ['thesis/research/status.md'] }] },
      pack,
      meta()
    )
    expect(digest?.openItems[0].sources[0].label).toBe('thesis/research/status.md')
  })

  it('invalid dates dropped or tentative; null dates survive with when', () => {
    const { digest } = normalizeDigest(
      {
        ...base,
        dueDates: [
          {
            what: 'Proposal',
            date: '2026-11-20',
            confidence: 'confirmed',
            kind: 'report',
            weight: '20%',
            sources: ['F1']
          },
          {
            what: 'Presentation',
            date: null,
            when: 'Week 11 (TBC)',
            confidence: 'confirmed',
            sources: ['F1']
          },
          { what: 'Bad date', date: '2026-02-30', confidence: 'confirmed', sources: ['F1'] }
        ],
        recentProgress: [
          { date: '2026-11-09', text: 'Commit', sources: ['G1'] },
          { date: 'yesterday', text: 'No date', sources: ['G1'] }
        ]
      },
      pack,
      meta()
    )
    expect(digest?.dueDates).toEqual([
      {
        what: 'Proposal',
        date: '2026-11-20',
        confidence: 'confirmed',
        weight: 20,
        kind: 'report',
        sources: [{ label: 'thesis/CONTEXT.md', date: '2026-11-10' }]
      },
      {
        what: 'Presentation',
        date: null,
        when: 'Week 11 (TBC)',
        confidence: 'tentative',
        sources: [{ label: 'thesis/CONTEXT.md', date: '2026-11-10' }]
      },
      {
        what: 'Bad date',
        date: null,
        when: '2026-02-30',
        confidence: 'tentative',
        sources: [{ label: 'thesis/CONTEXT.md', date: '2026-11-10' }]
      }
    ])
    expect(digest?.recentProgress.map((p) => p.text)).toEqual(['Commit'])
    expect(digest?.recentProgress[0].sources[0]).toEqual({
      label: 'git:thesis',
      date: '2026-11-09'
    })
  })

  it('clamps list sizes and lengths', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ text: `item ${i}`, sources: ['F1'] }))
    const { digest } = normalizeDigest(
      {
        goal: 'g'.repeat(500),
        currentState: 's'.repeat(20_000),
        openItems: many,
        candidateTasks: many.map((m, i) => ({
          title: `Check ${i}`,
          minutes: 5,
          sources: m.sources
        }))
      },
      pack,
      meta()
    )
    expect(digest?.goal.length).toBeLessThanOrEqual(200)
    expect(digest?.currentState.length).toBeLessThanOrEqual(14_000)
    expect(digest?.openItems).toHaveLength(30)
    expect(digest?.candidateTasks).toHaveLength(8)
  })

  it('candidate minutes coerced to 2-30', () => {
    const { digest } = normalizeDigest(
      {
        ...base,
        candidateTasks: [
          { title: 'A', minutes: 0, sources: ['F1'] },
          { title: 'B', minutes: 90, sources: ['F1'] },
          { title: 'C', minutes: 'x', sources: ['F1'] }
        ]
      },
      pack,
      meta()
    )
    expect(digest?.candidateTasks.map((t) => t.minutes)).toEqual([2, 30, 10])
  })

  it('quote must appear in the cited excerpt', () => {
    const { digest, warnings } = normalizeDigest(
      {
        ...base,
        candidateTasks: [
          { title: 'Find the slot', quote: 'week 11   presentation date TBC', sources: ['F1'] },
          { title: 'Invented', quote: 'not in the file', sources: ['F1'] }
        ]
      },
      pack,
      meta()
    )
    expect(digest?.candidateTasks[0].quote).toBe('week 11 presentation date TBC')
    expect(digest?.candidateTasks[1].quote).toBeUndefined()
    expect(warnings).toContain('quote not found in cited block')
  })

  it('renders inline [F3] as (label, 10 Nov)', () => {
    const { digest } = normalizeDigest(base, pack, meta())
    expect(digest?.currentState).toBe(
      '### Overview\nPilot done (thesis/research/status.md, 3 Nov). Presentation pending (thesis/CONTEXT.md, 10 Nov) (git:thesis, 9 Nov). Ghost.'
    )
  })

  it('keeps carried-over candidate ids, hashes new ones stably', () => {
    const first = normalizeDigest(
      {
        ...base,
        candidateTasks: [{ id: null, title: 'Find the Week 11 slot (5 min)', sources: ['F1'] }]
      },
      pack,
      meta()
    ).digest!
    const id = first.candidateTasks[0].id
    expect(id).toMatch(/^g[a-z0-9]{10}$/)
    expect(id).toBe(candidateId('Find the week 11 slot', 'thesis/CONTEXT.md'))
    // Reworded but carried over by id.
    const second = normalizeDigest(
      {
        ...base,
        candidateTasks: [{ id, title: 'Find the Week 11 presentation slot', sources: ['F1'] }]
      },
      pack,
      meta(first)
    ).digest!
    expect(second.candidateTasks[0].id).toBe(id)
    // An id that isn't in the previous digest is not trusted.
    const third = normalizeDigest(
      {
        ...base,
        candidateTasks: [{ id: 'evil', title: 'Find the Week 11 slot', sources: ['F1'] }]
      },
      pack,
      meta(first)
    ).digest!
    expect(third.candidateTasks[0].id).toBe(id)
  })

  it('rejects a digest without goal or state', () => {
    expect(normalizeDigest({ goal: '', currentState: 'x' }, pack, meta()).digest).toBeNull()
    expect(normalizeDigest({ goal: 'x' }, pack, meta()).digest).toBeNull()
    expect(normalizeDigest('nope', pack, meta()).digest).toBeNull()
  })

  it('only cites blocks that were sent', () => {
    const { digest } = normalizeDigest(
      {
        ...base,
        openItems: [
          { text: 'x', sources: ['F2'] },
          { text: 'y', sources: ['F1'] }
        ]
      },
      pack,
      { ...meta(), sentIds: ['F1'] }
    )
    expect(digest?.openItems.map((o) => o.text)).toEqual(['y'])
  })

  it('keeps constraints with citations and maps digestCore to labels', () => {
    const { digest } = normalizeDigest(
      {
        ...base,
        constraints: [{ text: 'AI may not write code', sources: ['F1'] }],
        suggestedKind: 'deadline'
      },
      pack,
      meta()
    )
    expect(digest?.constraints).toEqual([
      {
        text: 'AI may not write code',
        sources: [{ label: 'thesis/CONTEXT.md', date: '2026-11-10' }]
      }
    ])
    expect(digest?.suggestedKind).toBe('deadline')
    expect(digestCore(digest!).constraints).toEqual([
      { text: 'AI may not write code', sources: ['thesis/CONTEXT.md'] }
    ])
  })
})

describe('digest helpers', () => {
  it('renderCitation and isIsoDate', () => {
    expect(renderCitation({ label: 'a.md', date: '2026-11-10' })).toBe('(a.md, 10 Nov)')
    expect(renderCitation({ label: 'a.md' })).toBe('(a.md)')
    expect(isIsoDate('2024-02-29')).toBe(true)
    expect(isIsoDate('2026-02-29')).toBe(false)
    expect(isIsoDate('2026-1-01')).toBe(false)
  })
})
