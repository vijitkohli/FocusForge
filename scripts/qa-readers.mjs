// Electron QA for Phase 3 readers (context packs, watcher, digest mode),
// against the fixture built by scripts/qa-readers-fixtures.mjs (rebuilt at
// the start of every run).
//
//   npx electron-vite build && node scripts/qa-readers.mjs [output]            # stub digests (default)
//   npx electron-vite build && node scripts/qa-readers.mjs [output] --live-ai  # real proxy, fixtures only
//
// Refuses to run unless every path it hands the app is under
// /tmp/focusforge-qa. HOME points at the fake home, so the real vault, ~/UNI,
// ~/Projects and ~/Documents/FlowState are never involved. In stub mode a
// tiny local HTTP server stands in for CLIProxyAPI's health endpoint and no
// model is called; --live-ai sends only the synthetic fixture excerpts.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { connectCdp, sleep } from './qa-cdp.mjs'
import { assertQaPath } from './qa-fixtures.mjs'
import {
  DATA,
  HOME,
  LAUNCHER,
  LIFE_CANARY,
  NB_OUTPUT_CANARY,
  ROOT,
  SECRET_CANARY,
  SECTION_CANARY,
  SK_CANARY,
  SNAPSHOT,
  UNI,
  VAULT,
  buildFixtures,
  snapshotHome
} from './qa-readers-fixtures.mjs'

const LIVE = process.argv.includes('--live-ai')
const outArg = process.argv.slice(2).find((a) => !a.startsWith('--'))
const output = assertQaPath(outArg ?? path.join(ROOT, LIVE ? 'live' : 'screenshots'), 'output')
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const REAL_HOME = os.homedir()
const ITEMS = ['thesis', 'comp9321', 'psyc1023', 'personalwebsite', 'focusforge']
const PROXY_PORT = 18317

// ---------- Fixture and preflight
buildFixtures()
fs.mkdirSync(output, { recursive: true })
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const settingsPath = path.join(DATA, 'system/settings.json')
const registryPath = path.join(DATA, 'system/master_index.json')
{
  for (const p of [ROOT, HOME, VAULT, DATA, LAUNCHER, settingsPath, registryPath]) assertQaPath(p)
  const s = readJson(settingsPath)
  assertQaPath(s.vaultPath, 'settings.vaultPath')
  for (const r of s.sourceRoots) assertQaPath(r.path, 'settings.sourceRoots')
  for (const e of readJson(registryPath)) {
    assertQaPath(e.path, `registry ${e.id}`)
    for (const src of e.sources ?? []) assertQaPath(src.split('.md#')[0], `source of ${e.id}`)
  }
  const launcher = fs.readFileSync(LAUNCHER, 'utf8')
  for (const k of ['appData', 'documents', 'userData'])
    assert.match(launcher, new RegExp(`setPath\\('${k}', "/tmp/focusforge-qa/`), `launcher ${k}`)
}
const packPath = (id) => path.join(DATA, id, 'reader', 'pack.json')
const digestPath = (id) => path.join(DATA, id, 'reader', 'digest.json')

// ---------- Fake proxy health endpoint (stub mode)
let proxy = null
const startProxy = () =>
  new Promise((resolve) => {
    proxy = http.createServer((_req, res) => {
      res.writeHead(401)
      res.end()
    })
    proxy.listen(PROXY_PORT, '127.0.0.1', resolve)
  })
const stopProxy = () => new Promise((resolve) => (proxy ? proxy.close(() => resolve()) : resolve()))
if (!LIVE) await startProxy()

const require = createRequire(import.meta.url)
const electron = require('electron')
const env = {
  ...process.env,
  HOME: fs.realpathSync(HOME),
  FOCUSFORGE_QA: '1',
  // Python would otherwise cache bytecode under the fake home's Library/.
  PYTHONDONTWRITEBYTECODE: '1',
  FOCUSFORGE_READER_DEBOUNCE_MS: '3000',
  ...(LIVE
    ? {}
    : {
        FOCUSFORGE_DIGEST_FAKE: '1',
        FOCUSFORGE_PROXY_URL: `http://127.0.0.1:${PROXY_PORT}/v1/models`
      })
}
delete env.ELECTRON_RUN_AS_NODE
if (LIVE) delete env.FOCUSFORGE_DIGEST_FAKE
const app = spawn(electron, ['--remote-debugging-port=9353', '--inspect=9355', LAUNCHER], {
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
const statuses = () => cdp.evaluate('window.api.getReaderStatus()')
async function until(fn, label, timeout) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const v = await fn()
    if (v) return v
    await sleep(300)
  }
  throw new Error(`Timed out: ${label}`)
}
const digest = (id) => (fs.existsSync(digestPath(id)) ? readJson(digestPath(id)) : null)

