// Builds the isolated Phase 3 readers fixture for scripts/qa-readers.mjs:
// a fake home (UNI, Projects, an Obsidian vault with a closed Life folder),
// a FlowState data folder with the five slice items and their sources, a fake
// obsidian.json and a QA-only Electron launcher that traces main-process fs.
//
//   node scripts/qa-readers-fixtures.mjs           # (re)build
//   node scripts/qa-readers-fixtures.mjs --clean   # remove it
//
// Everything lives under /tmp/focusforge-qa/readers; the script refuses to
// touch anything else. All content is synthetic.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertQaPath, QA_ROOT } from './qa-fixtures.mjs'

export const ROOT = path.join(QA_ROOT, 'readers')
export const HOME = path.join(ROOT, 'home')
export const VAULT = path.join(HOME, 'Vault')
export const UNI = path.join(HOME, 'UNI')
export const PROJECTS = path.join(HOME, 'Projects')
export const DATA = path.join(ROOT, 'documents', 'FlowState')
export const USER_DATA = path.join(ROOT, 'user-data')
export const APP_DATA = path.join(ROOT, 'app-data')
export const LAUNCHER = path.join(ROOT, 'launch.cjs')
export const SNAPSHOT = path.join(ROOT, 'fixture-snapshot.json')

export const LIFE_CANARY = 'LIFE-CANARY-7f3a'
export const SECRET_CANARY = 'SECRET-CANARY-9b2c'
export const SECTION_CANARY = 'SECTION-CANARY-2e8d'
export const SK_CANARY = 'sk-test-ABCDEFGHIJKLMNOP123456'
export const NB_OUTPUT_CANARY = 'NBOUTPUTBASE64CANARY'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DAY = 86_400_000

function write(file, data = '', ageDays = 0) {
  assertQaPath(file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data)
  if (ageDays) {
    const t = new Date(Date.now() - ageDays * DAY)
    fs.utimesSync(file, t, t)
  }
}

function gitRepo(dir, commits) {
  assertQaPath(dir)
  const env = { ...process.env, HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const git = (...args) =>
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', ...args],
      {
        env: {
          ...env,
          ...(git.when ? { GIT_AUTHOR_DATE: git.when, GIT_COMMITTER_DATE: git.when } : {})
        },
        stdio: 'ignore'
      }
    )
  fs.mkdirSync(dir, { recursive: true })
  git('init', '-q')
  for (const [daysAgo, message, files] of commits) {
    for (const [name, text] of Object.entries(files)) write(path.join(dir, name), text)
    git.when = new Date(Date.now() - daysAgo * DAY).toISOString()
    git('add', '-A')
    git('commit', '-q', '--no-gpg-sign', '-m', message)
  }
}

