// src/main/planning/packSource.ts
//
// Where the planner gets an item's context (SYNC_PLAN contract 1):
// getContextPack(itemId) -> { pack, digest, text } using Phase 3's types.
//   - Phase 3's reader registers its source with registerPackSource() once it lands;
//   - until then, FOCUSFORGE_PACK_FIXTURES=<dir> serves <dir>/<itemId>.json
//     ({ pack, digest }) for dev and QA (engine/evals/fixture_pack.py --out <dir>);
//   - otherwise there is no pack and plans fall back to the ledger.

import fs from 'fs-extra'
import path from 'path'
import type { ContextPack } from '../../common/readers'
import type { ItemDigest } from '../../common/digest'
import { packToPromptText } from '../sources/packPrompt'

export interface PackBundle {
  pack: ContextPack
  digest: ItemDigest | null
  text: string
}

export interface PackSource {
  getContextPack(itemId: string): Promise<PackBundle | null>
}

export const PACK_PROMPT_CHARS = 120_000

export class NullPackSource implements PackSource {
  async getContextPack(): Promise<PackBundle | null> {
    return null
  }
}

const SAFE_ID = /^[A-Za-z0-9 _.-]+$/

export class FixturePackSource implements PackSource {
  constructor(private dir: string) {}

  async getContextPack(itemId: string): Promise<PackBundle | null> {
    if (!SAFE_ID.test(itemId) || itemId.includes('..')) return null
    const file = path.join(this.dir, `${itemId}.json`)
    try {
      if (!(await fs.pathExists(file))) return null
      const raw = await fs.readJSON(file)
      const pack = raw?.pack as ContextPack | undefined
      if (!pack || !Array.isArray(pack.files)) return null
      const digest = (raw.digest ?? null) as ItemDigest | null
      return { pack, digest, text: packToPromptText(pack, { maxChars: PACK_PROMPT_CHARS }) }
    } catch (err) {
      console.error('Fixture pack unreadable', err)
      return null
    }
  }
}

/** The subset of Phase 3's PackStore (src/main/sources/packStore.ts) the planner reads. */
export interface PackStoreLike {
  readPack(id: string): Promise<ContextPack | null>
  readDigest(id: string): Promise<ItemDigest | null>
}

/**
 * Phase 3's stored pack + digest. Wire on merge with:
 *   registerPackSource(new StorePackSource(initReaders().store, packToPromptText))
 * (packToPromptText from src/main/sources/packPrompt.ts).
 */
export class StorePackSource implements PackSource {
  constructor(
    private store: PackStoreLike,
    private toText: (pack: ContextPack, o: { maxChars?: number }) => string = packToPromptText
  ) {}

  async getContextPack(itemId: string): Promise<PackBundle | null> {
    const pack = await this.store.readPack(itemId)
    if (!pack) return null
    const digest = await this.store.readDigest(itemId)
    return { pack, digest, text: this.toText(pack, { maxChars: PACK_PROMPT_CHARS }) }
  }
}

let registered: PackSource | null = null

/** Phase 3's reader calls this at startup; it then wins over fixtures. */
export function registerPackSource(source: PackSource | null): void {
  registered = source
}

export function resolvePackSource(env: NodeJS.ProcessEnv = process.env): PackSource {
  if (registered) return registered
  const dir = env.FOCUSFORGE_PACK_FIXTURES
  if (dir) return new FixturePackSource(dir)
  return new NullPackSource()
}
