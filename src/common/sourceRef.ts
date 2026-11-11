// src/common/sourceRef.ts
// Item source references. A source is an absolute path, or a section of a
// Markdown note written as `<abs path to .md>#<heading text>`. Kept in its
// own file (re-exported from workstreams.ts) so the path guard can use it
// without pulling in the item model.

const SECTION_MARK = /\.md#/i

/** Splits `<path>.md#<heading>` at the FIRST `.md#`. Anything else is a plain path. */
export function splitSourceRef(ref: string): { path: string; heading?: string } {
  const m = SECTION_MARK.exec(ref)
  if (!m) return { path: ref }
  const cut = m.index + 3 // keep '.md' on the path
  const heading = ref.slice(cut + 1)
  return heading ? { path: ref.slice(0, cut), heading } : { path: ref.slice(0, cut) }
}

/** Builds a source ref; a heading is only attached to `.md` paths. */
export function formatSourceRef(path: string, heading?: string): string {
  const h = heading?.trim()
  if (!h || !/\.md$/i.test(path)) return path
  return `${path}#${h}`
}
