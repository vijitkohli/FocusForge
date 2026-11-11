// src/main/sources/slice.ts
// The first-run slice: which suggestions start ticked and active. The list is
// match keys (normalised names / course codes), never paths, so the public
// repo carries nothing personal. settings.initialActiveKeys overrides it.
import { DEFAULT_INITIAL_ACTIVE, courseCode } from '../../common/workstreams'
import { normalizeKey } from './match'

export { DEFAULT_INITIAL_ACTIVE }

/** Match keys a name answers to: its normalised key and its course code. */
export function sliceKeysFor(name: string): string[] {
  const keys = [normalizeKey(name)]
  const code = courseCode(name)
  if (code) keys.push(code)
  return keys.filter(Boolean)
}

/** Whether any of the names (item name, folder names, vault unit names) is in the slice. */
export function inSlice(activeKeys: Iterable<string>, names: string[]): boolean {
  const set = new Set([...activeKeys].map((k) => normalizeKey(k)))
  if (set.size === 0) return false
  return names.some((n) => sliceKeysFor(n).some((k) => set.has(k)))
}
