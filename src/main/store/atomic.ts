import fs from 'fs-extra'
import path from 'path'
import { randomBytes } from 'crypto'

function tempPathFor(target: string, tempDir?: string): string {
  const tag = `${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  // In a shared temp folder the name stays short (a long note name plus the
  // suffix could pass the 255-byte limit) and can't be mistaken for a note.
  return tempDir ? path.join(tempDir, `ff-${tag}`) : `${target}.${tag}`
}

/** The fs calls writeFileAtomic makes. VaultFs injects its own so every vault call is traceable. */
export interface AtomicFs {
  mkdir(p: string, opts: { recursive: true }): Promise<unknown>
  open(
    p: string,
    flags: 'w'
  ): Promise<{
    writeFile(data: string, enc: 'utf-8'): Promise<void>
    sync(): Promise<void>
    close(): Promise<void>
  }>
  rename(from: string, to: string): Promise<void>
  unlink(p: string): Promise<void>
}

// Methods look fs-extra up at call time, so tests can spy on it.
const defaultAtomicFs: AtomicFs = {
  mkdir: (p) => fs.ensureDir(p),
  open: (p, flags) => fs.promises.open(p, flags),
  rename: (a, b) => fs.rename(a, b),
  unlink: (p) => fs.remove(p)
}

export interface AtomicWriteOptions {
  /**
   * Folder for the temp file instead of beside the target. It must be on the
   * same volume so the rename stays atomic (vault notes use
   * `<vault>/FocusForge/.tmp.nosync`, which iCloud doesn't sync).
   */
  tempDir?: string
  /**
   * Runs after the temp file is synced, just before the rename. Returning
   * false aborts: the temp file is removed and the target is left as it was.
   */
  beforeRename?: () => Promise<boolean>
  fsImpl?: AtomicFs
}

/**
 * Writes `data` to a temp file beside `target` (or in `tempDir`), fsyncs it,
 * then renames it over the target. A rename on one volume is atomic, so a
 * crash or sleep mid-write leaves either the old file or the new one - never
 * a truncated one. Resolves 'aborted' when `beforeRename` said no.
 */
export async function writeFileAtomic(
  target: string,
  data: string,
  opts: AtomicWriteOptions = {}
): Promise<'written' | 'aborted'> {
  const io = opts.fsImpl ?? defaultAtomicFs
  await io.mkdir(path.dirname(target), { recursive: true })
  if (opts.tempDir) await io.mkdir(opts.tempDir, { recursive: true })
  const temp = tempPathFor(target, opts.tempDir)
  try {
    const handle = await io.open(temp, 'w')
    try {
      await handle.writeFile(data, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (opts.beforeRename && !(await opts.beforeRename())) {
      await io.unlink(temp).catch(() => undefined)
      return 'aborted'
    }
    await io.rename(temp, target)
    return 'written'
  } catch (error) {
    await io.unlink(temp).catch(() => undefined)
    throw error
  }
}

export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await writeFileAtomic(target, JSON.stringify(value, null, 2) + '\n')
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
