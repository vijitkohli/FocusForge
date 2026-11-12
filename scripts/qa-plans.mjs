// Electron QA for two-level planning (Phase 5), fully isolated under
// /tmp/focusforge-qa/plans: its own FlowState data, app data, launcher and the
// synthetic fixture packs from engine/evals/fixture_pack.py (served through
// FOCUSFORGE_PACK_FIXTURES). Never touches real data, the vault or ~/UNI.
//
//   npx electron-vite build && env -u ELECTRON_RUN_AS_NODE node scripts/qa-plans.mjs [--live-ai]
//
// Without --live-ai only the offline checks run (legacy task unchanged, a
// seeded milestone plan renders, slipped banner, Part N of M in Focus data).
// --live-ai adds real planning calls through CLIProxyAPI with synthetic content.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { connectCdp, sleep } from './qa-cdp.mjs'

const QA_ROOT = '/tmp/focusforge-qa'
const ROOT = path.join(QA_ROOT, 'plans')
const DOCS = path.join(ROOT, 'documents')
const DATA = path.join(DOCS, 'FlowState')
const PACKS = path.join(ROOT, 'packs')
const LAUNCHER = path.join(ROOT, 'launch.cjs')
const OUTPUT = path.join(ROOT, 'screenshots')
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const LIVE = process.argv.includes('--live-ai')

function assertQaPath(p, label = p) {
  const real = path.resolve(p)
  assert.ok(real.startsWith(`${QA_ROOT}/`), `${label} must be under ${QA_ROOT}`)
  return real
}

const local = (offset = 0) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------- Fixture
fs.rmSync(ROOT, { recursive: true, force: true })
for (const p of [DATA, PACKS, OUTPUT]) fs.mkdirSync(assertQaPath(p), { recursive: true })
execFileSync(
  path.join(REPO, 'engine/env/bin/python'),
  [path.join(REPO, 'engine/evals/fixture_pack.py'), '--out', PACKS],
  { stdio: 'ignore' }
)
const write = (p, obj) => {
  fs.mkdirSync(path.dirname(assertQaPath(p)), { recursive: true })
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2))
}
const ledger =
  '## Constraints & Specifications\n\n## Document Excerpts\n\n## Milestones & Completed Work\n\n## Plan Adjustments\n'
