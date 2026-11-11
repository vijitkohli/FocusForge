// src/main/sources/headings.ts
// The one content read in Phase 2: heading lines of hub/list notes, so a
// section like `IDEAS TO DO.md › FocusForge` can be attached to an item.
// Body text is dropped as soon as the lines are split; headings are never
// logged. Reads go through the guard, so Life and secrets are refused.
import type { PathGuard } from './guard'

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const MAX_HEADINGS = 200

/** Heading texts of a Markdown note, in order, de-duplicated. [] when unreadable. */
export async function readHeadings(
  guard: PathGuard,
  absPath: string,
  maxBytes = 256_000
): Promise<string[]> {
  if (!/\.md$/i.test(absPath)) return []
  const read = await guard.readTextPrefix(absPath, maxBytes)
  if (!read) return []
  const lines = read.text.split(/\r?\n/)
  if (read.truncated) lines.pop() // a cut-off last line may be half a heading
  const out: string[] = []
  const seen = new Set<string>()
  let fence: string | null = null
  let i = 0
  // YAML front matter: `# comments` there are not headings
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, idx) => idx > 0 && /^(---|\.\.\.)\s*$/.test(l))
    if (end > 0) i = end + 1
  }
  for (; i < lines.length && out.length < MAX_HEADINGS; i++) {
    const line = lines[i]
    const f = FENCE.exec(line)
    if (f) {
      if (!fence) fence = f[1][0]
      else if (f[1][0] === fence) fence = null
      continue
    }
    if (fence) continue
    const m = HEADING.exec(line)
    if (!m) continue
    const text = m[2].trim()
    if (text && !seen.has(text)) {
      seen.add(text)
      out.push(text)
    }
  }
  return out
}
