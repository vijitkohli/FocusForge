// src/main/vault/format.ts
// Escaping, block ids, links and YAML scalars for vault notes. Pure (no fs,
// no electron).
import { createHash } from 'crypto'
import path from 'path'
import { renderCitation as renderDigestCitation } from '../../common/digest'
import { splitSourceRef } from '../../common/sourceRef'
import type { BlockKind, DigestSource, PlannedSubtask, TaskWithPlan } from './types'

/** Phase 3 clamps `currentState` to 14 KB; State never carries more. */
export const STATE_MAX_BYTES = 14 * 1024
const TRIMMED = '…(trimmed)'

/**
 * Makes untrusted text (titles, names, citations) render literally on one
 * line: it can't fake a link, tag, inline field, tick, block id, comment,
 * highlight or HTML.
 */
export function escapeInline(s: string): string {
  return (
    String(s ?? '')
      .replace(/\s*[\r\n]+\s*/g, ' ')
      .trim()
      // a trailing block id would turn the line into a block target
      .replace(/\s+\^[A-Za-z0-9-]*$/, '')
      .replace(/[\\[\]*_`|$^]/g, (c) => `\\${c}`)
      .replace(/#(?=\S)/g, '\\#')
      .replace(/</g, '&lt;')
      // %% comment, == highlight, ~~ strike: break every pair
      .replace(/([%=~])(?=\1)/g, '\\$1')
      // Dataview inline fields: `key:: value` and `(key:: value)`
      .replace(/::/g, ':\\:')
  )
}

/** Wikilink alias text: one line, nothing that ends the link early. */
function aliasText(s: string): string {
  return String(s ?? '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/[[\]|#^]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** `[[FocusForge/Learning/Thesis/Thesis|Thesis]]`: always the full vault path, never ambiguous. */
export function wikilink(rel: string, alias: string): string {
  const target = rel.replace(/\.md$/i, '')
  const a = aliasText(alias)
  return a && a !== target ? `[[${target}|${a}]]` : `[[${target}]]`
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * Code-fence tracking shared by every line scanner here, so they agree on
 * what's inside a fence. `open` is the opening run (e.g. "```") or null.
 * Returns the state after `line` and whether the line is a fence line.
 */
export function fenceAfter(
  open: string | null,
  line: string
): { open: string | null; fenceLine: boolean } {
  const f = FENCE.exec(line)
  if (!f) return { open, fenceLine: false }
  if (open === null) return { open: f[1], fenceLine: true }
  const closes =
    f[1][0] === open[0] && f[1].length >= open.length && !line.slice(f[0].length).trim()
  return closes ? { open: null, fenceLine: true } : { open, fenceLine: false }
}

/**
 * Digest Markdown made safe for `## State (auto)`: headings demoted to level
 * 4 or deeper (so no `#`/`##` line survives), checkboxes become bullets,
 * inline fields and `^ff-` block ids are neutralised, an open code fence is
 * closed, and the result is capped at 14 KB.
 */
export function sanitizeStateMarkdown(md: string): string {
  const lines = String(md ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  const out: string[] = []
  let fence: string | null = null
  for (const raw of lines) {
    let line = raw.replace(/\s*\^ff-[a-z]+-[a-z0-9]+(?=\s|$)/gi, '')
    const wasOpen = fence !== null
    const step = fenceAfter(fence, line)
    fence = step.open
    if (wasOpen || step.fenceLine) {
      out.push(line)
      continue
    }
    const h = /^ {0,3}(#{1,6})(?=\s|$)/.exec(line)
    if (h) {
      const level = Math.min(6, Math.max(4, h[1].length + 1))
      line = '#'.repeat(level) + line.slice(h[0].length)
    }
    line = line
      .replace(/^(\s*)(?:[-*+]|\d+[.)]) \[.\](\s|$)/, '$1- ')
      .replace(/([[(])([^\]\n()]*?::)/g, '\\$1$2')
    out.push(line)
  }
  let text = out.join('\n').replace(/\s+$/, '')
  if (fence) text += `\n${fence}`
  if (Buffer.byteLength(text, 'utf8') > STATE_MAX_BYTES) text = capMarkdown(text)
  return text
}

/** Cuts at a line boundary under the cap, re-closes an open fence, adds the marker. */
function capMarkdown(text: string): string {
  const budget = STATE_MAX_BYTES - Buffer.byteLength(`\n\`\`\`\`\`\`\n${TRIMMED}`, 'utf8')
  const lines = text.split('\n')
  const kept: string[] = []
  let used = 0
  let fence: string | null = null
  for (const line of lines) {
    const size = Buffer.byteLength(line, 'utf8') + 1
    if (used + size > budget) break
    kept.push(line)
    used += size
    fence = fenceAfter(fence, line).open
  }
  let out = kept.join('\n').replace(/\s+$/, '')
  if (fence) out += `\n${fence}`
  return `${out}\n${TRIMMED}`
}

function base36Hash(input: string): string {
  const hex = createHash('sha1').update(input, 'utf8').digest('hex')
  return BigInt(`0x${hex}`).toString(36).padStart(31, '0').slice(0, 10)
}

/**
 * `ff-<kind>-<10 base36>` from sha1(kind + taskId [+ '/' + childId]). Stable
 * across re-plans because merges keep step ids; distinct per task because
 * subtask ids are only unique within one task.
 */
export function blockIdFor(
  kind: Exclude<BlockKind, 'g'>,
  taskId: string,
  childId?: string
): string {
  const input = childId === undefined ? `${kind}${taskId}` : `${kind}${taskId}/${childId}`
  return `ff-${kind}-${base36Hash(input)}`
}

/** `ff-g-<gid>`: the candidate id lowercased when it is short and safe, else a hash. */
export function gapBlockId(gapId: string): string {
  const lower = String(gapId).toLowerCase()
  return `ff-g-${/^[a-z0-9]{1,16}$/.test(lower) ? lower : base36Hash(String(gapId))}`
}

/** Gap subtasks of the Loose ends task tick through `gapId`; every other step is `^ff-s`. */
export function stepBlockId(task: Pick<TaskWithPlan, 'id' | 'auto'>, step: PlannedSubtask): string {
  return task.auto === 'loose-ends' && step.gapId
    ? gapBlockId(step.gapId)
    : blockIdFor('s', task.id, step.id)
}

const YAML_RESERVED = /^(?:true|false|yes|no|on|off|null|~|y|n)$/i

/** Dates, datetimes and plain ids bare; everything else JSON-quoted. */
export function yamlScalar(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null'
  if (typeof v === 'boolean') return String(v)
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?$/.test(s)) return s
  if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(s) && !YAML_RESERVED.test(s) && !/^[-+.]?\d/.test(s)) {
    return s
  }
  return JSON.stringify(s)
}

export function yamlList(values: string[]): string {
  return `[${values.map((v) => JSON.stringify(v)).join(', ')}]`
}

/** Local 'YYYY-MM-DD' from a date key or an ISO string; null when unparseable. */
export function localDateOf(s: string | null | undefined): string | null {
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 'YYYY-MM-DD' plus n days (local calendar). */
export function addDays(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00`)
  d.setDate(d.getDate() + n)
  return localDateOf(d.toISOString()) as string
}

/** Phase 3's "(label, 10 Nov)" citation, with the label escaped for a note. */
export function renderCitation(s: DigestSource): string {
  return renderDigestCitation({
    label: escapeInline(s.label),
    date: localDateOf(s.date) ?? undefined
  })
}

/** Citation for the first source, or ''. */
export function citeFirst(sources: DigestSource[] | undefined): string {
  return sources && sources[0] ? renderCitation(sources[0]) : ''
}

/** "45 min", "3 h", "1 h 30 min". */
export function formatMinutes(m: number): string {
  const total = Math.max(0, Math.round(m))
  const h = Math.floor(total / 60)
  const min = total % 60
  if (h === 0) return `${min} min`
  return min === 0 ? `${h} h` : `${h} h ${min} min`
}

/**
 * Frontmatter label for a source ref: vault notes as `[[Folder/Note]]`
 * (plus `#Heading`), home paths as `~/…`, anything else as given.
 */
export function sourceLabel(ref: string, ctx: { home?: string; vaultRoot?: string }): string {
  const { path: p, heading } = splitSourceRef(ref)
  const under = (root: string | undefined): string | null => {
    if (!root) return null
    const r = path.resolve(root)
    const x = path.resolve(p)
    return x === r ? '' : x.startsWith(r + path.sep) ? x.slice(r.length + 1) : null
  }
  const inVault = under(ctx.vaultRoot)
  if (inVault !== null && inVault !== '') {
    const note = inVault.split(path.sep).join('/').replace(/\.md$/i, '')
    return `[[${note}${heading ? `#${heading}` : ''}]]`
  }
  const inHome = under(ctx.home)
  const shown = inHome !== null ? (inHome ? `~/${inHome.split(path.sep).join('/')}` : '~') : p
  return heading ? `${shown}#${heading}` : shown
}
