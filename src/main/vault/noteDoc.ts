// src/main/vault/noteDoc.ts
// Splits a note into what the app owns and what the owner owns, and puts it
// back together. Pure (no fs, no electron).
//
// A note is: frontmatter, then the app region (the preamble before the first
// `## ` heading plus every `## … (auto)` section), then any other `##`
// sections the owner added (kept word for word), then `## My notes` to the
// end of the file (never rewritten, never scanned for ticks). Headings inside
// code fences don't count.
import { createHash } from 'crypto'
import { fenceAfter } from './format'
import type { RenderedNote } from './types'

export const MY_NOTES_HEADING = '## My notes'

export interface ParsedNote {
  /** Inner frontmatter text (no `---` lines), '\n' line ends; null when absent or malformed. */
  frontmatter: string | null
  /** True when the file opened with `---` but it never closed: treated as body. */
  malformedFrontmatter: boolean
  /** Preamble plus every `## … (auto)` section, '\n' line ends. Ticks are read only from here. */
  appRegion: string
  /** Owner `##` sections above My notes, verbatim apart from trailing blank lines. */
  unknownSections: string[]
  /** How many of those had an app section after them (they get moved down). */
  misplaced: number
  /** From the `## My notes` line to the end of the file, byte for byte; null when missing. */
  myNotes: string | null
  eol: '\n' | '\r\n'
}

const H2 = /^## +(.*?)\s*$/

export function hashText(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/**
 * Hash of an app region with every checkbox mark folded to `[ ]`, so a tick
 * in Obsidian isn't mistaken for an edit of app-owned text.
 */
export function regionHash(appRegion: string): string {
  return hashText(appRegion.replace(/^(\s*[-*+] )\[[ xX]\]/gm, '$1[ ]'))
}

function isAutoHeading(line: string): boolean {
  const m = H2.exec(line)
  return !!m && /\(auto\)$/i.test(m[1])
}

function isMyNotesHeading(line: string): boolean {
  const m = H2.exec(line)
  return !!m && m[1].toLowerCase() === 'my notes'
}

/** Lines with their original line ends, so slices stay byte-exact. */
function splitKeepEol(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

const stripEol = (line: string): string => line.replace(/\r?\n$/, '')

export function parseNote(text: string): ParsedNote {
  const eol: '\n' | '\r\n' = /\r\n/.test(text) ? '\r\n' : '\n'
  const lines = splitKeepEol(text)
  let start = 0
  let frontmatter: string | null = null
  let malformedFrontmatter = false
  if (lines.length > 0 && stripEol(lines[0]) === '---') {
    const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(stripEol(l)))
    if (end > 0) {
      frontmatter = lines.slice(1, end).map(stripEol).join('\n')
      start = end + 1
    } else {
      malformedFrontmatter = true
    }
  }

  // Find My notes (outside fences) and the ## boundaries above it.
  let fence: string | null = null
  let myNotesAt = -1
  const heads: number[] = []
  for (let i = start; i < lines.length; i++) {
    const line = stripEol(lines[i])
    const wasOpen = fence !== null
    const step = fenceAfter(fence, line)
    fence = step.open
    if (wasOpen || step.fenceLine) continue
    if (isMyNotesHeading(line)) {
      myNotesAt = i
      break
    }
    if (H2.test(line)) heads.push(i)
  }
  const bodyEnd = myNotesAt >= 0 ? myNotesAt : lines.length
  const myNotes = myNotesAt >= 0 ? lines.slice(myNotesAt).join('') : null

  const norm = (from: number, to: number): string => lines.slice(from, to).map(stripEol).join('\n')
  const app: string[] = []
  const unknown: { text: string; at: number }[] = []
  const firstHead = heads.length ? heads[0] : bodyEnd
  if (firstHead > start) app.push(norm(start, firstHead))
  let lastAuto = -1
  heads.forEach((h, k) => {
    const to = k + 1 < heads.length ? heads[k + 1] : bodyEnd
    if (isAutoHeading(stripEol(lines[h]))) {
      app.push(norm(h, to))
      lastAuto = h
    } else {
      unknown.push({ text: norm(h, to).replace(/\s+$/, ''), at: h })
    }
  })
  return {
    frontmatter,
    malformedFrontmatter,
    appRegion: app.join('\n').replace(/\s+$/, ''),
    unknownSections: unknown.map((u) => u.text),
    misplaced: unknown.filter((u) => u.at < lastAuto).length,
    myNotes,
    eol
  }
}

/** A top-level key line: `key:` with the key at column 0. */
const KEY_LINE = /^([A-Za-z_][\w.-]*)\s*:(?:\s|$)/

/**
 * Replaces app-owned keys in place (a multi-line value such as a block list
 * is replaced as a whole), appends the missing ones in order, and keeps every
 * other line, comment and key byte for byte. Returns the inner text.
 */
export function mergeFrontmatter(raw: string | null, owned: [key: string, yaml: string][]): string {
  const ownedMap = new Map(owned)
  const lines = raw === null || raw === '' ? [] : raw.split('\n')
  const out: string[] = []
  const written = new Set<string>()
  let skipping = false
  for (const line of lines) {
    const m = KEY_LINE.exec(line)
    if (m) {
      skipping = false
      const key = m[1]
      if (ownedMap.has(key)) {
        skipping = true // drop this key's old value lines too
        if (!written.has(key)) {
          out.push(`${key}: ${ownedMap.get(key)}`)
          written.add(key)
        }
        continue
      }
    } else if (skipping) {
      // Continuation of an owned key: indented lines and `- item` lines.
      if (/^(\s+\S|-\s|-$)/.test(line)) continue
      skipping = false
    }
    out.push(line)
  }
  // Blank lines that ended up after a replaced block stay; missing keys go last.
  while (
    out.length > 0 &&
    out[out.length - 1].trim() === '' &&
    owned.some(([k]) => !written.has(k))
  )
    out.pop()
  for (const [key, yaml] of owned) {
    if (!written.has(key)) out.push(`${key}: ${yaml}`)
  }
  return out.join('\n')
}

/** Reads top-level scalar keys (enough for `ff_id`, `ff_task`, `ff_note`). */
export function readFrontmatterKeys(text: string): Record<string, string> {
  const fm = parseNote(text).frontmatter
  const out: Record<string, string> = {}
  if (fm === null) return out
  for (const line of fm.split('\n')) {
    const m = /^([A-Za-z_][\w.-]*)\s*:\s*(.*?)\s*$/.exec(line)
    if (!m || m[1] in out) continue
    let v = m[2]
    if (/^"(?:[^"\\]|\\.)*"$/.test(v)) {
      try {
        v = JSON.parse(v)
      } catch {
        // keep raw
      }
    } else if (/^'.*'$/.test(v)) {
      v = v.slice(1, -1).replace(/''/g, "'")
    }
    out[m[1]] = v
  }
  return out
}

