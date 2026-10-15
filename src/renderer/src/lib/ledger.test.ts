import { describe, expect, it } from 'vitest'
import { LEDGER_SECTIONS } from '../../../common/types'
import { missingLedgerSections, parseLedger } from './ledger'

describe('ledger', () => {
  it('parses headings, stamped/unstamped bullets and multiline excerpts', () => {
    expect(
      parseLedger(
        '## Document Excerpts\n- [2026-07-08] page one\n  continued\n\nsecond paragraph\n- unstamped\n\n## Plan Adjustments\n- [2026-07-09] Moved two steps\n'
      )
    ).toEqual([
      {
        heading: 'Document Excerpts',
        entries: [
          { bullet: true, date: '2026-07-08', text: 'page one\n  continued\n\nsecond paragraph' },
          { bullet: true, text: 'unstamped' }
        ]
      },
      {
        heading: 'Plan Adjustments',
        entries: [{ bullet: true, date: '2026-07-09', text: 'Moved two steps' }]
      }
    ])
  })

  it('keeps prose, unknown headings and malformed stamps readable', () => {
    expect(parseLedger('Intro\r\n## Custom\r\nSome text\r\n- [yesterday] note\r\n')).toEqual([
      { heading: '', entries: [{ bullet: false, text: 'Intro' }] },
      {
        heading: 'Custom',
        entries: [
          { bullet: false, text: 'Some text' },
          { bullet: true, text: '[yesterday] note' }
        ]
      }
    ])
    expect(parseLedger('')).toEqual([])
    expect(parseLedger('## Empty\n')).toEqual([{ heading: 'Empty', entries: [] }])
  })

  it('reports the required headings that are missing', () => {
    expect(missingLedgerSections('')).toEqual([...LEDGER_SECTIONS])
    expect(
      missingLedgerSections(LEDGER_SECTIONS.map((heading) => `## ${heading}\n`).join('\n'))
    ).toEqual([])
    expect(missingLedgerSections('## Document Excerpts\n')).not.toContain('Document Excerpts')
  })
})
