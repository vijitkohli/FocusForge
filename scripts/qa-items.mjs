// Electron QA for item discovery and the approval screen, against the fixture
// built by scripts/qa-fixtures.mjs (rebuilt at the start of every run).
//
//   npx electron-vite build && node scripts/qa-items.mjs [output]
//
// Refuses to run unless every path it will hand the app (data folder, settings
// paths, registry, launcher, output) is under /tmp/focusforge-qa. The app is
// launched with HOME pointed at the fake home and its own appData, so the real
// vault, ~/UNI, ~/Projects and ~/Documents/FlowState are never involved.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { connectCdp, sleep } from './qa-cdp.mjs'
import {
  BODY_CANARY,
  DATA,
  HOME,
  ITEMS,
  LAUNCHER,
  LIFE_CANARY,
  SECRET_CANARY,
  SNAPSHOT,
  VAULT,
  assertQaPath,
  buildFixtures,
  snapshotHome
} from './qa-fixtures.mjs'

const output = assertQaPath(process.argv[2] ?? path.join(ITEMS, 'screenshots'), 'output')
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const REAL_HOME = os.homedir()

// ---------- Fixture and preflight
buildFixtures()
fs.mkdirSync(output, { recursive: true })
const settingsPath = path.join(DATA, 'system/settings.json')
const registryPath = path.join(DATA, 'system/master_index.json')
const discoveryPath = path.join(DATA, 'system/discovery.json')
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
{
  for (const p of [ITEMS, HOME, VAULT, DATA, LAUNCHER, settingsPath, registryPath]) assertQaPath(p)
  const s = readJson(settingsPath)
  assertQaPath(s.vaultPath, 'settings.vaultPath')
  for (const r of s.sourceRoots) assertQaPath(r.path, 'settings.sourceRoots')
  for (const e of readJson(registryPath)) assertQaPath(e.path, `registry ${e.id}`)
  const launcher = fs.readFileSync(LAUNCHER, 'utf8')
  for (const k of ['appData', 'documents', 'userData'])
    assert.match(launcher, new RegExp(`setPath\\('${k}', "/tmp/focusforge-qa/`), `launcher ${k}`)
}