try {
  cdp = await connectCdp({ port: 9353, mainPort: 9355, output, log: () => appLog })
  await sleep(500)

  const projects = await cdp.evaluate('window.api.getProjects()')
  assert.ok(
    projects.every((p) => assertQaPath(p.path)),
    'registry outside QA root'
  )

  // ---------- 2. Every slice item gets a pack and a digest
  await until(
    async () => {
      const s = await statuses()
      return ITEMS.every(
        (id) => s[id]?.state === 'idle' && s[id]?.lastDigestAt && fs.existsSync(digestPath(id))
      )
    },
    'all five items idle with a digest',
    LIVE ? 600_000 : 90_000
  )
  pass('all five items read and summarised; pack.json and digest.json exist')

  // ---------- 3. Pack checks
  const thesis = readJson(packPath('thesis'))
  assert.equal(thesis.files[0].label, 'thesis/CONTEXT.md')
  assert.equal(thesis.files[0].id, 'F1')
  assert.equal(thesis.notDownloaded, 1, 'iCloud stub counted')
  assert.equal(thesis.conflicts, 1, 'conflict copy counted')
  assert.ok(thesis.git.length === 1 && thesis.git[0].commits.length === 3, 'thesis git log')
  assert.ok(thesis.files.some((f) => f.label === 'vault:Learning/Thesis Hub/Thesis.md'))
  assert.ok(!thesis.files.some((f) => f.label.includes('Thesis 2.md')))
  assert.ok(thesis.files[0].text.includes('[redacted]'))
  const comp = readJson(packPath('comp9321'))
  const spec = comp.files.find((f) => f.label === 'comp9321/ass1/spec.pdf')
  assert.ok(spec && spec.text.includes('Assignment 1 specification'), 'spec PDF text')
  const nb = comp.files.find((f) => f.label === 'comp9321/ass1.ipynb')
  assert.ok(nb && nb.text.includes('# Assignment 1'), 'notebook markdown')
  assert.ok(!JSON.stringify(comp).includes(NB_OUTPUT_CANARY), 'notebook outputs dropped')
  const psyc = readJson(packPath('psyc1023'))
  assert.ok(
    psyc.files.some(
      (f) => f.label === 'pysc1023/draft.docx' && f.text.includes('Essay draft on memory')
    ),
    'docx text'
  )
  assert.ok(
    psyc.files.some((f) => f.label === 'pysc1023/brief.pdf' && f.text.includes('Essay brief')),
    'brief PDF'
  )
  const ff = readJson(packPath('focusforge'))
  const section = ff.files.find((f) => f.label === 'vault:Projects/PROJECTS TO DO.md#FocusForge')
  assert.ok(section && section.text.includes('ship the readers'), 'FocusForge section')
  assert.ok(!JSON.stringify(ff).includes(SECTION_CANARY), 'only the FocusForge section')
  assert.ok(!ff.files.some((f) => f.label.includes('node_modules')), 'noise skipped')
  pass('packs: CONTEXT first, PDF/notebook/docx text, section only, stub and conflict counted')

  // ---------- 4. Gap candidate from the TBC line
  const d1 = digest('thesis')
  const gap = d1.candidateTasks.find((t) => /presentation|week 11/i.test(t.title))
  assert.ok(gap, 'presentation gap')
  assert.equal(gap.sources[0].label, 'thesis/CONTEXT.md')
  assert.match(gap.id, /^g[a-z0-9]{10}$/)
  const data = readJson(path.join(DATA, 'thesis', 'project_data.json'))
  const loose = data.tasks.find((t) => t.auto === 'loose-ends')
  assert.ok(loose && loose.deadlineKind === 'none', 'Loose ends task exists with deadlineKind none')
  assert.ok(
    loose.subtasks.length <= 3 && loose.subtasks.some((s) => s.gapId === gap.id),
    'gap step'
  )
  if (!LIVE) {
    assert.ok(
      d1.dueDates.some((x) => x.date === null && /week 11/i.test(x.when ?? '')),
      'null-date due survives'
    )
    assert.ok(d1.constraints.length > 0, 'constraints')
  }
  pass(`thesis gap "${gap.title}" cites thesis/CONTEXT.md and became a Loose ends step`)

  if (LIVE) {
    for (const id of ITEMS) {
      const d = digest(id)
      assert.ok(d.goal && d.currentState, `${id} digest usable`)
      const labels = new Set([
        ...readJson(packPath(id)).files.map((f) => f.label),
        ...readJson(packPath(id)).git.map((g) => g.label)
      ])
      for (const list of [
        d.openItems,
        d.dueDates,
        d.recentProgress,
        d.candidateTasks,
        d.constraints
      ])
        for (const e of list)
          for (const s of e.sources)
            assert.ok(labels.has(s.label), `${id}: citation ${s.label} resolves`)
    }
    pass('live: every citation resolves to a pack block')
  }

  // ---------- 5. Editing CONTEXT.md refreshes only that item
  const before = Object.fromEntries(ITEMS.map((id) => [id, digest(id).generatedAt]))
  const ctxPath = path.join(UNI, 'thesis', 'CONTEXT.md')
  assertQaPath(ctxPath)
  const ctx = fs.readFileSync(ctxPath, 'utf8')
  fs.writeFileSync(
    ctxPath,
    ctx.replace('permission guards for coding agents', 'permission guards EDIT-MARKER-55e1')
  )
  const edited = Date.now()
  await until(
    () => {
      const d = digest('thesis')
      return d.generatedAt !== before.thesis && (LIVE || d.goal.includes('EDIT-MARKER-55e1'))
    },
    'thesis digest regenerated with the edit',
    LIVE ? 240_000 : 30_000
  )
  const d2 = digest('thesis')
  if (!LIVE) assert.ok(d2.goal.includes('EDIT-MARKER-55e1'), 'new digest reflects the edit')
  else
    assert.ok(
      JSON.stringify(d2).includes('EDIT-MARKER') || d2.generatedAt,
      'live digest regenerated'
    )
  for (const id of ITEMS.filter((x) => x !== 'thesis'))
    assert.equal(digest(id).generatedAt, before[id], `${id} untouched`)
  pass(
    `edit to thesis/CONTEXT.md re-summarised in ${Math.round((Date.now() - edited) / 1000)} s; other items untouched`
  )

  // ---------- 6. Refresh from the UI
  await cdp.evaluate(
    `[...document.querySelectorAll('nav[aria-label="Main navigation"] button, nav[aria-label="Main navigation"] a')].find(b => (b.getAttribute('aria-label') || b.textContent).includes('Library'))?.click()`
  )
  await cdp.waitFor(`document.body.innerText.includes('Synced')`, 'library sync badges')
  await cdp.screenshot('readers-library', 1440, 900)
  await cdp.evaluate(`document.querySelector('button[aria-label="Open Thesis"]').click()`)
  await cdp.waitFor(
    `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Refresh')`,
    'project Refresh button'
  )
  await cdp.evaluate(
    `(() => { window.__seen = new Set(); window.__obs = setInterval(() => { const t = document.body.innerText; for (const s of ['Checking for changes…', 'Summarising…', 'Synced']) if (t.includes(s)) window.__seen.add(s) }, 50); window.api.onReaderStatus(a => window.__seen.add('state:' + a.thesis.state)); return true })()`
  )
  const before6 = digest('thesis').generatedAt
  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Refresh').click()`
  )
  await until(
    () => digest('thesis').generatedAt !== before6,
    'manual refresh digest',
    LIVE ? 240_000 : 30_000
  )
  await cdp.waitFor(`document.body.innerText.includes('Synced')`, 'back to Synced')
  const seen = await cdp.evaluate('[...window.__seen]')
  assert.ok(
    seen.includes('Summarising…') ||
      seen.includes('state:digesting') ||
      seen.includes('state:queued'),
    `saw a busy state: ${seen}`
  )
  // Summary panel
  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent.includes('Summary')).click()`
  )
  await cdp.waitFor(`document.body.innerText.includes('Gaps to check')`, 'summary panel')
  await cdp.screenshot('readers-project', 1440, 900)
  pass(`Refresh in the UI: ${seen.join(', ')}; Summary panel shows gaps`)

  // ---------- 7. Proxy down -> waiting-ai, back up -> resumes (stub mode only)
  if (!LIVE) {
    await stopProxy()
    await cdp.mainEvaluate('globalThis.__ffReaders.proxyHealth.markDown(); true')
    const before7 = digest('thesis').generatedAt
    await cdp.evaluate(`window.api.refreshItem('thesis')`)
    await until(async () => (await statuses()).thesis.state === 'waiting-ai', 'waiting-ai', 15_000)
    assert.equal(cdp.dialogs.length, 0, 'no dialogs')
    await cdp.waitFor(
      `document.body.innerText.includes("Waiting for AI (it'll resume on its own)")`,
      'waiting copy'
    )
    await startProxy()
    await cdp.mainEvaluate('globalThis.__ffReaders.proxyHealth.check()')
    await until(() => digest('thesis').generatedAt !== before7, 'resumed after proxy up', 30_000)
    pass('proxy down: waiting-ai with no dialog; proxy back: digest resumed')
  }

  // ---------- 8. Canary sweep
  const roots = JSON.parse(
    await cdp.mainEvaluate('JSON.stringify(globalThis.__ffReaders.readers.service.watchedRoots())')
  )
  assert.ok(roots.length >= 4, `watching folders: ${roots.length}`)
  for (const r of roots) {
    assertQaPath(r, 'watched root')
    assert.ok(
      path.resolve(r) !== fs.realpathSync(VAULT) && !/\/life(\/|$)/i.test(r),
      `bad watch root ${r}`
    )
  }
  const trace = JSON.parse(await cdp.mainEvaluate('JSON.stringify(globalThis.__qaPaths)'))
  const lifeRoots = ['/tmp/focusforge-qa/', '/private/tmp/focusforge-qa/'].map((r) =>
    (r + 'readers/home/Vault/Life').toLowerCase()
  )
  const allowedOutside = ['out', 'engine', 'node_modules'].flatMap((d) => [
    path.join(REPO, d) + '/',
    fs.realpathSync(path.join(REPO, d)) + '/'
  ])
  const qaHome = ['/tmp/focusforge-qa/readers/home/', '/private/tmp/focusforge-qa/readers/home/']
  for (const [op, p] of trace) {
    if (!p.startsWith('/')) continue
    const low = p.normalize('NFC').toLowerCase()
    assert.ok(
      !lifeRoots.some((l) => low === l || low.startsWith(l + '/')),
      `touched Life: ${op} ${p}`
    )
    if (
      qaHome.some((h) => p.startsWith(h)) &&
      ['open', 'openSync', 'readFile', 'readFileSync', 'opendir', 'opendirSync', 'watch'].includes(
        op
      )
    )
      assert.ok(
        !/(\/\.env$|api_key\.txt$|node_modules)/.test(p),
        `opened a secret/noise path: ${op} ${p}`
      )
    if (p.startsWith(REAL_HOME + '/') && !p.startsWith('/tmp') && !p.startsWith('/private/tmp'))
      assert.ok(
        allowedOutside.some((a) => p.startsWith(a)),
        `touched a real home path: ${op} ${p}`
      )
  }
  const corpus = {
    dom: await cdp.evaluate('document.body.innerText'),
    log: appLog,
    watched: roots.join('\n')
  }
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else corpus[path.relative(DATA, p)] = fs.readFileSync(p, 'utf8')
    }
  }
  walk(DATA)
  for (const [where, body] of Object.entries(corpus))
    for (const bad of [
      LIFE_CANARY,
      SECRET_CANARY,
      SECTION_CANARY,
      SK_CANARY,
      'sk-test-',
      '/Life/',
      'CANARY-LIFE'
    ])
      assert.ok(!body.includes(bad), `${bad} leaked into ${where}`)
  pass(
    `canary sweep clean: ${Object.keys(corpus).length} files + DOM + logs; ${trace.length} traced paths, none in Life; ${roots.length} watched roots, no vault root`
  )

  // ---------- 9. Home unchanged apart from the one deliberate edit
  const rel = path.relative(HOME, ctxPath)
  const strip = (snap) => snap.filter(([p]) => p !== rel)
  assert.deepEqual(strip(snapshotHome()), strip(readJson(SNAPSHOT)), 'home changed')
  assert.ok(!snapshotHome().some(([p]) => p.endsWith('index.lock')), 'no git lock left')
  pass('fake home unchanged apart from the edit (git wrote nothing)')

  assert.equal(cdp.errors.length, 0, `Renderer errors: ${JSON.stringify(cdp.errors)}`)
  fs.writeFileSync(
    path.join(output, 'report.json'),
    JSON.stringify({ live: LIVE, results, errors: cdp.errors, traced: trace.length }, null, 2)
  )
  console.log(
    `Readers QA passed (${LIVE ? 'live' : 'stub'}): ${results.length} checks. Output: ${output}`
  )
} finally {
  cdp?.close()
  app.kill('SIGTERM')
  await stopProxy()
  fs.writeFileSync(path.join(output, 'electron.log'), appLog)
}
