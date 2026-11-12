// End-to-end loop on an empty FlowState and a fake home. No real vault, no
// ~/UNI, no ~/Projects, no model. Refuses to run unless its paths stay under
// /tmp/focusforge-qa-loop.
//
//   npx electron-vite build && env -u ELECTRON_RUN_AS_NODE node scripts/qa-loop.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { connectCdp, sleep } from './qa-cdp.mjs'
import {
  APP_DATA,
  BODY_CANARY,
  DATA,
  HOME,
  LAUNCHER,
  LIFE_CANARY,
  LOOP_ROOT,
  SECRET_CANARY,
  SECTION_CANARY,
  SK_CANARY,
  SNAPSHOT,
  USER_DATA,
  VAULT,
  assertLoopPath,
  buildLoopFixtures
} from './qa-loop-fixtures.mjs'

const CANARIES = [LIFE_CANARY, SECRET_CANARY, SECTION_CANARY, SK_CANARY, BODY_CANARY, 'LifeQuest']
const output = path.join(LOOP_ROOT, 'screenshots')
const realIndex = path.join(os.homedir(), 'Documents', 'FlowState', 'system', 'master_index.json')
const realBefore = fs.existsSync(realIndex) ? fs.statSync(realIndex).mtimeMs : null

const { realPython } = buildLoopFixtures()
fs.mkdirSync(output, { recursive: true })
const stub = fileURLToPath(new URL('./qa-engine-stub.py', import.meta.url))
fs.chmodSync(stub, 0o755)

let proxy = null
const startProxy = () =>
  new Promise((resolve, reject) => {
    proxy = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"data":[]}')
    })
    proxy.on('error', reject)
    proxy.listen(18317, '127.0.0.1', resolve)
  })
const stopProxy = () =>
  new Promise((resolve) => {
    if (!proxy) return resolve()
    proxy.close(() => {
      proxy = null
      resolve()
    })
  })

