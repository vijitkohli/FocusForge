// Builds the isolated item-discovery fixture for scripts/qa-items.mjs:
// a fake home (UNI, Projects, an Obsidian vault with a closed Life folder),
// a FlowState data folder with a few existing items, a fake obsidian.json and
// a QA-only Electron launcher that traces every path the main process touches.
//
//   node scripts/qa-fixtures.mjs           # (re)build
//   node scripts/qa-fixtures.mjs --clean   # remove it
//
// Everything lives under /tmp/focusforge-qa/items and the script refuses to
// touch anything else. Names and contents are generic; the only real-looking
// names are the five slice keys the app ships with.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const QA_ROOT = '/tmp/focusforge-qa'
export const ITEMS = path.join(QA_ROOT, 'items')
export const HOME = path.join(ITEMS, 'home')
export const VAULT = path.join(HOME, 'Vault')
export const DATA = path.join(ITEMS, 'documents', 'FlowState')
export const USER_DATA = path.join(ITEMS, 'user-data')
export const APP_DATA = path.join(ITEMS, 'app-data')
export const LAUNCHER = path.join(ITEMS, 'launch.cjs')
export const SNAPSHOT = path.join(ITEMS, 'fixture-snapshot.json')
export const SECRET_CANARY = 'CANARY-SECRET-7f3a'
export const LIFE_CANARY = 'CANARY-LIFE-91c2'
export const BODY_CANARY = 'BODY-NOT-NEEDED-5d1e'
export const SLICE = ['thesis', 'comp9321', 'psyc1023', 'personalwebsite', 'focusforge']

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DAY = 86_400_000

/** Throws unless `p` resolves inside /tmp/focusforge-qa (either spelling of /tmp). */
export function assertQaPath(p, label = 'path') {
  const abs = path.resolve(p)
  const ok = [QA_ROOT, '/private' + QA_ROOT].some((r) => abs === r || abs.startsWith(r + '/'))
  if (!ok) throw new Error(`Refusing: ${label} is outside ${QA_ROOT}: ${abs}`)
  return abs
}

function write(file, text = '', ageDays = 0) {
  assertQaPath(file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  if (ageDays) age(file, ageDays)
}

function age(p, days) {
  const t = new Date(Date.now() - days * DAY)
  fs.utimesSync(p, t, t)
}

/** Sets every file and folder under `dir` (and `dir`) to `days` ago. */
function ageTree(dir, days) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) ageTree(p, days)
    else age(p, days)
  }
  age(dir, days)
}

function gitRepo(dir, daysAgo, files) {
  for (const [name, text] of Object.entries(files)) write(path.join(dir, name), text)
  const when = new Date(Date.now() - daysAgo * DAY).toISOString()
  const env = {
    ...process.env,
    HOME,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_DATE: when
  }
  const git = (...args) =>
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', ...args],
      { env, stdio: 'ignore' }
    )
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '--no-gpg-sign', '-m', 'fixture')
}

export function cleanFixtures() {
  assertQaPath(ITEMS)
  // Reopen the closed Life folders (top-down) so they can be removed.
  const reopen = (dir) => {
    if (!fs.existsSync(dir)) return
    fs.chmodSync(dir, 0o755)
    for (const e of fs.readdirSync(dir, { withFileTypes: true }))
      if (e.isDirectory()) reopen(path.join(dir, e.name))
  }
  reopen(path.join(VAULT, 'Life'))
  fs.rmSync(ITEMS, { recursive: true, force: true })
}

/** Path, size and mtime of everything under home except the closed Life folder. */
export function snapshotHome() {
  const out = []
  const life = path.join(VAULT, 'Life')
  const walk = (dir) => {
    for (const e of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name)
      if (p === life) continue
      const st = fs.lstatSync(p)
      out.push([path.relative(HOME, p), st.isDirectory() ? -1 : st.size, Math.round(st.mtimeMs)])
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p)
    }
  }
  walk(HOME)
  return out
}