const require = createRequire(import.meta.url)
const electron = require('electron')
// The real (/private/tmp) spelling, so labels read ~/UNI/... like on a normal home.
const env = { ...process.env, HOME: fs.realpathSync(HOME) }
delete env.ELECTRON_RUN_AS_NODE
const app = spawn(electron, ['--remote-debugging-port=9343', '--inspect=9345', LAUNCHER], {
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
let appLog = ''
app.stdout.on('data', (d) => (appLog += d))
app.stderr.on('data', (d) => (appLog += d))

let cdp
const results = []
const pass = (msg) => {
  results.push(msg)
  console.log(`✓ ${msg}`)
}

/** Every approval row as plain data. */
const ROWS = `[...document.querySelectorAll('li[data-item-key]')].map(li => {
  const radio = li.querySelector('[role="radiogroup"] [aria-checked="true"]');
  const box = li.querySelector('input[type="checkbox"]');
  const holder = li.closest('[id$="-also"], [id$="-quiet"]');
  return {
    key: li.dataset.itemKey,
    name: li.querySelector('h3 span')?.textContent.trim() ?? '',
    category: li.closest('section[data-category]')?.dataset.category,
    existing: li.textContent.includes('Already in FocusForge'),
    checked: box ? box.checked : null,
    status: radio ? radio.textContent.trim() : null,
    where: holder ? (holder.id.endsWith('-also') ? 'also' : 'quiet') : 'main',
    chips: [...li.querySelectorAll('ul[aria-label^="Sources for"] li')].map(c => c.textContent.trim()),
    text: li.innerText
  } })`
const rows = () => cdp.evaluate(ROWS)
const footer = () =>
  cdp.evaluate(
    `[...document.querySelectorAll('footer button')].map(b => b.textContent.trim()).find(t => t.startsWith('Save')) ?? ''`
  )
const row = async (name) => {
  const found = (await rows()).find((r) => r.name === name)
  assert.ok(found, `Row not found: ${name}`)
  return found
}
const liScope = (name) =>
  `[...document.querySelectorAll('li[data-item-key]')].find(li => li.querySelector('h3 span')?.textContent.trim() === ${JSON.stringify(name)})`
const stubDialog = (paths) =>
  cdp.mainEvaluate(`(() => { const { dialog } = process.getBuiltinModule('module').createRequire(process.cwd() + '/')('electron');
    globalThis.__qaOpen = globalThis.__qaOpen || dialog.showOpenDialog;
    dialog.showOpenDialog = async () => (${JSON.stringify({ canceled: false, filePaths: paths })}); return true })()`)
const restoreDialog = () =>
  cdp.mainEvaluate(`(() => { const { dialog } = process.getBuiltinModule('module').createRequire(process.cwd() + '/')('electron');
    if (globalThis.__qaOpen) dialog.showOpenDialog = globalThis.__qaOpen; return true })()`)
const waitLoaded = () =>
  cdp.waitFor(
    `document.body.innerText.includes("Here's what I found") && !document.body.innerText.includes('Looking through your folders') && document.querySelectorAll('li[data-item-key]').length > 0`,
    'approval screen loaded'
  )

try {
  cdp = await connectCdp({ port: 9343, mainPort: 9345, output, log: () => appLog })
  await sleep(600)

  // The app's own view of the world must be the fixture.
  const projects = await cdp.evaluate('window.api.getProjects()')
  assert.ok(
    projects.every((p) => assertQaPath(p.path)),
    'registry outside QA root'
  )

  // ---------- First run lands on the approval screen
  await waitLoaded()
  pass('first run opens the approval screen')
  await cdp.screenshot('items-loaded', 1440, 900)
  await cdp.screenshot('items-loaded', 900, 670)

  const order = await cdp.evaluate(
    `[...document.querySelectorAll('main section[data-category]')].map(s => s.dataset.category)`
  )
  assert.deepEqual(order, ['Learning', 'Career', 'Projects', 'Life'])
  pass('groups are Learning, Career, Projects, Life')

  const text = await cdp.evaluate('document.body.innerText')
  assert.ok(text.includes("I'm starting you with five. Tick anything else you want me to follow."))
  pass('intro line')

  let all = await rows()
  const active = all.filter((r) => r.status === 'Active').map((r) => r.name)
  assert.deepEqual(
    [...active].sort(),
    ['FocusForge', 'PSYC1023', 'Personal Website', 'Thesis', 'comp9321'].sort(),
    `active rows: ${JSON.stringify(active)}`
  )
  pass('exactly 5 rows start active (the slice)')
  for (const r of all.filter((r) => !r.existing && !active.includes(r.name)))
    assert.equal(r.checked, false, `${r.name} should start unticked`)
  pass('every other suggestion starts unticked')

  const ff = await row('FocusForge')
  assert.ok(
    ff.chips.some((c) => c.startsWith('PROJECTS TO DO.md › FocusForge')),
    JSON.stringify(ff)
  )
  const thesis = await row('Thesis')
  assert.ok(
    thesis.chips.some((c) => c.includes('thesis-experiments')),
    'thesis-experiments merged'
  )
  assert.ok(
    thesis.chips.some((c) => c.startsWith('Thesis Hub/')),
    'Thesis Hub attached'
  )
  const psyc = await row('PSYC1023')
  assert.ok(
    psyc.chips.some((c) => c.includes('pysc1023')),
    'pysc1023 attached'
  )
  assert.ok(psyc.existing, 'PSYC1023 adopted')
  pass('section chip on FocusForge; thesis, PSYC1023 sources')

  const headstart = await row('Headstart Mentoring')
  assert.equal(headstart.checked, false)
  assert.equal(headstart.where, 'also')
  assert.ok(
    headstart.chips.some((c) => c.includes('› Headstart')),
    JSON.stringify(headstart)
  )
  pass('Headstart: section chip, unticked under "Also found"')

  const leet = await row('leetcode')
  assert.ok(leet.existing)
  assert.equal(leet.status, 'Paused')
  const career = all.find((r) => r.category === 'Career')
  assert.ok(career, 'Career row exists')
  assert.equal(career.checked, false)
  const comp2511 = await row('COMP2511')
  assert.equal(comp2511.where, 'quiet')
  assert.equal(comp2511.checked, false)
  assert.equal(
    await cdp.evaluate(`document.getElementById('items-group-learning-quiet').hidden`),
    true,
    '"Quiet for a while" starts collapsed'
  )
  pass('leetcode kept as paused; Career unticked; COMP2511 under collapsed "Quiet for a while"')

  const life = await cdp.evaluate(
    `(() => { const s = document.querySelector('section[data-category="Life"]'); return { rows: s.querySelectorAll('li[data-item-key]').length, text: s.innerText } })()`
  )
  assert.equal(life.rows, 0)
  assert.ok(life.text.includes('Your own Life folder stays closed.'))
  assert.ok(
    !all.some(
      (r) =>
        r.name === 'Reading' || r.chips.some((c) => /Reading\.md|Reading\/|FocusForge\//.test(c))
    ),
    'a row came from the app-owned FocusForge/Life folder'
  )
  for (const bad of ['Learning Hub', 'PROJECTS TO DO', 'TODO', 'Now'])
    assert.ok(!all.some((r) => r.name === bad), `${bad} should not be a row`)
  pass('Life group empty with the closed line; no row from FocusForge/Life or hub notes')

  assert.equal(await footer(), 'Save 6 items · 5 active')
  pass('footer counts')

  // ---------- Edits: suggested name, keyboard status change, hide
  await cdp.click('More for comp9321')
  await cdp.click('Call it COMP9321')
  await row('COMP9321')
  await cdp.evaluate(
    `${liScope('Thesis')}.querySelector('[role="radiogroup"] [aria-checked="true"]').focus()`
  )
  await cdp.key('ArrowRight', 'ArrowRight')
  assert.equal((await row('Thesis')).status, 'Paused')
  assert.equal(await footer(), 'Save 6 items · 4 active')
  await cdp.key('ArrowLeft', 'ArrowLeft')
  assert.equal((await row('Thesis')).status, 'Active')
  pass('rename to suggested name; status by keyboard')

  await cdp.click('Quiet for a while (', { exact: false })
  await cdp.click('More for Redirect Personal')
  await cdp.click('Hide')
  assert.ok(!(await rows()).some((r) => r.name === 'Redirect Personal'))
  assert.ok((await cdp.evaluate('document.body.innerText')).includes('Hidden (1)'))
  pass('hide moves a suggestion to Hidden')

  // ---------- Add a Life item
  await cdp.click('Add a Life item')
  await cdp.waitFor(
    `document.activeElement?.getAttribute('placeholder') === 'For example, Reading'`,
    'Life name input focused'
  )
  await cdp.typeText('Reading')
  await cdp.key('Enter')
  const reading = await row('Reading')
  assert.equal(reading.category, 'Life')
  assert.equal(reading.status, 'Active')
  assert.equal(await footer(), 'Save 7 items · 6 active')
  pass('Add a Life item → Reading in Life, Active')

  await stubDialog([path.join(VAULT, 'Life')])
  await cdp.click('Add a folder or note', { scope: liScope('Reading') })
  await cdp.waitFor(
    `${liScope('Reading')}.querySelector('[role="alert"]') !== null`,
    'Life refusal'
  )
  const refusal = await cdp.evaluate(
    `${liScope('Reading')}.querySelector('[role="alert"]').textContent`
  )
  assert.equal(refusal, "Your vault's Life folder stays closed. Pick something else.")
  assert.equal((await row('Reading')).chips.length, 0)
  pass('picking the vault Life folder is refused warmly')

  const readingList = path.join(HOME, 'Projects/reading-list')
  await stubDialog([readingList])
  await cdp.click('Add a folder or note', { scope: liScope('Reading') })
  await cdp.waitFor(
    `${liScope('Reading')}.querySelectorAll('ul li').length === 1`,
    'source attached'
  )
  assert.ok((await row('Reading')).chips[0].includes('reading-list'))
  await restoreDialog()
  pass('a folder from ~/Projects attaches to the Life item')

  await cdp.screenshot('items-edited', 1440, 900)
  await cdp.tabCheck('items', 120)
  pass('focus ring on every tab stop (120 stops)')

  // ---------- Save
  await cdp.click('Save 7 items · 6 active')
  await cdp.waitFor(
    `document.body.innerText.includes('All set. Your next step is on Now Playing.')`,
    'saved line'
  )
  await cdp.waitFor(`!document.body.innerText.includes("Here's what I found")`, 'navigate to Now')
  pass('save shows the all-set line and goes to Now Playing')

  const registry = readJson(registryPath)
  const byName = Object.fromEntries(registry.map((e) => [e.name, e]))
  const activeNames = registry.filter((e) => (e.status ?? 'active') === 'active').map((e) => e.name)
  assert.deepEqual(
    activeNames.sort(),
    ['COMP9321', 'FocusForge', 'PSYC1023', 'Personal Website', 'Reading', 'Thesis'].sort(),
    `active registry: ${JSON.stringify(activeNames)}`
  )
  assert.equal(registry.length, 7, `registry: ${registry.map((e) => e.name)}`)
  assert.equal(byName.leetcode?.status, 'paused')
  for (const id of ['comp9321', 'Thesis', 'PSYC1023', 'leetcode'])
    assert.ok(
      registry.some((e) => e.id === id),
      `adopted id ${id} kept`
    )
  assert.equal(byName.COMP9321.id, 'comp9321')
  for (const e of registry)
    assert.ok(['Learning', 'Career', 'Projects', 'Life'].includes(e.category), `${e.name} category`)
  for (const bad of [
    'Headstart Mentoring',
    'COMP2511',
    'Career',
    'Redirect Personal',
    'Reading List'
  ])
    assert.ok(!byName[bad], `${bad} must not be created`)
  assert.ok(
    byName.FocusForge.sources.some((s) =>
      s.endsWith('/Vault/Projects/PROJECTS TO DO.md#FocusForge')
    ),
    JSON.stringify(byName.FocusForge.sources)
  )
  assert.equal(byName.Reading.category, 'Life')
  assert.deepEqual(
    byName.Reading.sources.map((s) => path.basename(s)),
    ['reading-list']
  )
  for (const e of registry)
    for (const s of e.sources ?? []) assertQaPath(s.replace(/\.md#.*$/, '.md'))
  const settings = readJson(settingsPath)
  assert.ok(settings.discoveryCompletedAt, 'discoveryCompletedAt set')
  assert.ok(readJson(discoveryPath).dismissedKeys.length === 1, 'hidden key saved')
  pass('registry: 6 active (5 + Reading), leetcode paused, adopted ids kept, nothing else created')

  // ---------- Sidebar and Library
  await sleep(500)
  const sidebar = await cdp.evaluate(
    `[...document.querySelectorAll('nav[aria-label="Items"] button')].map(b => b.getAttribute('aria-label')).filter(n => n !== 'See all')`
  )
  assert.deepEqual(
    [...sidebar].sort(),
    ['COMP9321', 'FocusForge', 'PSYC1023', 'Personal Website', 'Reading', 'Thesis'].sort(),
    `sidebar: ${JSON.stringify(sidebar)}`
  )
  pass('Sidebar lists only active items')

  await cdp.click('Library')
  await cdp.waitFor(`!!document.querySelector('main section[data-category]')`, 'library groups')
  const lib =
    await cdp.evaluate(`[...document.querySelectorAll('main section[data-category]')].map(s => ({
    c: s.dataset.category, names: [...s.querySelectorAll('h3')].map(h => h.textContent.trim()), text: s.innerText }))`)
  assert.deepEqual(
    lib.map((s) => s.c),
    ['Learning', 'Career', 'Projects', 'Life']
  )
  const learning = lib.find((s) => s.c === 'Learning')
  assert.ok(learning.names.includes('leetcode') && learning.text.includes('Paused'))
  assert.deepEqual(lib.find((s) => s.c === 'Life').names, ['Reading'])
  await cdp.screenshot('library-items', 1440, 900)
  await cdp.screenshot('library-items', 900, 670)

  await cdp.click('Options for PSYC1023')
  await cdp.click('Archive')
  await cdp.waitFor(`document.body.innerText.includes('Archived (1)')`, 'archived group')
  assert.equal(await cdp.evaluate(`document.getElementById('library-archived').hidden`), true)
  assert.equal(readJson(registryPath).find((e) => e.id === 'PSYC1023').status, 'archived')
  await sleep(300)
  assert.ok(
    !(await cdp.evaluate(
      `[...document.querySelectorAll('nav[aria-label="Items"] button')].some(b => b.getAttribute('aria-label') === 'PSYC1023')`
    )),
    'archived item left the sidebar'
  )
  await cdp.click('Archived (1)')
  await cdp.click('Options for PSYC1023')
  await cdp.click('Make active')
  assert.equal(readJson(registryPath).find((e) => e.id === 'PSYC1023').status, 'active')
  pass('Library: four sections, Paused label, archived collapsed, archive/make active')

  await cdp.click('New item')
  await cdp.evaluate(`(() => {
    const i = document.querySelector('input[placeholder="For example, COMP6991"]'); i.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i, 'QA errand');
    i.dispatchEvent(new Event('input', {bubbles:true}));
    const l = [...document.querySelectorAll('label')].find(l => l.textContent.trim() === 'Category');
    const s = document.getElementById(l.htmlFor);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s, 'Career');
    s.dispatchEvent(new Event('change', {bubbles:true})) })()`)
  await sleep(150)
  await cdp.click('Create')
  await cdp.waitFor(`document.body.innerText.includes('New task with coach')`, 'new item opened')
  const errand = readJson(registryPath).find((e) => e.name === 'QA errand')
  assert.equal(errand?.category, 'Career')
  await cdp.click('Library')
  await cdp.click('Options for QA errand')
  await cdp.click('Delete item')
  await sleep(400)
  assert.ok(!readJson(registryPath).some((e) => e.name === 'QA errand'))
  pass('New item with a category select, then delete')

  // ---------- Settings: Sources
  await cdp.click('Profile')
  await cdp.waitFor(`document.body.innerText.includes('Obsidian vault')`, 'sources section')
  const sources = await cdp.evaluate(
    `[...document.querySelectorAll('section')].find(s => s.querySelector('h2')?.textContent === 'Sources').innerText`
  )
  assert.ok(sources.includes('/Vault') && sources.includes('UNI') && sources.includes('Projects'))
  assert.ok(sources.includes('Life folder stays closed'))
  pass('Settings shows vault and folders read-only')

  // ---------- Look again: idempotent
  await cdp.click('Review items')
  await waitLoaded()
  all = await rows()
  assert.ok(!(await cdp.evaluate('document.body.innerText')).includes("I'm starting you with five"))
  for (const n of [
    'COMP9321',
    'FocusForge',
    'PSYC1023',
    'Personal Website',
    'Thesis',
    'Reading',
    'leetcode'
  ])
    assert.ok(
      all.some((r) => r.name === n && r.existing),
      `${n} adopted on re-run`
    )
  assert.equal(all.filter((r) => r.name === 'FocusForge').length, 1, 'no duplicate rows')
  assert.ok(!all.some((r) => r.name === 'Redirect Personal'), 'hidden stays hidden')
  assert.equal(await footer(), 'Save 7 items · 6 active')
  await cdp.screenshot('items-again', 1440, 900)
  pass('re-run is idempotent: everything adopted, hidden stays hidden')
  await cdp.click('Now')

  // ---------- Canaries
  const trace = await cdp.mainEvaluate('JSON.stringify(globalThis.__qaPaths)').then(JSON.parse)
  assert.ok(trace.length > 50, 'tracer recorded paths')
  // The tracer must have seen the guard's real work, or the checks below prove nothing.
  assert.ok(
    trace.some(([op, p]) => op === 'open' && p.endsWith('/Vault/Projects/PROJECTS TO DO.md')),
    'tracer saw the hub-note heading read'
  )
  assert.ok(
    trace.some(([op, p]) => op === 'opendir' && p.endsWith('/home/UNI')),
    'tracer saw the UNI listing'
  )
  const roots = ['/tmp/focusforge-qa/', '/private/tmp/focusforge-qa/']
  const lifeRoots = roots.map((r) => (r + 'items/home/Vault/Life').toLowerCase())
  const allowedOutside = ['out/', 'engine/', 'node_modules/'].map((d) => path.join(REPO, d))
  const hubs = ['PROJECTS TO DO.md', 'Learning Hub.md']
  for (const [op, p] of trace) {
    if (!p.startsWith('/')) continue
    const low = p.normalize('NFC').toLowerCase()
    assert.ok(
      !lifeRoots.some((l) => low === l || low.startsWith(l + '/') || low.startsWith(l + ' ')),
      `touched Life: ${op} ${p}`
    )
    assert.ok(!/api token\.rtf$|\/\.env$/i.test(p), `touched a secret: ${op} ${p}`)
    if (!roots.some((r) => p.startsWith(r))) {
      const real = p.startsWith(REAL_HOME + '/')
      if (real)
        assert.ok(
          allowedOutside.some((a) => p.startsWith(a)),
          `touched a real home path: ${op} ${p}`
        )
      continue
    }
    const inHome = roots.some((r) => p.startsWith(r + 'items/home/'))
    if (inHome && ['readFile', 'readFileSync', 'open', 'openSync'].includes(op))
      assert.ok(hubs.includes(path.basename(p)), `read file contents in home: ${op} ${p}`)
  }
  pass(`tracer: ${trace.length} paths, none in Life, no secrets, content reads only hub notes`)

  const dom = await cdp.evaluate('document.body.innerText')
  const corpus = {
    dom,
    discovery: fs.readFileSync(discoveryPath, 'utf8'),
    registry: fs.readFileSync(registryPath, 'utf8'),
    log: appLog
  }
  for (const [where, body] of Object.entries(corpus))
    for (const bad of [
      BODY_CANARY,
      LIFE_CANARY,
      SECRET_CANARY,
      'CANARY-LIFE-DO-NOT-READ',
      'Journal'
    ])
      assert.ok(!body.includes(bad), `${bad} leaked into ${where}`)
  pass('no canary strings in the DOM, discovery.json, registry or logs')

  assert.deepEqual(snapshotHome(), readJson(SNAPSHOT), 'home changed')
  pass('fake home unchanged (nothing written to sources or vault)')

  assert.equal(cdp.errors.length, 0, `Renderer errors: ${JSON.stringify(cdp.errors)}`)
  fs.writeFileSync(
    path.join(output, 'report.json'),
    JSON.stringify(
      { results, dialogs: cdp.dialogs, errors: cdp.errors, traced: trace.length },
      null,
      2
    )
  )
  console.log(`Items QA passed: ${results.length} checks. Output: ${output}`)
} finally {
  cdp?.close()
  app.kill('SIGTERM')
  fs.writeFileSync(path.join(output, 'electron.log'), appLog)
}
