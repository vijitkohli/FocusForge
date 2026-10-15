import { USER_PROFILE_SECTIONS, type UserProfileSection } from '../../../common/types'

export type ProfileSections = Record<UserProfileSection, string>

export interface ParsedProfile {
  sections: ProfileSections
  overview: string
}

const OVERVIEW = 'Projects Overview'

/** Bodies include their original whitespace, bullets and newlines; never trim them. */
export function parseProfile(markdown: string): ParsedProfile {
  const sections: ProfileSections = { 'About Me': '', Preferences: '', 'Patterns & Friction': '' }
  let overview = ''
  const headings: { name: UserProfileSection | typeof OVERVIEW; start: number; end: number }[] = []
  const seen = new Set<string>()
  let fence: { marker: string; length: number } | undefined
  for (const match of markdown.matchAll(/[^\n]+\n?|\n/g)) {
    const line = match[0].replace(/\r?\n$/, '')
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.marker &&
        marker[1].length >= fence.length &&
        /^[\t ]*$/.test(marker[2])
      ) {
        fence = undefined
      }
      continue
    }
    if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      fence = { marker: marker[1][0], length: marker[1].length }
      continue
    }
    const heading = /^## (About Me|Preferences|Patterns & Friction|Projects Overview)$/.exec(line)
    if (!heading || seen.has(heading[1])) continue
    // Only the first occurrence is structural. Duplicate headings and their
    // bodies stay verbatim in the active section instead of overwriting text.
    seen.add(heading[1])
    headings.push({
      name: heading[1] as UserProfileSection | typeof OVERVIEW,
      start: match.index!,
      end: match.index! + match[0].length
    })
  }
  headings.forEach((match, index) => {
    const name = match.name
    let body = markdown.slice(match.end, headings[index + 1]?.start)
    if (name === OVERVIEW) overview = body
    else {
      // One newline separates the body from the next heading; all other whitespace is content.
      if (headings[index + 1] && body.endsWith('\n'))
        body = body.slice(0, body.endsWith('\r\n') ? -2 : -1)
      sections[name as UserProfileSection] = body
    }
  })
  return { sections, overview }
}

export function buildProfile(sections: ProfileSections, overview: string): string {
  let markdown = ''
  for (const heading of USER_PROFILE_SECTIONS) {
    const body = sections[heading]
    markdown += `## ${heading}\n${body}\n`
  }
  return `${markdown}## ${OVERVIEW}\n${overview}`
}
