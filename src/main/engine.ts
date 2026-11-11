import { PythonShell } from 'python-shell'

/** The caller cancelled the call (Stop button, or a newer call replaced it). */
export class EngineCancelled extends Error {
  constructor() {
    super('The engine call was cancelled.')
    this.name = 'EngineCancelled'
  }
}

/** The engine didn't finish within its time limit. */
export class EngineTimeout extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`The engine took longer than ${Math.round(timeoutMs / 1000)}s.`)
    this.name = 'EngineTimeout'
  }
}

/** A running engine process: `promise` settles once, `cancel` kills the process. */
export interface EngineCall<T = EngineMessage> {
  promise: Promise<T>
  cancel(): void
}

// One NDJSON line from an engine script; shapes vary by script and `type`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EngineMessage = Record<string, any>

export interface RunEngineOptions {
  pythonPath: string
  /** Hard limit for the whole process; it is killed when this passes. */
  timeoutMs: number
  /**
   * Streaming scripts: the message that settles the call (e.g. `type: 'result'`).
   * The process keeps running afterwards so trailing lines still reach
   * `onMessage`. Without it, the call resolves with the last line at exit.
   */
  resolveOn?: (message: EngineMessage) => boolean
  /** Every line that doesn't settle the call. */
  onMessage?: (message: EngineMessage) => void
  /** Called with each stderr line (diagnostics only). */
  onStderr?: (line: string) => void
  /** A pre-spawned process for this script (see WarmSpare); a fresh one is spawned otherwise. */
  shell?: PythonShell
}

/**
 * Spawns a Python engine script, writes one JSON payload to its stdin and
 * reads JSON lines from stdout. Every call has a time limit and can be
 * cancelled; both kill the child process so a stalled model request can never
 * leave the UI waiting forever or leak a Python process.
 */
export function runEngine(
  scriptPath: string,
  payload: unknown,
  options: RunEngineOptions
): EngineCall {
  const shell =
    options.shell ?? new PythonShell(scriptPath, { mode: 'json', pythonPath: options.pythonPath })
  const output: EngineMessage[] = []
  let settled = false
  let exited = false
  let settle: { resolve: (value: EngineMessage) => void; reject: (error: Error) => void }

  const promise = new Promise<EngineMessage>((resolve, reject) => {
    settle = { resolve, reject }
  })
  const finish = (error: Error | null, value?: EngineMessage): void => {
    if (settled) return
    settled = true
    if (error) settle.reject(error)
    else settle.resolve(value as EngineMessage)
  }
  const kill = (): void => {
    if (exited) return
    try {
      shell.kill('SIGTERM')
    } catch {
      // already gone
    }
  }

  const timer = setTimeout(() => {
    finish(new EngineTimeout(options.timeoutMs))
    kill()
  }, options.timeoutMs)

  shell.on('message', (message: EngineMessage) => {
    if (!settled && options.resolveOn?.(message)) finish(null, message)
    else {
      output.push(message)
      options.onMessage?.(message)
    }
  })
  shell.on('stderr', (line: string) => options.onStderr?.(line))

  shell.send(payload as object).end((err) => {
    exited = true
    clearTimeout(timer)
    if (err) finish(err)
    else if (options.resolveOn) finish(new Error(`${scriptPath} exited without a result`))
    else if (output.length === 0) finish(new Error(`${scriptPath} produced no output`))
    else finish(null, output[output.length - 1])
  })

  return {
    promise,
    cancel: () => {
      finish(new EngineCancelled())
      kill()
    }
  }
}

/**
 * Tracks at most one in-flight call per key (e.g. `chat:<webContentsId>`):
 * starting a new one cancels the previous, and `cancel(key)` stops it.
 */
export class EngineCallRegistry {
  private calls = new Map<string, EngineCall>()

  track(key: string, call: EngineCall): EngineCall {
    this.calls.get(key)?.cancel()
    this.calls.set(key, call)
    const release = (): void => {
      if (this.calls.get(key) === call) this.calls.delete(key)
    }
    call.promise.then(release, release)
    return call
  }

  isActive(key: string, call: EngineCall): boolean {
    return this.calls.get(key) === call
  }

  cancel(key: string): void {
    this.calls.get(key)?.cancel()
  }

  cancelAll(): void {
    for (const call of this.calls.values()) call.cancel()
  }
}

/**
 * Keeps one idle, already-started process for a script. Engine scripts import
 * LiteLLM (about 1.5 s) before they read stdin, so a process spawned ahead of
 * time has paid that cost by the time a request arrives. Each process still
 * serves exactly one request, so cancel-by-kill and isolation are unchanged.
 */
export class WarmSpare {
  private spare: { shell: PythonShell; exited: boolean } | null = null
  private disposed = false

  constructor(
    private readonly scriptPath: string,
    private readonly pythonPath: string,
    private readonly spawn: (scriptPath: string, pythonPath: string) => PythonShell = (
      script,
      python
    ) => new PythonShell(script, { mode: 'json', pythonPath: python })
  ) {}

  /** Starts a spare if there isn't a live one. */
  warm(): void {
    if (this.disposed || (this.spare && !this.spare.exited)) return
    try {
      const entry = { shell: this.spawn(this.scriptPath, this.pythonPath), exited: false }
      const markExited = (): void => {
        entry.exited = true
      }
      entry.shell.on('close', markExited)
      entry.shell.on('error', markExited)
      this.spare = entry
    } catch (error) {
      console.error('Could not start a warm engine process', error)
      this.spare = null
    }
  }

  /** Hands over the spare (or undefined when none is ready) and starts the next one. */
  take(): PythonShell | undefined {
    const entry = this.spare
    this.spare = null
    setTimeout(() => this.warm(), 0)
    return entry && !entry.exited ? entry.shell : undefined
  }

  dispose(): void {
    this.disposed = true
    if (this.spare && !this.spare.exited) {
      try {
        this.spare.shell.kill('SIGTERM')
      } catch {
        // already gone
      }
    }
    this.spare = null
  }
}
