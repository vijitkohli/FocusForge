import os from 'os'
import path from 'path'
import fs from 'fs-extra'
import { execFileSync } from 'child_process'
import { beforeAll, describe, expect, it } from 'vitest'
import { EngineCallRegistry, EngineCancelled, EngineTimeout, WarmSpare, runEngine } from './engine'

const PYTHON = 'python3'
let dir: string

function script(name: string, body: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(
    file,
    `import sys, json, time\npayload = json.loads(sys.stdin.read() or "{}")\n${body}\n`
  )
  return file
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-test-'))
  execFileSync(PYTHON, ['--version'])
})

describe('runEngine', () => {
  it('resolves one-shot calls with the last line', async () => {
    const file = script(
      'echo.py',
      'print(json.dumps({"n": 1}))\nprint(json.dumps({"echo": payload["x"]}))'
    )
    const call = runEngine(file, { x: 7 }, { pythonPath: PYTHON, timeoutMs: 10_000 })
    await expect(call.promise).resolves.toEqual({ echo: 7 })
  })

  it('resolves streaming calls on the result line and still delivers trailing lines', async () => {
    const file = script(
      'stream.py',
      [
        'for t in ["a", "b"]: print(json.dumps({"type": "token", "text": t}), flush=True)',
        'print(json.dumps({"type": "result", "status": "clarifying"}), flush=True)',
        'print(json.dumps({"type": "notes", "notes": [1]}), flush=True)'
      ].join('\n')
    )
    const seen: string[] = []
    let notesSeen: () => void = () => undefined
    const notes = new Promise<void>((resolve) => (notesSeen = resolve))
    const call = runEngine(
      file,
      {},
      {
        pythonPath: PYTHON,
        timeoutMs: 10_000,
        resolveOn: (m) => m.type === 'result',
        onMessage: (m) => {
          seen.push(m.type)
          if (m.type === 'notes') notesSeen()
        }
      }
    )
    await expect(call.promise).resolves.toMatchObject({ status: 'clarifying' })
    await notes
    expect(seen).toEqual(['token', 'token', 'notes'])
  })

  it('times out a stalled script and kills it', async () => {
    const file = script(
      'stall.py',
      'import os\nprint(json.dumps({"pid": os.getpid()}), flush=True)\ntime.sleep(30)'
    )
    let pid = 0
    const call = runEngine(
      file,
      {},
      {
        pythonPath: PYTHON,
        timeoutMs: 1_500,
        resolveOn: () => false,
        onMessage: (m) => (pid = m.pid)
      }
    )
    await expect(call.promise).rejects.toBeInstanceOf(EngineTimeout)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(pid).toBeGreaterThan(0)
    expect(alive(pid)).toBe(false)
  })

  it('cancels and kills a running script', async () => {
    const file = script(
      'slow.py',
      'import os\nprint(json.dumps({"pid": os.getpid()}), flush=True)\ntime.sleep(30)'
    )
    let pid = 0
    let started: () => void = () => undefined
    const running = new Promise<void>((resolve) => (started = resolve))
    const call = runEngine(
      file,
      {},
      {
        pythonPath: PYTHON,
        timeoutMs: 10_000,
        resolveOn: () => false,
        onMessage: (m) => {
          pid = m.pid
          started()
        }
      }
    )
    await running
    call.cancel()
    await expect(call.promise).rejects.toBeInstanceOf(EngineCancelled)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(alive(pid)).toBe(false)
  })

  it('rejects when a streaming script exits without a result', async () => {
    const file = script('noresult.py', 'print(json.dumps({"type": "token", "text": "x"}))')
    const call = runEngine(
      file,
      {},
      { pythonPath: PYTHON, timeoutMs: 10_000, resolveOn: (m) => m.type === 'result' }
    )
    await expect(call.promise).rejects.toThrow('without a result')
  })
})

describe('EngineCallRegistry', () => {
  it('cancels the previous call for the same key', async () => {
    const file = script('wait.py', 'time.sleep(30)')
    const registry = new EngineCallRegistry()
    const first = registry.track(
      'chat:1',
      runEngine(file, {}, { pythonPath: PYTHON, timeoutMs: 10_000 })
    )
    const second = registry.track(
      'chat:1',
      runEngine(file, {}, { pythonPath: PYTHON, timeoutMs: 10_000 })
    )
    await expect(first.promise).rejects.toBeInstanceOf(EngineCancelled)
    expect(registry.isActive('chat:1', second)).toBe(true)
    registry.cancel('chat:1')
    await expect(second.promise).rejects.toBeInstanceOf(EngineCancelled)
    expect(registry.isActive('chat:1', second)).toBe(false)
  })
})

describe('WarmSpare', () => {
  it('hands over a pre-started process that then serves one request', async () => {
    const file = script(
      'warm.py',
      'import os\nprint(json.dumps({"pid": os.getpid(), "echo": payload.get("x")}))'
    )
    const spare = new WarmSpare(file, PYTHON)
    spare.warm()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const shell = spare.take()
    expect(shell).toBeDefined()
    const call = runEngine(file, { x: 3 }, { pythonPath: PYTHON, timeoutMs: 10_000, shell })
    const result = await call.promise
    expect(result.echo).toBe(3)
    expect(result.pid).toBe(shell?.childProcess.pid)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const next = spare.take()
    expect(next).toBeDefined()
    expect(next?.childProcess.pid).not.toBe(result.pid)
    spare.dispose()
    next?.kill('SIGTERM')
  })

  it('skips a spare that already exited and kills the spare on dispose', async () => {
    const quitter = script('quit.py', 'pass')
    const spare = new WarmSpare(quitter, PYTHON)
    spare.warm()
    // quit.py exits once stdin closes; force that by ending stdin directly.
    const first = (spare as unknown as { spare: { shell: { end: (cb: () => void) => void } } })
      .spare.shell
    await new Promise<void>((resolve) => first.end(() => resolve()))
    expect(spare.take()).toBeUndefined()
    spare.dispose()

    const waiter = script('wait2.py', 'time.sleep(30)')
    const live = new WarmSpare(waiter, PYTHON)
    live.warm()
    const pid = (live as unknown as { spare: { shell: { childProcess: { pid: number } } } }).spare
      .shell.childProcess.pid
    live.dispose()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(alive(pid)).toBe(false)
  })
})
