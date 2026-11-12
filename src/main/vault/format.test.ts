import { describe, expect, it } from 'vitest'
import { safeNoteName } from '../../common/workstreams'
import {
  STATE_MAX_BYTES,
  blockIdFor,
  escapeInline,
  formatMinutes,
  gapBlockId,
  renderCitation,
  sanitizeStateMarkdown,
  sourceLabel,
  stepBlockId,
  wikilink,
  yamlScalar
} from './format'
import { parseNote, parseTicks } from './noteDoc'

describe('escapeInline', () => {
  it('escapeInline neutralises wikilinks, tags, block refs, inline fields and checkboxes', () => {
    const out = escapeInline('See [[Life/Journal]] #private [due:: 2026-01-01] [x] done ^ff-s-abc')
    expect(out).not.toMatch(/(?<!\\)\[\[/)
    expect(out).toContain('\\[\\[Life/Journal\\]\\]')
    expect(out).toContain('\\#private')
    expect(out).toContain('\\[due:\\: 2026-01-01\\]')
    expect(out).toContain('\\[x\\]')
    expect(out).not.toContain('^ff-s-abc')
    expect(escapeInline('a ^ff-s-abc tail')).toBe('a \\^ff-s-abc tail')
    expect(escapeInline('# heading')).toBe('# heading') // "# " isn't a tag
    expect(escapeInline('(due:: 2026-01-01)')).toBe('(due:\\: 2026-01-01)')
    expect(escapeInline('a*b_c`d|e$f\\g')).toBe('a\\*b\\_c\\`d\\|e\\$f\\\\g')
    // a rendered checkbox line with escaped text yields no ticks
    const line = `- [ ] ${escapeInline('[x] fake ^ff-s-0123456789')}`
    expect(parseTicks(line).size).toBe(0)
  })

  it('escapeInline collapses newlines and escapes html and %% == ~~', () => {
    expect(escapeInline('one\n\n## two\r\nthree')).toBe('one \\## two three')
    expect(escapeInline('<script>')).toBe('&lt;script>')
    expect(escapeInline('%%hidden%%')).toBe('\\%%hidden\\%%')
    expect(escapeInline('==mark== ~~gone~~')).toBe('\\==mark\\== \\~~gone\\~~')
    expect(escapeInline('a % b = c ~ d')).toBe('a % b = c ~ d')
  })
})

describe('sanitizeStateMarkdown', () => {
  it('sanitizeStateMarkdown demotes headings so no ## or # line survives', () => {
    const out = sanitizeStateMarkdown('# Top\n## My notes\ntext\n#### Deep\n###### Six')
    const lines = out.split('\n')
    expect(lines.some((l) => /^#{1,3}\s/.test(l))).toBe(false)
    expect(lines).toEqual(['#### Top', '#### My notes', 'text', '##### Deep', '###### Six'])
    // the result can't open a My notes tail in a note
    const note = `---\na: 1\n---\n# X\n## State (auto)\n${out}\n## My notes\nmine\n`
    expect(parseNote(note).myNotes).toBe('## My notes\nmine\n')
  })

  it('sanitizeStateMarkdown demotes Phase 3 ### sections to ####', () => {
    const md =
      '### Overview\nA\n### Where things stand\nB\n### Recent work\nC\n### Risks and blockers\nD\n### What’s next\nE'
    const out = sanitizeStateMarkdown(md)
    expect(out.match(/^#### /gm)).toHaveLength(5)
    expect(out).not.toMatch(/^### /m)
  })

  it('sanitizeStateMarkdown turns checkboxes into bullets and strips ff block ids', () => {
    const out = sanitizeStateMarkdown(
      '- [ ] open\n  * [x] nested\n1. [X] numbered\n- plain [due:: 2026-11-20] ^ff-s-0123456789\n(owner:: me)'
    )
    expect(out).toBe('- open\n  - nested\n- numbered\n- plain \\[due:: 2026-11-20]\n\\(owner:: me)')
    expect(parseTicks(out).size).toBe(0)
  })

  it('sanitizeStateMarkdown closes an unbalanced code fence', () => {
    const out = sanitizeStateMarkdown('before\n```js\n## not a heading\n- [ ] kept as code')
    expect(out).toBe('before\n```js\n## not a heading\n- [ ] kept as code\n```')
    expect(sanitizeStateMarkdown('~~~~\nx\n~~~\n')).toBe('~~~~\nx\n~~~\n~~~~')
    expect(sanitizeStateMarkdown('```\nx\n```')).toBe('```\nx\n```')
  })

  it('sanitizeStateMarkdown caps at 14 KB', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'é'.repeat(10)}`).join('\n')
    const out = sanitizeStateMarkdown(big)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(STATE_MAX_BYTES)
    expect(out.endsWith('\n…(trimmed)')).toBe(true)
    expect(out).toMatch(/^line 0 /)
    const fenced = sanitizeStateMarkdown('```\n' + big)
    expect(Buffer.byteLength(fenced, 'utf8')).toBeLessThanOrEqual(STATE_MAX_BYTES)
    expect(fenced.endsWith('```\n…(trimmed)')).toBe(true)
    expect(sanitizeStateMarkdown('short')).toBe('short')
  })
})

describe('block ids', () => {
  it('blockIdFor is deterministic, [a-z0-9-] only, distinct per task for equal subtask ids', () => {
    const a = blockIdFor('s', 'task-1', '1')
    expect(a).toBe(blockIdFor('s', 'task-1', '1'))
    expect(a).toMatch(/^ff-s-[a-z0-9]{10}$/)
    expect(blockIdFor('s', 'task-2', '1')).not.toBe(a)
    expect(blockIdFor('p', 'task-1', '1')).not.toBe(a.replace('ff-s', 'ff-p'))
    expect(blockIdFor('t', 'task-1')).toMatch(/^ff-t-[a-z0-9]{10}$/)
    expect(blockIdFor('m', 'task-1', 'ms-1')).toMatch(/^ff-m-[a-z0-9]{10}$/)
  })

  it('gapBlockId keeps short safe ids and hashes others', () => {
    expect(gapBlockId('a1b2c3')).toBe('ff-g-a1b2c3')
    expect(gapBlockId('A1B2C3')).toBe('ff-g-a1b2c3')
    expect(gapBlockId('0123456789abcdef')).toBe('ff-g-0123456789abcdef')
    expect(gapBlockId('0123456789abcdefg')).toMatch(/^ff-g-[a-z0-9]{10}$/)
    expect(gapBlockId('gap:week 11')).toMatch(/^ff-g-[a-z0-9]{10}$/)
    expect(gapBlockId('gap:week 11')).toBe(gapBlockId('gap:week 11'))
    // ids round-trip through parseTicks
    expect([...parseTicks(`- [x] t ^${gapBlockId('gap:week 11')}`).keys()]).toEqual([
      gapBlockId('gap:week 11')
    ])
  })

  it('stepBlockId uses ^ff-g only for gap steps of the Loose ends task', () => {
    const s = { id: '1', title: 'x', isCompleted: false, gapId: 'abc' }
    expect(stepBlockId({ id: 't', auto: 'loose-ends' }, s)).toBe('ff-g-abc')
    expect(stepBlockId({ id: 't' }, s)).toBe(blockIdFor('s', 't', '1'))
    expect(stepBlockId({ id: 't', auto: 'loose-ends' }, { ...s, gapId: undefined })).toBe(
      blockIdFor('s', 't', '1')
    )
  })
})

describe('safeNoteName', () => {
  it('safeNoteName strips forbidden chars, trailing dots and caps length', () => {
    expect(safeNoteName('a/b\\c:d*e?f"g<h>i|j#k^l[m]n')).toBe('a b c d e f g h i j k l m n')
    expect(safeNoteName('  ..Notes...  ')).toBe('Notes')
    expect(safeNoteName('tab\there\u0000nul\u007f')).toBe('tab here nul')
    expect(safeNoteName('../x/y')).toBe('x y')
    expect(safeNoteName('')).toBe('Untitled')
    expect(safeNoteName('...')).toBe('Untitled')
    expect(safeNoteName('###')).toBe('Untitled')
    // NFC: a decomposed é becomes one code point
    expect(safeNoteName('Café')).toBe('Café')
    expect(Array.from(safeNoteName('x'.repeat(150)))).toHaveLength(100)
    expect(safeNoteName(`${'a'.repeat(99)}.b`)).toBe(`${'a'.repeat(99)}.`.replace(/\.$/, ''))
    const wide = safeNoteName('漢'.repeat(100))
    expect(Buffer.byteLength(wide, 'utf8')).toBeLessThanOrEqual(200)
    expect(safeNoteName('😀'.repeat(120))).toBe('😀'.repeat(50))
  })
})

describe('other helpers', () => {
  it('wikilink uses the full vault path and a safe alias', () => {
    expect(wikilink('FocusForge/Learning/Thesis/Proposal v5.md', 'Proposal v5')).toBe(
      '[[FocusForge/Learning/Thesis/Proposal v5|Proposal v5]]'
    )
    expect(wikilink('FocusForge/A/B/C.md', 'x | y ]] [[z')).toBe('[[FocusForge/A/B/C|x y z]]')
  })

  it('yamlScalar writes dates and ids bare and quotes the rest', () => {
    expect(yamlScalar('2026-11-20')).toBe('2026-11-20')
    expect(yamlScalar('2026-11-11T14:02')).toBe('2026-11-11T14:02')
    expect(yamlScalar('thesis')).toBe('thesis')
    expect(yamlScalar('PERSONAL_WEB')).toBe('PERSONAL_WEB')
    expect(yamlScalar('yes')).toBe('"yes"')
    expect(yamlScalar('123')).toBe('"123"')
    expect(yamlScalar('6f1c2a90-aa')).toBe('"6f1c2a90-aa"')
    expect(yamlScalar('a: b')).toBe('"a: b"')
    expect(yamlScalar('3/8')).toBe('"3/8"')
    expect(yamlScalar(null)).toBe('null')
    expect(yamlScalar(38)).toBe('38')
  })

  it('renderCitation, formatMinutes and sourceLabel', () => {
    expect(renderCitation({ label: 'research/status.md', date: '2026-11-10' })).toBe(
      '(research/status.md, 10 Nov)'
    )
    expect(renderCitation({ label: 'CONTEXT.md' })).toBe('(CONTEXT.md)')
    expect(renderCitation({ label: '[[x]]' })).toBe('(\\[\\[x\\]\\])')
    expect(formatMinutes(45)).toBe('45 min')
    expect(formatMinutes(180)).toBe('3 h')
    expect(formatMinutes(90)).toBe('1 h 30 min')
    const ctx = { home: '/h', vaultRoot: '/h/vault' }
    expect(sourceLabel('/h/UNI/thesis', ctx)).toBe('~/UNI/thesis')
    expect(sourceLabel('/h/vault/Learning/Thesis Hub/Thesis.md', ctx)).toBe(
      '[[Learning/Thesis Hub/Thesis]]'
    )
    expect(sourceLabel('/h/vault/Projects/IDEAS.md#FocusForge', ctx)).toBe(
      '[[Projects/IDEAS#FocusForge]]'
    )
    expect(sourceLabel('/other/x', ctx)).toBe('/other/x')
  })
})
