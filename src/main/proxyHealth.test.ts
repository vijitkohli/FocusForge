import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProxyHealth, usesProxy } from './proxyHealth'

const respond = (status: number): typeof fetch =>
  (async () => new Response(null, { status })) as unknown as typeof fetch
const refuse: typeof fetch = (async () => {
  throw new TypeError('fetch failed')
}) as unknown as typeof fetch

afterEach(() => {
  vi.useRealTimers()
})

describe('ProxyHealth', () => {
  it('401 counts as up', async () => {
    expect(await new ProxyHealth({ fetchImpl: respond(401) }).isUp()).toBe(true)
    expect(await new ProxyHealth({ fetchImpl: respond(200) }).isUp()).toBe(true)
  })

  it('refused and timeout count as down', async () => {
    expect(await new ProxyHealth({ fetchImpl: refuse }).isUp()).toBe(false)
    const hang: typeof fetch = ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch
    expect(await new ProxyHealth({ fetchImpl: hang, timeoutMs: 20 }).isUp()).toBe(false)
  })

  it('ttl cache', async () => {
    let t = 0
    let calls = 0
    const f = (async () => (
      calls++,
      new Response(null, { status: 200 })
    )) as unknown as typeof fetch
    const h = new ProxyHealth({ fetchImpl: f, ttlMs: 1000, now: () => t })
    await h.isUp()
    t = 500
    await h.isUp()
    expect(calls).toBe(1)
    t = 1500
    await h.isUp()
    expect(calls).toBe(2)
    expect(h.current()).toEqual({ up: true, checkedAt: new Date(1500).toISOString() })
  })

  it('onChange fires on flips; markDown/markUp', async () => {
    let up = true
    const f = (async () => {
      if (!up) throw new Error('refused')
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch
    const h = new ProxyHealth({ fetchImpl: f })
    expect(h.current()).toEqual({ up: null, checkedAt: null })
    const seen: boolean[] = []
    const off = h.onChange((v) => seen.push(v))
    await h.check() // null -> up counts as a change
    await h.check()
    up = false
    await h.check()
    h.markDown()
    h.markUp()
    off()
    h.markDown()
    expect(seen).toEqual([true, false, true])
  })

  it('startPolling backs off while down and stops cleanly', async () => {
    vi.useFakeTimers()
    let calls = 0
    let up = false
    const f = (async () => {
      calls++
      if (!up) throw new Error('refused')
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch
    const h = new ProxyHealth({ fetchImpl: f })
    const stop = h.startPolling({ upMs: 1000, downMs: [100, 200] })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(199)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toBe(3)
    up = true
    await vi.advanceTimersByTimeAsync(200)
    expect(calls).toBe(4)
    expect(h.current().up).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(5)
    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(5)
  })

  it('usesProxy', () => {
    expect(usesProxy('cliproxy/gemini-3-flash')).toBe(true)
    expect(usesProxy('gpt-4o')).toBe(false)
    expect(usesProxy(undefined)).toBe(false)
  })
})
