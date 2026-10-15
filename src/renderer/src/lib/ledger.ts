import { LEDGER_SECTIONS, type LedgerSection } from '../../../common/types'

export interface LedgerEntry {
  text: string
  date?: string
  bullet: boolean
}

export interface ParsedLedgerSection {
  heading: string
  entries: LedgerEntry[]
}

export function parseLedger(markdown: string): ParsedLedgerSection[] {
  const sections: ParsedLedgerSection[] = []
  let section: ParsedLedgerSection | undefined
  let entry: LedgerEntry | undefined
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^## (.+)$/.exec(line)
    if (heading) {
      section = { heading: heading[1].trim(), entries: [] }
      sections.push(section)
      entry = undefined
      continue
    }
    if (!section && !line.trim()) continue
    if (!section) {
      section = { heading: '', entries: [] }
      sections.push(section)
    }
    const bullet = /^- (.*)$/.exec(line)
    if (bullet) {
      const stamp = /^\[(\d{4}-\d{2}-\d{2})\](?:\s+|$)(.*)$/.exec(bullet[1])
      entry = { bullet: true, text: stamp ? stamp[2] : bullet[1] }
      if (stamp) entry.date = stamp[1]
      section.entries.push(entry)
    } else if (entry) {
      entry.text += `\n${line}`
    } else if (line.trim()) {
      entry = { bullet: false, text: line }
      section.entries.push(entry)
    }
  }
  for (const parsed of sections) {
    for (const item of parsed.entries) item.text = item.text.trimEnd()
  }
  return sections
}

export function missingLedgerSections(markdown: string): LedgerSection[] {
  const headings = new Set(parseLedger(markdown).map((section) => section.heading))
  return LEDGER_SECTIONS.filter((heading) => !headings.has(heading))
}