export interface ComposedNote {
  text: string
  appRegionHash: string
  myNotesHash: string
  /** Owner sections moved down to just above My notes. */
  rescued: number
}

/**
 * The note text for a render: merged frontmatter (with `updated`), the
 * rendered app region, the owner's own `##` sections, then My notes exactly
 * as they were. Keeps the file's line ends. compose(compose(x)) === compose(x).
 */
export function composeNote(
  existing: string | null,
  r: Pick<RenderedNote, 'frontmatter' | 'body'>,
  updated: string
): ComposedNote {
  const prev = existing === null ? null : parseNote(existing)
  const eol = prev?.eol ?? '\n'
  const fm = mergeFrontmatter(prev?.frontmatter ?? null, [...r.frontmatter, ['updated', updated]])
  const parts = [`---\n${fm}\n---\n${r.body.replace(/\r\n?/g, '\n').replace(/\s+$/, '')}\n`]
  for (const s of prev?.unknownSections ?? []) parts.push(`\n${s}\n`)
  const head = parts.join('').replace(/\n/g, eol) + eol
  const myNotes = prev?.myNotes ?? `${MY_NOTES_HEADING}${eol}`
  const text = head + myNotes
  const parsed = parseNote(text)
  return {
    text,
    appRegionHash: regionHash(parsed.appRegion),
    myNotesHash: hashText(parsed.myNotes ?? ''),
    rescued: prev?.misplaced ?? 0
  }
}

/** Matches a checkbox list item: `- [x]`, `* [ ]`, `+ [X]`, indented or not. */
const CHECKBOX = /^\s*[-*+] \[(.)\]/
const BLOCK_ID = /(?:^|\s)\^(ff-[sgpt]-[a-z0-9]{1,16})(?=\s|$)/

/**
 * Tick state of every app checkbox in the app region: `x`/`X` -> true,
 * space -> false, any other mark ignored. Lines without an `^ff-` id (or with
 * a milestone `^ff-m` id) are ignored, as are code fences. First one wins on
 * a duplicate id.
 */
export function parseTicks(appRegion: string): Map<string, boolean> {
  const out = new Map<string, boolean>()
  let fence: string | null = null
  for (const line of appRegion.split(/\r?\n/)) {
    const wasOpen = fence !== null
    const step = fenceAfter(fence, line)
    fence = step.open
    if (wasOpen || step.fenceLine) continue
    const c = CHECKBOX.exec(line)
    if (!c) continue
    const mark = c[1]
    if (mark !== 'x' && mark !== 'X' && mark !== ' ') continue
    const id = BLOCK_ID.exec(line.slice(c[0].length))
    if (!id || out.has(id[1])) continue
    out.set(id[1], mark !== ' ')
  }
  return out
}
