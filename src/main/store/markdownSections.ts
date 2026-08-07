/**
 * Small helpers for manipulating a flat markdown document made of `## Heading`
 * sections (the context ledger and the user profile both use this shape). All
 * functions match sections by exact heading text and treat the section body as
 * everything up to the next `\n## ` heading (or end of file).
 *
 * Centralizing these removes the near-identical find-heading/slice/splice logic
 * that was previously duplicated across the ledger and profile append/trim
 * paths.
 */

const HEADING_PREFIX = '\n## '

/** Byte range [start, end) of a heading's body (text after the heading line). */
function sectionBodyRange(text: string, heading: string): { start: number; end: number } | null {
  const headingIndex = text.indexOf(heading)
  if (headingIndex === -1) return null
  const start = headingIndex + heading.length
  const nextHeadingIndex = text.indexOf(HEADING_PREFIX, start)
  const end = nextHeadingIndex === -1 ? text.length : nextHeadingIndex
  return { start, end }
}

/**
 * Appends `line` as the last entry under `## <section>`. If the heading is
 * missing (older/malformed doc), the section is created at the end. Returns the
 * updated document text.
 */
export function appendUnderHeading(text: string, section: string, line: string): string {
  const heading = `## ${section}`
  const range = sectionBodyRange(text, heading)
  if (!range) {
    return `${text}\n${heading}\n${line}\n`
  }
  return text.slice(0, range.end).replace(/\n*$/, '\n') + `${line}\n` + text.slice(range.end)
}

/** Returns the raw body text of `## <section>`, or '' if the heading is absent. */
export function sectionBody(text: string, section: string): string {
  const range = sectionBodyRange(text, `## ${section}`)
  if (!range) return ''
  return text.slice(range.start, range.end)
}

/**
 * Keeps only the last `max` bullet lines ("- ...") under `## <section>`,
 * dropping older ones. No-op if the heading is missing or already within
 * budget. Returns the updated document text.
 */
export function trimSectionBullets(text: string, section: string, max: number): string {
  const heading = `## ${section}`
  const range = sectionBodyRange(text, heading)
  if (!range) return text

  const body = text.slice(range.start, range.end)
  const bullets = body.split('\n').filter((l) => l.trim().startsWith('- '))
  if (bullets.length <= max) return text

  const kept = bullets.slice(-max).join('\n')
  return text.slice(0, range.start) + `\n${kept}\n` + text.slice(range.end)
}
