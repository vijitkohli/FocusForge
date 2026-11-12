// src/main/proxyHealth.ts
// The one shared CLIProxyAPI health check (cross-phase contract 5). Phase 3
// readers gate background summaries on it, Phase 5's planQueue takes the same
// instance, Phase 6 shows it as the sidebar dot, and packaging's launch check
// reuses it. Create exactly one instance in index.ts and pass it around.
//
// Semantics: any HTTP response (including 401/404) means the proxy is up; a
// refused connection or a 3 s timeout means down. No API key is read or sent.

export type ProxyStatus = 'up' | 'down' | 'unknown' | 'not-used'

export interface ProxyHealthOptions {
  /** Default: FOCUSFORGE_PROXY_URL ?? 'http://localhost:8317/v1/models'. */
  url?: string
  fetchImpl?: typeof fetch
  /** How long a check result is reused by isUp() (default 60 s). */
  ttlMs?: number
  /** Per-check timeout (default 3 s). */
  timeoutMs?: number
  now?: () => number
}

export interface PollOptions {
  /** Interval while up (default 60 s). */
  upMs?: number
  /** Back-off steps while down (default 15 s, 30 s, 60 s, 5 min; the last repeats). */
  downMs?: number[]
}

export const DEFAULT_PROXY_URL = 'http://localhost:8317/v1/models'

/** True when a model id routes through CLIProxyAPI. */
export function usesProxy(model: string | undefined | null): boolean {
  return typeof model === 'string' && model.startsWith('cliproxy/')
}

export class ProxyHealth {
  private readonly url: string
  private readonly fetchImpl: typeof fetch
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly now: () => number
  private up: boolean | null = null
  private checkedAtMs: number | null = null
  private inflight: Promise<boolean> | null = null
  private listeners = new Set<(up: boolean) => void>()

  constructor(o: ProxyHealthOptions = {}) {
    this.url = o.url ?? process.env.FOCUSFORGE_PROXY_URL ?? DEFAULT_PROXY_URL
    this.fetchImpl = o.fetchImpl ?? ((input, init) => fetch(input, init))
    this.ttlMs = o.ttlMs ?? 60_000
    this.timeoutMs = o.timeoutMs ?? 3_000
    this.now = o.now ?? Date.now
  }

  /** Cached result while fresh (ttl), otherwise a new check. */
  async isUp(): Promise<boolean> {
    if (
      this.up !== null &&
      this.checkedAtMs !== null &&
      this.now() - this.checkedAtMs < this.ttlMs
    ) {
      return this.up
    }
    return this.check()
  }

  /** Always checks (concurrent callers share one request). */
  check(): Promise<boolean> {
    if (this.inflight) return this.inflight
    this.inflight = this.probe().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async probe(): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let ok: boolean
    try {
      const res = await this.fetchImpl(this.url, { method: 'GET', signal: controller.signal })
      ok = typeof res?.status === 'number'
      // Drain without reading content into memory.
      void res?.body?.cancel?.().catch?.(() => undefined)
    } catch {
      ok = false
    } finally {
      clearTimeout(timer)
    }
    this.set(ok)
    return ok
  }

  /** Called on a 'proxy-down' outcome from a real call. */
  markDown(): void {
    this.set(false)
  }

  /** Called when a real call succeeded through the proxy. */
  markUp(): void {
    this.set(true)
  }

  private set(up: boolean): void {
    const changed = this.up !== up
    this.up = up
    this.checkedAtMs = this.now()
    if (changed) for (const cb of [...this.listeners]) cb(up)
  }

  /** Fires only when the state flips (not on the first check). */
  onChange(cb: (up: boolean) => void): () => void {
    const wrapped = (up: boolean): void => {
      try {
        cb(up)
      } catch {
        // a listener's failure never breaks the others
      }
    }
    this.listeners.add(wrapped)
    return () => this.listeners.delete(wrapped)
  }

  /** Last known state, without checking. */
  current(): { up: boolean | null; checkedAt: string | null } {
    return {
      up: this.up,
      checkedAt: this.checkedAtMs === null ? null : new Date(this.checkedAtMs).toISOString()
    }
  }

  /**
   * Checks now, then every `upMs` while up and on a back-off while down.
   * Listeners still fire only on change. Returns a stop function.
   */
  startPolling(o: PollOptions = {}): () => void {
    const upMs = o.upMs ?? 60_000
    const downMs = o.downMs?.length ? o.downMs : [15_000, 30_000, 60_000, 300_000]
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let step = 0
    const tick = async (): Promise<void> => {
      if (stopped) return
      const up = await this.check()
      if (stopped) return
      const delay = up ? upMs : downMs[Math.min(step, downMs.length - 1)]
      step = up ? 0 : step + 1
      timer = setTimeout(() => void tick(), delay)
      ;(timer as { unref?: () => void }).unref?.()
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }
}