/** A one-page PDF with a real text layer; xref offsets computed. */
export function minimalPdf(lines) {
  const esc = (l) => l.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const content = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A tiny stored (uncompressed) zip. */
function storedZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of entries) {
    const data = Buffer.from(text, 'utf8')
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

export function minimalDocx(paragraphs) {
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')
  return storedZip([
    ['[Content_Types].xml', '<Types/>'],
    [
      'word/document.xml',
      `<?xml version="1.0"?><w:document xmlns:w="${ns}"><w:body>${body}</w:body></w:document>`
    ]
  ])
}

export function cleanFixtures() {
  assertQaPath(ROOT)
  const reopen = (dir) => {
    if (!fs.existsSync(dir)) return
    fs.chmodSync(dir, 0o755)
    for (const e of fs.readdirSync(dir, { withFileTypes: true }))
      if (e.isDirectory()) reopen(path.join(dir, e.name))
  }
  reopen(path.join(VAULT, 'Life'))
  fs.rmSync(ROOT, { recursive: true, force: true })
}

/** sha256-free snapshot: path, size and mtime of everything under home (Life skipped, .git included). */
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

function registryEntry(id, name, extra) {
  const dir = path.join(DATA, id)
  write(
    path.join(dir, 'project_data.json'),
    JSON.stringify({ name, created: '2026-09-01T00:00:00.000Z', tasks: [] }, null, 2)
  )
  write(path.join(dir, `context_${id}.md`), '# Context\n')
  return { id, name, path: dir, progress: 0, lastActive: '2026-10-01T00:00:00.000Z', ...extra }
}

export function buildFixtures() {
  cleanFixtures()

  // ---- ~/UNI/thesis: git repo, CONTEXT with a TBC gap, ~40 notes, secrets
  gitRepo(path.join(UNI, 'thesis'), [
    [20, 'start the thesis repo', { 'README.md': '# Thesis repo\nGuards for agent tools.\n' }],
    [6, 'add pilot study notes', { 'research/status.md': 'Status: pilot done, writing up.\n' }],
    [
      2,
      'add guard study',
      {
        'CONTEXT.md': [
          '# Thesis',
          '## What this is',
          'What this is: an honours thesis on permission guards for coding agents.',
          '## Current state',
          '- Pilot study done (see research/status.md).',
          '- Week 11 presentation date TBC',
          `- Old API key in notes: ${SK_CANARY}`,
          '## Deadlines',
          '- [ ] Proposal v5 to supervisor [due:: 2026-11-20]',
          '## Rules',
          '- AI may not write the thesis text (school policy).',
          '## Last updated',
          '2026-11-09: added the guard study.'
        ].join('\n')
      }
    ]
  ])
  for (let i = 0; i < 40; i++)
    write(
      path.join(UNI, 'thesis', 'notes', `week-${i}.md`),
      `# Week ${i}\nReading notes ${i}.\n`,
      10 + i
    )
  write(path.join(UNI, 'thesis', '.env'), `OPENAI_KEY=${SECRET_CANARY}\n`)
  write(path.join(UNI, 'thesis', 'api_key.txt'), SECRET_CANARY)
  write(path.join(UNI, 'thesis-experiments', '.env'), `TOKEN=${SECRET_CANARY}\n`)

  // ---- ~/UNI/comp9321: CONTEXT, notebook with a big output, spec PDF
  write(
    path.join(UNI, 'comp9321', 'CONTEXT.md'),
    '# COMP9321\nWhat this is: a data services course.\n- Assignment 1 marks unknown\n'
  )
  write(
    path.join(UNI, 'comp9321', 'ass1.ipynb'),
    JSON.stringify({
      cells: [
        {
          cell_type: 'markdown',
          source: ['# Assignment 1\n', 'Clean the dataset and build the API.']
        },
        {
          cell_type: 'code',
          source: 'import pandas as pd\ndf = pd.read_csv("data.csv")',
          outputs: [{ data: { 'image/png': NB_OUTPUT_CANARY + 'A'.repeat(200_000) } }]
        }
      ]
    })
  )
  write(
    path.join(UNI, 'comp9321', 'ass1', 'spec.pdf'),
    minimalPdf([
      'Assignment 1 specification',
      'Build a REST API for the dataset.',
      'Due Week 5 Friday'
    ])
  )
  fs.symlinkSync(path.join(VAULT, 'Life'), path.join(UNI, 'comp9321', 'linked-life'))

  // ---- ~/UNI/pysc1023: CONTEXT, brief PDF, a docx draft
  write(
    path.join(UNI, 'pysc1023', 'CONTEXT.md'),
    '# PSYC1023\nWhat this is: an intro psychology course.\n- Find the course outline\n'
  )
  write(
    path.join(UNI, 'pysc1023', 'brief.pdf'),
    minimalPdf(['Essay brief', 'Write 1500 words on memory.'])
  )
  write(
    path.join(UNI, 'pysc1023', 'draft.docx'),
    minimalDocx(['Essay draft on memory', 'Intro paragraph here.'])
  )

  // ---- ~/Projects
  gitRepo(path.join(PROJECTS, 'personal-website'), [
    [
      3,
      'new hero section',
      {
        'CONTEXT.md':
          '# Personal website\nWhat this is: a portfolio site.\n- Domain renewal date unknown\n'
      }
    ]
  ])
  gitRepo(path.join(PROJECTS, 'FocusForge'), [
    [1, 'readers phase', { 'CONTEXT.md': '# FocusForge\nWhat this is: a focus app.\n' }]
  ])
  write(path.join(PROJECTS, 'FocusForge', 'node_modules', 'x.md'), `noise ${SECRET_CANARY}\n`)

  // ---- Vault
  write(path.join(VAULT, '.obsidian', 'app.json'), '{}\n')
  write(
    path.join(VAULT, 'Projects', 'PROJECTS TO DO.md'),
    `# Projects\n## FocusForge\n- [ ] ship the readers\n## Headstart\n- ${SECTION_CANARY}\n`
  )
  write(path.join(VAULT, 'Projects', 'PERSONAL WEB.md'), '# Personal web\n- [ ] new about page\n')
  write(path.join(VAULT, 'Projects', 'PERSONAL WEB 2.md'), 'conflict copy\n')
  write(
    path.join(VAULT, 'Learning', 'Thesis Hub', 'Thesis.md'),
    '# Thesis hub\nSupervisor meets on Tuesdays.\n'
  )
  write(path.join(VAULT, 'Learning', 'Thesis Hub', 'Thesis 2.md'), 'conflict copy of the hub\n')
  write(path.join(VAULT, 'Learning', 'Thesis Hub', '.Thesis notes.md.icloud'), 'stub')
  write(
    path.join(VAULT, 'FocusForge', 'Learning', 'Thesis', 'Thesis.md'),
    '# Thesis\n## State (auto)\napp-owned\n'
  )
  write(path.join(VAULT, 'Life', 'CANARY-LIFE-DO-NOT-READ.md'), LIFE_CANARY)
  write(path.join(VAULT, 'Life', 'Journal', 'day.md'), LIFE_CANARY)
  fs.chmodSync(path.join(VAULT, 'Life', 'Journal'), 0o000)
  fs.chmodSync(path.join(VAULT, 'Life'), 0o000)

  // ---- FlowState: the five slice items with sources, discovery done
  const registry = [
    registryEntry('thesis', 'Thesis', {
      category: 'Learning',
      kind: 'deadline',
      status: 'active',
      sources: [
        path.join(UNI, 'thesis'),
        path.join(UNI, 'thesis-experiments'),
        path.join(VAULT, 'Learning', 'Thesis Hub')
      ]
    }),
    registryEntry('comp9321', 'COMP9321', {
      category: 'Learning',
      kind: 'deadline',
      status: 'active',
      sources: [path.join(UNI, 'comp9321')]
    }),
    registryEntry('psyc1023', 'PSYC1023', {
      category: 'Learning',
      kind: 'deadline',
      status: 'active',
      sources: [path.join(UNI, 'pysc1023')]
    }),
    registryEntry('personalwebsite', 'Personal website', {
      category: 'Projects',
      kind: 'passion',
      status: 'active',
      sources: [
        path.join(PROJECTS, 'personal-website'),
        path.join(VAULT, 'Projects', 'PERSONAL WEB.md')
      ]
    }),
    registryEntry('focusforge', 'FocusForge', {
      category: 'Projects',
      kind: 'passion',
      status: 'active',
      sources: [
        path.join(PROJECTS, 'FocusForge'),
        `${path.join(VAULT, 'Projects', 'PROJECTS TO DO.md')}#FocusForge`
      ]
    })
  ]
  write(path.join(DATA, 'system', 'master_index.json'), JSON.stringify(registry, null, 2))
  write(
    path.join(DATA, 'system', 'settings.json'),
    JSON.stringify(
      {
        vaultPath: VAULT,
        // Vault notes are covered by qa-vault.mjs; keep the writer off here.
        vaultNotes: false,
        sourceRoots: [
          { path: UNI, category: 'Learning' },
          { path: PROJECTS, category: 'Projects' }
        ],
        vaultCategories: ['Learning', 'Projects', 'Career'],
        discoveryCompletedAt: '2026-11-01T00:00:00.000Z',
        discoveryDismissedAt: null,
        aiNudges: false,
        weeklyReview: false
      },
      null,
      2
    )
  )
  write(
    path.join(APP_DATA, 'obsidian', 'obsidian.json'),
    JSON.stringify({ vaults: { qa: { path: VAULT, ts: Date.now(), open: true } } })
  )
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.symlinkSync(path.join(REPO, 'engine'), path.join(ROOT, 'engine'))

  write(
    LAUNCHER,
    `// Generated by scripts/qa-readers-fixtures.mjs. QA only.
const fs = require('fs')
const cp = require('child_process')
const trace = (globalThis.__qaPaths = [])
const rec = (op, p) => { try { trace.push([op, typeof p === 'string' ? p : String(p && p.path || p)]) } catch {} }
for (const name of ['opendir', 'readdir', 'lstat', 'stat', 'readFile', 'open', 'realpath']) {
  const orig = fs.promises[name]
  fs.promises[name] = function (p, ...rest) { rec(name, p); return orig.call(this, p, ...rest) }
}
for (const name of ['readFileSync', 'lstatSync', 'statSync', 'readdirSync', 'opendirSync', 'openSync', 'watch']) {
  const orig = fs[name]
  fs[name] = function (p, ...rest) { rec(name, p); return orig.call(this, p, ...rest) }
}
const native = fs.realpathSync.native
fs.realpathSync.native = function (p, ...rest) { rec('realpathSync', p); return native.call(this, p, ...rest) }
const execFile = cp.execFile
cp.execFile = function (file, args, ...rest) { rec('execFile', [file, ...(args || [])].join(' ')); return execFile.call(this, file, args, ...rest) }
const { app } = require('electron')
app.setPath('appData', ${JSON.stringify(APP_DATA)})
app.setPath('documents', ${JSON.stringify(path.join(ROOT, 'documents'))})
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
    console.log(`Removed ${ROOT}`)
  } else {
    console.log(`Fixture ready: ${JSON.stringify(buildFixtures())}`)
  }
}
