import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

// Requires a launcher that redirects Electron's documents/userData paths to a QA copy.
// --live-ai additionally runs one real coach conversation and plan adjustment
// through the configured model (CLIProxyAPI); off by default.
const args = process.argv.slice(2)
const liveAI = args.includes('--live-ai')
const [launcher, output = '/tmp/focusforge-qa/screenshots'] = args.filter(
  (a) => !a.startsWith('--')
)
if (!launcher)
  throw new Error(
    'Usage: node scripts/qa-now-playing.mjs /path/to/isolated-launcher.cjs [output] [--live-ai]'
  )
const require = createRequire(import.meta.url)
const electron = require('electron')
await mkdir(output, { recursive: true })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
// --inspect exposes the main process so checks can drive main-only paths
// (nudge click → open-focus, the native reset dialog).
const app = spawn(electron, ['--remote-debugging-port=9333', '--inspect=9335', launcher], {
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
let appLog = ''
app.stdout.on('data', (d) => {
  appLog += d
})
app.stderr.on('data', (d) => {
  appLog += d
})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let socket
let mainSocket
let dialogAccept = true
const dialogs = []
const pending = new Map()
let sequence = 0
const errors = []
const checks = []
function send(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP timeout: ${method}`))
    }, 15000)
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
async function click(text, exact = true) {
  const result = await evaluate(
    `(() => { const el = [...document.querySelectorAll('button')].find(e => !e.disabled && ${exact ? `(e.textContent.trim() === ${JSON.stringify(text)} || e.getAttribute('aria-label') === ${JSON.stringify(text)})` : `e.textContent.includes(${JSON.stringify(text)})`}); if (!el) return false; el.click(); return true })()`
  )
  assert.ok(result, `Button not found: ${text}`)
  await sleep(220)
}
async function key(key, code = key, modifiers = 0) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers })
  await sleep(80)
}
async function nav(name) {
  const labels = { now: 'Now', library: 'Library', history: 'History', profile: 'Profile' }
  const text = labels[name]
  const result = await evaluate(
    `(() => { const el = [...document.querySelectorAll('aside button')].find(e => e.textContent.trim() === ${JSON.stringify(text)} || (e.getAttribute('aria-label') || '').startsWith(${JSON.stringify(text)})); if (!el) return false; el.click(); return true })()`
  )
  assert.ok(result, `Navigation not found: ${name}`)
  await sleep(350)
}
async function screenshot(name, width, height) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluate(`document.querySelectorAll('main').forEach(e => {e.scrollTop = 0})`)
  await sleep(250)
  const layout = await evaluate(
    `(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, overflow: [...document.querySelectorAll('main')].map(e => ({width:e.clientWidth, scroll:e.scrollWidth})), title:document.title, sidebar:document.querySelector('aside')?.getBoundingClientRect().width }))()`
  )
  assert.equal(layout.title, 'FocusForge')
  assert.ok(layout.scroll <= width, `${name}: document horizontal overflow`)
  assert.ok(
    layout.overflow.every((e) => e.scroll <= e.width + 1),
    `${name}: main horizontal overflow ${JSON.stringify(layout)}`
  )
  if (name === 'focus') {
    const center = await evaluate(
      `(() => {const r=document.querySelector('#focus-title').closest('section').getBoundingClientRect();return {x:r.x,w:r.width,viewport:innerWidth}})()`
    )
    assert.ok(
      Math.abs(center.x + center.w / 2 - center.viewport / 2) < 2,
      `Focus not centered: ${JSON.stringify(center)}`
    )
  }
  if (name === 'now-playing') {
    const hue = await evaluate(
      `getComputedStyle(document.querySelector('[role="img"] > span')).backgroundColor`
    )
    assert.notEqual(hue, 'rgba(0, 0, 0, 0)', 'Project cover hue was pruned')
    const play = await evaluate(
      `(() => {const r=document.querySelector('[aria-label="Play in Focus (Space)"]').getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:innerHeight}})()`
    )
    if (width === 1440) {
      const bottom = await evaluate(
        `document.querySelector('[aria-label="Daily completed steps"]').getBoundingClientRect().bottom`
      )
      assert.ok(bottom <= height, `Home heatmap below first viewport: ${bottom}`)
    }
    assert.ok(
      play.top >= 0 && play.bottom <= play.height,
      `Home Play outside first viewport: ${JSON.stringify(play)}`
    )
  }
  const image = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false
  })
  await writeFile(
    path.join(output, `${name}-${width}x${height}.png`),
    Buffer.from(image.data, 'base64')
  )
  checks.push({ name, width, height, layout })
  console.log(`Captured ${name} ${width}x${height}`)
}
async function both(name) {
  await screenshot(name, 900, 670)
  await screenshot(name, 1440, 900)
}
async function tabCheck(view) {
  await evaluate('document.activeElement?.blur()')
  const controls = await evaluate(
    `document.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]').length`
  )
  let previous = null
  for (let i = 0; i < Math.min(180, controls + 2); i++) {
    await key('Tab')
    const focus = await evaluate(
      `(() => { const e=document.activeElement; const s=getComputedStyle(e); return { tag:e.tagName, type:e.type||'', focused:e.matches(':focus'), label:(e.getAttribute('aria-label') || e.textContent || '').trim().slice(0,60), outline:s.outlineStyle, width:s.outlineWidth, visible:e.matches(':focus-visible'), docFocus:document.hasFocus(), html:e.outerHTML.slice(0,160) } })()`
    )
    // `focused: false` on a focused-looking element means focus sits inside UA
    // shadow DOM (e.g. a native picker button) where the app's ring can't reach.
    if (focus.tag !== 'BODY')
      assert.ok(
        focus.visible && focus.outline !== 'none' && parseFloat(focus.width) >= 2,
        `${view} missing focus ring at Tab #${i + 1} of ${controls} ${JSON.stringify(focus)} (previous: ${JSON.stringify(previous)})`
      )
    previous = { label: focus.label, tag: focus.tag }
  }
}
/** Evaluates an expression in the Electron main process via the Node inspector. */
async function mainEvaluate(expression) {
  if (!mainSocket) {
    const targets = await fetch('http://127.0.0.1:9335/json').then((r) => r.json())
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
async function bodyText() {
  return evaluate('document.body.innerText')
}
async function waitFor(predicate, label, timeout = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await evaluate(predicate)) return
    await sleep(200)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
async function clickLabel(prefix) {
  const ok = await evaluate(
    `(() => { const e=[...document.querySelectorAll('button, input')].find(e => !e.disabled && (e.getAttribute('aria-label') || '').startsWith(${JSON.stringify(prefix)})); if (!e) return false; e.click(); return true })()`
  )
  assert.ok(ok, `Control not found: ${prefix}`)
  await sleep(220)
}
async function selectByLabel(label, value) {
  const ok = await evaluate(`(() => {
    const l=[...document.querySelectorAll('label')].find(l => l.textContent.trim() === ${JSON.stringify(label)});
    const e=l && document.getElementById(l.htmlFor); if (!e) return false;
    const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
    setter.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('change',{bubbles:true})); return true })()`)
  assert.ok(ok, `Select not found: ${label}`)
  await sleep(300)
}
async function loadTask(projectId, taskId) {
  const data = await evaluate(`window.api.loadProjectData(${JSON.stringify(projectId)})`)
  return data.tasks.find((t) => t.id === taskId)
}
async function openTask(title) {
  await click('COMP6991')
  await waitFor(`document.body.innerText.includes(${JSON.stringify(title)})`, `task ${title}`)
  await click(title, false)
  await waitFor(`!!document.querySelector('[aria-label="Task options"]')`, 'task page')
}
async function input(selector, text) {
  await evaluate(
    `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw Error('Input not found'); e.focus(); const setter=Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,'value').set; setter.call(e,${JSON.stringify(text)}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`
  )
  await sleep(80)
}
try {
  let target
  for (let i = 0; i < 80; i++) {
    try {
      const targets = await fetch('http://127.0.0.1:9333/json').then((r) => r.json())
      target = targets.find((t) => t.type === 'page')
      if (target) break
    } catch {
      /* Wait for Electron. */
    }
    await sleep(150)
  }
  assert.ok(target, `Electron did not expose DevTools. ${appLog}`)
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
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
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  // Chromium stops matching :focus when the window loses OS focus mid-run;
  // emulate a focused page so keyboard checks don't depend on the desktop.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await sleep(600)
  // Guard against accidentally running mutation checks on the owner's live app.
  const projects = await evaluate('window.api.getProjects()')
  assert.ok(
    projects.every(
      (p) =>
        p.path.startsWith('/tmp/focusforge-qa/') || p.path.startsWith('/private/tmp/focusforge-qa/')
    ),
    'QA launcher must use copied registry paths'
  )
  // A "Plan today" set left by an earlier run would change Now Playing's layout.
  // Cleared through the API, so reload for the renderer to drop its loaded copy.
  if (await evaluate('window.api.getTodayPlan()')) {
    await evaluate('window.api.saveTodayPlan(null)')
    await evaluate('location.reload()')
    await sleep(500)
    await waitFor(`!!document.querySelector('aside button')`, 'reload after clearing today plan')
    await sleep(500)
  }
  await both('now-empty')
  await nav('library')
  await both('library-current')
  const ids = await evaluate(`(async () => {
    const p = await window.api.createProject('COMP6991');
    const task = {id:'qa-lab4',title:'Finish Lab 4',createdAt:'2026-07-01T12:00:00.000Z',deadline:'2026-08-01',status:'in-progress',depth:'Brief',model:'gemini/gemini-2.5-flash',
      subtasks:Array.from({length:16},(_,i)=>({id:'qa-step-'+i,title:['Review the COMP6991 Lab 4 assignment spec PDF','Identify the core requirements','Set up the Rust project','Create lib.rs'][i%4]+(i>3?' — part '+(i+1):''),isCompleted:false,difficulty:['easy','medium','hard'][i%3],timeEstimate:[15,20,10,5][i%4],scheduledDate:'2026-07-08'})),
      prerequisites:[{id:'qa-prep',title:'Watch lecture 4 on traits',kind:'learn',timeEstimate:10,isCompleted:false},{id:'qa-setup',title:'Install cargo-nextest',kind:'setup',timeEstimate:5,isCompleted:true}]};
    const data=await window.api.loadProjectData(p.id); data.tasks=[task]; const result=await window.api.saveProjectData(p.id,data); if(!result.success)throw Error(result.error); return {projectId:p.id,taskId:task.id};
  })()`)
  await nav('now')
  await both('now-playing')
  await tabCheck('now')
  const carried = await evaluate('document.body.innerText')
  assert.ok(
    carried.includes('Carried over') && carried.includes('(16)'),
    '16 carried-over fixture steps missing'
  )
  assert.ok(!/\d+d overdue/.test(carried), 'Overdue guilt badge rendered')
  const heatmap = await evaluate(
    `(() => {const e=document.querySelector('[aria-label="Daily completed steps"]');const s=getComputedStyle(e);return {rows:s.gridTemplateRows,flow:s.gridAutoFlow,gap:s.gap,cells:e.children.length}})()`
  )
  assert.equal(heatmap.flow, 'column')
  assert.equal(heatmap.gap, '3px')
  assert.ok(heatmap.cells >= 84)
  await click('Re-plan all from today')
  assert.ok(
    (await evaluate('document.body.innerText')).includes('Moved 16 steps into the days ahead.')
  )
  const planned = await evaluate(`window.api.loadProjectData(${JSON.stringify(ids.projectId)})`)
  const today = await evaluate(
    `(() => {const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')})()`
  )
  assert.ok(
    planned.tasks[0].subtasks.every((s) => s.scheduledDate >= today),
    'Replan did not move every fixture step'
  )
  console.log('Verified carried-over count and re-plan persistence (16 steps).')
  await click('Play in Focus (Space)')
  await both('focus')
  await screenshot('focus', 2056, 1257)
  await evaluate('document.activeElement?.blur()')
  await key(' ', 'Space')
  await sleep(200)
  assert.ok(
    await evaluate(`!!document.querySelector('button[aria-label^="Play"]')`),
    'Space did not pause'
  )
  await key(' ', 'Space')
  await sleep(1100)
  await evaluate('document.activeElement?.blur()')
  await key('Enter')
  assert.ok(
    (await evaluate('document.body.innerText')).includes('1 done this session'),
    'Enter did not complete step'
  )
  await key('s', 'KeyS')
  await tabCheck('focus')
  await key('Escape')
  await nav('library')
  await both('library')
  await tabCheck('library')
  await click('COMP6991')
  await both('project')
  await tabCheck('project')
  await click('Project notes')
  await both('notes')
  for (let i = 0; i < 15; i++) {
    await key('Tab')
    assert.ok(
      await evaluate(`!!document.activeElement.closest('[role="dialog"]')`),
      'Drawer focus escaped'
    )
  }
  await click('Edit notes')
  await input('[role="dialog"] textarea', 'QA missing headings')
  assert.ok(
    (await evaluate('document.body.innerText')).includes('These section headings are missing')
  )
  const ledger = await evaluate(`window.api.readContextLedger(${JSON.stringify(ids.projectId)})`)
  await input('[role="dialog"] textarea', ledger + '\n- [2026-10-15] QA note saved locally.\n')
  await click('Save changes')
  assert.ok(
    (await evaluate(`window.api.readContextLedger(${JSON.stringify(ids.projectId)})`)).includes(
      'QA note saved locally.'
    )
  )
  await key('Escape')
  assert.ok(!(await evaluate(`!!document.querySelector('[role="dialog"]')`)))
  await click('New task with coach')
  await both('coach')
  await tabCheck('coach')
  await click('Lab report due Friday')
  assert.equal(await evaluate('document.querySelector("textarea").value'), 'Lab report due Friday')
  const composer = await evaluate(
    `(() => {const r=document.querySelector('form').getBoundingClientRect();return {bottom:r.bottom,height:innerHeight}})()`
  )
  assert.ok(composer.bottom < composer.height, 'Coach composer not pinned in viewport')
  await click('COMP6991')
  await click('Finish Lab 4', false)
  await both('task-list')
  await tabCheck('task')
  await click('Identify the core requirements')
  await input('input[aria-label="Edit step 2"]', 'Identify the core requirements carefully')
  await key('Enter')
  await sleep(200)
  assert.ok(
    (
      await evaluate(`window.api.loadProjectData(${JSON.stringify(ids.projectId)})`)
    ).tasks[0].subtasks.some((s) => s.title === 'Identify the core requirements carefully')
  )
  await click('Add a step')
  await input('input[aria-label="New step title"]', 'QA added step')
  await key('Enter')
  await sleep(200)
  assert.ok(
    (
      await evaluate(`window.api.loadProjectData(${JSON.stringify(ids.projectId)})`)
    ).tasks[0].subtasks.some((s) => s.title === 'QA added step')
  )
  await click('Board')
  await both('task-board')
  const firstOptions = await evaluate(
    `(() => {const e=document.querySelector('[draggable="true"] button[aria-haspopup="menu"]');if(!e)return false;e.click();return true})()`
  )
  assert.ok(firstOptions)
  await click('Move to Doing')
  assert.ok(
    (
      await evaluate(`window.api.loadProjectData(${JSON.stringify(ids.projectId)})`)
    ).tasks[0].subtasks.some((s) => s.status === 'doing')
  )
  await nav('history')
  await both('history')
  await tabCheck('history')
  await nav('profile')
  await both('profile')
  await tabCheck('profile')
  const previousProfile = await evaluate('document.querySelector("textarea").value')
  await input('textarea', previousProfile + 'QA profile: short steps help me start.\n')
  await click('Save changes')
  assert.ok(
    (await evaluate('window.api.readUserProfile()')).includes(
      'QA profile: short steps help me start.'
    )
  )
  await nav('now')
  await click('Low energy')
  assert.ok((await evaluate('document.body.innerText')).includes('Easy'))
  await click('All')

  // ---------- Extended interaction coverage ----------
  const localKey = (offset = 0) =>
    evaluate(
      `(() => {const d=new Date();d.setDate(d.getDate()+${offset});return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')})()`
    )

  // Command shortcuts (⌘ = CDP modifier 4) from a neutral focus.
  await evaluate('document.activeElement?.blur()')
  for (const [k, code, expect] of [
    ['2', 'Digit2', 'New project'],
    ['3', 'Digit3', 'Coming up'],
    [',', 'Comma', 'What gets in your way'],
    ['1', 'Digit1', 'Up next']
  ]) {
    await key(k, code, 4)
    await sleep(300)
    assert.ok((await bodyText()).includes(expect), `⌘${k} did not open the view with "${expect}"`)
  }
  console.log('Verified ⌘1/⌘2/⌘3/⌘, navigation.')

  // Menu keyboard model: ArrowDown opens on the first item, arrows move, Escape
  // closes and returns focus to the trigger; an outside press also closes it.
  await evaluate(`document.querySelector('main button[aria-label^="Options for"]').focus()`)
  await key('ArrowDown')
  assert.equal(
    await evaluate(
      `document.activeElement.getAttribute('role') + ':' + document.activeElement.textContent.trim()`
    ),
    'menuitem:Play this next'
  )
  await key('ArrowDown')
  assert.equal(await evaluate(`document.activeElement.textContent.trim()`), 'Open task')
  await key('Escape')
  assert.ok(!(await evaluate(`!!document.querySelector('[role="menu"]')`)), 'Escape left menu open')
  assert.ok(
    await evaluate(
      `(document.activeElement.getAttribute('aria-label') || '').startsWith('Options for')`
    ),
    'Escape did not return focus to the menu trigger'
  )
  await evaluate(`document.querySelector('main button[aria-label^="Options for"]').click()`)
  await sleep(150)
  assert.ok(await evaluate(`!!document.querySelector('[role="menu"]')`))
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: 300, y: 20, button: 'left', clickCount: 1 })
  await sleep(200)
  assert.ok(
    !(await evaluate(`!!document.querySelector('[role="menu"]')`)),
    'Outside press left menu open'
  )
  console.log('Verified menu arrows, Escape focus return and outside-press close.')

  // Fixture: a one-step, one-minute task for the timer overflow check.
  const todayKey = await localKey(0)
  await evaluate(`(async () => {
    const data = await window.api.loadProjectData(${JSON.stringify(ids.projectId)});
    data.tasks = data.tasks.filter(t => t.id !== 'qa-timer');
    data.tasks.push({id:'qa-timer',title:'Timer check',createdAt:new Date().toISOString(),deadline:${JSON.stringify(await localKey(3))},status:'in-progress',depth:'Brief',model:'gemini/gemini-2.5-flash',
      subtasks:[{id:'qa-timer-1',title:'One minute warm-up',isCompleted:false,difficulty:'easy',timeEstimate:1,scheduledDate:${JSON.stringify(todayKey)}}],prerequisites:[]});
    const r = await window.api.saveProjectData(${JSON.stringify(ids.projectId)}, data); if (!r.success) throw Error(r.error);
  })()`)
  await nav('library')
  await openTask('Timer check')
  await click('Play next step')
  await waitFor(`!!document.querySelector('#focus-title')`, 'focus view')
  await sleep(62000)
  assert.ok(
    (await bodyText()).includes('taking longer is fine'),
    'Timer overflow reassurance missing'
  )
  assert.ok(
    await evaluate(`!!document.querySelector('.scrubber-overflow')`),
    'Overflow marker missing'
  )
  assert.ok(
    !(await evaluate(
      `!!document.querySelector('[role="progressbar"].bg-hard, .text-hard [role="progressbar"]')`
    ))
  )
  await screenshot('focus-overflow', 1440, 900)
  await key('Escape')
  await nav('now')
  await sleep(1500)
  await nav('library')
  await openTask('Timer check')
  await click('Play next step')
  await waitFor(`!!document.querySelector('#focus-title')`, 'focus view again')
  assert.ok(
    /\+\d+:\d\d · taking longer is fine/.test(await bodyText()),
    'Timer did not persist across navigation'
  )
  await click('Done')
  await sleep(400)
  assert.ok(
    (await loadTask(ids.projectId, 'qa-timer')).subtasks[0].isCompleted,
    'Focus Done did not persist'
  )
  await key('Escape')
  console.log('Verified timer overflow reassurance/marker, persistence across navigation, Done.')

  // Task delete confirmation: cancel keeps it, accept removes it.
  await nav('library')
  await openTask('Timer check')
  dialogAccept = false
  await click('Task options')
  await click('Delete task')
  assert.ok(await loadTask(ids.projectId, 'qa-timer'), 'Cancelled task delete still deleted')
  dialogAccept = true
  await click('Task options')
  await click('Delete task')
  await sleep(400)
  assert.ok(!(await loadTask(ids.projectId, 'qa-timer')), 'Confirmed task delete did not delete')
  console.log('Verified task delete cancel/confirm.')

  // Task page: checkbox complete/undo, prerequisite toggle, step delete.
  await nav('library')
  await openTask('Finish Lab 4')
  const stepTitle = (await loadTask(ids.projectId, 'qa-lab4')).subtasks[2].title
  await clickLabel('Mark step 3:')
  assert.ok(
    (await loadTask(ids.projectId, 'qa-lab4')).subtasks[2].isCompleted,
    'Checkbox did not complete'
  )
  await clickLabel('Mark step 3:')
  assert.ok(
    !(await loadTask(ids.projectId, 'qa-lab4')).subtasks[2].isCompleted,
    'Checkbox undo failed'
  )
  await clickLabel('Mark Watch lecture 4 on traits')
  assert.ok(
    (await loadTask(ids.projectId, 'qa-lab4')).prerequisites[0].isCompleted,
    'Prerequisite toggle failed'
  )
  await clickLabel('Mark Watch lecture 4 on traits')
  const before = (await loadTask(ids.projectId, 'qa-lab4')).subtasks.length
  await click('Options for step 3')
  await click('Delete')
  await sleep(300)
  const afterDelete = (await loadTask(ids.projectId, 'qa-lab4')).subtasks
  assert.equal(afterDelete.length, before - 1, 'Step delete did not persist')
  assert.ok(!afterDelete.some((s) => s.title === stepTitle))
  console.log('Verified checkbox complete/undo, prerequisite toggle, step delete.')

  // Deadline: the calendar button keeps the editor open; leaving the group commits.
  const newDeadline = await localKey(20)
  await click('Due', false)
  await waitFor(`!!document.querySelector('input[aria-label="Task deadline"]')`, 'deadline editor')
  await input('input[aria-label="Task deadline"]', newDeadline)
  for (let i = 0; i < 6; i++) {
    const label = await evaluate(`document.activeElement.getAttribute('aria-label')`)
    if (label === 'Open calendar for task deadline') break
    await key('Tab')
  }
  assert.equal(
    await evaluate(`document.activeElement.getAttribute('aria-label')`),
    'Open calendar for task deadline'
  )
  assert.ok(
    await evaluate(`!!document.querySelector('input[aria-label="Task deadline"]')`),
    'Moving to the calendar button closed the deadline editor'
  )
  await key('Tab')
  await sleep(400)
  const rescheduled = await loadTask(ids.projectId, 'qa-lab4')
  assert.equal(rescheduled.deadline, newDeadline, 'Deadline edit did not persist')
  assert.ok(
    rescheduled.subtasks.filter((s) => !s.isCompleted).every((s) => s.scheduledDate <= newDeadline),
    'Steps not redistributed inside the new deadline'
  )
  console.log('Verified deadline edit via DateInput group blur and redistribution.')

  // Per-task re-plan banner.
  await evaluate(`(async () => {
    const data = await window.api.loadProjectData(${JSON.stringify(ids.projectId)});
    const t = data.tasks.find(t => t.id === 'qa-lab4');
    t.subtasks.filter(s => !s.isCompleted).slice(0, 2).forEach(s => { s.scheduledDate = '2026-07-08' });
    await window.api.saveProjectData(${JSON.stringify(ids.projectId)}, data);
  })()`)
  await nav('library')
  await openTask('Finish Lab 4')
  await waitFor(`!!document.querySelector('[aria-label="Re-plan slipped steps"]')`, 'replan banner')
  await click('Re-plan from today')
  await sleep(400)
  assert.ok(
    (await loadTask(ids.projectId, 'qa-lab4')).subtasks
      .filter((s) => !s.isCompleted)
      .every((s) => s.scheduledDate >= todayKey),
    'Per-task re-plan left overdue steps'
  )
  console.log('Verified per-task re-plan.')

  // Project create, then delete with cancel then confirm.
  await nav('library')
  await click('New project')
  await input('input[placeholder="For example, COMP6991"]', 'QA temp')
  await click('Create')
  await sleep(400)
  assert.ok((await evaluate('window.api.getProjects()')).some((p) => p.name === 'QA temp'))
  // Creating a project opens it.
  assert.ok((await bodyText()).includes('New task with coach'), 'Create did not open the project')
  await nav('library')
  dialogAccept = false
  await click('Options for QA temp')
  await click('Delete project')
  assert.ok((await evaluate('window.api.getProjects()')).some((p) => p.name === 'QA temp'))
  dialogAccept = true
  await click('Options for QA temp')
  await click('Delete project')
  await sleep(400)
  assert.ok(!(await evaluate('window.api.getProjects()')).some((p) => p.name === 'QA temp'))
  console.log('Verified project create and delete cancel/confirm.')

  // AI settings persist.
  await nav('profile')
  const originalSettings = await evaluate('window.api.getSettings()')
  const altModel =
    originalSettings.chatModel === 'cliproxy/gemini-3-flash'
      ? 'cliproxy/gemini-3.5-flash-lite'
      : 'cliproxy/gemini-3-flash'
  await selectByLabel('Chat model', altModel)
  assert.equal((await evaluate('window.api.getSettings()')).chatModel, altModel)
  await selectByLabel('Chat model', originalSettings.chatModel)
  assert.equal((await evaluate('window.api.getSettings()')).chatModel, originalSettings.chatModel)
  console.log('Verified AI settings persistence.')

  // Nudge notification click path: main sends open-focus → Focus opens.
  await nav('now')
  await mainEvaluate(
    `process.getBuiltinModule('module').createRequire(process.cwd() + '/')('electron').BrowserWindow.getAllWindows()[0].webContents.send('open-focus')`
  )
  await waitFor(
    `!!document.querySelector('#focus-title') || document.body.innerText.includes('queue cleared')`,
    'focus from nudge'
  )
  await key('Escape')
  console.log('Verified nudge click opens Focus.')

  // Reset: cancelling the native dialog keeps every project (stubbed to Cancel).
  const projectCount = (await evaluate('window.api.getProjects()')).length
  await mainEvaluate(`(() => { const { dialog } = process.getBuiltinModule('module').createRequire(process.cwd() + '/')('electron');
    globalThis.__qaShowMessageBox = dialog.showMessageBox;
    dialog.showMessageBox = async () => ({ response: 0 }); return true })()`)
  await nav('profile')
  await click('Erase all data', false)
  await sleep(500)
  await mainEvaluate(`(() => { const { dialog } = process.getBuiltinModule('module').createRequire(process.cwd() + '/')('electron');
    dialog.showMessageBox = globalThis.__qaShowMessageBox; return true })()`)
  assert.equal(
    (await evaluate('window.api.getProjects()')).length,
    projectCount,
    'Reset cancel deleted data'
  )
  console.log('Verified reset cancel keeps data (confirm path not exercised: destructive).')

  if (liveAI) {
    // One real coach run + AI adjustment through the configured model.
    await nav('library')
    await click('COMP6991')
    await click('New task with coach')
    await selectByLabel('Model', 'cliproxy/gemini-3-flash')
    await input(
      'textarea[aria-label="Message to the coach"]',
      'Write my COMP6991 lab reflection, 300 words. DO NOT ASK FOLLOW UP QUESTIONS'
    )
    let sawTokens = false
    await click('Send')
    const started = Date.now()
    while (Date.now() - started < 180000) {
      if (await evaluate(`!!document.querySelector('[aria-label="Task options"]')`)) break
      if ((await bodyText()).includes('Write my COMP6991')) sawTokens = true
      await sleep(500)
    }
    assert.ok(
      await evaluate(`!!document.querySelector('[aria-label="Task options"]')`),
      'Coach did not hand off to the task page'
    )
    await screenshot('live-task', 1440, 900)
    const project = await evaluate(`window.api.loadProjectData(${JSON.stringify(ids.projectId)})`)
    const live = project.tasks.find((t) => t.title.startsWith('Write my COMP6991'))
    assert.ok(live && live.subtasks.length > 0, 'Generated task not saved')
    await clickLabel('Mark step 1:')
    const done = (await loadTask(ids.projectId, live.id)).subtasks[0]
    assert.ok(done.isCompleted)
    await input('input[aria-label="How should the plan change?"]', 'make this shorter')
    await click('Adjust')
    await waitFor(`!document.body.innerText.includes('Adjusting')`, 'plan adjustment', 180000)
    const adjusted = await loadTask(ids.projectId, live.id)
    assert.ok(
      adjusted.subtasks.some(
        (s) => s.id === done.id && s.isCompleted && s.completedAt === done.completedAt
      ),
      'Adjustment dropped completed progress'
    )
    console.log(
      `Verified live coach (${live.subtasks.length} steps, echo seen: ${sawTokens}) and adjustment kept progress.`
    )
    dialogAccept = true
    await click('Task options')
    await click('Delete task')
  }

  {
    // ---- Improvement-plan features (IMPROVEMENTS_PLAN.md). Model calls only with --live-ai.
    const pad2 = (n) => String(n).padStart(2, '0')
    const dayKey = (offset = 0) => {
      const d = new Date()
      d.setDate(d.getDate() + offset)
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    }
    const qaRoot = '/tmp/focusforge-qa/documents/FlowState'
    const mainFs = `process.getBuiltinModule('fs')`
    const mainElectron = `process.getBuiltinModule('module').createRequire(process.cwd() + '/')('electron')`
    const pid = ids.projectId
    await evaluate(`(async () => {
    const step = (i) => ({ id: 'qa-f-' + i, title: 'Feature step ' + (i + 1), isCompleted: false, difficulty: 'easy', timeEstimate: 10, scheduledDate: ${JSON.stringify(dayKey())} })
    const data = await window.api.loadProjectData(${JSON.stringify(pid)})
    data.tasks = data.tasks.filter((t) => !t.id.startsWith('qa-f'))
    data.tasks.push({ id: 'qa-feature', title: 'QA feature task', createdAt: new Date().toISOString(), deadline: ${JSON.stringify(dayKey())}, status: 'in-progress', depth: 'Brief', model: 'm', subtasks: [0, 1, 2, 3].map(step) })
    data.tasks.push({ id: 'qa-f-unplanned', title: 'QA imported quiz', createdAt: new Date().toISOString(), deadline: ${JSON.stringify(dayKey(14))}, status: 'unplanned', depth: 'Brief', model: '', subtasks: [], assessment: { weight: 10, kind: 'quiz', notes: 'Online, 20 minutes.', when: 'Week 9', source: 'qa.pdf' } })
    const result = await window.api.saveProjectData(${JSON.stringify(pid)}, data, undefined, data.rev ?? 0)
    if (!result.success) throw Error(result.error)
  })()`)
    await evaluate('window.api.getUpcomingSubtasks()')
    await nav('library')
    await nav('now')

    // Data safety: a save carrying a stale rev is refused; today's backup exists.
    const revCheck = await evaluate(`(async () => {
    const a = await window.api.loadProjectData(${JSON.stringify(pid)})
    const b = await window.api.loadProjectData(${JSON.stringify(pid)})
    const first = await window.api.saveProjectData(${JSON.stringify(pid)}, a, undefined, a.rev ?? 0)
    const second = await window.api.saveProjectData(${JSON.stringify(pid)}, b, undefined, b.rev ?? 0)
    return [first.success, second.success, !!second.conflict]
  })()`)
    assert.deepEqual(revCheck, [true, false, true], 'Stale save was not refused')
    assert.ok(
      await mainEvaluate(
        `${mainFs}.existsSync(${JSON.stringify(`${qaRoot}/system/backups/${dayKey()}/${pid}/project_data.json`)})`
      ),
      'No backup for today'
    )
    console.log('Verified stale-rev saves are refused and a daily backup exists.')

    // Plan today: fill 30 minutes, export .ics through a stubbed save dialog, clear.
    await click('Plan today')
    await selectByLabel('I have', '30')
    await click('Fill today')
    await waitFor(`document.body.innerText.includes('of 30 min')`, 'today plan')
    const planned = await evaluate('window.api.getTodayPlan()')
    assert.ok(planned && planned.items.length > 0 && planned.budgetMinutes === 30)
    await both('now-plan-today')
    const icsPath = '/tmp/focusforge-qa/qa-today.ics'
    await mainEvaluate(
      `(() => { const { dialog } = ${mainElectron}; dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(icsPath)} }); return true })()`
    )
    await click('Add to calendar')
    await waitFor(`document.body.innerText.includes('Saved. Open the file')`, 'ics saved')
    const ics = await mainEvaluate(`${mainFs}.readFileSync(${JSON.stringify(icsPath)}, 'utf8')`)
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.includes('BEGIN:VEVENT'), 'Bad .ics')
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, planned.items.length)
    await click("Today's plan options")
    await click('Clear today’s plan')
    await waitFor(`!document.body.innerText.includes('of 30 min')`, 'plan cleared')
    console.log(`Verified Plan today (${planned.items.length} steps), .ics export and clearing.`)

    // Weekly repeat: week 2 is created at once (due within 7 days), then stop repeating.
    await nav('library')
    await openTask('QA feature task')
    await click('Task options')
    await click('Repeat weekly…')
    await click('Repeat weekly')
    await waitFor(`document.body.innerText.includes('Repeats every')`, 'repeat saved')
    const series = (
      await evaluate(`window.api.loadProjectData(${JSON.stringify(pid)})`)
    ).tasks.filter((t) => t.seriesId === 'qa-feature')
    assert.ok(
      series.some((t) => t.title === 'QA feature task · week 2' && t.deadline === dayKey(7)),
      'Week 2 not created'
    )
    await screenshot('task-repeat', 1440, 900)
    await click('Task options')
    await click('Stop repeating')
    await waitFor(`!document.body.innerText.includes('Repeats every')`, 'repeat stopped')
    console.log('Verified weekly repeat creates next week and can be stopped.')

    // Unplanned (imported) task: "Not planned" row, task page CTA, Coach prefill.
    await nav('library')
    await click('COMP6991')
    await waitFor(`document.body.innerText.includes('Not planned')`, 'unplanned row')
    await click('QA imported quiz', false)
    await waitFor(`document.body.innerText.includes('Not planned yet')`, 'unplanned task page')
    await click('Plan with coach')
    await waitFor(
      `!!document.querySelector('textarea[aria-label="Message to the coach"]')?.value`,
      'coach prefill'
    )
    const brief = await evaluate(
      `document.querySelector('textarea[aria-label="Message to the coach"]').value`
    )
    assert.ok(
      brief.startsWith('QA imported quiz.') && brief.includes('10%'),
      `Coach brief: ${brief}`
    )
    assert.ok((await bodyText()).includes('Plan “QA imported quiz”'))
    await screenshot('coach-plan-imported', 1440, 900)
    console.log('Verified unplanned task row, task-page CTA and coach prefill.')

    // Weekly review card (written directly; generation itself is unit-tested) and the notification route.
    const review = {
      weekStart: dayKey(-6),
      generatedAt: new Date().toISOString(),
      summary: {
        weekStart: dayKey(-6),
        weekEnd: dayKey(),
        stepsDone: 7,
        activeDays: 3,
        currentStreak: 2,
        longestStreak: 4,
        tasksFinished: 1,
        carriedOver: 0,
        topProject: { name: 'COMP6991', steps: 5 },
        focusMinutes: 45,
        estimateRatio: null
      },
      text: 'QA review: you finished 7 steps across 3 days.',
      suggestion: 'QA suggestion: start with the smallest step.',
      source: 'template'
    }
    await mainEvaluate(
      `(() => { const fs = ${mainFs}; fs.mkdirSync(${JSON.stringify(`${qaRoot}/system/reviews`)}, { recursive: true }); fs.writeFileSync(${JSON.stringify(`${qaRoot}/system/reviews/${review.weekStart}.json`)}, ${JSON.stringify(JSON.stringify(review))}); return true })()`
    )
    await nav('now')
    await mainEvaluate(
      `(() => { const { BrowserWindow } = ${mainElectron}; const w = BrowserWindow.getAllWindows()[0]; w.webContents.send('reviews-changed'); w.webContents.send('open-history'); return true })()`
    )
    await waitFor(
      `document.body.innerText.includes('QA review: you finished 7 steps')`,
      'review card'
    )
    assert.ok((await bodyText()).includes('Try this week:'))
    await both('history-review')
    await mainEvaluate(
      `(() => { ${mainFs}.rmSync(${JSON.stringify(`${qaRoot}/system/reviews/${review.weekStart}.json`)}); return true })()`
    )
    console.log('Verified the weekly review card and its notification route to History.')

    if (liveAI) {
      // Stop: cancelling a coach turn restores the message with no error.
      await nav('library')
      await click('COMP6991')
      await click('New task with coach')
      await input(
        'textarea[aria-label="Message to the coach"]',
        'QA stop check: essay on the cold war'
      )
      await click('Send')
      await waitFor(
        `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Stop')`,
        'Stop button'
      )
      await click('Stop')
      await waitFor(
        `document.querySelector('textarea[aria-label="Message to the coach"]')?.value === 'QA stop check: essay on the cold war'`,
        'message restored after Stop',
        20000
      )
      assert.ok(
        !(await evaluate(`!!document.querySelector('[role="alert"]')`)),
        'Stop showed an error'
      )
      console.log('Verified Stop cancels a coach turn and restores the message.')

      // Stuck?: split the current Focus step into smaller ones (real model).
      await nav('library')
      await openTask('QA feature task')
      await click('Play next step')
      await waitFor(`!!document.querySelector('#focus-title')`, 'focus')
      const stuckTitle = await evaluate(`document.querySelector('#focus-title').textContent`)
      const before = (await loadTask(pid, 'qa-feature')).subtasks.length
      await click('Stuck? Make it smaller')
      await waitFor(
        `document.querySelector('#focus-title')?.textContent !== ${JSON.stringify(stuckTitle)}`,
        'split',
        120000
      )
      const after = await loadTask(pid, 'qa-feature')
      assert.ok(
        after.subtasks.length >= before + 1 && after.subtasks.length <= before + 2,
        'Split did not add 2-3 steps'
      )
      assert.ok(!after.subtasks.some((s) => s.title === stuckTitle), 'Stuck step still present')
      const firstNew = after.subtasks.find((s) => s.id.startsWith('split-'))
      assert.ok(firstNew && firstNew.timeEstimate <= 5, 'First split step over 5 min')
      await screenshot('focus-after-split', 1440, 900)
      await key('Escape')
      console.log(
        `Verified Stuck? split "${stuckTitle}" into ${after.subtasks.length - before + 1} steps.`
      )

      // Course outline import through a stubbed file picker and a generated PDF.
      const outlineTxt = '/tmp/focusforge-qa/qa-outline.txt'
      const outlinePdf = '/tmp/focusforge-qa/qa-outline.pdf'
      await writeFile(
        outlineTxt,
        [
          'QAXX1000 Testing Systems - Course Outline - Term 3, 2026',
          'Term runs from Monday 14 September 2026 to Friday 4 December 2026.',
          'Assessment summary',
          'Assignment 1: Unit tests          20%   Friday 20 November 2026, 5pm',
          'Lab quiz                          10%   Week 9 lab',
          'Final exam (2 hours)              70%   Exam period',
          'Assignment 1 is individual: write unit tests for the provided module and submit a zip.',
          'The lab quiz is a 20 minute online quiz. The final exam covers all lectures.'
        ].join('\n')
      )
      const { spawnSync } = await import('node:child_process')
      const pdf = spawnSync('cupsfilter', [outlineTxt], { maxBuffer: 10_000_000 })
      assert.equal(pdf.status, 0, 'cupsfilter could not make the outline PDF')
      await writeFile(outlinePdf, pdf.stdout)
      await mainEvaluate(
        `(() => { const { dialog } = ${mainElectron}; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(outlinePdf)}] }); return true })()`
      )
      await nav('library')
      await click('COMP6991')
      await click('Import course outline')
      await waitFor(
        `!!document.querySelector('[aria-label="Assessments found"]')`,
        'outline read',
        180000
      )
      await screenshot('outline-review', 1440, 900)
      // Keep only rows that already have a due date.
      await evaluate(`[...document.querySelectorAll('[aria-label="Assessments found"] > li')].forEach((li) => {
      const date = li.querySelector('input[type="date"]'); const box = li.querySelector('input[type="checkbox"]')
      if (box && box.checked && (!date || !date.value)) box.click() })`)
      await sleep(300)
      await evaluate(
        `document.querySelector('[aria-label="Assessments found"]').closest('form').querySelector('button[type="submit"]').click()`
      )
      await waitFor(
        `document.body.innerText.includes('Plan each one with the coach')`,
        'outline import',
        20000
      )
      const imported = (
        await evaluate(`window.api.loadProjectData(${JSON.stringify(pid)})`)
      ).tasks.filter((t) => t.status === 'unplanned' && t.assessment?.source === 'qa-outline.pdf')
      assert.ok(
        imported.some((t) => /assignment/i.test(t.title) && t.deadline === '2026-11-20'),
        'Assignment 1 not imported'
      )
      const ledger = await evaluate(`window.api.readContextLedger(${JSON.stringify(pid)})`)
      assert.ok(ledger.includes('outline "qa-outline.pdf"'), 'Outline not noted in the ledger')
      console.log(`Verified course outline import (${imported.length} task(s)).`)
    }

    // Clean up the feature fixtures so later checks see the original data.
    await evaluate(`(async () => {
    const data = await window.api.loadProjectData(${JSON.stringify(pid)})
    data.tasks = data.tasks.filter((t) => !t.id.startsWith('qa-f') && t.seriesId !== 'qa-feature' && t.assessment?.source !== 'qa-outline.pdf')
    await window.api.saveProjectData(${JSON.stringify(pid)}, data)
    await window.api.saveTodayPlan(null)
  })()`)
  }

  // Coach error states, deterministic and with no model call: the chat-turn
  // handler is replaced from the main process (it stays replaced for the rest
  // of this run, so this comes after the live AI block).
  const coachErrors = [
    {
      handler: `async () => ({ status: 'error', message: 'No API key found for OpenAI. Add OPENAI_API_KEY to engine/.env, then try again.', data: null })`,
      expect: 'No API key found for OpenAI'
    },
    {
      handler: `async () => { throw new Error('engine crashed') }`,
      expect: "Couldn't reach the coach"
    }
  ]
  for (const { handler, expect } of coachErrors) {
    await mainEvaluate(`(() => { const { ipcMain } = process.getBuiltinModule('module').createRequire(process.cwd() + '/')('electron');
      ipcMain.removeHandler('chat-turn'); ipcMain.handle('chat-turn', ${handler}); return true })()`)
    await nav('library')
    await click('COMP6991')
    await click('New task with coach')
    await input('textarea[aria-label="Message to the coach"]', 'QA error-state check')
    await click('Send')
    await waitFor(`!!document.querySelector('[role="alert"]')`, `coach error "${expect}"`)
    const alertText = await evaluate(`document.querySelector('[role="alert"]').innerText`)
    assert.ok(alertText.includes(expect), `Coach error copy: ${alertText}`)
    assert.ok(!/System Error/i.test(alertText))
    assert.equal(
      await evaluate(`document.querySelector('textarea[aria-label="Message to the coach"]').value`),
      'QA error-state check',
      'Failed send did not restore the message for retry'
    )
    await screenshot(
      `coach-error-${coachErrors.indexOf(coachErrors.find((c) => c.expect === expect)) + 1}`,
      1440,
      900
    )
  }
  console.log('Verified coach engine-error and IPC-failure states keep the message for retry.')

  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  })
  assert.ok(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`))
  await nav('now')
  await both('now-reduced-motion')
  const transitionDuration = await evaluate(
    `getComputedStyle(document.querySelector('button')).transitionDuration`
  )
  assert.equal(transitionDuration, '0s')
  await writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      {
        checks,
        heatmap,
        errors,
        dialogs,
        liveAI,
        fixture: ids,
        realProjects: projects.map((p) => p.name)
      },
      null,
      2
    )
  )
  assert.equal(errors.length, 0, `Renderer errors: ${JSON.stringify(errors)}`)
  console.log(`QA passed. ${checks.length} screenshots. No renderer errors. Output: ${output}`)
} finally {
  socket?.close()
  mainSocket?.close()
  app.kill('SIGTERM')
  await writeFile(path.join(output, 'electron.log'), appLog)
}
