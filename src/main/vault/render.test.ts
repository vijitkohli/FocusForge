import { describe, expect, it } from 'vitest'
import { blockIdFor, gapBlockId } from './format'
import { composeNote, parseNote, parseTicks } from './noteDoc'
import {
  CALLOUT,
  NOT_PLANNED,
  NOT_SUMMARISED,
  dataviewSnippet,
  renderAboutNote,
  renderItemNote,
  renderTaskNote
} from './render'
import { digest, done, item, milestone, step, task } from './testFixtures'
import type { ItemNoteInput, TaskNoteInput, TaskWithPlan } from './types'

const TODAY = '2026-11-11'
const ITEM_REL = 'FocusForge/Learning/Thesis/Thesis.md'

function itemInput(over: Partial<ItemNoteInput> = {}): ItemNoteInput {
  return {
    item: item(),
    tasks: [],
    taskLinks: {},
    digest: null,
    log: [],
    today: TODAY,
    ...over
  }
}

function taskInput(t: TaskWithPlan, over: Partial<TaskNoteInput> = {}): TaskNoteInput {
  return { item: item(), task: t, itemRel: ITEM_REL, log: [], today: TODAY, ...over }
}

/** `## X (auto)` section text (without the heading), or null. */
function sectionOf(body: string, title: string): string | null {
  const lines = body.split('\n')
  const start = lines.indexOf(`## ${title} (auto)`)
  if (start < 0) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => l.startsWith('## '))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
}

const looseEnds = (subtasks: TaskWithPlan['subtasks']): TaskWithPlan =>
  task('le', 'Loose ends', { auto: 'loose-ends', deadlineKind: 'none', subtasks })

