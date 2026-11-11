// src/main/sources/match.ts
// Pure name matching for discovery: folder names, vault note names, list-note
// headings and registry entries. Deterministic; no model calls.
import { courseCode } from '../../common/workstreams'

export { courseCode }

const STOPWORDS = new Set(['the', 'and', 'of'])

/**
 * NFC -> lowercase -> strip `.md` -> strip a trailing ` hub` -> cut at ` - `
 * -> strip non-alphanumerics. `COMP9321 - Course Notes.md` -> 'comp9321',
 * `Thesis Hub` -> 'thesis', `personal-website` -> 'personalwebsite'.
 */
export function normalizeKey(s: string): string {
  let k = s.normalize('NFC').toLowerCase().trim()
  k = k.replace(/\.md$/, '').trim()
  k = k.replace(/\s+hub$/, '')
  const cut = k.indexOf(' - ')
  if (cut > 0) k = k.slice(0, cut)
  return k.replace(/[^\p{L}\p{N}]/gu, '')
}

/** Name words: camelCase and non-alphanumerics split, lowercased, stopwords dropped. */
export function tokens(s: string): string[] {
  return s
    .normalize('NFC')
    .replace(/\.md$/i, '')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !STOPWORDS.has(t))
}

/**
 * Two course codes with the same digits whose letters differ by one
 * substitution or one adjacent transposition (`pscy1023` ~ `psyc1023`).
 */
export function similarCode(a: string, b: string): boolean {
  if (a === b || a.length !== b.length) return false
  const la = a.slice(0, 4)
  const lb = b.slice(0, 4)
  if (a.slice(4) !== b.slice(4)) return false
  const diffs: number[] = []
  for (let i = 0; i < la.length; i++) if (la[i] !== lb[i]) diffs.push(i)
  if (diffs.length === 1) return true
  if (diffs.length === 2 && diffs[1] === diffs[0] + 1) {
    const [i, j] = diffs
    return la[i] === lb[j] && la[j] === lb[i]
  }
  return false
}

function tokenCovers(short: string[], long: string[]): boolean {
  if (short.length === 0) return false
  let strong = false
  for (const s of short) {
    const hit = long.find(
      (l) => l === s || (Math.min(s.length, l.length) >= 3 && (l.startsWith(s) || s.startsWith(l)))
    )
    if (!hit) return false
    if (Math.min(s.length, hit.length) >= 4) strong = true
  }
  return strong
}

export type MatchKind = 'code' | 'exact' | 'similar' | 'tokens'
export const MATCH_SCORE: Record<MatchKind, number> = { code: 4, exact: 3, similar: 2, tokens: 1 }

/**
 * Rules in order (first hit wins): equal course codes; equal normalised keys;
 * course codes one letter off; every word of the shorter name matches or
 * prefix-matches a word of the other. Coded names never match by words, and
 * two different codes never match at all.
 */
export function matchNames(a: string, b: string): { kind: MatchKind; score: number } | null {
  const ca = courseCode(a)
  const cb = courseCode(b)
  const hit = (kind: MatchKind): { kind: MatchKind; score: number } => ({
    kind,
    score: MATCH_SCORE[kind]
  })
  if (ca && cb) {
    if (ca === cb) return hit('code')
    if (similarCode(ca, cb)) return hit('similar')
    return null
  }
  const ka = normalizeKey(a)
  if (ka && ka === normalizeKey(b)) return hit('exact')
  if (ca || cb) return null
  const ta = tokens(a)
  const tb = tokens(b)
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  if (tokenCovers(short, long) || (ta.length === tb.length && tokenCovers(long, short))) {
    return hit('tokens')
  }
  return null
}

/** Best match between any name on one side and any on the other. */
export function bestMatch(as: string[], bs: string[]): { kind: MatchKind; score: number } | null {
  let best: { kind: MatchKind; score: number } | null = null
  for (const a of as) {
    for (const b of bs) {
      const m = matchNames(a, b)
      if (m && (!best || m.score > best.score)) best = m
    }
  }
  return best
}

/**
 * Greedy one-to-one-per-left assignment by descending score. Each left item
 * gets at most one right item; a right item may take several lefts unless
 * `exclusive` is set. Ties keep input order.
 */
export function assignGreedy<L, R>(
  lefts: L[],
  rights: R[],
  score: (l: L, r: R) => number,
  exclusive = false
): { left: L; right: R; score: number }[] {
  const pairs: { li: number; ri: number; score: number }[] = []
  lefts.forEach((l, li) =>
    rights.forEach((r, ri) => {
      const s = score(l, r)
      if (s > 0) pairs.push({ li, ri, score: s })
    })
  )
  pairs.sort((x, y) => y.score - x.score || x.li - y.li || x.ri - y.ri)
  const usedL = new Set<number>()
  const usedR = new Set<number>()
  const out: { left: L; right: R; score: number }[] = []
  for (const p of pairs) {
    if (usedL.has(p.li) || (exclusive && usedR.has(p.ri))) continue
    usedL.add(p.li)
    usedR.add(p.ri)
    out.push({ left: lefts[p.li], right: rights[p.ri], score: p.score })
  }
  return out
}

/**
 * Sibling merges: a folder named `<a>-*` or `<a>_*`, where `<a>` is another
 * folder, merges into `<a>` (longest prefix wins, chains resolve to the top).
 * Returns child key -> parent key.
 */
export function planMerges(folders: { key: string; name: string }[]): Map<string, string> {
  const direct = new Map<string, string>()
  for (const b of folders) {
    const bn = b.name.normalize('NFC').toLowerCase()
    let best: { key: string; len: number } | null = null
    for (const a of folders) {
      if (a.key === b.key) continue
      const an = a.name.normalize('NFC').toLowerCase()
      if (!an || an === bn) continue
      if ((bn.startsWith(`${an}-`) || bn.startsWith(`${an}_`)) && (!best || an.length > best.len)) {
        best = { key: a.key, len: an.length }
      }
    }
    if (best) direct.set(b.key, best.key)
  }
  const out = new Map<string, string>()
  for (const child of direct.keys()) {
    let top = direct.get(child)!
    const seen = new Set([child])
    while (direct.has(top) && !seen.has(top)) {
      seen.add(top)
      top = direct.get(top)!
    }
    out.set(child, top)
  }
  return out
}
