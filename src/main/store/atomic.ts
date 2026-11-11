import fs from 'fs-extra'
import path from 'path'
import { randomBytes } from 'crypto'

function tempPathFor(target: string): string {
  return `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
}

/**
 * Writes `data` to a temp file beside `target`, fsyncs it, then renames it over
 * the target. A rename within one directory is atomic, so a crash or sleep
 * mid-write leaves either the old file or the new one - never a truncated one.
 */
export async function writeFileAtomic(target: string, data: string): Promise<void> {
  await fs.ensureDir(path.dirname(target))
  const temp = tempPathFor(target)
  try {
    const handle = await fs.promises.open(temp, 'w')
    try {
      await handle.writeFile(data, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temp, target)
  } catch (error) {
    await fs.remove(temp).catch(() => undefined)
    throw error
  }
}

export function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  return writeFileAtomic(target, JSON.stringify(value, null, 2) + '\n')
}

/** Sync variant for the few startup/creation paths that are synchronous. */
export function writeFileAtomicSync(target: string, data: string): void {
  fs.ensureDirSync(path.dirname(target))
  const temp = tempPathFor(target)
  try {
    const fd = fs.openSync(temp, 'w')
    try {
      fs.writeFileSync(fd, data, 'utf-8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temp, target)
  } catch (error) {
    fs.removeSync(temp)
    throw error
  }
}

export function writeJsonAtomicSync(target: string, value: unknown): void {
  writeFileAtomicSync(target, JSON.stringify(value, null, 2) + '\n')
}