describe('renderItemNote', () => {
  it('item note sections in fixed order with callout', () => {
    const r = renderItemNote(
      itemInput({
        tasks: [
          task('t1', 'Proposal', { subtasks: [step('1', 'Write intro')] }),
          looseEnds([step('g1', 'Find the slot', { gapId: 'abc' })])
        ],
        digest: digest()
      })
    )
    const heads = r.body.split('\n').filter((l) => /^#{1,2} /.test(l))
    expect(heads).toEqual([
      '# Thesis',
      '## Next step (auto)',
      '## Loose ends (auto)',
      '## Tasks (auto)',
      '## Deadlines (auto)',
      '## State (auto)',
      '## Log (auto)'
    ])
    expect(r.body).toContain(
      `# Thesis\n${CALLOUT}\n\n> Goal: Submit a defensible thesis by 2026-12-05.`
    )
    expect(r.frontmatter.map(([k]) => k)).toEqual([
      'ff_id',
      'ff_note',
      'category',
      'kind',
      'status',
      'sources',
      'progress',
      'next_due'
    ])
    expect(Object.fromEntries(r.frontmatter)).toMatchObject({
      ff_id: 'thesis',
      ff_note: 'item',
      category: 'Learning',
      status: 'active',
      progress: '0',
      next_due: '2026-11-20'
    })
  })

  it("next step picks earliest-deadline task's current milestone step", () => {
    const later = task('late', 'Later', {
      deadline: '2026-12-01',
      createdAt: '2026-10-01T00:00:00.000Z',
      subtasks: [step('1', 'Later step')]
    })
    const soon = task('soon', 'Soon', {
      deadline: '2026-11-15',
      milestones: [
        milestone('m1', 'Collect', { status: 'done' }),
        milestone('m2', 'Rewrite', { status: 'active' }),
        milestone('m3', 'Send')
      ],
      subtasks: [
        done('a', 'Read feedback', { milestoneId: 'm1' }),
        step('s3', 'Staged for send', { milestoneId: 'm3' }),
        done('b', 'List comments', { milestoneId: 'm2' }),
        step('c', 'Rewrite sampling', { milestoneId: 'm2', timeEstimate: 20 })
      ]
    })
    const r = renderItemNote(itemInput({ tasks: [later, soon] }))
    expect(sectionOf(r.body, 'Next step')).toBe(
      `- [ ] Rewrite sampling (20 min) ^${blockIdFor('s', 'soon', 'c')}`
    )
    expect(r.checks[blockIdFor('s', 'soon', 'c')]).toBe(false)
    expect(sectionOf(renderItemNote(itemInput()).body, 'Next step')).toBe(
      '_Nothing to do right now._'
    )
  })

  it('deadlines: task rows are ^ff-t checkboxes, digest-only dates plain bullets, old dates dropped, duplicates merged, deliverable-covered dates skipped', () => {
    const tasks = [
      task('t1', 'Proposal v5 to supervisor', {
        deadline: '2026-11-20',
        subtasks: [done('1', 'a'), step('2', 'b')]
      }),
      task('t2', 'Ethics form', { deadline: '2026-11-12', subtasks: [done('1', 'a')] }),
      task('t3', 'Assignment 1', {
        deadline: '2026-11-25',
        origin: { kind: 'deliverable', key: 'assignment 1 report', source: 'outline.md' },
        subtasks: [step('1', 'a')]
      }),
      task('old', 'Old finished', { deadline: '2026-10-01', subtasks: [done('1', 'a')] })
    ]
    const d = digest({
      dueDates: [
        {
          what: 'Week 11 presentation',
          date: '2026-11-24',
          confidence: 'confirmed',
          sources: [{ label: 'research/status.md', date: '2026-11-10' }]
        },
        { what: 'Week 11 Presentation!', date: '2026-11-24', confidence: 'confirmed', sources: [] },
        { what: 'Assignment 1 report', date: '2026-11-26', confidence: 'confirmed', sources: [] },
        {
          what: 'Proposal v5 to supervisor',
          date: '2026-11-20',
          confidence: 'confirmed',
          sources: []
        },
        { what: 'Long gone', date: '2026-11-01', confidence: 'confirmed', sources: [] },
        { what: 'Just past', date: '2026-11-05', confidence: 'confirmed', sources: [] }
      ]
    })
    const r = renderItemNote(itemInput({ tasks, digest: d }))
    expect(sectionOf(r.body, 'Deadlines')!.split('\n')).toEqual([
      '- Just past [due:: 2026-11-05]',
      `- [x] Ethics form [due:: 2026-11-12] ^${blockIdFor('t', 't2')}`,
      `- [ ] Proposal v5 to supervisor [due:: 2026-11-20] ^${blockIdFor('t', 't1')}`,
      '- Week 11 presentation [due:: 2026-11-24] (research/status.md, 10 Nov)',
      `- [ ] Assignment 1 [due:: 2026-11-25] ^${blockIdFor('t', 't3')}`
    ])
    expect(r.checks[blockIdFor('t', 't2')]).toBe(true)
    expect(r.checks[blockIdFor('t', 't1')]).toBe(false)
    expect(r.checks[blockIdFor('t', 'old')]).toBeUndefined()
  })

  it('null date renders when text without inline field; tentative suffix', () => {
    const d = digest({
      dueDates: [
        {
          what: 'Week 11 presentation',
          date: null,
          when: 'Week 11 (TBC)',
          confidence: 'tentative',
          sources: [{ label: 'CONTEXT.md' }]
        },
        { what: 'Final exam', date: null, confidence: 'confirmed', sources: [] },
        {
          what: 'Draft due',
          date: '2026-11-18',
          confidence: 'tentative',
          sources: [{ label: 'outline.md', date: '2026-11-02' }]
        }
      ]
    })
    const tasks = [task('t1', 'Report', { deadline: '2026-11-19', deadlineKind: 'tentative' })]
    const lines = sectionOf(
      renderItemNote(itemInput({ tasks, digest: d })).body,
      'Deadlines'
    )!.split('\n')
    expect(lines).toEqual([
      '- Draft due [due:: 2026-11-18] (tentative) (outline.md, 2 Nov)',
      `- [ ] Report [due:: 2026-11-19] (tentative) ^${blockIdFor('t', 't1')}`,
      '- Week 11 presentation · Week 11 (TBC) (tentative) (CONTEXT.md)',
      '- Final exam · date TBC'
    ])
    expect(lines[2]).not.toContain('[due::')
  })

  it('loose ends render ^ff-g checkboxes from gapId subtasks with why and citation; omitted when none', () => {
    const d = digest({
      candidateTasks: [
        {
          id: 'abc123',
          title: 'Find the slot',
          minutes: 5,
          gapKind: 'to-check',
          why: 'presentation date TBC',
          sources: [{ label: 'CONTEXT.md' }]
        },
        {
          id: 'Gap/Long id with spaces',
          title: 'Ask',
          minutes: 5,
          gapKind: 'unknown',
          why: 'unclear',
          sources: [{ label: 'notes.md' }]
        }
      ]
    })
    const le = looseEnds([
      step('g1', 'Find the Week 11 slot on TMS', { gapId: 'abc123', timeEstimate: 5 }),
      step('g2', 'Ask about marking (notes.md)', {
        gapId: 'Gap/Long id with spaces',
        timeEstimate: 5
      }),
      done('g3', 'Already done', { gapId: 'zzz' }),
      step('plain', 'Not a gap')
    ])
    const main = task('t1', 'Proposal', { subtasks: [step('1', 'Write intro')] })
    const r = renderItemNote(itemInput({ tasks: [main, le], digest: d }))
    expect(sectionOf(r.body, 'Loose ends')!.split('\n')).toEqual([
      `- [ ] Find the Week 11 slot on TMS (5 min) — presentation date TBC (CONTEXT.md) ^ff-g-abc123`,
      `- [ ] Ask about marking (notes.md) (5 min) — unclear ^${gapBlockId('Gap/Long id with spaces')}`
    ])
    expect(r.checks['ff-g-abc123']).toBe(false)
    expect(parseTicks(r.body).get('ff-g-abc123')).toBe(false)
    const none = renderItemNote(
      itemInput({ tasks: [main, looseEnds([done('g3', 'x', { gapId: 'z' })])] })
    )
    expect(none.body).not.toContain('## Loose ends (auto)')
    // A gap that is the next step is shown once, as the next step.
    const onlyGap = renderItemNote(itemInput({ tasks: [le], digest: d }))
    expect(sectionOf(onlyGap.body, 'Next step')).toContain('^ff-g-abc123')
    expect(sectionOf(onlyGap.body, 'Loose ends')).not.toContain('^ff-g-abc123')
    expect(onlyGap.warnings).toEqual([])
  })

  it('tasks list links, step counts, due dates and tentative', () => {
    const tasks = [
      task('t1', 'Proposal v5', { subtasks: [done('1', 'a'), step('2', 'b'), step('3', 'c')] }),
      task('t2', 'Pilot study', {
        deadline: '2026-11-22',
        deadlineKind: 'tentative',
        subtasks: [step('1', 'a')]
      }),
      task('t3', 'Someday', { deadlineKind: 'none' }),
      looseEnds([])
    ]
    const r = renderItemNote(
      itemInput({
        tasks,
        taskLinks: {
          t1: 'FocusForge/Learning/Thesis/Proposal v5.md',
          t2: 'FocusForge/Learning/Thesis/Pilot study.md',
          le: 'FocusForge/Learning/Thesis/Loose ends.md'
        }
      })
    )
    expect(sectionOf(r.body, 'Tasks')!.split('\n')).toEqual([
      '- [[FocusForge/Learning/Thesis/Proposal v5|Proposal v5]] · 1/3 steps · due 2026-11-20',
      '- [[FocusForge/Learning/Thesis/Pilot study|Pilot study]] · 0/1 steps · due 2026-11-22 (tentative)',
      '- Someday · not planned yet',
      '- [[FocusForge/Learning/Thesis/Loose ends|Loose ends]] · not planned yet'
    ])
  })

  it('constraints and openItems render in State', () => {
    const d = digest({
      openItems: [
        {
          text: 'Limitations paragraph missing',
          status: 'todo',
          sources: [{ label: 'handoff.md' }]
        },
        { text: 'Waiting on ethics', status: 'waiting', sources: [] },
        {
          text: 'Blocked by data',
          status: 'blocked',
          sources: [{ label: 'log.md', date: '2026-11-09' }]
        }
      ],
      constraints: [
        { text: 'AI may not write code (course policy)', sources: [{ label: 'outline.md' }] }
      ],
      currentState: '### Where things stand\nPilot v2 ran.\n- [ ] not a tick'
    })
    expect(sectionOf(renderItemNote(itemInput({ digest: d })).body, 'State')).toBe(
      [
        '**Open items**',
        '- Limitations paragraph missing (handoff.md)',
        '- Waiting on ethics (waiting)',
        '- Blocked by data (blocked) (log.md, 9 Nov)',
        '',
        '**Rules that bind plans**',
        '- AI may not write code (course policy) (outline.md)',
        '',
        '#### Where things stand',
        'Pilot v2 ran.',
        '- not a tick'
      ].join('\n')
    )
  })

  it('no digest shows the not-summarised line', () => {
    const r = renderItemNote(itemInput())
    expect(sectionOf(r.body, 'State')).toBe(NOT_SUMMARISED)
    expect(r.body).not.toContain('> Goal:')
  })

  it('suggestedKind line only when it differs', () => {
    const differs = renderItemNote(
      itemInput({ item: item({ kind: 'ongoing' }), digest: digest({ suggestedKind: 'deadline' }) })
    )
    expect(differs.body).toContain(
      '> FocusForge thinks this is a deadline item. Change it in the app.'
    )
    const same = renderItemNote(itemInput({ digest: digest({ suggestedKind: 'deadline' }) }))
    expect(same.body).not.toContain('FocusForge thinks')
    expect(
      renderItemNote(itemInput({ digest: digest({ suggestedKind: null }) })).body
    ).not.toContain('FocusForge thinks')
  })

  it('links use full vault paths', () => {
    const r = renderItemNote(
      itemInput({
        tasks: [task('t1', 'Proposal v5')],
        taskLinks: { t1: 'FocusForge/Learning/Thesis/Proposal v5.md' }
      })
    )
    const links = r.body.match(/\[\[[^\]]+\]\]/g) ?? []
    expect(links.length).toBeGreaterThan(0)
    expect(links.every((l) => l.startsWith('[[FocusForge/'))).toBe(true)
    const t = renderTaskNote(taskInput(task('t1', 'Proposal v5')))
    expect(t.body).toContain('Part of [[FocusForge/Learning/Thesis/Thesis|Thesis]]')
    expect(Object.fromEntries(t.frontmatter).item).toBe(
      '"[[FocusForge/Learning/Thesis/Thesis|Thesis]]"'
    )
  })

  it('titles and digest text are escaped so they cannot fake links, ticks or fields', () => {
    const r = renderItemNote(
      itemInput({
        item: item({ name: 'Evil [[Life/Journal]]' }),
        tasks: [
          task('t1', 'Step [x] ^ff-s-0000000000', {
            subtasks: [step('1', '#tag [due:: 2026-01-01]')]
          })
        ],
        digest: digest({ goal: '[[Life/x]] ## heading' })
      })
    )
    expect(r.body).not.toMatch(/(?<!\\)\[\[Life/)
    expect(r.body).not.toMatch(/(?<!\\)\[due:: 2026-01-01/)
    expect([...parseTicks(r.body).keys()].every((id) => id in r.checks)).toBe(true)
  })

  it('rendering is deterministic for equal input', () => {
    const make = (): ItemNoteInput =>
      itemInput({
        item: item({ sources: ['/h/UNI/thesis', '/h/vault/Learning/Hub/Thesis.md'] }),
        tasks: [
          task('t1', 'Proposal', { subtasks: [step('1', 'a'), done('2', 'b')] }),
          looseEnds([step('g', 'gap', { gapId: 'abc' })])
        ],
        taskLinks: { t1: 'FocusForge/Learning/Thesis/Proposal.md' },
        digest: digest({
          dueDates: [{ what: 'X', date: '2026-11-30', confidence: 'confirmed', sources: [] }]
        }),
        log: [
          {
            at: '2026-11-10T01:00:00.000Z',
            date: '2026-11-10',
            kind: 'tick',
            text: 'Ticked "a" in Obsidian',
            key: 'k1'
          },
          {
            at: '2026-11-11T01:00:00.000Z',
            date: '2026-11-11',
            kind: 'done',
            text: 'Done in FocusForge: "b"',
            key: 'k2',
            taskId: 't1'
          },
          {
            at: '2026-09-01T01:00:00.000Z',
            date: '2026-09-01',
            kind: 'done',
            text: 'too old',
            key: 'k3'
          }
        ],
        home: '/h',
        vaultRoot: '/h/vault'
      })
    const a = renderItemNote(make())
    expect(renderItemNote(make())).toEqual(a)
    expect(sectionOf(a.body, 'Log')!.split('\n')).toEqual([
      '- 2026-11-11 · Done in FocusForge: "b"',
      '- 2026-11-10 · Ticked "a" in Obsidian'
    ])
    expect(Object.fromEntries(a.frontmatter).sources).toBe(
      '["~/UNI/thesis", "[[Learning/Hub/Thesis]]"]'
    )
    expect(Object.fromEntries(a.frontmatter).progress).toBe('33')
  })

  it('removed item gets the removed callout and status', () => {
    const r = renderItemNote(itemInput({ removedOn: '2026-11-11' }))
    expect(r.body).toContain(
      'Removed from FocusForge on 2026-11-11. This note is no longer updated.'
    )
    expect(r.body).not.toContain('Kept in sync by FocusForge')
    expect(Object.fromEntries(r.frontmatter).status).toBe('removed')
  })
})

describe('renderTaskNote', () => {
  it('task note: milestones with status and targetDate, steps grouped Now / Done / Other', () => {
    const t = task('t1', 'Proposal v5 to supervisor', {
      prerequisites: [
        { id: 'p1', title: 'Download the comments PDF', timeEstimate: 5, isCompleted: true }
      ],
      milestones: [
        milestone('m1', 'Collect supervisor feedback', {
          status: 'done',
          estimateMinutes: 45,
          doneWhen: 'all comments listed'
        }),
        milestone('m2', 'Rewrite methods', {
          status: 'active',
          estimateMinutes: 180,
          doneWhen: 'methods match pilot v2',
          targetDate: '2026-11-16'
        }),
        milestone('m3', 'Final read and send', { estimateMinutes: 90, doneWhen: 'emailed as PDF' })
      ],
      subtasks: [
        done('a', 'Read feedback email', { milestoneId: 'm1', timeEstimate: 5 }),
        step('b', 'Open methods.md and list the 3 comments', {
          milestoneId: 'm2',
          timeEstimate: 5
        }),
        step('c', 'Rewrite the sampling paragraph', { milestoneId: 'm2', timeEstimate: 20 }),
        step('d', 'Staged: export PDF', { milestoneId: 'm3' }),
        step('e', 'Orphan step', { milestoneId: 'gone' }),
        step('f', 'No milestone')
      ]
    })
    const r = renderTaskNote(taskInput(t))
    expect(sectionOf(r.body, 'Milestones')!.split('\n')).toEqual([
      `1. ~~Collect supervisor feedback~~ · 45 min · done when: all comments listed · done ^${blockIdFor('m', 't1', 'm1')}`,
      `2. **Rewrite methods** · 3 h · done when: methods match pilot v2 · by 2026-11-16 · now ^${blockIdFor('m', 't1', 'm2')}`,
      `3. Final read and send · 1 h 30 min · done when: emailed as PDF · next ^${blockIdFor('m', 't1', 'm3')}`
    ])
    const steps = sectionOf(r.body, 'Steps')!
    expect(steps.split('\n')).toEqual([
      '### Before you start',
      `- [x] Download the comments PDF (5 min) ^${blockIdFor('p', 't1', 'p1')}`,
      '### Now: Rewrite methods',
      `- [ ] Open methods.md and list the 3 comments (5 min) ^${blockIdFor('s', 't1', 'b')}`,
      `- [ ] Rewrite the sampling paragraph (20 min) ^${blockIdFor('s', 't1', 'c')}`,
      '### Done',
      `- [x] Read feedback email (5 min) ^${blockIdFor('s', 't1', 'a')}`,
      '### Other steps',
      `- [ ] Orphan step (10 min) ^${blockIdFor('s', 't1', 'e')}`,
      `- [ ] No milestone (10 min) ^${blockIdFor('s', 't1', 'f')}`
    ])
    expect(steps).not.toContain('Staged')
    // milestones are never tickable
    expect(Object.keys(r.checks).some((k) => k.startsWith('ff-m-'))).toBe(false)
    expect(parseTicks(r.body).size).toBe(Object.keys(r.checks).length)
    expect(Object.fromEntries(r.frontmatter)).toMatchObject({
      ff_id: 'thesis',
      ff_task: 't1',
      ff_note: 'task',
      deadline: '2026-11-20',
      deadline_kind: 'hard',
      progress: '"1/6"'
    })
    expect(r.body).toContain(
      'Part of [[FocusForge/Learning/Thesis/Thesis|Thesis]] · due [due:: 2026-11-20]\n'
    )
  })

  it('task without milestones renders flat steps (pre-Phase-5)', () => {
    const r = renderTaskNote(
      taskInput(task('t1', 'Flat', { subtasks: [done('1', 'One'), step('2', 'Two')] }))
    )
    expect(sectionOf(r.body, 'Steps')!.split('\n')).toEqual([
      `- [x] One (10 min) ^${blockIdFor('s', 't1', '1')}`,
      `- [ ] Two (10 min) ^${blockIdFor('s', 't1', '2')}`
    ])
    expect(r.body).not.toContain('## Milestones (auto)')
    const withPrereq = renderTaskNote(
      taskInput(
        task('t1', 'Flat', {
          prerequisites: [{ id: 'p', title: 'Install', isCompleted: false }],
          subtasks: [step('2', 'Two')]
        })
      )
    )
    expect(sectionOf(withPrereq.body, 'Steps')).toContain('### Before you start')
    expect(sectionOf(withPrereq.body, 'Steps')).toContain('### Steps')
  })

  it('unplanned task shows the plan hint', () => {
    const r = renderTaskNote(taskInput(task('t1', 'Assignment 2', { status: 'unplanned' })))
    expect(sectionOf(r.body, 'Steps')).toBe(NOT_PLANNED)
    expect(r.checks).toEqual({})
  })

  it('tentative and none deadlines, and the Loose ends note uses ^ff-g', () => {
    const tent = renderTaskNote(taskInput(task('t1', 'Report', { deadlineKind: 'tentative' })))
    expect(tent.body).toContain('· due [due:: 2026-11-20] (tentative)')
    expect(Object.fromEntries(tent.frontmatter).deadline_kind).toBe('tentative')
    const le = looseEnds([step('g1', 'Find slot', { gapId: 'abc' }), step('s1', 'Plain')])
    const r = renderTaskNote(taskInput(le))
    expect(r.body).toContain('Part of [[FocusForge/Learning/Thesis/Thesis|Thesis]]\n')
    expect(r.body).not.toContain('[due::')
    expect(Object.fromEntries(r.frontmatter).deadline).toBe('null')
    expect(Object.keys(r.checks)).toEqual(['ff-g-abc', blockIdFor('s', 'le', 's1')])
  })

  it('task log shows only its own entries', () => {
    const log = [
      {
        at: '2026-11-10T01:00:00.000Z',
        date: '2026-11-10',
        kind: 'done' as const,
        text: 'mine',
        key: 'a',
        taskId: 't1'
      },
      {
        at: '2026-11-10T02:00:00.000Z',
        date: '2026-11-10',
        kind: 'done' as const,
        text: 'other',
        key: 'b',
        taskId: 't2'
      },
      {
        at: '2026-11-10T03:00:00.000Z',
        date: '2026-11-10',
        kind: 'progress' as const,
        text: 'item-wide',
        key: 'c'
      }
    ]
    expect(sectionOf(renderTaskNote(taskInput(task('t1', 'T'), { log })).body, 'Log')).toBe(
      '- 2026-11-10 · mine'
    )
  })
})

describe('renderAboutNote and composing', () => {
  it('about note holds the Dataview snippet and composes with My notes', () => {
    const r = renderAboutNote()
    expect(r.body).toContain(dataviewSnippet())
    const text = composeNote(null, r, '2026-11-11T14:02').text
    expect(
      text.startsWith('---\nff_note: about\nupdated: 2026-11-11T14:02\n---\n# About these notes')
    ).toBe(true)
    expect(parseNote(text).myNotes).toBe('## My notes\n')
  })

  it('a composed item note round-trips: ticks parsed from it equal the rendered checks', () => {
    const r = renderItemNote(
      itemInput({
        tasks: [
          task('t1', 'Proposal', { subtasks: [done('1', 'a'), step('2', 'b')] }),
          looseEnds([step('g', 'gap', { gapId: 'abc' }), step('g2', 'gap 2', { gapId: 'def' })])
        ],
        digest: digest()
      })
    )
    const text = composeNote(null, r, 'u').text
    expect(Object.fromEntries(parseTicks(parseNote(text).appRegion))).toEqual(r.checks)
  })
})
