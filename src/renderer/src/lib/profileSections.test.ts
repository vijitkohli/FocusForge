import { describe, expect, it } from 'vitest'
import { buildProfile, parseProfile, type ProfileSections } from './profileSections'

describe('profile sections', () => {
  it('round-trips editable content without trimming whitespace or interpreting Markdown', () => {
    const sections: ProfileSections = {
      'About Me': '\n  leading spaces\n- a bullet\n\n',
      Preferences: 'No terminal newline',
      'Patterns & Friction': 'first\n\n## A nested heading\n  indented\n'
    }
    const overview = '- Machine-owned overview\n\nKeep this untouched.\n'
    expect(parseProfile(buildProfile(sections, overview))).toEqual({ sections, overview })
  })

  it('round-trips a canonical existing profile byte for byte', () => {
    const markdown =
      '## About Me\n- Student\n\n## Preferences\n\n## Patterns & Friction\n- Getting started\n\n## Projects Overview\n- COMP6991\n'
    const parsed = parseProfile(markdown)
    expect(buildProfile(parsed.sections, parsed.overview)).toBe(markdown)
  })

  it('editing one body keeps the other bodies and machine overview untouched', () => {
    const parsed = parseProfile(
      '## About Me\nold\n\n## Preferences\n  quiet\n\n## Patterns & Friction\n\n## Projects Overview\n- Do not edit\n'
    )
    parsed.sections['About Me'] = 'new\nwith another line'
    const edited = parseProfile(buildProfile(parsed.sections, parsed.overview))
    expect(edited).toEqual(parsed)
    expect(edited.overview).toBe('- Do not edit\n')
  })

  it.each(['```markdown', '~~~markdown', '   ````markdown'])(
    'ignores recognized headings inside a %s fence in editable content and overview',
    (opening) => {
      const closing = opening.trim().match(/^[`~]+/)![0]
      const fenced = `${opening}\n## About Me\n## Preferences\n## Patterns & Friction\n## Projects Overview\n${closing}\n`
      const sections: ProfileSections = {
        'About Me': `before\n${fenced}after\n`,
        Preferences: 'quiet',
        'Patterns & Friction': fenced
      }
      const overview = `overview\n${fenced}untouched\n`
      const markdown = buildProfile(sections, overview)
      expect(parseProfile(markdown)).toEqual({ sections, overview })
      const parsed = parseProfile(markdown)
      expect(buildProfile(parsed.sections, parsed.overview)).toBe(markdown)
    }
  )

  it('only closes a fence with the same marker, sufficient length, and no trailing content', () => {
    const sections: ProfileSections = {
      'About Me':
        '````md\n```\n## Preferences\n~~~~\n## Projects Overview\n```` not a close\n## Patterns & Friction\n`````   \nkept',
      Preferences: 'real preferences',
      'Patterns & Friction': 'real friction'
    }
    const overview = 'real overview'
    expect(parseProfile(buildProfile(sections, overview))).toEqual({ sections, overview })
  })

  it('keeps the rest of an unclosed fence as content, including heading-like lines', () => {
    const body = 'before\n~~~\n## Preferences\nnot structural\n## Projects Overview\nstill fenced'
    expect(parseProfile(`## About Me\n${body}`)).toEqual({
      sections: { 'About Me': body, Preferences: '', 'Patterns & Friction': '' },
      overview: ''
    })
  })

  it('keeps duplicate recognized headings and bodies in the active section, including overview', () => {
    const sections: ProfileSections = {
      'About Me': 'first\n\n## About Me\nsecond\n',
      Preferences: 'quiet\n## Preferences\nmore preferences\n## About Me\na later note',
      'Patterns & Friction': 'friction\n## Patterns & Friction\nmore friction'
    }
    const overview =
      'first overview\n\n## Projects Overview\nsecond overview\n## Preferences\nkeep here\n'
    const markdown = buildProfile(sections, overview)
    const parsed = parseProfile(markdown)
    expect(parsed).toEqual({ sections, overview })
    expect(buildProfile(parsed.sections, parsed.overview)).toBe(markdown)
    parsed.sections['About Me'] = 'edited'
    const edited = parseProfile(buildProfile(parsed.sections, parsed.overview))
    expect(edited).toEqual(parsed)
    expect(edited.overview).toBe(overview)
  })

  it('preserves CRLF bodies, fenced headings, and duplicate headings verbatim', () => {
    const markdown =
      '## About Me\r\n  first\r\n```md\r\n## Preferences\r\n```\r\n## About Me\r\nsecond\r\n\r\n## Preferences\r\nquiet\r\n\r\n## Projects Overview\r\nfirst\r\n## Projects Overview\r\nsecond\r\n'
    const parsed = parseProfile(markdown)
    expect(parsed).toEqual({
      sections: {
        'About Me': '  first\r\n```md\r\n## Preferences\r\n```\r\n## About Me\r\nsecond\r\n',
        Preferences: 'quiet\r\n',
        'Patterns & Friction': ''
      },
      overview: 'first\r\n## Projects Overview\r\nsecond\r\n'
    })
    expect(parseProfile(buildProfile(parsed.sections, parsed.overview))).toEqual(parsed)
  })

  it('handles absent sections, empty bodies and a heading at EOF', () => {
    expect(parseProfile('')).toEqual({
      sections: { 'About Me': '', Preferences: '', 'Patterns & Friction': '' },
      overview: ''
    })
    expect(parseProfile('## About Me\nhello\n## Projects Overview').sections['About Me']).toBe(
      'hello'
    )
    const empty = parseProfile('')
    expect(parseProfile(buildProfile(empty.sections, empty.overview))).toEqual(empty)
  })
})
