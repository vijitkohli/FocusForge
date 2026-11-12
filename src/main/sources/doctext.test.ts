import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PathGuard } from './guard'
import { createDocText, type DocTextEngine } from './doctext'

let tmp: string
let uni: string
let cache: string

function guard(): PathGuard {
  return new PathGuard({
    sourceRoots: [uni],
    vaultRoots: [],
    readableVault: null,
    writableRoots: [cache],
    caseInsensitive: true
  })
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-doctext-')))
  uni = path.join(tmp, 'UNI')
  cache = path.join(tmp, 'flow', 'cache')
  fs.mkdirSync(path.join(uni, 'c'), { recursive: true })
  fs.mkdirSync(cache, { recursive: true })
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function counting(
  reply: { text?: string; error?: string } | Error = { text: 'extracted' }
): DocTextEngine & { calls: number } {
  const fn = (async () => {
    fn.calls++
    if (reply instanceof Error) throw reply
    return reply
  }) as unknown as DocTextEngine & { calls: number }
  fn.calls = 0
  return fn
}

const meta = (p: string): { mtimeMs: number; size: number } => {
  const st = fs.statSync(p)
  return { mtimeMs: st.mtimeMs, size: st.size }
}

describe('doctext', () => {
  it('cache hit skips the engine', async () => {
    const f = path.join(uni, 'c', 'spec.pdf')
    fs.writeFileSync(f, '%PDF-1.4 one')
    const engine = counting()
    const doc = createDocText({ guard: guard, engine, cacheDir: cache })
    expect((await doc(f, 'pdf', meta(f)))?.text).toBe('extracted')
    expect((await doc(f, 'pdf', meta(f)))?.text).toBe('extracted')
    expect(engine.calls).toBe(1)
    // mtime-only change: same bytes -> no engine call
    const t = new Date('2026-11-01T00:00:00')
    fs.utimesSync(f, t, t)
    expect((await doc(f, 'pdf', meta(f)))?.text).toBe('extracted')
    expect(engine.calls).toBe(1)
  })

  it('changed hash calls the engine once', async () => {
    const f = path.join(uni, 'c', 'brief.docx')
    fs.writeFileSync(f, 'v1')
    const engine = counting()
    const doc = createDocText({ guard: guard, engine, cacheDir: cache })
    await doc(f, 'docx', meta(f))
    fs.writeFileSync(f, 'v2 changed')
    await doc(f, 'docx', meta(f))
    await doc(f, 'docx', meta(f))
    expect(engine.calls).toBe(2)
  })

  it('oversize files are skipped', async () => {
    const f = path.join(uni, 'c', 'huge.pdf')
    fs.writeFileSync(f, 'x'.repeat(2000))
    const engine = counting()
    const doc = createDocText({ guard: guard, engine, cacheDir: cache, maxBytes: 1000 })
    expect(await doc(f, 'pdf', meta(f))).toBeNull()
    expect(engine.calls).toBe(0)
  })

  it('engine error yields null without throwing', async () => {
    const f = path.join(uni, 'c', 'bad.pdf')
    fs.writeFileSync(f, 'nope')
    expect(
      await createDocText({
        guard: guard,
        engine: counting({ error: 'unreadable' }),
        cacheDir: cache
      })(f, 'pdf', meta(f))
    ).toBeNull()
    expect(
      await createDocText({ guard: guard, engine: counting(new Error('boom')), cacheDir: cache })(
        f,
        'pdf',
        meta(f)
      )
    ).toBeNull()
  })

  it('denied paths never reach the engine', async () => {
    const f = path.join(uni, 'c', 'secret_brief.pdf')
    fs.writeFileSync(f, 'x')
    const engine = counting()
    expect(
      await createDocText({ guard: guard, engine, cacheDir: cache })(f, 'pdf', meta(f))
    ).toBeNull()
    expect(engine.calls).toBe(0)
  })
})
