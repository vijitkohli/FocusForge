// src/main/sources/excerpt.ts
// Pure text helpers for the context pack: head+tail cuts, Markdown section
// extraction, notebook flattening, secret redaction, binary sniffing,
// iCloud conflict-copy detection and header escaping. No fs, no electron.

/** Marker line between the kept head and tail. */
export function omittedMarker(n: number): string {
  return `\n[… ${n.toLocaleString('en-US')} characters omitted …]\n`
}

/** Drops a U+FFFD left by cutting through a multi-byte UTF-8 sequence. */
export function trimReplacementChars(text: string): string {
  return text.replace(/^�+/, '').replace(/�+$/, '')
}

/**
 * Keeps `headRatio` of `max` from the head and the rest from the tail, cut at
 * line boundaries where possible, joined by an omitted-characters marker.
 */
export function headTail(
  text: string,
  max: number,
  headRatio = 0.7
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  const budget = Math.max(0, max - 48) // room for the marker
  let headLen = Math.floor(budget * headRatio)
  let tailLen = budget - headLen
  // Prefer line boundaries (within the last/first 20% of each part).
  const nl = text.lastIndexOf('\n', headLen)
  if (nl > headLen * 0.8) headLen = nl
  const tailStart0 = text.length - tailLen
  const nl2 = text.indexOf('\n', tailStart0)
  if (nl2 !== -1 && nl2 - tailStart0 < tailLen * 0.2) tailLen = text.length - (nl2 + 1)
  const head = trimReplacementChars(text.slice(0, headLen))
  const tail = trimReplacementChars(text.slice(text.length - tailLen))
  const omitted = text.length - head.length - tail.length
  return { text: head.replace(/\n$/, '') + omittedMarker(omitted) + tail, truncated: true }
}

/** Heading text compared loosely: NFC, trimmed, case-folded, no trailing #, emphasis or [[ ]]. */
export function foldHeading(s: string): string {
  return s
    .normalize('NFC')
    .replace(/\s+#+\s*$/, '')
    .replace(/\[\[([^\]|]*)(?:\|[^\]]*)?\]\]/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const FENCE = /^\s{0,3}(```|~~~)/
const ATX = /^\s{0,3}(#{1,6})\s+(.*?)\s*$/

/**
 * The section of `md` under `heading`: from that heading line to the next
 * heading of the same or higher level (fenced code is skipped when scanning).
 * With `toEnd`, it runs to the end of the file, so a section like Phase 4's
 * "My notes" keeps its own subheadings. null when the heading isn't found.
 */
export function extractSection(
  md: string,
  heading: string,
  opts: { toEnd?: boolean } = {}
): string | null {
  const want = foldHeading(heading)
  if (!want) return null
  const lines = md.split(/\r?\n/)
  let inFence = false
  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = ATX.exec(line)
    if (!m) continue
    const lv = m[1].length
    if (start === -1) {
      if (foldHeading(m[2]) === want) {
        start = i
        level = lv
        if (opts.toEnd) break
      }
    } else if (lv <= level) {
      return lines.slice(start, i).join('\n').trimEnd()
    }
  }
  if (start === -1) return null
  return lines.slice(start).join('\n').trimEnd()
}

/**
 * Jupyter notebook JSON -> `# %% [markdown]` / `# %% [code]` blocks. Markdown
 * cells in full, code cells capped at `maxCodeLines`; outputs, attachments
 * and metadata dropped. null when the JSON doesn't parse.
 */
export function notebookToText(json: string, maxCodeLines = 60): string | null {
  let nb: unknown
  try {
    nb = JSON.parse(json)
  } catch {
    return null
  }
  const cells = (nb as { cells?: unknown })?.cells
  if (!Array.isArray(cells)) return null
  const out: string[] = []
  for (const c of cells) {
    if (!c || typeof c !== 'object') continue
    const cell = c as { cell_type?: unknown; source?: unknown }
    const src = Array.isArray(cell.source)
      ? cell.source.filter((x): x is string => typeof x === 'string').join('')
      : typeof cell.source === 'string'
        ? cell.source
        : ''
    if (!src.trim()) continue
    if (cell.cell_type === 'markdown') {
      out.push(`# %% [markdown]\n${src.trimEnd()}`)
    } else if (cell.cell_type === 'code') {
      const lines = src.trimEnd().split('\n')
      const kept = lines.slice(0, maxCodeLines).join('\n')
      const more =
        lines.length > maxCodeLines ? `\n# … ${lines.length - maxCodeLines} more lines` : ''
      out.push(`# %% [code]\n${kept}${more}`)
    }
  }
  return out.join('\n\n')
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[bpas]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
]
const SECRET_ASSIGN =
  /^(\s*(?:export\s+)?["']?[A-Za-z0-9_.-]*(?:API[_-]?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD)["']?\s*[:=]\s*)(["']?)(\S{12,})\2/gim

/** Replaces credential-shaped strings with `[redacted]`; returns the count. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0
  let out = text
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      count++
      return '[redacted]'
    })
  }
  out = out.replace(SECRET_ASSIGN, (m, pre: string, q: string, val: string) => {
    if (val === '[redacted]') return m
    count++
    return `${pre}${q}[redacted]${q}`
  })
  return { text: out, count }
}

/** True when the first 8 KB contain a NUL character. */
export function looksBinary(text: string): boolean {
  return text.slice(0, 8192).includes('\0')
}

const CONFLICT = /^(.*\S) (\d+)(\.[^.]+)$/

/**
 * iCloud conflict copy (`Note 2.md`): returns the base name (`Note.md`) when
 * that base exists among `siblings`, else null.
 */
export function isConflictCopy(name: string, siblings: Iterable<string>): string | null {
  const m = CONFLICT.exec(name.normalize('NFC'))
  if (!m) return null
  const base = `${m[1]}${m[3]}`
  const set = siblings instanceof Set ? (siblings as Set<string>) : new Set(siblings)
  for (const s of set) if (s.normalize('NFC') === base) return base
  return null
}

/** Prefixes content lines that start with `===` so file text can't forge a block header. */
export function escapeFenceLines(text: string): string {
  return text.replace(/^(\s*)===/gm, '$1​===')
}