function registryEntry(id, name, extra = {}) {
  const dir = path.join(DATA, id)
  write(
    path.join(dir, 'project_data.json'),
    JSON.stringify({ name, created: '2026-09-01T00:00:00.000Z', tasks: [] }, null, 2)
  )
  write(path.join(dir, `context_${id}.md`), '# Context\n')
  fs.mkdirSync(path.join(dir, 'sources'), { recursive: true })
  return {
    id,
    name,
    path: dir,
    progress: 0,
    lastActive: '2026-10-01T00:00:00.000Z',
    ...extra
  }
}

export function buildFixtures() {
  cleanFixtures()
  const uni = path.join(HOME, 'UNI')
  const projects = path.join(HOME, 'Projects')

  // ---- ~/UNI (Learning)
  write(path.join(uni, 'comp9321/ass2/todo.md'), '- [ ] read the spec\n')
  write(path.join(uni, 'comp9321/node_modules/x/index.js'), 'module.exports = 1\n')
  write(path.join(uni, 'pysc1023/ideas.md'), '- essay ideas\n')
  write(path.join(uni, 'thesis/CLAUDE.md'), '# Thesis context\n')
  write(path.join(uni, 'thesis/research/status.md'), 'Status: drafting\n')
  gitRepo(path.join(uni, 'thesis-experiments'), 3, { 'run.py': 'print(1)\n' })
  write(path.join(uni, 'comp2511/notes.md'), 'old notes\n')
  ageTree(path.join(uni, 'comp2511'), 200)
  write(path.join(uni, 'GITLAB PAT.rtf'), SECRET_CANARY)
  fs.symlinkSync(path.join(VAULT, 'Life'), path.join(uni, 'comp9321/linked-life'))

  // ---- ~/Projects (Projects)
  gitRepo(path.join(projects, 'FocusForge'), 2, { 'CLAUDE.md': '# App context\n' })
  write(path.join(projects, 'personal-website/index.html'), '<h1>hi</h1>\n')
  gitRepo(path.join(projects, 'headstart-mentoring'), 5, { 'README.txt': 'mentoring site\n' })
  write(path.join(projects, 'reading-list/books.txt'), 'a list of books\n')
  write(path.join(projects, 'redirect-personal/index.html'), 'old redirect\n')
  ageTree(path.join(projects, 'redirect-personal'), 200)
  write(path.join(projects, '.env'), `TOKEN=${SECRET_CANARY}\n`)

  // ---- Vault
  write(path.join(VAULT, '.obsidian/app.json'), '{}\n')
  write(path.join(VAULT, 'Learning/Courses/26T3/COMP9321 - Data Services Engineering.md'), 'x\n')
  write(path.join(VAULT, 'Learning/Courses/26T3/PSYC1023.md'), 'x\n')
  write(path.join(VAULT, 'Learning/Thesis Hub/Thesis.md'), 'x\n')
  write(path.join(VAULT, 'Learning/Thesis Hub/PeX notes.md'), 'x\n')
  write(path.join(VAULT, 'Learning/Leetcode.md'), 'x\n')
  write(
    path.join(VAULT, 'Learning/Learning Hub.md'),
    `# Learning\n## Weekly rhythm\nbody ${BODY_CANARY}\n## Exam prep\n`
  )
  write(path.join(VAULT, 'Projects/Headstart Mentoring Website.md'), 'x\n')
  write(path.join(VAULT, 'Projects/PERSONAL WEB.md'), 'x\n')
  write(
    path.join(VAULT, 'Projects/PROJECTS TO DO.md'),
    `# Projects\n## FocusForge\n- [ ] thing\n${BODY_CANARY}\n## Headstart\n- [ ] other\n## Random Idea\nsome words ${BODY_CANARY}\n`
  )
  write(path.join(VAULT, 'Career/Applications.md'), 'x\n')
  write(path.join(VAULT, 'TODO/Now.md'), 'x\n')
  write(path.join(VAULT, 'FocusForge/Life/Reading/Reading.md'), 'app-owned note\n')
  write(path.join(VAULT, 'Life/CANARY-LIFE-DO-NOT-READ.md'), LIFE_CANARY)
  write(path.join(VAULT, 'Life/Journal/day.md'), LIFE_CANARY)
  fs.chmodSync(path.join(VAULT, 'Life/Journal'), 0o000)
  fs.chmodSync(path.join(VAULT, 'Life'), 0o000)

  // ---- FlowState data: four existing items, one (leetcode) outside the slice
  const registry = [
    registryEntry('comp9321', 'comp9321'),
    registryEntry('Thesis', 'Thesis'),
    registryEntry('PSYC1023', 'PSYC1023'),
    registryEntry('leetcode', 'leetcode')
  ]
  write(path.join(DATA, 'system/master_index.json'), JSON.stringify(registry, null, 2))
  write(
    path.join(DATA, 'system/settings.json'),
    JSON.stringify(
      {
        vaultPath: VAULT,
        sourceRoots: [
          { path: uni, category: 'Learning' },
          { path: projects, category: 'Projects' }
        ],
        vaultCategories: ['Learning', 'Projects', 'Career'],
        initialActiveKeys: SLICE,
        discoveryCompletedAt: null,
        discoveryDismissedAt: null
      },
      null,
      2
    )
  )

  // ---- Fake Obsidian config (the real one is never read in QA)
  write(
    path.join(APP_DATA, 'obsidian/obsidian.json'),
    JSON.stringify({ vaults: { qa: { path: VAULT, ts: Date.now(), open: true } } })
  )
  fs.mkdirSync(USER_DATA, { recursive: true })
  // app.getAppPath() is the launcher's folder; link the engine so warm-up doesn't fail.
  fs.symlinkSync(path.join(REPO, 'engine'), path.join(ITEMS, 'engine'))

  // ---- QA-only launcher: isolates every Electron path and traces main-process fs access.
  write(
    LAUNCHER,
    `// Generated by scripts/qa-fixtures.mjs. QA only.
const fs = require('fs')
const cp = require('child_process')
const trace = (globalThis.__qaPaths = [])
const rec = (op, p) => { try { trace.push([op, typeof p === 'string' ? p : String(p && p.path || p)]) } catch {} }
for (const name of ['opendir', 'readdir', 'lstat', 'stat', 'readFile', 'open', 'realpath']) {
  const orig = fs.promises[name]
  fs.promises[name] = function (p, ...rest) { rec(name, p); return orig.call(this, p, ...rest) }
}
for (const name of ['readFileSync', 'lstatSync', 'statSync', 'readdirSync', 'opendirSync', 'openSync']) {
  const orig = fs[name]
  fs[name] = function (p, ...rest) { rec(name, p); return orig.call(this, p, ...rest) }
}
const native = fs.realpathSync.native
fs.realpathSync.native = function (p, ...rest) { rec('realpathSync', p); return native.call(this, p, ...rest) }
const execFile = cp.execFile
cp.execFile = function (file, args, ...rest) { rec('execFile', [file, ...(args || [])].join(' ')); return execFile.call(this, file, args, ...rest) }
const { app } = require('electron')
app.setPath('appData', ${JSON.stringify(APP_DATA)})
app.setPath('documents', ${JSON.stringify(path.join(ITEMS, 'documents'))})
app.setPath('userData', ${JSON.stringify(USER_DATA)})
require(${JSON.stringify(path.join(REPO, 'out/main/index.js'))})
`
  )

  fs.writeFileSync(SNAPSHOT, JSON.stringify(snapshotHome()))
  return { home: HOME, vault: VAULT, data: DATA, launcher: LAUNCHER }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--clean')) {
    cleanFixtures()
    console.log(`Removed ${ITEMS}`)
  } else {
    const out = buildFixtures()
    console.log(`Fixture ready: ${JSON.stringify(out)}`)
  }
}
