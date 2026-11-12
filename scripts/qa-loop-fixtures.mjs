// Isolated home for the Phase 7 loop. Empty FlowState, so the app starts at
// discovery. Everything is under /tmp/focusforge-qa-loop. Content is synthetic.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { minimalPdf } from './qa-readers-fixtures.mjs'

export const LOOP_ROOT = '/tmp/focusforge-qa-loop'
export const HOME = path.join(LOOP_ROOT, 'home')
export const VAULT = path.join(HOME, 'Vault')
export const UNI = path.join(HOME, 'UNI')
export const PROJECTS = path.join(HOME, 'Projects')
export const DATA = path.join(LOOP_ROOT, 'documents', 'FlowState')
export const USER_DATA = path.join(LOOP_ROOT, 'user-data')
export const APP_DATA = path.join(LOOP_ROOT, 'app-data')
export const LAUNCHER = path.join(LOOP_ROOT, 'launch.cjs')
export const SNAPSHOT = path.join(LOOP_ROOT, 'fixture-snapshot.json')

export const LIFE_CANARY = 'LIFE-CANARY-7f3a'
export const SECRET_CANARY = 'SECRET-CANARY-9b2c'
export const SECTION_CANARY = 'SECTION-CANARY-2e8d'
export const SK_CANARY = 'sk-test-ABCDEFGHIJKLMNOP123456'
export const BODY_CANARY = 'BODY-NOT-NEEDED-5d1e'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DAY = 86_400_000

export function assertLoopPath(p, label = 'path') {
  const abs = path.resolve(p)
  const ok = [LOOP_ROOT, '/private' + LOOP_ROOT].some((r) => abs === r || abs.startsWith(r + path.sep))
  if (!ok) throw new Error(`Refusing: ${label} is outside ${LOOP_ROOT}: ${abs}`)
  return abs
}

