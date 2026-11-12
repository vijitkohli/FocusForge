// Electron QA for Phase 4 vault notes: the app writes item and task notes
// under <vault>/FocusForge, ticks made "in Obsidian" (plain fs edits) flow
// back, My notes are never touched, and nothing outside FocusForge/ changes.
//
//   npx electron-vite build && node scripts/qa-vault.mjs [output]
//   node scripts/qa-vault.mjs --clean        # remove the fixture
//
// Everything lives under /tmp/focusforge-qa/vault-qa: a fake home (UNI,
// Projects, an Obsidian vault whose Life folder is chmod 000 with a canary),
// its own FlowState data, app data and launcher. HOME points at the fake home,
// so the real vault, ~/UNI, ~/Projects and ~/Documents/FlowState are never
// involved. No model is called: digests are faked and the engine's proxy URL
// points at a closed local port.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { connectCdp, sleep } from './qa-cdp.mjs'
import { assertQaPath, QA_ROOT } from './qa-fixtures.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.join(QA_ROOT, 'vault-qa')
const HOME = path.join(ROOT, 'home')
const VAULT = path.join(HOME, 'Vault')
const UNI = path.join(HOME, 'UNI')
const PROJECTS = path.join(HOME, 'Projects')
const DATA = path.join(ROOT, 'documents', 'FlowState')
const USER_DATA = path.join(ROOT, 'user-data')
const APP_DATA = path.join(ROOT, 'app-data')
const LAUNCHER = path.join(ROOT, 'launch.cjs')
const BIN = path.join(ROOT, 'bin')
const BRCTL_LOG = path.join(ROOT, 'brctl.log')
const LIFE = path.join(VAULT, 'Life')
const LIFE_CANARY = 'CANARY-LIFE-DO-NOT-READ-4b7e'
const APP = path.join(VAULT, 'FocusForge')
const PROXY_PORT = 18327
const REAL_HOME = os.homedir()
const DAY = 86_400_000