const items = [
  { id: 'data9001', name: 'DATA9001', category: 'Learning', kind: 'deadline' },
  { id: 'piano', name: 'Piano', category: 'Life', kind: 'passion' },
  { id: 'website', name: 'Personal website', category: 'Projects', kind: 'passion' }
]
write(
  path.join(DATA, 'system/master_index.json'),
  items.map((i) => ({
    ...i,
    path: path.join(DATA, i.id),
    progress: 0,
    lastActive: new Date().toISOString(),
    status: 'active',
    sources: []
  }))
)
write(
  path.join(DATA, 'system/user_profile.md'),
  '## About Me\n\n## Preferences\n\n## Patterns & Friction\n'
)
write(path.join(DATA, 'system/settings.json'), {
  discoveryCompletedAt: new Date().toISOString(),
  vaultPath: path.join(ROOT, 'vault'),
  vaultNotes: false,
  sourceRoots: [],
  initialActiveKeys: []
})
fs.mkdirSync(path.join(ROOT, 'vault'), { recursive: true })
const legacy = {
  id: 'legacy',
  title: 'Legacy lab',
  createdAt: new Date(Date.now() - 3 * 864e5).toISOString(),
  deadline: local(5),
  status: 'in-progress',
  depth: 'Brief',
  model: '',
  prerequisites: [],
  subtasks: [
    {
      id: 'l1',
      title: 'Open the lab sheet',
      isCompleted: true,
      status: 'done',
      timeEstimate: 5,
      scheduledDate: local(-1),
      completedAt: new Date().toISOString()
    },
    {
      id: 'l2',
      title: 'Write the method section',
      isCompleted: false,
      status: 'todo',
      timeEstimate: 20,
      scheduledDate: local(1)
    }
  ]
}
const assignment = {
  id: 'a3',
  title: 'Assignment 3',
  createdAt: new Date().toISOString(),
  deadline: local(14),
  deadlineKind: 'hard',
  status: 'unplanned',
  depth: 'Deep',
  model: '',
  subtasks: [],
  prerequisites: [],
  origin: { kind: 'deliverable', key: 'deliverable:assignment 3', source: 'data9001/ass3/spec.md' },
  assessment: {
    weight: 15,
    kind: 'assignment',
    notes: '',
    when: 'Week 10',
    source: 'data9001/ass3/spec.md'
  }
}
const seededPlan = {
  id: 'seeded',
  title: 'Seeded milestone plan',
  createdAt: new Date(Date.now() - 5 * 864e5).toISOString(),
  deadline: local(10),
  status: 'in-progress',
  depth: 'Deep',
  model: '',
  prerequisites: [],
  deadlineKind: 'hard',
  milestones: [
    {
      id: 'm1',
      title: 'Read the brief',
      estimateMinutes: 60,
      doneWhen: 'brief read',
      status: 'done',
      completedAt: new Date(Date.now() - 2 * 864e5).toISOString()
    },
    {
      id: 'm2',
      title: 'Draft the report',
      estimateMinutes: 300,
      doneWhen: 'full draft exists',
      status: 'active',
      targetDate: local(-1),
      expanded: 'partial'
    },
    {
      id: 'm3',
      title: 'Revise and submit',
      estimateMinutes: 120,
      doneWhen: 'submitted',
      status: 'todo',
      targetDate: local(9)
    }
  ],
  subtasks: [
    {
      id: 's1',
      title: 'Skim the brief',
      isCompleted: true,
      status: 'done',
      timeEstimate: 15,
      milestoneId: 'm1',
      completedAt: new Date(Date.now() - 3 * 864e5).toISOString()
    },
    {
      id: 's2',
      title: 'Write the intro paragraph',
      isCompleted: false,
      status: 'todo',
      timeEstimate: 20,
      milestoneId: 'm2',
      scheduledDate: local(0)
    },
    {
      id: 's3',
      title: 'Staged revision step',
      isCompleted: false,
      status: 'todo',
      timeEstimate: 15,
      milestoneId: 'm3',
      scheduledDate: local(8)
    }
  ]
}
write(path.join(DATA, 'data9001/project_data.json'), {
  name: 'DATA9001',
  tasks: [assignment, legacy, seededPlan]
})
write(path.join(DATA, 'piano/project_data.json'), {
  name: 'Piano',
  tasks: [
    {
      id: 'piano-goal',
      title: 'Learn piano',
      createdAt: new Date().toISOString(),
      deadline: local(28),
      deadlineKind: 'none',
      scope: 'goal',
      status: 'unplanned',
      depth: 'Deep',
      model: '',
      subtasks: [],
      prerequisites: []
    }
  ]
})
write(path.join(DATA, 'website/project_data.json'), { name: 'Personal website', tasks: [] })
for (const i of items) write(path.join(DATA, i.id, `context_${i.id}.md`), ledger)
fs.symlinkSync(path.join(REPO, 'engine'), path.join(ROOT, 'engine'))
write(
  LAUNCHER,
  `// Generated by scripts/qa-plans.mjs. QA only.
const { app } = require('electron')
app.setPath('appData', ${JSON.stringify(path.join(ROOT, 'app-data'))})
app.setPath('documents', ${JSON.stringify(DOCS)})
app.setPath('userData', ${JSON.stringify(path.join(ROOT, 'user-data'))})
require(${JSON.stringify(path.join(REPO, 'out/main/index.js'))})
`
)
const launcherText = fs.readFileSync(LAUNCHER, 'utf8')
for (const k of ['appData', 'documents', 'userData'])
  assert.match(
    launcherText,
    new RegExp(`setPath\\('${k}', "/tmp/focusforge-qa/plans/`),
    `launcher ${k}`
  )

