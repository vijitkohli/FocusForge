import { describe, expect, it } from 'vitest'
import {
  composeNote,
  hashText,
  mergeFrontmatter,
  parseNote,
  parseTicks,
  readFrontmatterKeys
} from './noteDoc'
import { renderItemNote } from './render'
import { digest, item, step, task } from './testFixtures'

const rendered = {
  frontmatter: [
    ['ff_id', 'thesis'],
    ['ff_note', 'item'],
    ['sources', '["~/UNI/thesis"]']
  ] as [string, string][],
  body: '# Thesis\n> [!info] Kept in sync by FocusForge\n\n## Next step (auto)\n- [ ] Do it ^ff-s-0123456789\n\n## Log (auto)\n_Nothing yet._\n'
}

describe('parseNote and composeNote', () => {
  it('My notes preserved byte for byte including CRLF, trailing spaces and its own ## subheadings', () => {
    const mine =
      '## My notes\r\nAsk about the table.   \r\n\r\n## Sub heading\r\n- [x] my own tick ^ff-s-0123456789\r\n\ttabbed  '
    const existing = `---\r\nff_id: thesis\r\n---\r\n# Thesis\r\n## Next step (auto)\r\n- [ ] old\r\n\r\n${mine}`
    const out = composeNote(existing, rendered, '2026-11-11T14:02')
    expect(out.text.endsWith(mine)).toBe(true)
    expect(parseNote(out.text).myNotes).toBe(mine)
    expect(out.myNotesHash).toBe(hashText(mine))
    // the app part follows the file's CRLF line ends
    const head = out.text.slice(0, out.text.length - mine.length)
    expect(head.replace(/\r\n/g, '')).not.toContain('\n')
    expect(head).toContain('## Next step (auto)\r\n- [ ] Do it ^ff-s-0123456789\r\n')
    // ticks inside My notes are never read
    expect(parseTicks(parseNote(out.text).appRegion).get('ff-s-0123456789')).toBe(false)
  })

  it('"## My notes" inside a code fence in State is not treated as the tail', () => {
    const text = [
      '---',
      'ff_id: x',
      '---',
      '# X',
      '## State (auto)',
      '```',
      '## My notes',
      'fake',
      '```',
      '## Log (auto)',
      '- entry',
      '## My notes',
      'real'
    ].join('\n')
    const p = parseNote(text)
    expect(p.myNotes).toBe('## My notes\nreal')
    expect(p.appRegion).toContain('fake')
    expect(p.appRegion).toContain('## Log (auto)')
    expect(p.unknownSections).toEqual([])
  })

  it('unknown frontmatter keys and comments preserved verbatim; owned keys replaced in place; missing appended', () => {
    const raw = [
      'tags: [uni]   ',
      '# owner comment',
      'ff_id: old',
      'aliases:',
      '  - T',
      'progress: 1'
    ].join('\n')
    const out = mergeFrontmatter(raw, [
      ['ff_id', 'thesis'],
      ['progress', '38'],
      ['next_due', '2026-11-20']
    ])
    expect(out).toBe(
      [
        'tags: [uni]   ',
        '# owner comment',
        'ff_id: thesis',
        'aliases:',
        '  - T',
        'progress: 38',
        'next_due: 2026-11-20'
      ].join('\n')
    )
    expect(mergeFrontmatter(null, [['a', '1']])).toBe('a: 1')
    // duplicate owned keys collapse to one
    expect(mergeFrontmatter('a: 1\na: 2\nb: x', [['a', '9']])).toBe('a: 9\nb: x')
  })

  it('multi-line owned key (sources list) replaced as a block', () => {
    const raw = [
      'ff_id: thesis',
      'sources:',
      '  - "~/UNI/a"',
      '  - "~/UNI/b"',
      '- "~/UNI/c"',
      'tags: [x]'
    ].join('\n')
    expect(mergeFrontmatter(raw, [['sources', '["~/UNI/thesis"]']])).toBe(
      ['ff_id: thesis', 'sources: ["~/UNI/thesis"]', 'tags: [x]'].join('\n')
    )
  })

  it('unknown ## section above My notes is rescued before My notes', () => {
    const existing = [
      '---',
      'ff_id: thesis',
      '---',
      '# Thesis',
      '## Next step (auto)',
      '- [ ] old',
      '',
      '## Ideas',
      'my idea',
      '### deeper',
      'more',
      '',
      '## Log (auto)',
      '- old log',
      '## My notes',
      'mine'
    ].join('\n')
    const p = parseNote(existing)
    expect(p.unknownSections).toEqual(['## Ideas\nmy idea\n### deeper\nmore'])
    expect(p.misplaced).toBe(1)
    const out = composeNote(existing, rendered, '2026-11-11T14:02')
    expect(out.rescued).toBe(1)
    expect(out.text).toContain(
      '_Nothing yet._\n\n## Ideas\nmy idea\n### deeper\nmore\n\n## My notes\nmine'
    )
    expect(out.text).not.toContain('old log')
    // once it sits above My notes it isn't counted as moved again
    expect(composeNote(out.text, rendered, '2026-11-11T14:02').rescued).toBe(0)
  })

  it('missing My notes heading yields an empty My notes and rescues the rest', () => {
    const existing =
      '---\nff_id: thesis\n---\n# Thesis\n## Next step (auto)\n- [ ] x\n## Owner bit\nkeep me\n'
    const p = parseNote(existing)
    expect(p.myNotes).toBeNull()
    const out = composeNote(existing, rendered, '2026-11-11T14:02')
    expect(out.text).toContain('## Owner bit\nkeep me\n\n## My notes\n')
    expect(out.text.endsWith('## My notes\n')).toBe(true)
    expect(composeNote(null, rendered, 'u').text.endsWith('_Nothing yet._\n\n## My notes\n')).toBe(
      true
    )
  })

  it('malformed frontmatter treated as body and flagged', () => {
    const existing = '---\nff_id: thesis\nno closing line\n# Thesis\n## My notes\nmine\n'
    const p = parseNote(existing)
    expect(p.malformedFrontmatter).toBe(true)
    expect(p.frontmatter).toBeNull()
    expect(p.appRegion.startsWith('---\nff_id: thesis')).toBe(true)
    const out = composeNote(existing, rendered, 'u')
    expect(out.text.startsWith('---\nff_id: thesis\nff_note: item\n')).toBe(true)
    expect(out.text.endsWith('## My notes\nmine\n')).toBe(true)
    expect(parseNote(out.text).malformedFrontmatter).toBe(false)
  })

  it('parseTicks reads x, X and space; ignores other marks, My notes and lines without ff ids', () => {
    const region = [
      '- [x] a ^ff-s-aaaaaaaaaa',
      '- [X] b ^ff-s-bbbbbbbbbb',
      '- [ ] c ^ff-s-cccccccccc',
      '- [-] cancelled ^ff-s-dddddddddd',
      '- [/] half ^ff-s-eeeeeeeeee',
      '- [x] no id',
      '- plain ^ff-s-ffffffffff',
      '  * [x] nested star ^ff-p-gggggggggg',
      '+ [ ] plus ^ff-t-hhhhhhhhhh'
    ].join('\n')
    const t = parseTicks(region)
    expect(Object.fromEntries(t)).toEqual({
      'ff-s-aaaaaaaaaa': true,
      'ff-s-bbbbbbbbbb': true,
      'ff-s-cccccccccc': false,
      'ff-p-gggggggggg': true,
      'ff-t-hhhhhhhhhh': false
    })
    const note = `---\na: 1\n---\n# X\n## Steps (auto)\n${region}\n## My notes\n- [x] mine ^ff-s-zzzzzzzzzz\n`
    expect(parseTicks(parseNote(note).appRegion).has('ff-s-zzzzzzzzzz')).toBe(false)
  })

  it('parseTicks reads x, X, space for ff-s, ff-g, ff-p, ff-t; ignores ff-m, My notes and other marks', () => {
    const t = parseTicks(
      [
        '- [x] s ^ff-s-0123456789',
        '- [X] g ^ff-g-a1b2',
        '- [ ] p ^ff-p-0123456789',
        '- [x] t ^ff-t-0123456789',
        '- [x] m ^ff-m-0123456789',
        '- [?] q ^ff-g-zz',
        '```',
        '- [x] fenced ^ff-s-9999999999',
        '```'
      ].join('\n')
    )
    expect(Object.fromEntries(t)).toEqual({
      'ff-s-0123456789': true,
      'ff-g-a1b2': true,
      'ff-p-0123456789': false,
      'ff-t-0123456789': true
    })
  })

  it('parseTicks accepts trailing Tasks-plugin text after the block id', () => {
    const t = parseTicks(
      '- [x] Draft ^ff-s-0123456789 ✅ 2026-11-11\n- [ ] Next ^ff-g-ab12\t📅 2026-11-20'
    )
    expect(Object.fromEntries(t)).toEqual({ 'ff-s-0123456789': true, 'ff-g-ab12': false })
    // an id glued to other text is not a block id
    expect(parseTicks('- [x] word^ff-s-0123456789').size).toBe(0)
  })

  it('composeNote is idempotent: compose(compose(x)) === compose(x)', () => {
    const r = renderItemNote({
      item: item({ sources: ['/h/UNI/thesis'] }),
      tasks: [task('t1', 'Proposal', { subtasks: [step('1', 'Write intro')] })],
      taskLinks: { t1: 'FocusForge/Learning/Thesis/Proposal.md' },
      digest: digest({ currentState: '### A\n```\n## inside\n```\ntext' }),
      log: [],
      today: '2026-11-11',
      home: '/h'
    })
    const existing =
      '---\ntags: [uni]\nff_id: thesis\n---\n# Thesis\n## Ideas\nmine\n## Next step (auto)\nx\n## My notes\nhello\n'
    const once = composeNote(existing, r, '2026-11-11T14:02')
    const twice = composeNote(once.text, r, '2026-11-11T14:02')
    expect(twice.text).toBe(once.text)
    expect(twice.appRegionHash).toBe(once.appRegionHash)
    expect(twice.myNotesHash).toBe(once.myNotesHash)
    const fresh = composeNote(null, r, '2026-11-11T14:02')
    expect(composeNote(fresh.text, r, '2026-11-11T14:02').text).toBe(fresh.text)
    // the hash covers the app region only: a new timestamp leaves it alone
    expect(composeNote(once.text, r, '2026-11-12T09:00').appRegionHash).toBe(once.appRegionHash)
  })

  it('readFrontmatterKeys reads quoted and bare scalars', () => {
    const keys = readFrontmatterKeys(
      "---\nff_id: thesis\nff_task: \"6f1c-1\"\nitem: 'it''s'\n---\n# x"
    )
    expect(keys).toEqual({ ff_id: 'thesis', ff_task: '6f1c-1', item: "it's" })
    expect(readFrontmatterKeys('# no frontmatter')).toEqual({})
  })
})
