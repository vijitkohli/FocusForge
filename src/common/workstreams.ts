// src/common/workstreams.ts
// The item model ("workstream" in code): category, kind, status and sources
// on a registry entry. Pure; shared by main and renderer.
import type {
  ProjectSummary,
  Workstream,
  WorkstreamKind,
  WorkstreamPatch,
  WorkstreamStatus
} from './types'

export { splitSourceRef, formatSourceRef } from './sourceRef'

/** The four fixed categories, in display order (Library, approval screen). */
export const CATEGORIES = ['Learning', 'Career', 'Projects', 'Life'] as const
export type ItemCategory = (typeof CATEGORIES)[number]
export const CATEGORY_ORDER: readonly ItemCategory[] = CATEGORIES

export const WORKSTREAM_KINDS: readonly WorkstreamKind[] = ['deadline', 'passion', 'ongoing']
export const WORKSTREAM_STATUSES: readonly WorkstreamStatus[] = ['active', 'paused', 'archived']

/**
 * First-run slice: only suggestions matching these match keys (normalised
 * names or course codes, never paths) start checked and active. Overridable
 * via settings.initialActiveKeys. Re-exported from src/main/sources/slice.ts.
 */
export const DEFAULT_INITIAL_ACTIVE: readonly string[] = [
  'thesis',
  'comp9321',
  'psyc1023',
  'personalwebsite',
  'focusforge'
]

export function isItemCategory(v: unknown): v is ItemCategory {
  return typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v)
}
export function isWorkstreamKind(v: unknown): v is WorkstreamKind {
  return typeof v === 'string' && (WORKSTREAM_KINDS as readonly string[]).includes(v)
}
export function isWorkstreamStatus(v: unknown): v is WorkstreamStatus {
  return typeof v === 'string' && (WORKSTREAM_STATUSES as readonly string[]).includes(v)
}

const COURSE_CODE = /(?<![a-z0-9])([a-z]{4})[ _-]?(\d{4})(?![0-9])/i

/** `COMP9321 - Course Notes` -> 'comp9321'; null when there's no 4-letter + 4-digit code. */
export function courseCode(s: string): string | null {
  const m = COURSE_CODE.exec(s.normalize('NFC'))
  return m ? `${m[1]}${m[2]}`.toLowerCase() : null
}

/** Learning for course codes and theses, otherwise Projects. */
export function defaultCategoryFor(name: string): ItemCategory {
  return courseCode(name) || /thesis/i.test(name) ? 'Learning' : 'Projects'
}

/** Fills and coerces the item fields; other fields pass through untouched. */
export function withWorkstreamDefaults(s: ProjectSummary): Workstream {
  const name = typeof s.name === 'string' ? s.name : String(s.id ?? '')
  return {
    ...s,
    category: isItemCategory(s.category) ? s.category : defaultCategoryFor(name || s.id),
    kind: isWorkstreamKind(s.kind) ? s.kind : 'ongoing',
    status: isWorkstreamStatus(s.status) ? s.status : 'active',
    sources: Array.isArray(s.sources)
      ? [...new Set(s.sources.filter((x): x is string => typeof x === 'string' && x !== ''))]
      : []
  }
}

/**
 * Keeps only well-formed keys of an untrusted patch (IPC input). Names are
 * trimmed and capped; sources are de-duplicated strings (the guard check is
 * the caller's job).
 */
export function sanitizeWorkstreamPatch(raw: unknown): WorkstreamPatch {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: WorkstreamPatch = {}
  if (typeof r.name === 'string' && r.name.trim()) out.name = r.name.trim().slice(0, 120)
  if (isItemCategory(r.category)) out.category = r.category
  if (isWorkstreamKind(r.kind)) out.kind = r.kind
  if (isWorkstreamStatus(r.status)) out.status = r.status
  if (Array.isArray(r.sources)) {
    out.sources = [
      ...new Set(r.sources.filter((x): x is string => typeof x === 'string' && x.trim() !== ''))
    ]
  }
  return out
}

/** Items grouped in CATEGORY_ORDER; every category is present (possibly empty). */
export function groupByCategory<T extends ProjectSummary>(
  list: T[]
): { category: ItemCategory; items: T[] }[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    items: list.filter((p) => withWorkstreamDefaults(p).category === category)
  }))
}

/**
 * Registry/folder id from a name: same `[^a-z0-9]` -> `_` rule as before,
 * then `_2`, `_3`... Compared case-insensitively, because the data folder may
 * live on a case-insensitive filesystem.
 */
export function uniqueProjectId(name: string, taken: Set<string>): string {
  const base = name.replace(/[^a-z0-9]/gi, '_') || 'item'
  const lower = new Set([...taken].map((t) => t.toLowerCase()))
  if (!lower.has(base.toLowerCase())) return base
  for (let i = 2; ; i++) {
    const id = `${base}_${i}`
    if (!lower.has(id.toLowerCase())) return id
  }
}

/** Folder name -> display name: `comp9321` -> 'COMP9321', `garden-planner` -> 'Garden Planner'. */
export function displayNameFor(folderName: string): string {
  const name = folderName.normalize('NFC').trim()
  const code = courseCode(name)
  if (code && name.replace(/[^a-z0-9]/gi, '').toLowerCase() === code) return code.toUpperCase()
  const spaced = /[-_]/.test(name) || name === name.toLowerCase()
  if (!spaced) return name
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => {
      const c = courseCode(w)
      if (c && w.toLowerCase() === c) return c.toUpperCase()
      return w.charAt(0).toUpperCase() + w.slice(1)
    })
    .join(' ')
}

/** Characters Obsidian or the filesystem won't take in a note or folder name. */
function safeNoteName(name: string): string {
  const s = name
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
    .trim()
  return s || 'Untitled'
}

/** Vault-relative note path for an item (written in Phase 4): `FocusForge/<Category>/<Name>/<Name>.md`. */
export function vaultNotePathFor(ws: { name: string; category?: string }): string {
  const category = isItemCategory(ws.category) ? ws.category : defaultCategoryFor(ws.name)
  const n = safeNoteName(ws.name)
  return `FocusForge/${category}/${n}/${n}.md`
}