const local = (days) => {
  const d = new Date(Date.now() + days * DAY)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function write(file, data) {
  assertQaPath(file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}

function clean() {
  assertQaPath(ROOT)
  if (!fs.existsSync(ROOT)) return
  try {
    fs.chmodSync(LIFE, 0o755)
    fs.chmodSync(path.join(LIFE, 'CANARY-LIFE-DO-NOT-READ.md'), 0o644)
  } catch {
    /* not there */
  }
  fs.rmSync(ROOT, { recursive: true, force: true })
}

if (process.argv.includes('--clean')) {
  clean()
  console.log(`Removed ${ROOT}`)
  process.exit(0)
}

// ---------- Fixture
function buildFixture() {
  clean()
  write(path.join(VAULT, '.obsidian', 'app.json'), '{}')
  write(
    path.join(VAULT, 'Learning', 'Thesis Hub', 'Thesis.md'),
    '# Thesis hub\nSupervisor notes.\n'
  )
  write(path.join(VAULT, 'Projects', 'PERSONAL WEB.md'), '# Personal web\n')
  write(path.join(VAULT, 'TODO', 'Dashboard.md'), '# Dashboard\n')
  write(path.join(LIFE, 'CANARY-LIFE-DO-NOT-READ.md'), `${LIFE_CANARY}\n`)
  fs.chmodSync(path.join(LIFE, 'CANARY-LIFE-DO-NOT-READ.md'), 0o000)
  fs.chmodSync(LIFE, 0o000)
  write(
    path.join(UNI, 'thesis', 'CONTEXT.md'),
    '# Thesis\n## Current state\nPilot v2 ran with 12 tasks.\n## Next steps\n- Rewrite methods\n'
  )
  write(path.join(UNI, 'comp9321', 'README.md'), '# COMP9321\n')
  write(path.join(UNI, 'psyc1023', 'README.md'), '# PSYC1023\n')
  write(path.join(PROJECTS, 'personal-website', 'README.md'), '# Site\n')
  write(path.join(PROJECTS, 'FocusForge', 'README.md'), '# FocusForge\n')

  const now = new Date().toISOString()
  const step = (id, title, extra = {}) => ({
    id,
    title,
    isCompleted: false,
    timeEstimate: 10,
    ...extra
  })
  const task = (id, title, subtasks, extra = {}) => ({
    id,
    title,
    createdAt: now,
    deadline: local(8),
    status: 'in-progress',
    depth: 'Standard',
    model: '',
    subtasks,
    ...extra
  })
  const items = [
    {
      id: 'thesis',
      name: 'Thesis',
      category: 'Learning',
      kind: 'deadline',
      sources: [path.join(UNI, 'thesis')],
      tasks: [
        task('t-proposal', 'Proposal v5', [
          step('s1', 'Open methods.md and list the 3 comments'),
          step('s2', 'Rewrite the sampling paragraph'),
          step('s3', 'Send to supervisor')
        ]),
        task('t-pilot', 'Pilot study', [step('p1', 'Re-run the hard pilot')])
      ]
    },
    {
      id: 'comp9321',
      name: 'COMP9321',
      category: 'Learning',
      kind: 'deadline',
      sources: [],
      tasks: [
        task('t-ass2', 'Assignment 2', [
          step('a1', 'Read the spec'),
          step('a2', 'Set up the repo')
        ]),
        task(
          't-loose',
          'Loose ends',
          [step('g1', 'Find the Week 11 quiz date', { gapId: 'gapquiz1' })],
          { auto: 'loose-ends', deadlineKind: 'none' }
        )
      ]
    },
    {
      id: 'psyc1023',
      name: 'PSYC1023',
      category: 'Learning',
      kind: 'deadline',
      sources: [],
      tasks: [task('t-essay', 'Essay plan', [step('e1', 'Pick a question')])]
    },
    {
      id: 'personalwebsite',
      name: 'Personal website',
      category: 'Projects',
      kind: 'passion',
      sources: [],
      tasks: [task('t-about', 'About page', [step('w1', 'Write two lines about me')])]
    },
    {
      id: 'focusforge',
      name: 'FocusForge',
      category: 'Projects',
      kind: 'passion',
      sources: [],
      tasks: []
    },
    {
      id: 'reading',
      name: 'Reading',
      category: 'Life',
      kind: 'passion',
      sources: [],
      tasks: [task('t-novel', 'Finish the novel', [step('r1', 'Read chapter 3')])]
    }
  ]
  const registry = items.map((i) => ({
    id: i.id,
    name: i.name,
    path: path.join(DATA, i.id),
    progress: 0,
    lastActive: now,
    category: i.category,
    kind: i.kind,
    status: 'active',
    sources: i.sources
  }))
  write(path.join(DATA, 'system', 'master_index.json'), registry)
  for (const i of items) {
    write(path.join(DATA, i.id, 'project_data.json'), {
      name: i.name,
      created: now,
      tasks: i.tasks,
      rev: 1
    })
    write(
      path.join(DATA, i.id, `context_${i.id}.md`),
      '## Constraints & Specifications\n\n## Document Excerpts\n\n## Milestones & Completed Work\n\n## Plan Adjustments\n'
    )
  }
  write(
    path.join(DATA, 'system', 'user_profile.md'),
    '## About Me\n\n## Preferences\n\n## Patterns & Friction\n'
  )
  write(path.join(DATA, 'system', 'settings.json'), {
    vaultPath: VAULT,
    vaultNotes: true,
    readersEnabled: true,
    sourceRoots: [
      { path: UNI, category: 'Learning' },
      { path: PROJECTS, category: 'Projects' }
    ],
    vaultCategories: ['Learning', 'Projects', 'Career'],
    initialActiveKeys: [],
    discoveryCompletedAt: now,
    discoveryDismissedAt: null,
    aiNudges: false,
    weeklyReview: false
  })
  fs.mkdirSync(APP_DATA, { recursive: true })
  fs.mkdirSync(USER_DATA, { recursive: true })
  // brctl stub: logs what it was asked to download (eviction check).
  write(path.join(BIN, 'brctl'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(BRCTL_LOG)}\n`)
  fs.chmodSync(path.join(BIN, 'brctl'), 0o755)
  write(
    LAUNCHER,
    `// Generated by scripts/qa-vault.mjs. QA only.
const fs = require('fs')
const trace = (globalThis.__qaPaths = [])
const rec = (op, p) => { try { trace.push([op, typeof p === 'string' ? p : String(p && p.path || p)]) } catch {} }
for (const name of ['opendir', 'readdir', 'lstat', 'stat', 'readFile', 'open', 'realpath', 'writeFile', 'rename', 'mkdir', 'unlink', 'rm']) {
  const orig = fs.promises[name]
  if (orig) fs.promises[name] = function (p, ...rest) { rec(name, p); if (name === 'rename') rec(name, rest[0]); return orig.call(this, p, ...rest) }
}
for (const name of ['readFileSync', 'lstatSync', 'statSync', 'readdirSync', 'opendirSync', 'openSync', 'watch', 'writeFileSync', 'renameSync', 'mkdirSync']) {
  const orig = fs[name]
  fs[name] = function (p, ...rest) { rec(name, p); return orig.call(this, p, ...rest) }
}
const native = fs.realpathSync.native
fs.realpathSync.native = function (p, ...rest) { rec('realpathSync', p); return native.call(this, p, ...rest) }
const { app } = require('electron')
app.setPath('appData', ${JSON.stringify(APP_DATA)})
app.setPath('documents', ${JSON.stringify(path.join(ROOT, 'documents'))})
app.setPath('userData', ${JSON.stringify(USER_DATA)})
require(${JSON.stringify(path.join(REPO, 'out/main/index.js'))})
`
  )
  // The app's engine dir is next to the launcher.
  fs.symlinkSync(path.join(REPO, 'engine'), path.join(ROOT, 'engine'))
}

function hashTree(dir, skip = () => false) {
  const out = {}
  const walk = (d) => {
    for (const e of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, e.name)
      const rel = path.relative(dir, full)
      if (skip(rel)) continue
      if (e.isDirectory()) walk(full)
      else if (e.isFile())
        out[rel] = createHash('sha256').update(fs.readFileSync(full)).digest('hex')
    }
  }
  walk(dir)
  return out
}

const output = assertQaPath(
  process.argv.slice(2).find((a) => !a.startsWith('--')) ?? path.join(ROOT, 'screenshots'),
  'output'
)
buildFixture()
fs.mkdirSync(output, { recursive: true })
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

// ---------- Preflight: every path the app gets is under /tmp/focusforge-qa
{
  const s = readJson(path.join(DATA, 'system', 'settings.json'))
  assertQaPath(s.vaultPath, 'settings.vaultPath')
  for (const r of s.sourceRoots) assertQaPath(r.path, 'settings.sourceRoots')
  for (const e of readJson(path.join(DATA, 'system', 'master_index.json'))) {
    assertQaPath(e.path, `registry ${e.id}`)
    for (const src of e.sources) assertQaPath(src, `source of ${e.id}`)
  }
  const launcher = fs.readFileSync(LAUNCHER, 'utf8')
  for (const k of ['appData', 'documents', 'userData'])
    assert.match(launcher, new RegExp(`setPath\\('${k}', "/tmp/focusforge-qa/`), `launcher ${k}`)
}

const vaultBefore = hashTree(VAULT, (rel) => rel === 'FocusForge' || rel === 'Life')
const uniBefore = hashTree(UNI)
const projectsBefore = hashTree(PROJECTS)
const lifeBefore = fs.statSync(LIFE)

// ---------- Fake proxy health endpoint (readers think the proxy is up; digests are faked)
const proxy = http.createServer((_req, res) => {
  res.writeHead(401)
  res.end()
})
await new Promise((resolve) => proxy.listen(PROXY_PORT, '127.0.0.1', resolve))

const require = createRequire(import.meta.url)
const electron = require('electron')
const env = {
  ...process.env,
  HOME: fs.realpathSync(HOME),
  PATH: `${BIN}:${process.env.PATH}`,
  FOCUSFORGE_QA: '1',
  PYTHONDONTWRITEBYTECODE: '1',
  FOCUSFORGE_READER_DEBOUNCE_MS: '2000',
  FOCUSFORGE_VAULT_DEBOUNCE_MS: '400',
  FOCUSFORGE_DIGEST_FAKE: '1',
  FOCUSFORGE_PROXY_URL: `http://127.0.0.1:${PROXY_PORT}/v1/models`,
  // Any planner call fails fast on a closed local port: nothing reaches a model.
  CLIPROXY_API_BASE: 'http://127.0.0.1:9/v1',
  CLIPROXY_API_KEY: 'qa-not-a-key'
}
delete env.ELECTRON_RUN_AS_NODE
const appProc = spawn(electron, ['--remote-debugging-port=9363', '--inspect=9365', LAUNCHER], {
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
let appLog = ''
appProc.stdout.on('data', (d) => (appLog += d))
appProc.stderr.on('data', (d) => (appLog += d))

let cdp
const results = []
const pass = (msg) => {
  results.push(msg)
  console.log(`✓ ${msg}`)
}
async function until(fn, label, timeout = 15_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const v = await fn()
    if (v) return v
    await sleep(250)
  }
  throw new Error(`Timed out: ${label}`)
}
const note = (rel) => path.join(APP, ...rel.split('/'))
const readNote = (rel) => fs.readFileSync(note(rel), 'utf8')
const exists = (rel) => fs.existsSync(note(rel))
const data = (id) => readJson(path.join(DATA, id, 'project_data.json'))
const writes = () => cdp.mainEvaluate('globalThis.__ffVault.sync.writer.writes')
const status = () => cdp.evaluate('window.api.getVaultStatus()')
const tickLine = (text, title, mark) =>
  text.replace(new RegExp(`- \\[[ xX]\\] (${title}[^\\n]*\\^ff-[sgpt]-)`), `- [${mark}] $1`)
const appSave = async (id, mutate) => {
  // The renderer's path: load, change, save with the loaded rev.
  await cdp.evaluate(`(async () => {
    for (let i = 0; i < 3; i++) {
      const d = await window.api.loadProjectData(${JSON.stringify(id)})
      ;(${mutate})(d)
      const r = await window.api.saveProjectData(${JSON.stringify(id)}, d, undefined, d.rev ?? 0)
      if (r.success) return true
    }
    throw new Error('save failed')
  })()`)
}

const ITEM = 'Learning/Thesis/Thesis.md'
const PROPOSAL = 'Learning/Thesis/Proposal v5.md'
const PILOT = 'Learning/Thesis/Pilot study.md'

try {
  cdp = await connectCdp({ port: 9363, mainPort: 9365, output, log: () => appLog })
  const projects = await cdp.evaluate('window.api.getProjects()')
  assert.ok(
    projects.every((p) => assertQaPath(p.path)),
    'registry outside QA root'
  )

  // ---------- 1. Launch: every item note, task note and the About note
  const expected = [
    ITEM,
    PROPOSAL,
    PILOT,
    'Learning/COMP9321/COMP9321.md',
    'Learning/COMP9321/Assignment 2.md',
    'Learning/COMP9321/Loose ends.md',
    'Learning/PSYC1023/PSYC1023.md',
    'Learning/PSYC1023/Essay plan.md',
    'Projects/Personal website/Personal website.md',
    'Projects/Personal website/About page.md',
    'Projects/FocusForge/FocusForge.md',
    'Life/Reading/Reading.md',
    'Life/Reading/Finish the novel.md',
    'About these notes.md'
  ]
  await until(() => expected.every(exists), 'all notes written', 20_000)
  assert.match(readNote('About these notes.md'), /```dataview/)
  assert.match(readNote(ITEM), /\[\[FocusForge\/Learning\/Thesis\/Proposal v5\|Proposal v5\]\]/)
  const reg = readJson(path.join(DATA, 'system', 'master_index.json'))
  assert.equal(reg.find((e) => e.id === 'thesis').vaultNote, `FocusForge/${ITEM}`)
  const st1 = await status()
  assert.equal(st1.writable, true)
  pass(`launch: ${expected.length} notes written (6 items incl. Life/Reading, tasks, About)`)

  // ---------- 2. Idempotence
  await sleep(3_000)
  await cdp.evaluate('window.api.syncVaultNow()')
  const w0 = await writes()
  await sleep(2_500)
  await cdp.evaluate('window.api.syncVaultNow()')
  await cdp.evaluate('window.api.syncVaultNow()')
  await sleep(1_500)
  assert.equal(await writes(), w0, 'Sync now rewrote unchanged notes')
  pass('idempotent: two forced syncs, 0 writes')

  // ---------- 3. Tick in Obsidian
  const rev0 = data('thesis').rev
  fs.writeFileSync(note(PROPOSAL), tickLine(readNote(PROPOSAL), 'Open methods.md', 'x'))
  await until(() => data('thesis').tasks[0].subtasks[0].isCompleted, 'tick applied', 8_000)
  assert.ok(data('thesis').rev > rev0)
  await until(() => readNote(PROPOSAL).includes('in Obsidian'), 'tick logged', 12_000)
  assert.match(readNote(PROPOSAL), /- \[x\] Open methods\.md/)
  const dom = await cdp.evaluate(
    `window.api.loadProjectData('thesis').then(d => d.tasks[0].subtasks[0].isCompleted)`
  )
  assert.equal(dom, true)
  pass('Obsidian tick: step done in the app (rev bumped), note keeps [x] and logs it')

  // ---------- 4. Untick
  await sleep(6_000) // past the quiet window from our own last write
  fs.writeFileSync(note(PROPOSAL), tickLine(readNote(PROPOSAL), 'Open methods.md', ' '))
  await until(() => !data('thesis').tasks[0].subtasks[0].isCompleted, 'untick applied', 8_000)
  pass('Obsidian untick: step back to todo')

  // ---------- 5. My notes survive an app change; they reach the item's pack
  await sleep(6_000)
  const MINE =
    '## My notes\nAsk about the ablation table. QA-MYNOTES-61d\n### Later\n- [x] not a tick\n'
  fs.writeFileSync(note(ITEM), readNote(ITEM).replace(/## My notes\n$/, MINE))
  await sleep(6_000)
  await appSave(
    'thesis',
    `(d) => { d.tasks[0].subtasks[2].isCompleted = true; d.tasks[0].subtasks[2].status = 'done' }`
  )
  await until(
    () => /\d\/3 steps/.test(readNote(ITEM)) && readNote(ITEM).includes('1/3 steps'),
    'item note re-rendered',
    12_000
  )
  assert.ok(readNote(ITEM).endsWith(MINE), 'My notes changed')
  await until(
    () => {
      const p = path.join(DATA, 'thesis', 'reader', 'pack.json')
      return fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('QA-MYNOTES-61d')
    },
    'My notes in the pack',
    20_000
  )
  const pack = readJson(path.join(DATA, 'thesis', 'reader', 'pack.json'))
  const mine = pack.files.find((f) => f.label.endsWith('#My notes'))
  assert.ok(mine && !mine.label.includes(VAULT), 'My-notes label is model-safe')
  pass('My notes kept byte for byte across an app save, and fed to the pack as a My-notes source')

  // ---------- 6. Owner edit in State (auto) is replaced, with a backup and a log line
  await sleep(6_000)
  const edited = readNote(ITEM).replace(
    '## State (auto)\n',
    '## State (auto)\nI EDITED THIS QA-EDIT\n'
  )
  fs.writeFileSync(note(ITEM), edited)
  await sleep(6_000)
  await appSave('thesis', `(d) => { d.tasks[1].subtasks[0].title = 'Re-run the hard pilot (v3)' }`)
  await until(() => !readNote(ITEM).includes('QA-EDIT'), 'edit replaced', 15_000)
  assert.match(readNote(ITEM), /FocusForge replaced your edit in “State”/)
  const backups = path.join(DATA, 'system', 'vault', 'overwritten')
  const day = fs.readdirSync(backups)[0]
  assert.match(
    fs.readFileSync(path.join(backups, day, 'FocusForge', ...ITEM.split('/')), 'utf8'),
    /QA-EDIT/
  )
  pass('owner edit of an app section replaced, backed up to FlowState and logged')

  // ---------- 7. Owner frontmatter keys are kept
  await sleep(6_000)
  fs.writeFileSync(
    note(ITEM),
    readNote(ITEM).replace('ff_note: item\n', 'ff_note: item\ntags: [x]\n')
  )
  await sleep(6_000)
  await appSave('thesis', `(d) => { d.tasks[1].subtasks[0].title = 'Re-run the hard pilot (v4)' }`)
  await until(() => readNote(PILOT).includes('(v4)'), 'pilot re-rendered', 12_000)
  await until(() => readNote(ITEM).includes('updated:'), 'item note', 2_000)
  assert.match(readNote(ITEM), /\ntags: \[x\]\n/)
  pass('owner frontmatter key preserved')

  // ---------- 8. Quiet window: no write within 5 s of the note's last change
  await sleep(6_000)
  const touchedAt = Date.now()
  fs.utimesSync(note(PILOT), new Date(touchedAt), new Date(touchedAt))
  await appSave('thesis', `(d) => { d.tasks[1].subtasks[0].title = 'Re-run the hard pilot (v5)' }`)
  await until(() => readNote(PILOT).includes('(v5)'), 'quiet write', 15_000)
  const landed = fs.statSync(note(PILOT)).mtimeMs
  assert.ok(landed - touchedAt >= 4_900, `wrote ${landed - touchedAt} ms after the touch`)
  pass(`quiet window: write landed ${Math.round(landed - touchedAt)} ms after the touch`)

  // ---------- 9. Conflict copy reported; the original keeps syncing
  await sleep(6_000)
  fs.copyFileSync(note(ITEM), note('Learning/Thesis/Thesis 2.md'))
  await appSave('thesis', `(d) => { d.tasks[1].subtasks[0].title = 'Re-run the hard pilot (v6)' }`)
  await until(
    async () =>
      (await status()).notes.some(
        (n) => n.itemId === 'thesis' && !n.taskId && n.state === 'conflict'
      ),
    'conflict shown',
    15_000
  )
  const conflict = (await status()).notes.find((n) => n.itemId === 'thesis' && !n.taskId)
  assert.equal(conflict.message, 'Obsidian has two copies of Thesis. Open both and keep one.')
  await until(() => readNote(PILOT).includes('(v6)'), 'still syncing', 12_000)
  fs.unlinkSync(note('Learning/Thesis/Thesis 2.md'))
  pass('conflict copy reported (never merged); Thesis keeps syncing')

  // ---------- 10. Eviction: an iCloud placeholder is never written over
  await sleep(6_000)
  const ESSAY = 'Learning/PSYC1023/Essay plan.md'
  fs.renameSync(note(ESSAY), note('Learning/PSYC1023/.Essay plan.md.icloud'))
  await appSave('psyc1023', `(d) => { d.tasks[0].subtasks[0].title = 'Pick a question today' }`)
  await until(
    async () => (await status()).notes.some((n) => n.taskId === 't-essay' && n.state === 'waiting'),
    'waiting for iCloud',
    12_000
  )
  assert.equal(exists(ESSAY), false)
  await until(() => fs.existsSync(BRCTL_LOG), 'brctl called', 5_000)
  assert.match(fs.readFileSync(BRCTL_LOG, 'utf8'), /^download .*Essay plan\.md$/m)
  pass('evicted note left alone, status says waiting, brctl download asked once (stubbed)')

  // ---------- 11. Deletion is respected; Recreate restores it with empty My notes
  const ASS = 'Learning/COMP9321/Assignment 2.md'
  fs.unlinkSync(note(ASS))
  await cdp.evaluate('window.api.syncVaultNow()')
  await until(
    async () => (await status()).notes.some((n) => n.taskId === 't-ass2' && n.state === 'deleted'),
    'deleted state',
    10_000
  )
  await sleep(1_500)
  assert.equal(exists(ASS), false, 'deleted note was recreated')
  const re = await cdp.evaluate(`window.api.recreateVaultNote('comp9321', 't-ass2')`)
  assert.deepEqual(re, { ok: true })
  assert.match(readNote(ASS), /## My notes\n$/)
  pass('owner-deleted note not recreated; Recreate brings it back with empty My notes')

  // ---------- 12. ^ff-g tick in Loose ends resolves through gapId
  const LOOSE = 'Learning/COMP9321/Loose ends.md'
  await sleep(6_000)
  assert.match(readNote(LOOSE), /\^ff-g-gapquiz1/)
  fs.writeFileSync(note(LOOSE), tickLine(readNote(LOOSE), 'Find the Week 11 quiz date', 'x'))
  await until(() => data('comp9321').tasks[1].subtasks[0].isCompleted, 'gap tick applied', 8_000)
  pass('^ff-g tick completed the Loose ends step via gapId')

  // ---------- 13. Rename in the app moves the folder; links follow
  await cdp.evaluate(`window.api.updateWorkstream('thesis', { name: 'Honours thesis' })`)
  const NEW = 'Learning/Honours thesis/Honours thesis.md'
  await until(() => exists(NEW), 'folder moved', 12_000)
  assert.equal(fs.existsSync(path.join(APP, 'Learning', 'Thesis')), false)
  assert.match(
    readNote(NEW),
    /\[\[FocusForge\/Learning\/Honours thesis\/Proposal v5\|Proposal v5\]\]/
  )
  assert.ok(readNote(NEW).endsWith(MINE), 'My notes lost in the move')
  pass('item rename moved the folder and note; links updated; My notes kept')

  // ---------- 14. Open in Obsidian (shell stubbed)
  await cdp.mainEvaluate('globalThis.__qaOpened = globalThis.__ffVault.stubOpenExternal(); true')
  const opened = await cdp.evaluate(`window.api.openInObsidian('thesis')`)
  assert.deepEqual(opened, { ok: true })
  const urls = await cdp.mainEvaluate('JSON.stringify(globalThis.__qaOpened)')
  const url = JSON.parse(urls)[0]
  assert.ok(url.startsWith('obsidian://open?path='), url)
  assert.equal(decodeURIComponent(url.slice('obsidian://open?path='.length)), note(NEW))
  pass('Open in Obsidian sends obsidian://open?path=<item note>')

  // ---------- 15. UI: Settings block and the item page button
  await cdp.click('Profile')
  await cdp.waitFor(`document.body.innerText.includes('Vault notes')`, 'vault notes block')
  await cdp.evaluate(`document.querySelector('[data-testid="vault-summary"]')?.scrollIntoView()`)
  const summary = await cdp.evaluate(
    `document.querySelector('[data-testid="vault-summary"]')?.textContent`
  )
  assert.match(summary, /^Synced/)
  assert.ok(
    await cdp.evaluate(
      `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Copy Dataview snippet')`
    )
  )
  await cdp.screenshot('vault-settings', 1440, 900)
  await cdp.click('Honours thesis', { exact: false })
  await cdp.waitFor(
    `!!document.querySelector('[data-testid="open-in-obsidian"]')`,
    'Open in Obsidian button'
  )
  await cdp.screenshot('vault-item', 1440, 900)
  pass('Settings shows the Vault notes block; the item page shows Open in Obsidian')

  // ---------- 16. Canary
  const lifeAfter = fs.statSync(LIFE)
  assert.equal(lifeAfter.mode, lifeBefore.mode, 'Life mode changed')
  assert.equal(lifeAfter.mtimeMs, lifeBefore.mtimeMs, 'Life mtime changed')
  assert.deepEqual(
    hashTree(VAULT, (rel) => rel === 'FocusForge' || rel === 'Life'),
    vaultBefore,
    'vault changed outside FocusForge'
  )
  assert.deepEqual(hashTree(UNI), uniBefore, 'UNI changed')
  assert.deepEqual(hashTree(PROJECTS), projectsBefore, 'Projects changed')
  const trace = JSON.parse(await cdp.mainEvaluate('JSON.stringify(globalThis.__qaPaths)'))
  const lifeRoots = [LIFE, path.join(fs.realpathSync(VAULT), 'Life')].map((p) => p.toLowerCase())
  const writesOps = new Set([
    'writeFile',
    'rename',
    'mkdir',
    'unlink',
    'rm',
    'writeFileSync',
    'renameSync',
    'mkdirSync'
  ])
  const vaultRoots = [VAULT, fs.realpathSync(VAULT)]
  const appRoots = [APP, path.join(fs.realpathSync(VAULT), 'FocusForge')]
  let vaultWrites = 0
  for (const [op, p] of trace) {
    if (!p.startsWith('/')) continue
    const low = p.normalize('NFC').toLowerCase()
    assert.ok(
      !lifeRoots.some((l) => low === l || low.startsWith(l + '/')),
      `touched Life: ${op} ${p}`
    )
    if (writesOps.has(op) && vaultRoots.some((v) => p === v || p.startsWith(v + '/'))) {
      vaultWrites++
      assert.ok(
        appRoots.some((a) => p === a || p.startsWith(a + '/')),
        `vault write outside FocusForge: ${op} ${p}`
      )
    }
    if (writesOps.has(op) && p.startsWith(REAL_HOME + '/'))
      assert.ok(
        p.startsWith(path.join(REPO, 'engine')) || p.startsWith(path.join(REPO, 'out')),
        `wrote a real home path: ${op} ${p}`
      )
  }
  for (const f of Object.keys(hashTree(DATA))) {
    const body = fs.readFileSync(path.join(DATA, f), 'utf8')
    assert.ok(!body.includes(LIFE_CANARY), `Life canary leaked into ${f}`)
  }
  assert.ok(!appLog.includes(LIFE_CANARY))
  pass(
    `canary: Life untouched (mode, mtime, ${trace.length} traced paths); vault outside FocusForge, UNI and Projects unchanged; ${vaultWrites} vault writes all inside FocusForge`
  )

  assert.equal(cdp.errors.length, 0, `Renderer errors: ${JSON.stringify(cdp.errors)}`)
  fs.writeFileSync(
    path.join(output, 'report.json'),
    JSON.stringify({ results, errors: cdp.errors, traced: trace.length }, null, 2)
  )
  console.log(`Vault QA passed: ${results.length} checks. Output: ${output}`)
} finally {
  cdp?.close()
  appProc.kill('SIGTERM')
  await new Promise((resolve) => proxy.close(() => resolve()))
  fs.writeFileSync(path.join(output, 'electron.log'), appLog)
  // Leave Life readable for the next clean.
  try {
    execFileSync('chmod', ['-R', 'u+rwx', LIFE])
  } catch {
    /* best effort */
  }
}
