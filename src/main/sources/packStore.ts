// src/main/sources/packStore.ts
// Pack, digest and digest history for one item, under the FlowState data
// folder (`<item>/reader/`). Writes are atomic and serialised per item under
// the `reader:<id>` lock; no other lock is taken inside it.
import fs from 'fs-extra'
import path from 'path'
import { PACK_VERSION, type ContextPack } from '../../common/readers'
import { isItemDigest, type ItemDigest } from '../../common/digest'
import { writeJsonAtomic } from '../store/atomic'
import { withLock } from '../store/locks'

export const DIGEST_HISTORY_KEEP = 5

export interface PackStore {
  readPack(id: string): Promise<ContextPack | null>
  writePack(id: string, pack: ContextPack): Promise<void>
  readDigest(id: string): Promise<ItemDigest | null>
  /** Writes the digest and moves the previous one into history (newest 5 kept). */
  writeDigest(id: string, digest: ItemDigest): Promise<void>
}

export interface PackStoreOptions {
  /** `<ROOT_DIR>/<id>/reader` in the app. */
  readerDir: (id: string) => string
  /** Defence in depth: refuse writes outside the app's data folder. */
  canWrite?: (absPath: string) => boolean
  now?: () => Date
}

const SAFE_ID = /^[^/\\\0]+$/

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function createPackStore(o: PackStoreOptions): PackStore {
  const dir = (id: string): string => {
    if (!SAFE_ID.test(id) || id === '.' || id === '..') throw new Error('bad item id')
    return o.readerDir(id)
  }
  const assertWritable = (p: string): void => {
    if (o.canWrite && !o.canWrite(p)) throw new Error('reader write refused')
  }
  const readJson = async (p: string): Promise<unknown> => {
    try {
      return await fs.readJSON(p)
    } catch {
      return null
    }
  }

  return {
    async readPack(id) {
      const raw = (await readJson(path.join(dir(id), 'pack.json'))) as ContextPack | null
      return raw && raw.version === PACK_VERSION && Array.isArray(raw.files) ? raw : null
    },
    async writePack(id, pack) {
      const target = path.join(dir(id), 'pack.json')
      return withLock(`reader:${id}`, async () => {
        assertWritable(target)
        await writeJsonAtomic(target, pack)
      })
    },
    async readDigest(id) {
      const raw = await readJson(path.join(dir(id), 'digest.json'))
      return isItemDigest(raw) ? raw : null
    },
    async writeDigest(id, digest) {
      const base = dir(id)
      const target = path.join(base, 'digest.json')
      const history = path.join(base, 'digests')
      return withLock(`reader:${id}`, async () => {
        assertWritable(target)
        if (await fs.pathExists(target)) {
          const at = path.join(history, `${stamp((o.now ?? (() => new Date()))())}.json`)
          assertWritable(at)
          await fs.ensureDir(history)
          await fs.copy(target, at, { overwrite: true }).catch(() => undefined)
          const old = (await fs.readdir(history)).filter((f) => f.endsWith('.json')).sort()
          for (const f of old.slice(0, Math.max(0, old.length - DIGEST_HISTORY_KEEP))) {
            await fs.remove(path.join(history, f)).catch(() => undefined)
          }
        }
        await writeJsonAtomic(target, digest)
      })
    }
  }
}
