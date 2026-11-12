// src/main/sources/doctext.ts
// PDF/docx text for the context pack. The guard reads the bytes; a local
// Python process (engine/doctext.py, no network) turns them into text, so
// Python never opens an owner path. Results are cached by a hash of the
// folded path, so the engine only runs when a document actually changed.
import { createHash } from 'crypto'
import fs from 'fs-extra'
import path from 'path'
import type { PathGuard } from './guard'
import { writeJsonAtomic } from '../store/atomic'

export const DOCTEXT_CACHE_VERSION = 1

export type DocKind = 'pdf' | 'docx'

export interface DocTextRequest {
  kind: DocKind
  data_b64: string
  max_chars: number
}

/** Runs engine/doctext.py once. */
export type DocTextEngine = (
  req: DocTextRequest,
  timeoutMs: number
) => Promise<{ text?: string; error?: string }>

/** Text of one document (already capped), or null when unreadable / too big / failed. */
export type DocTextFn = (
  absPath: string,
  kind: DocKind,
  meta: { mtimeMs: number; size: number }
) => Promise<{ text: string; hash: string; bytesRead: number } | null>

interface CacheEntry {
  ver: number
  mtimeMs: number
  size: number
  hash: string
  text: string
}

export interface DocTextOptions {
  guard: () => PathGuard | Promise<PathGuard>
  engine: DocTextEngine
  cacheDir: string
  maxBytes?: number
  maxChars?: number
  timeoutMs?: number
}

/**
 * Builds the doc-text function. One engine process at a time; a cache hit
 * (same mtime and size, or same content hash) never spawns it.
 */
export function createDocText(o: DocTextOptions): DocTextFn {
  const maxBytes = o.maxBytes ?? 15 * 1024 * 1024
  const maxChars = o.maxChars ?? 15_000
  const timeoutMs = o.timeoutMs ?? 30_000
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => undefined)
    return run
  }

  return async (absPath, kind, meta) => {
    if (meta.size > maxBytes) return null
    const guard = await o.guard()
    if (!guard.check(absPath).ok) return null
    const key = createHash('sha1').update(guard.fold(absPath)).digest('hex')
    const cachePath = path.join(o.cacheDir, `${key}.json`)
    let cached: CacheEntry | null = null
    try {
      const raw = (await fs.readJSON(cachePath)) as CacheEntry
      if (raw && raw.ver === DOCTEXT_CACHE_VERSION && typeof raw.text === 'string') cached = raw
    } catch {
      // no cache yet
    }
    if (cached && cached.mtimeMs === meta.mtimeMs && cached.size === meta.size) {
      return { text: cached.text, hash: cached.hash, bytesRead: 0 }
    }
    const bytes = await guard.readBytes(absPath, maxBytes)
    if (!bytes) return null
    const hash = createHash('sha256').update(bytes).digest('hex')
    const save = async (text: string): Promise<void> => {
      const entry: CacheEntry = {
        ver: DOCTEXT_CACHE_VERSION,
        mtimeMs: meta.mtimeMs,
        size: meta.size,
        hash,
        text
      }
      if (!guard.canWrite(cachePath)) return
      await writeJsonAtomic(cachePath, entry).catch(() => undefined)
    }
    if (cached && cached.hash === hash) {
      await save(cached.text)
      return { text: cached.text, hash, bytesRead: bytes.length }
    }
    try {
      const res = await serial(() =>
        o.engine({ kind, data_b64: bytes.toString('base64'), max_chars: maxChars }, timeoutMs)
      )
      if (!res || typeof res.text !== 'string' || res.error) return null
      const text = res.text.slice(0, maxChars)
      if (!text.trim()) return null
      await save(text)
      return { text, hash, bytesRead: bytes.length }
    } catch {
      return null
    }
  }
}