function localKey(offset = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function write(file, data = '', ageDays = 0) {
  assertLoopPath(file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data)
  if (ageDays) {
    const t = new Date(Date.now() - ageDays * DAY)
    fs.utimesSync(file, t, t)
  }
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

function snapshot(dir) {
  const out = []
  const walk = (cur) => {
    for (const name of fs.readdirSync(cur).sort()) {
      const p = path.join(cur, name)
      if (p === path.join(VAULT, 'Life') || p.startsWith(path.join(VAULT, 'Life') + path.sep)) continue
      const st = fs.lstatSync(p)
      out.push([path.relative(HOME, p), st.isDirectory() ? -1 : st.size, Math.round(st.mtimeMs)])
      if (st.isDirectory() && !st.isSymbolicLink()) walk(p)
    }
  }
  for (const top of ['UNI', 'Projects', 'Vault']) walk(path.join(HOME, top))
  return out
}

export function buildLoopFixtures() {
  assertLoopPath(LOOP_ROOT)
  const reopen = (dir) => {
    if (!fs.existsSync(dir)) return
    try {
      fs.chmodSync(dir, 0o755)
    } catch {
      /* already open */
    }
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      if (fs.statSync(p).isDirectory()) reopen(p)
    }
  }
  reopen(path.join(VAULT, 'Life'))
  fs.rmSync(LOOP_ROOT, { recursive: true, force: true })
  const dueTomorrow = localKey(1)
  const dueLater = localKey(9)

  write(
    path.join(UNI, 'comp9321/CONTEXT.md'),
    `# COMP9321\n\nWhat this is: a data services course.\n\n- [ ] Assignment 3 [due:: ${dueTomorrow}]\n`
  )
  write(
    path.join(UNI, 'thesis/CONTEXT.md'),
    `# Thesis\n\nWhat this is: a research thesis.\n\n- [ ] Proposal v5 to supervisor [due:: ${dueLater}]\n- Week 11 presentation date TBC\n`
  )
  write(path.join(UNI, 'thesis-experiments/README.md'), 'Pilot notes.\n')
  gitRepo(path.join(UNI, 'thesis-experiments'), 1, { 'README.md': 'Pilot notes.\n' })
  write(path.join(UNI, 'pysc1023/CONTEXT.md'), '# PSYC1023\n\nWhat this is: a psychology course.\n')
  write(path.join(UNI, 'pysc1023/brief.pdf'), minimalPdf(['QA-BRIEF-TEXT', 'Week 3 reading']))
  write(path.join(UNI, 'pysc1023/rubric.pdf'), minimalPdf(['QA-RUBRIC-TEXT']))
  write(path.join(UNI, 'GITLAB PAT.rtf'), SECRET_CANARY)
  write(path.join(UNI, 'comp9321/.env'), `TOKEN=${SK_CANARY}\n`)
  write(path.join(VAULT, '.obsidian/app.json'), '{}\n')
  write(path.join(VAULT, 'Life/CANARY-LIFE-DO-NOT-READ.md'), LIFE_CANARY)
  try {
    fs.symlinkSync(path.join(VAULT, 'Life'), path.join(UNI, 'comp9321/linked-life'))
  } catch {
    /* already linked */
  }
  fs.chmodSync(path.join(VAULT, 'Life'), 0o000)

  write(
    path.join(PROJECTS, 'personal-website/CONTEXT.md'),
    '# Personal website\n\nWhat this is: a small site.\n',
    6
  )
  gitRepo(path.join(PROJECTS, 'FocusForge'), 2, {
    'CONTEXT.md': '# FocusForge\n\nWhat this is: a study app.\n',
    'CLAUDE.md': '# Notes\n'
  })
  gitRepo(path.join(PROJECTS, 'headstart-mentoring'), 1, { 'README.md': 'A mentoring site.\n' })

  write(path.join(VAULT, '.obsidian/app.json'), '{}\n')
  write(path.join(VAULT, 'Learning/Thesis Hub/Thesis.md'), 'Thesis hub note.\n')
  write(path.join(VAULT, 'Learning/Courses/26T3/PSYC1023.md'), 'Course note.\n')
  write(path.join(VAULT, 'Learning/COMP9321 - Data Services.md'), 'Course note.\n')
  write(path.join(VAULT, 'Projects/PERSONAL WEB.md'), 'Site note.\n')
  write(path.join(VAULT, 'Projects/PERSONAL WEB 2.md'), 'conflict copy\n')
  write(path.join(VAULT, 'Projects/PERSONAL WEB.md.icloud'), '')
  write(
    path.join(VAULT, 'Projects/PROJECTS TO DO.md'),
    `# Projects\n## FocusForge\n- [ ] thing\n## Random Idea\n${BODY_CANARY}\n## Other\n${SECTION_CANARY}\n`
  )

  write(path.join(DATA, 'system/master_index.json'), '[]\n')
  write(
    path.join(DATA, 'system/settings.json'),
    JSON.stringify(
      {
        chatModel: 'cliproxy/gemini-3-flash',
        planModel: 'cliproxy/gemini-3-flash',
        digestModel: 'cliproxy/gemini-3-flash',
        vaultPath: VAULT,
        vaultNotes: true,
        readersEnabled: true,
        sourceRoots: [
          { path: UNI, category: 'Learning' },
          { path: PROJECTS, category: 'Projects' }
        ],
        vaultCategories: ['Learning', 'Projects', 'Career'],
        initialActiveKeys: ['thesis', 'comp9321', 'psyc1023', 'personalwebsite', 'focusforge'],
        discoveryCompletedAt: null,
        discoveryDismissedAt: null
      },
      null,
      2
    )
  )
  write(
    path.join(APP_DATA, 'obsidian/obsidian.json'),
    JSON.stringify({ vaults: { qa: { path: VAULT, ts: Date.now(), open: true } } })
  )
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.symlinkSync(path.join(REPO, 'engine'), path.join(LOOP_ROOT, 'engine'))
  const realPython = path.join(REPO, 'engine/env/bin/python')
  write(
    LAUNCHER,
    `const fs = require('fs')
const { app } = require('electron')
app.setPath('appData', ${JSON.stringify(APP_DATA)})
app.setPath('documents', ${JSON.stringify(path.join(LOOP_ROOT, 'documents'))})
app.setPath('userData', ${JSON.stringify(USER_DATA)})
require(${JSON.stringify(path.join(REPO, 'out/main/index.js'))})
`
  )
  fs.writeFileSync(SNAPSHOT, JSON.stringify(snapshot(HOME)))
  return { realPython: fs.existsSync(realPython) ? realPython : 'python3' }
}