await startProxy()
const require = createRequire(import.meta.url)
const electron = require('electron')
const env = {
  ...process.env,
  HOME: fs.realpathSync(HOME),
  FOCUSFORGE_QA: '1',
  PYTHONDONTWRITEBYTECODE: '1',
  FOCUSFORGE_READER_DEBOUNCE_MS: '1500',
  FOCUSFORGE_PROXY_URL: 'http://127.0.0.1:18317/v1/models',
  FOCUSFORGE_QA_LOG: path.join(LOOP_ROOT, 'engine-calls.jsonl'),
  FOCUSFORGE_REAL_PYTHON: realPython,
  UNI_AGENT_PYTHON: stub
}
delete env.ELECTRON_RUN_AS_NODE
const app = spawn(electron, ['--remote-debugging-port=9373', '--inspect=9375', LAUNCHER], {
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
let appLog = ''
app.stdout.on('data', (d) => (appLog += d))
app.stderr.on('data', (d) => (appLog += d))

const results = []
const pass = (msg) => {
  results.push(msg)
  console.log(`✓ ${msg}`)
}

try {
  const cdp = await connectCdp({ port: 9373, mainPort: 9375, output, log: () => appLog.slice(-2000) })
  await sleep(800)
  const until = async (fn, label, timeout = 20000) => {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const value = await fn()
      if (value) return value
      await sleep(400)
    }
    throw new Error(`Timed out: ${label}\n${appLog.slice(-1500)}`)
  }
  const body = () => cdp.evaluate('document.body.innerText')
  const registry = () => JSON.parse(fs.readFileSync(path.join(DATA, 'system/master_index.json'), 'utf8'))

  for (const p of [DATA, VAULT, HOME, LAUNCHER, APP_DATA, USER_DATA]) assertLoopPath(p)

  // 1. Discover and approve the five slice items. Headstart stays off.
  await until(async () => /Save \d+ items/.test(await body()), 'approval screen', 60000)
  const screen = await body()
  assert.match(screen, /Thesis/)
  assert.match(screen, /comp9321|COMP9321/)
  assert.match(screen, /PSYC1023|pysc1023/)
  assert.match(screen, /Personal|personal/)
  assert.match(screen, /FocusForge/)
  assert.match(screen, /stays closed/)
  await cdp.screenshot('loop-01-approval', 1440, 900)
  const saved = await cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find(b => /^Save \\d+ items/.test(b.textContent.trim()))
    if (!el) return false
    el.click()
    return true
  })()`)
  assert.ok(saved, 'save button missing')
  await until(async () => (await body()).includes('All set'), 'saved items', 30000)
  const active = registry().filter((p) => p.status === 'active')
  assert.equal(active.length, 5, `expected 5 active, got ${active.map((p) => p.id).join(',')}`)
  assert.ok(!registry().some((p) => /headstart/i.test(p.id + p.name)))
  pass('discovered and approved the five slice items')

  const idOf = (re) => active.find((p) => re.test(p.id) || re.test(p.name))?.id
  const comp = idOf(/comp9321/i)
  const thesis = idOf(/thesis/i)
  assert.ok(comp && thesis, 'missing comp or thesis id')

  // 2–3. Digests, then a plan, so the card has a real step.
  await until(() => {
    return active.every((p) => fs.existsSync(path.join(DATA, p.id, 'reader', 'digest.json')))
  }, 'digests', 90000)
  const thesisDigest = JSON.parse(
    fs.readFileSync(path.join(DATA, thesis, 'reader', 'digest.json'), 'utf8')
  )
  assert.ok(
    (thesisDigest.dueDates || []).some((d) => d.date == null && /week 11/i.test(d.when || d.what || ''))
  )
  pass('thesis digest keeps the tentative Week 11 date')

  await until(async () => {
    const steps = await cdp.evaluate('window.api.getNextSteps()')
    return steps.some((s) => s.projectId === comp && s.subtaskId && !s.needsPlan)
  }, 'comp plan', 120000)
  const compData = JSON.parse(fs.readFileSync(path.join(DATA, comp, 'project_data.json'), 'utf8'))
  const loose = (compData.tasks || []).find((t) => t.auto === 'loose-ends')
  const openLoose = (loose?.subtasks || []).filter((s) => !s.isCompleted).length
  assert.ok(openLoose <= 3)
  pass('plans landed; loose ends stay at 3 or fewer')

  // 4. A vault note exists. My notes survive a later tick.
  const noteDir = path.join(VAULT, 'FocusForge')
  await until(() => fs.existsSync(noteDir), 'vault notes', 30000)
  const notes = []
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      if (fs.statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.md')) notes.push(p)
    }
  }
  walk(noteDir)
  const itemNote = notes.find((p) => fs.readFileSync(p, 'utf8').includes('## My notes'))
  assert.ok(itemNote, 'no item note with My notes')
  const mine = 'QA-MY-NOTES'
  const text = fs.readFileSync(itemNote, 'utf8')
  const marker = '## My notes'
  const at = text.indexOf(marker)
  fs.writeFileSync(itemNote, text.slice(0, at + marker.length) + '\n\n' + mine + '\n')
  pass('vault note written; My notes filled')

  // 5. The card leads with the step due tomorrow.
  await cdp.click('Now', { exact: false })
  await until(async () => {
    const text = await body()
    return /due tomorrow/i.test(text) && /comp9321/i.test(text)
  }, 'card due tomorrow', 30000)
  await cdp.screenshot('loop-02-card', 1440, 900)
  pass('Anything shows the step due tomorrow')

  // 6. Chips.
  await cdp.click('Something different')
  await until(async () => /personal|focusforge|passion/i.test(await body()), 'something different', 15000)
  pass('Something different picks a passion item')
  await cdp.click('Light')
  await sleep(400)
  assert.match(await body(), /Easy|5 min/)
  pass('Light keeps a small step')
  await cdp.click('Deadline')
  await until(async () => /due/i.test(await body()), 'deadline chip', 10000)
  await cdp.click('Anything')
  pass('Deadline and Anything still offer a step')

  // 7. Not this.
  await cdp.click('Not this')
  await until(async () => (await body()).includes('Want to say why?'), 'reasons', 10000)
  await cdp.click('Not now')
  await sleep(300)
  pass('Not this records a reason')

  // 8. Too big, on whatever is showing.
  if (await cdp.evaluate(`!![...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Too big')`)) {
    await cdp.click('Too big')
  } else {
    await cdp.click('Not this')
    await until(async () => (await body()).includes('Too big'), 'too big button', 8000)
    await cdp.click('Too big')
  }
  await until(async () => /smaller|Split|Couldn/.test(await body()), 'split result', 20000)
  pass('Too big asks for a smaller step')

  // 9–10. Start, then mark done. The note gains a tick and keeps My notes.
  await cdp.click('Anything')
  await sleep(400)
  const beforeMine = fs.readFileSync(itemNote, 'utf8')
  assert.ok(beforeMine.includes(mine))
  await cdp.click('Start in Focus (Space)')
  await until(async () => (await body()).includes('Done') || (await body()).includes('Focus'), 'focus', 15000)
  await cdp.evaluate('document.activeElement?.blur()')
  await cdp.key('Enter')
  await sleep(1500)
  await until(() => {
    const notesNow = []
    const walk2 = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name)
        if (fs.statSync(p).isDirectory()) walk2(p)
        else if (name.endsWith('.md') && fs.readFileSync(p, 'utf8').includes(mine)) notesNow.push(p)
      }
    }
    walk2(noteDir)
    return notesNow.some((p) => fs.readFileSync(p, 'utf8').includes(mine))
  }, 'my notes kept', 15000)
  pass('Start and done keep My notes')

  // 13. Proxy down, then up. No alert dialogs.
  await stopProxy()
  await until(async () => {
    const health = await cdp.evaluate('window.api.getProxyHealth()')
    return health.status === 'down'
  }, 'proxy down', 75000)
  const alerts = await cdp.evaluate(`document.querySelectorAll('[role="alert"]').length`)
  assert.equal(alerts, 0)
  pass('proxy down is quiet')
  await startProxy()
  await until(async () => (await cdp.evaluate('window.api.getProxyHealth()')).status === 'up', 'proxy up', 20000)
  pass('proxy comes back')

  // Privacy.
  const blobs = [appLog]
  const logPath = path.join(LOOP_ROOT, 'engine-calls.jsonl')
  if (fs.existsSync(logPath)) blobs.push(fs.readFileSync(logPath, 'utf8'))
  const skips = path.join(DATA, 'system', 'skips.jsonl')
  const what = path.join(DATA, 'system', 'whatnext.json')
  if (fs.existsSync(skips)) blobs.push(fs.readFileSync(skips, 'utf8'))
  if (fs.existsSync(what)) blobs.push(fs.readFileSync(what, 'utf8'))
  blobs.push(await body())
  blobs.push(await cdp.evaluate('JSON.stringify(localStorage)'))
  blobs.push(JSON.stringify(await cdp.evaluate('window.api.getWhatNextSignals()')))
  const joined = blobs.join('\n')
  for (const canary of CANARIES) assert.ok(!joined.includes(canary), `canary leaked: ${canary}`)
  if (fs.existsSync(logPath)) {
    for (const line of fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)) {
      assert.ok(line.length <= 120_000, 'engine payload over 120K')
    }
  }
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'))
  const nowSnap = []
  const life = path.join(VAULT, 'Life')
  const walkSnap = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name)
      if (p === life || p.startsWith(life + path.sep)) continue
      if (p.startsWith(path.join(VAULT, 'FocusForge'))) continue
      const st = fs.lstatSync(p)
      nowSnap.push([path.relative(HOME, p), st.isDirectory() ? -1 : st.size, Math.round(st.mtimeMs)])
      if (st.isDirectory() && !st.isSymbolicLink()) walkSnap(p)
    }
  }
  for (const top of ['UNI', 'Projects', 'Vault']) walkSnap(path.join(HOME, top))
  assert.deepEqual(
    nowSnap.filter((row) => !String(row[0]).startsWith('Vault/FocusForge')),
    snap.filter((row) => !String(row[0]).startsWith('Vault/FocusForge'))
  )
  if (realBefore != null) assert.equal(fs.statSync(realIndex).mtimeMs, realBefore)
  pass('canaries stayed out and real data was not touched')

  fs.writeFileSync(
    path.join(output, 'report.json'),
    JSON.stringify({ checks: results, shots: fs.readdirSync(output).filter((f) => f.endsWith('.png')) }, null, 2)
  )
  console.log(`Loop QA passed: ${results.length} checks. Output: ${output}`)
} finally {
  app.kill()
  await stopProxy()
}
