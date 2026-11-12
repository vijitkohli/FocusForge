// src/main/vault/layout.ts
// Where each note lives under FocusForge/, collision names, conflict copies
// and moved notes. Pure (no fs): callers pass listings and file texts in.
import { APP_VAULT_DIR } from '../sources/rules'
import { isItemCategory, defaultCategoryFor, safeNoteName } from '../../common/workstreams'
import { readFrontmatterKeys } from './noteDoc'
import type { NoteKind } from './types'

export const ABOUT_NOTE_REL = `${APP_VAULT_DIR}/About these notes.md`
export const LOOSE_ENDS_NOTE_NAME = 'Loose ends'

const fold = (s: string): string => s.normalize('NFC').toLowerCase()

/** `base`, else `base (2)`, `base (3)`… whichever isn't taken (case-insensitive, as APFS is). */
export function pickName(base: string, takenLower: ReadonlySet<string>): string {
  if (!takenLower.has(fold(base))) return base
  for (let n = 2; ; n++) {
    const name = `${base} (${n})`
    if (!takenLower.has(fold(name))) return name
  }
}

export interface LayoutItem {
  id: string
  name: string
  category?: string
  tasks: { id: string; title: string; auto?: 'loose-ends' }[]
}

/** What the sync state already knows: vault-relative path -> owner. */
export type KnownNotes = Record<string, { itemId: string; taskId?: string; kind: NoteKind }>

export interface PlannedItemNotes {
  /** `FocusForge/<Category>/<Name>` */
  folder: string
  /** `<folder>/<Name>.md` */
  note: string
  /** taskId -> `<folder>/<TaskName>.md` */
  tasks: Record<string, string>
  /** Set when the item was renamed or recategorised: move this folder to `folder` first. */
  moveFrom?: string
}

const dirOf = (rel: string): string => rel.slice(0, rel.lastIndexOf('/'))
const baseOf = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/i, '')

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Note paths for every item (registry order) and its tasks.
 * - An item keeps its folder while the folder still fits its name and
 *   category (`Name` or `Name (n)`); otherwise it gets a new one and `moveFrom`.
 * - Same-name items in one category get `Name (2)` by registry order.
 * - A task keeps its file name once chosen (only the folder part follows a
 *   move); new tasks get a free name, `<Name> (task)` when named like the item.
 * - The Loose ends task's note is `Loose ends.md`.
 * - `reserved` paths (notes of removed tasks, files the app doesn't own) are
 *   never handed to a new note or folder.
 */
export function planNotePaths(
  items: LayoutItem[],
  known: KnownNotes,
  reserved: Iterable<string> = []
): Record<string, PlannedItemNotes> {
  const reservedLower = new Set([...reserved].map(fold))
  const existingFolder = new Map<string, string>()
  const existingTask = new Map<string, string>()
  for (const [rel, rec] of Object.entries(known)) {
    if (rec.kind === 'item') existingFolder.set(rec.itemId, dirOf(rel))
    if (rec.kind === 'task' && rec.taskId) existingTask.set(`${rec.itemId}/${rec.taskId}`, rel)
  }

  const want = (it: LayoutItem): string => {
    const cat = isItemCategory(it.category) ? it.category : defaultCategoryFor(it.name)
    return `${APP_VAULT_DIR}/${cat}/${safeNoteName(it.name)}`
  }

  // Pass 1: items whose folder still fits keep it.
  const takenFolders = new Set<string>()
  for (const r of reservedLower) {
    // A reserved item note keeps its folder out of reach of other items.
    if (r.endsWith('.md') && fold(baseOf(dirOf(r))) === fold(baseOf(r))) takenFolders.add(dirOf(r))
  }
  const folderFor = new Map<string, string>()
  for (const it of items) {
    const prev = existingFolder.get(it.id)
    if (!prev) continue
    const fits = new RegExp(`^${escapeRe(fold(want(it)))}(?: \\(\\d+\\))?$`).test(fold(prev))
    if (fits && !takenFolders.has(fold(prev))) {
      folderFor.set(it.id, prev)
      takenFolders.add(fold(prev))
    }
  }
  // Pass 2: everyone else gets a free name, in registry order.
  for (const it of items) {
    if (folderFor.has(it.id)) continue
    const folder = pickName(want(it), takenFolders)
    folderFor.set(it.id, folder)
    takenFolders.add(fold(folder))
  }

  const out: Record<string, PlannedItemNotes> = {}
  for (const it of items) {
    const folder = folderFor.get(it.id) as string
    const prev = existingFolder.get(it.id)
    const name = baseOf(folder)
    const taken = new Set<string>([fold(name)])
    for (const r of reservedLower) if (dirOf(r) === fold(folder)) taken.add(baseOf(r))
    const tasks: Record<string, string> = {}
    // Chosen task names never change: keep them, re-homed under the current folder.
    for (const t of it.tasks) {
      const rel = existingTask.get(`${it.id}/${t.id}`)
      if (!rel) continue
      const file = baseOf(rel)
      if (taken.has(fold(file))) continue
      tasks[t.id] = `${folder}/${file}.md`
      taken.add(fold(file))
    }
    for (const t of it.tasks) {
      if (tasks[t.id]) continue
      let base = t.auto === 'loose-ends' ? LOOSE_ENDS_NOTE_NAME : safeNoteName(t.title)
      if (fold(base) === fold(name)) base = `${base} (task)`
      const file = pickName(base, taken)
      tasks[t.id] = `${folder}/${file}.md`
      taken.add(fold(file))
    }
    out[it.id] = {
      folder,
      note: `${folder}/${name}.md`,
      tasks,
      ...(prev && prev !== folder ? { moveFrom: prev } : {})
    }
  }
  return out
}

/**
 * iCloud/Obsidian conflict copies in one folder listing: an unknown
 * `<name> <n>.md` whose `<name>.md` is a known note. A known "Week 2.md" is
 * never flagged.
 */
export function findConflictCopies(
  listing: readonly string[],
  knownNames: ReadonlySet<string>
): { copy: string; original: string }[] {
  const known = new Set([...knownNames].map(fold))
  const out: { copy: string; original: string }[] = []
  for (const name of listing) {
    if (known.has(fold(name))) continue
    const m = /^(.*) (\d+)\.md$/i.exec(name)
    if (!m) continue
    const original = `${m[1]}.md`
    if (known.has(fold(original))) out.push({ copy: name, original })
  }
  return out
}

/**
 * A note the owner moved inside FocusForge/: the candidate whose frontmatter
 * carries the same `ff_id` (and `ff_task` for a task note).
 */
export function findMovedNote(
  candidates: readonly { rel: string; text: string }[],
  want: { itemId: string; taskId?: string }
): string | null {
  for (const c of candidates) {
    const fm = readFrontmatterKeys(c.text)
    if (fm.ff_id !== want.itemId) continue
    if (want.taskId ? fm.ff_task === want.taskId : fm.ff_note === 'item' && !fm.ff_task) {
      return c.rel
    }
  }
  return null
}