// ---------- Launch
const require = createRequire(import.meta.url)
const electron = require('electron')
const env = { ...process.env, FOCUSFORGE_PACK_FIXTURES: PACKS }
delete env.ELECTRON_RUN_AS_NODE
const app = spawn(electron, ['--remote-debugging-port=9353', '--inspect=9355', LAUNCHER], {
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
let cdp

const load = async (projectId, taskId) =>
  (await cdp.evaluate(`window.api.loadProjectData(${JSON.stringify(projectId)})`)).tasks.find(
    (t) => t.id === taskId
  )
const text = () => cdp.evaluate('document.body.innerText')
async function openTask(item, title) {
  await cdp.evaluate(
    `(() => { const el = [...document.querySelectorAll('aside button')].find(e => e.textContent.trim() === ${JSON.stringify(item)} || (e.getAttribute('aria-label') || '').startsWith(${JSON.stringify(item)})); el && el.click() })()`
  )
  await cdp.waitFor(`document.body.innerText.includes(${JSON.stringify(title)})`, `task ${title}`)
  await cdp.click(title, { exact: false })
  await cdp.waitFor(`!!document.querySelector('[aria-label="Task options"]')`, 'task page')
  await sleep(400)
}

try {
  cdp = await connectCdp({
    port: 9353,
    mainPort: 9355,
    output: OUTPUT,
    log: () => appLog.slice(-2000)
  })
  await cdp.waitFor(`!!document.querySelector('aside')`, 'app shell', 30000)

  // 6. Legacy task renders as before: no Parts, plain "Steps".
  await openTask('DATA9001', 'Legacy lab')
  let body = await text()
  assert.ok(!body.includes('The whole job'), 'legacy task shows no milestones')
  assert.ok(/\nSteps\n/.test(body) || body.includes('Steps'), 'legacy steps heading')
  await cdp.screenshot('legacy-task', 1280, 860)
  pass('legacy task renders without milestones')

  // Seeded plan: parts, current steps only, slipped banner.
  await openTask('DATA9001', 'Seeded milestone plan')
  body = await text()
  assert.ok(body.includes('The whole job · ~8 h · 1 of 3 parts done'), 'milestone summary')
  assert.ok(body.includes('Steps for Draft the report'), 'steps title names the active part')
  assert.ok(!body.includes('Staged revision step'), 'staged steps hidden')
  assert.ok(body.includes('ran past its planned day'), 'slipped banner')
  await cdp.screenshot('seeded-plan', 1280, 900)
  pass('seeded plan shows parts, current steps and the slipped banner')

  // 7. Focus data carries Part N of M.
  const upcoming = await cdp.evaluate('window.api.getUpcomingSubtasks()')
  const s2 = upcoming.find((u) => u.subtaskId === 's2')
  assert.equal(`${s2.milestoneIndex}/${s2.milestoneCount}`, '2/3')
  assert.ok(!upcoming.some((u) => u.subtaskId === 's3'), 'staged step not in the queue')
  pass('queue carries Part 2 of 3 and hides staged steps')

  const next = await cdp.evaluate('window.api.getNextSteps()')
  assert.ok(
    next.some((n) => n.taskId === 'a3' && n.needsPlan),
    'unplanned deliverable needs a plan'
  )
  pass('getNextSteps flags the unplanned task')

  if (LIVE) {
    // 1. Make a plan from the fixture pack.
    const planned = await cdp.evaluate(`window.api.planTask('data9001', 'a3')`)
    assert.equal(planned.status, 'planned', planned.message)
    let task = await load('data9001', 'a3')
    const total = task.milestones.reduce((s, m) => s + m.estimateMinutes, 0)
    assert.ok(total >= 600, `whole job ${total} min >= 10 h`)
    assert.ok(
      task.subtasks[0].timeEstimate <= 5 && task.subtasks[0].scheduledDate === local(0),
      'first step small and today'
    )
    assert.ok(
      !task.subtasks.some((s) => /\b(chat ?gpt|copilot|ai)\b/i.test(s.title)),
      'no AI steps'
    )
    await openTask('DATA9001', 'Assignment 3')
    assert.ok((await text()).includes('The whole job'))
    await cdp.screenshot('planned-assignment', 1280, 900)
    pass(`Make a plan: ${task.milestones.length} parts, ~${Math.round(total / 60)} h`)

    // 3. Stuck? keeps the milestone.
    const stuck = task.subtasks[1]
    const split = await cdp.evaluate(
      `window.api.splitStep('data9001', 'a3', ${JSON.stringify(stuck.id)})`
    )
    assert.ok(split.success, split.message)
    assert.ok(
      split.created.every((s) => s.milestoneId === stuck.milestoneId),
      'split parts keep the milestone'
    )
    pass('Stuck? split keeps steps in the same part')

    // 2. Tick through the batch: background planning stages / continues.
    task = await load('data9001', 'a3')
    const first = task.milestones.find((m) => m.status === 'active')
    const data = await cdp.evaluate(`window.api.loadProjectData('data9001')`)
    const t = data.tasks.find((x) => x.id === 'a3')
    const now = new Date().toISOString()
    t.subtasks = t.subtasks.map((s) =>
      s.milestoneId === first.id ? { ...s, isCompleted: true, status: 'done', completedAt: now } : s
    )
    const save = await cdp.evaluate(
      `window.api.saveProjectData('data9001', ${JSON.stringify(data)}, [], ${data.rev ?? 0})`
    )
    assert.ok(save.success, 'ticked batch saved')
    await cdp.waitFor(
      `window.api.loadProjectData('data9001').then(d => { const t = d.tasks.find(x => x.id === 'a3'); const cur = t.milestones.find(m => m.status !== 'done'); return t.subtasks.some(s => s.milestoneId === (cur && cur.id) && !s.isCompleted) })`,
      'next steps after the batch',
      200000
    )
    pass('next steps appear after finishing the batch (no reload)')

    // 4. AdjustPlan on a milestone task routes to replan; done work kept.
    task = await load('data9001', 'a3')
    const doneBefore = task.subtasks.filter((s) => s.isCompleted).map((s) => s.id)
    const adj = await cdp.evaluate(
      `window.api.updateChecklist('data9001', 'a3', 'make it lighter this week', ${JSON.stringify({ originalTask: task.title, subtasks: task.subtasks, prerequisites: [] })}, ${JSON.stringify(task.deadline)}, 'Deep', '')`
    )
    assert.ok(adj.success, adj.message)
    task = await load('data9001', 'a3')
    assert.ok(
      doneBefore.every((id) => task.subtasks.find((s) => s.id === id)?.isCompleted),
      'done steps kept'
    )
    pass('AdjustPlan "lighter this week" re-plans and keeps done work')

    // 5. Re-plan the rest from the slipped banner (seeded plan).
    await openTask('DATA9001', 'Seeded milestone plan')
    await cdp.click('Re-plan the rest')
    await cdp.waitFor(`!document.body.innerText.includes('Re-planning…')`, 'replan done', 200000)
    const seeded = await load('data9001', 'seeded')
    assert.equal(seeded.milestones[0].status, 'done')
    assert.ok(
      seeded.milestones
        .filter((m) => m.status !== 'done')
        .every((m) => !m.targetDate || m.targetDate >= local(0))
    )
    pass('Re-plan the rest moves remaining parts to today onwards')

    // 8. Name-only item asks one question, then plans.
    const q = await cdp.evaluate(`window.api.planTask('piano', 'piano-goal')`)
    assert.equal(q.status, 'clarifying', q.message)
    assert.ok((q.question.match(/\?/g) || []).length === 1, 'one question')
    const answered = await cdp.evaluate(
      `window.api.planTask('piano', 'piano-goal', 'Play one simple song with both hands by ear')`
    )
    assert.equal(answered.status, 'planned', answered.message)
    pass(`name-only item: one question ("${q.question}") then a plan`)
  } else {
    console.log('(skipping live-AI checks; pass --live-ai)')
  }
  assert.deepEqual(cdp.errors ?? [], [], 'renderer errors')
} catch (err) {
  console.error('✗', err.message)
  process.exitCode = 1
} finally {
  fs.writeFileSync(
    path.join(OUTPUT, 'report.json'),
    JSON.stringify({ live: LIVE, results }, null, 2)
  )
  fs.writeFileSync(path.join(OUTPUT, 'electron.log'), appLog)
  app.kill()
}
