// Minimal DevTools-protocol helpers for the Electron QA scripts (copied from
// qa-now-playing.mjs, which keeps its own copy). Renderer on `port`, main
// process (Node inspector) on `mainPort`.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function connectCdp({ port, mainPort, output, log = () => '' }) {
  let target
  for (let i = 0; i < 100; i++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
      target = targets.find((t) => t.type === 'page')
      if (target) break
    } catch {
      /* Wait for Electron. */
    }
    await sleep(150)
  }
  assert.ok(target, `Electron did not expose DevTools. ${log()}`)
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const pending = new Map()
  const errors = []
  const dialogs = []
  let sequence = 0
  let dialogAccept = true
  let mainSocket

  socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data)
    if (data.id) {
      const request = pending.get(data.id)
      if (request) {
        pending.delete(data.id)
        data.error
          ? request.reject(new Error(JSON.stringify(data.error)))
          : request.resolve(data.result)
      }
    }
    if (data.method === 'Page.javascriptDialogOpening') {
      dialogs.push(data.params.message)
      void send('Page.handleJavaScriptDialog', { accept: dialogAccept })
    }
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails)
    if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error')
      errors.push(data.params.entry)
  })

  function send(method, params = {}) {
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, 20000)
      pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout)
          resolve(result)
        },
        reject
      })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.text + ': ' + JSON.stringify(result.exceptionDetails.exception)
      )
    return result.result.value
  }

  async function mainEvaluate(expression) {
    if (!mainSocket) {
      const targets = await fetch(`http://127.0.0.1:${mainPort}/json`).then((r) => r.json())
      mainSocket = new WebSocket(targets[0].webSocketDebuggerUrl)
      await new Promise((resolve, reject) => {
        mainSocket.addEventListener('open', resolve, { once: true })
        mainSocket.addEventListener('error', reject, { once: true })
      })
    }
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const onMessage = (event) => {
        const data = JSON.parse(event.data)
        if (data.id !== id) return
        mainSocket.removeEventListener('message', onMessage)
        if (data.error || data.result?.exceptionDetails)
          reject(new Error(JSON.stringify(data.error ?? data.result.exceptionDetails)))
        else resolve(data.result.result.value)
      }
      mainSocket.addEventListener('message', onMessage)
      mainSocket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    })
  }

  async function waitFor(predicate, label, timeout = 20000) {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (await evaluate(predicate)) return
      await sleep(200)
    }
    throw new Error(`Timed out waiting for ${label}`)
  }

  async function key(k, code = k, modifiers = 0) {
    // Enter needs its text for native behaviour such as implicit form submission.
    const text = k === 'Enter' && !modifiers ? { text: '\r' } : {}
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers, ...text })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers })
    await sleep(80)
  }

  async function typeText(text) {
    await send('Input.insertText', { text })
    await sleep(120)
  }

  /** Clicks the first enabled button whose text or aria-label matches, optionally inside `scope`. */
  async function click(text, { exact = true, scope = 'document' } = {}) {
    const ok = await evaluate(`(() => {
      const root = ${scope}; if (!root) return false;
      const el = [...root.querySelectorAll('button, [role="menuitem"]')].find(e => !e.disabled && (${
        exact
          ? `e.textContent.trim() === ${JSON.stringify(text)} || e.getAttribute('aria-label') === ${JSON.stringify(text)}`
          : `e.textContent.includes(${JSON.stringify(text)}) || (e.getAttribute('aria-label') || '').includes(${JSON.stringify(text)})`
      }));
      if (!el) return false; el.click(); return true })()`)
    assert.ok(ok, `Button not found: ${text}`)
    await sleep(250)
  }

  async function screenshot(name, width, height) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    })
    await sleep(300)
    const layout = await evaluate(
      `(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, overflow: [...document.querySelectorAll('main')].map(e => ({width:e.clientWidth, scroll:e.scrollWidth})) }))()`
    )
    assert.ok(layout.scroll <= width, `${name}: document horizontal overflow`)
    assert.ok(
      layout.overflow.every((e) => e.scroll <= e.width + 1),
      `${name}: main horizontal overflow ${JSON.stringify(layout)}`
    )
    const image = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(
      path.join(output, `${name}-${width}x${height}.png`),
      Buffer.from(image.data, 'base64')
    )
    console.log(`Captured ${name} ${width}x${height}`)
  }

  async function tabCheck(view, max = 160) {
    await evaluate('document.activeElement?.blur()')
    for (let i = 0; i < max; i++) {
      await key('Tab')
      const focus = await evaluate(
        `(() => { const e=document.activeElement; const s=getComputedStyle(e); return { tag:e.tagName, label:(e.getAttribute('aria-label') || e.textContent || '').trim().slice(0,60), outline:s.outlineStyle, width:s.outlineWidth, visible:e.matches(':focus-visible'), sr: e.classList.contains('sr-only') } })()`
      )
      if (focus.tag === 'BODY') continue
      // Checkbox inputs are visually hidden; their styled box shows the ring (peer-focus-visible).
      if (focus.sr) {
        const ring = await evaluate(
          `getComputedStyle(document.activeElement.nextElementSibling).outlineStyle`
        )
        assert.notEqual(ring, 'none', `${view} checkbox missing focus ring at Tab #${i + 1}`)
        continue
      }
      assert.ok(
        focus.visible && focus.outline !== 'none' && parseFloat(focus.width) >= 2,
        `${view} missing focus ring at Tab #${i + 1} ${JSON.stringify(focus)}`
      )
    }
  }

  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  return {
    send,
    evaluate,
    mainEvaluate,
    waitFor,
    key,
    typeText,
    click,
    screenshot,
    tabCheck,
    errors,
    dialogs,
    setDialogAccept: (v) => {
      dialogAccept = v
    },
    close: () => {
      socket.close()
      mainSocket?.close()
    }
  }
}
