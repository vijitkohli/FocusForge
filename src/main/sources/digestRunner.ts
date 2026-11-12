// src/main/sources/digestRunner.ts
// Builds the `digest` engine payload from a pack and runs engine/digest.py.
// The payload carries labels and excerpts only (never absolute paths); the
// engine's reply is re-validated by normalizeDigest before it is stored.
import type { ContextPack } from '../../common/readers'
import {
  DIGEST_PROMPT_VERSION,
  DIGEST_VERSION,
  digestCore,
  type DigestCore,
  type ItemDigest
} from '../../common/digest'
import type { Workstream } from '../../common/types'
import type { EngineCall, EngineCallRegistry } from '../engine'
import { packToDigestInput, type DigestInputFile } from './packPrompt'

export type DigestErrorCode =
  | 'proxy-down'
  | 'rate-limited'
  | 'auth'
  | 'timeout'
  | 'invalid'
  | 'model-error'
  | 'cancelled'

export interface DigestPayload {
  mode: 'digest'
  promptVersion: number
  model: string
  today: string
  item: { name: string; category: string; kind: string }
  full: boolean
  targetChars: [number, number]
  previous: DigestCore | null
  changedIds: string[]
  files: DigestInputFile[]
  git: { id: string; label: string; text: string }[]
  index: string
}

export type DigestRunResult =
  | { ok: true; raw: unknown; repaired: boolean; warnings: string[] }
  | { ok: false; error: DigestErrorCode }

export interface DigestRunner {
  run(itemId: string, payload: DigestPayload, timeoutMs: number): Promise<DigestRunResult>
  cancel(itemId: string): void
  cancelAll(): void
}

export const FULL_TIMEOUT_MS = 150_000
export const INCREMENTAL_TIMEOUT_MS = 90_000
const MAX_AGE_MS = 7 * 86_400_000
const MAX_INCREMENTAL_RUNS = 8

/** Summary length scales with the pack: [clamp(25% of pack chars, 1.5K, 6K), up to 10K]. */
export function targetChars(packChars: number): [number, number] {
  const min = Math.min(6_000, Math.max(1_500, Math.round(packChars * 0.25)))
  return [min, Math.min(10_000, Math.round((min * 5) / 3))]
}

/** Full when there is no usable previous digest, it's old, drifted, or most of the pack changed. */
export function chooseMode(
  prev: ItemDigest | null,
  pack: ContextPack,
  nowMs: number
): 'full' | 'incremental' {
  if (!prev || !prev.basis) return 'full'
  if (prev.version !== DIGEST_VERSION || prev.promptVersion !== DIGEST_PROMPT_VERSION) return 'full'
  const age = nowMs - Date.parse(prev.generatedAt)
  if (!Number.isFinite(age) || age > MAX_AGE_MS) return 'full'
  if (prev.incrementalSinceFull >= MAX_INCREMENTAL_RUNS) return 'full'
  const total = pack.files.reduce((s, f) => s + f.chars, 0)
  const changed = pack.files
    .filter((f) => prev.basis!.files[f.label] !== f.hash)
    .reduce((s, f) => s + f.chars, 0)
  if (total > 0 && changed / total > 0.4) return 'full'
  return 'incremental'
}

export function buildDigestPayload(
  item: Pick<Workstream, 'name' | 'category' | 'kind'>,
  pack: ContextPack,
  prev: ItemDigest | null,
  o: { model: string; today: string; full: boolean }
): { payload: DigestPayload; sentIds: string[] } {
  const input = packToDigestInput(pack, {
    mode: o.full ? 'full' : 'incremental',
    maxChars: pack.budget.maxChars,
    basis: prev?.basis
  })
  return {
    payload: {
      mode: 'digest',
      promptVersion: DIGEST_PROMPT_VERSION,
      model: o.model,
      today: o.today,
      item: { name: item.name, category: item.category, kind: item.kind },
      full: o.full,
      targetChars: targetChars(pack.totalChars),
      previous: !o.full && prev ? digestCore(prev) : null,
      changedIds: input.changedIds,
      files: input.files,
      git: input.git,
      index: input.index
    },
    sentIds: input.sentIds
  }
}

const ERROR_CODES = new Set<DigestErrorCode>([
  'proxy-down',
  'rate-limited',
  'auth',
  'timeout',
  'invalid',
  'model-error'
])

/** Maps the engine's JSON reply to a run result. */
export function parseEngineReply(reply: unknown): DigestRunResult {
  const r = (reply && typeof reply === 'object' ? reply : {}) as Record<string, unknown>
  if (r.status === 'ok' && r.digest && typeof r.digest === 'object') {
    return {
      ok: true,
      raw: r.digest,
      repaired: r.repaired === true,
      warnings: Array.isArray(r.warnings)
        ? r.warnings.filter((w): w is string => typeof w === 'string').slice(0, 20)
        : []
    }
  }
  const code =
    typeof r.error === 'string' && ERROR_CODES.has(r.error as DigestErrorCode)
      ? (r.error as DigestErrorCode)
      : 'model-error'
  return { ok: false, error: code }
}

/**
 * Runs digest.py through the shared engine runner. Each item's call is
 * tracked under `digest:<itemId>`, so cancel() kills that process.
 */
export function engineDigestRunner(
  spawn: (payload: DigestPayload, timeoutMs: number) => EngineCall,
  registry: EngineCallRegistry,
  isCancelled: (e: unknown) => boolean,
  isTimeout: (e: unknown) => boolean
): DigestRunner {
  return {
    async run(itemId, payload, timeoutMs) {
      const call = registry.track(`digest:${itemId}`, spawn(payload, timeoutMs))
      try {
        return parseEngineReply(await call.promise)
      } catch (e) {
        if (isCancelled(e)) return { ok: false, error: 'cancelled' }
        if (isTimeout(e)) return { ok: false, error: 'timeout' }
        return { ok: false, error: 'model-error' }
      }
    },
    cancel(itemId) {
      registry.cancel(`digest:${itemId}`)
    },
    cancelAll() {
      registry.cancelAll()
    }
  }
}
