import { app, shell, BrowserWindow, ipcMain, dialog, Notification } from 'electron'
import { basename, join } from 'path'
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

import { FileSystemManager } from './fs-manager'
import { randomUUID } from 'crypto'
import {
  DecompositionResult,
  LedgerNote,
  ProjectData,
  SplitStepResult,
  Subtask,
  UserProfileNote
} from '../common/types'
import { normaliseSplit, spliceSplit } from '../common/split'
import {
  OutlineAssessment,
  OutlineReadResult,
  addAssessmentTasks,
  outlineLedgerNote
} from '../common/outline'
import { localDateKey } from '../common/schedule'
import { TodayPlan } from '../common/today'
import { WeeklyReview, reviewWeekDue, templateReview } from '../common/review'
import { materialiseSeries, seriesTemplate, startSeries, stopSeries } from '../common/recurrence'
import {
  EngineCall,
  EngineCallRegistry,
  EngineCancelled,
  EngineMessage,
  EngineTimeout,
  WarmSpare,
  runEngine
} from './engine'
import { PythonShell } from 'python-shell'
import { mergeChecklist, requestsRemovingCompleted } from '../common/merge'
import { loadSettings, saveSettings, sanitizeRendererSettingsPatch } from './settings'
import { registerSourceHandlers, guardedCreateFields } from './ipc/sources'
import { invalidateGuard } from './sources'
import fs from 'fs-extra'
import { BACKUP_DIR } from './store/paths'
import { ProxyHealth, usesProxy } from './proxyHealth'
import { initReaders, type ReaderWiring } from './ipc/readers'
import { initVaultSync } from './ipc/vault'
import type { VaultSync } from './vault'
import { PlannerDeps, PlanMode, runPlan } from './planning/planner'
import { PlanQueue, advanceTask, jobFor } from './planning/planQueue'
import { registerPackSource, resolvePackSource, StorePackSource } from './planning/packSource'
import { ItemTaskDeps, syncItemTasks } from './itemTasks'
import { withDismissed } from '../common/itemTasks'
import { hasMilestones, type PlanTaskResult } from '../common/milestones'
import { toProxyView, type ProxyHealthView } from '../common/whatNext'
import { WhatNextStore } from './store/WhatNextStore'
import { BACKGROUND_PLAN_DAILY_CAP, fillMissing } from './whatNext/fillMissing'

const fsManager = new FileSystemManager()

let mainWindow: BrowserWindow | null = null

// The one shared CLIProxyAPI health check (readers, planQueue and the sidebar dot).
const proxyHealth = new ProxyHealth()
const whatNext = new WhatNextStore({
  itemIds: () =>
    fsManager
      .getProjects()
      .filter((p) => p.status === 'active')
      .map((p) => p.id),
  readDigest: (id) => readers?.store.readDigest(id) ?? Promise.resolve(null)
})
// Phase 3 readers: watch item sources and keep packs and digests current.
let readers: (ReaderWiring & { startDelayMs: number }) | null = null
// Phase 4 vault notes (item/task notes under <vault>/FocusForge, ticks read back).
let vault: VaultSync | null = null

/**
 * Directory containing the Python engine scripts. Derived from the app path
 * (not process.cwd(), which depends on how the app was launched). When this app
 * gets packaged/frozen later, this is the single seam to point at
 * process.resourcesPath instead.
 */
function resolveEngineDir(): string {
  return join(app.getAppPath(), 'engine')
}

/**
 * Locates the Python interpreter to run the engine with. Order:
 *   1. UNI_AGENT_PYTHON env override (absolute path),
 *   2. the repo venv (engine/env) — posix `bin/python` or Windows `Scripts/python.exe`,
 *   3. `python3` on PATH as a last resort.
 */
function resolvePython(): string {
  const override = process.env.UNI_AGENT_PYTHON
  if (override && existsSync(override)) return override

  const engineDir = resolveEngineDir()
  const isWin = process.platform === 'win32'
  const venvPython = join(
    engineDir,
    'env',
    isWin ? 'Scripts' : 'bin',
    isWin ? 'python.exe' : 'python'
  )
  if (existsSync(venvPython)) return venvPython

  return isWin ? 'python' : 'python3'
}

const PYTHON_PATH = resolvePython()

const NUDGE_INTERVAL_MS = 1000 * 60 * 60 * 6 // re-check every 6 hours while running
const NUDGE_AI_TIMEOUT_MS = 25000

/**
 * Optionally rewrites the template nudge copy with the LLM (engine/nudge.py) so
 * it fits the user's profile and streak. Which item to nudge is still decided
 * deterministically by getNudge(); on any failure or timeout the template
 * body is used, so a nudge is never lost to a flaky model call.
 */
async function personaliseNudge(nudge: {
  body: string
  subject: string
  reason: 'overdue' | 'idle'
}): Promise<string> {
  try {
    const settings = await loadSettings()
    if (!settings.aiNudges) return nudge.body

    const [userProfile, stats] = await Promise.all([
      fsManager.readUserProfileForPrompt(),
      fsManager.getActivityStats()
    ])
    const result = await runPythonWithStdin(
      'nudge.py',
      {
        draft: nudge.body,
        subject: nudge.subject,
        reason: nudge.reason,
        currentStreak: stats.currentStreak,
        userProfile,
        model: settings.chatModel
      },
      NUDGE_AI_TIMEOUT_MS
    ).promise
    const body = typeof result?.body === 'string' ? result.body.trim() : ''
    return body || nudge.body
  } catch (err) {
    console.error('Nudge personalisation failed, using template', err)
    return nudge.body
  }
}

const REVIEW_CHECK_INTERVAL_MS = 1000 * 60 * 60 // hourly; a review is due Sunday 17:00 for 3 days
const REVIEW_AI_TIMEOUT_MS = 25000
let reviewing = false

/** Numbers + template copy, rewritten by engine/review.py when it answers in time. */
async function buildWeeklyReview(weekStart: string): Promise<WeeklyReview> {
  const summary = await fsManager.getWeekSummary(weekStart)
  const template = templateReview(summary)
  const review: WeeklyReview = {
    weekStart,
    generatedAt: new Date().toISOString(),
    summary,
    ...template,
    source: 'template'
  }
  try {
    const [settings, userProfile] = await Promise.all([
      loadSettings(),
      fsManager.readUserProfileForPrompt()
    ])
    const result = await runPythonWithStdin(
      'review.py',
      { summary, template, userProfile, model: settings.chatModel },
      REVIEW_AI_TIMEOUT_MS
    ).promise
    if (!result.error && typeof result.text === 'string' && typeof result.suggestion === 'string') {
      review.text = result.text
      review.suggestion = result.suggestion
      review.source = 'ai'
    }
  } catch (err) {
    console.error('Weekly review personalisation failed, using template', err)
  }
  return review
}

/**
 * Writes the week's review once, from Sunday 17:00 (or the next launch within
 * three days), then shows a notification that opens History.
 */
async function maybeWeeklyReview(): Promise<void> {
  if (reviewing) return
  reviewing = true
  try {
    const settings = await loadSettings()
    if (!settings.weeklyReview) return
    const weekStart = reviewWeekDue(new Date())
    if (!weekStart || (await fsManager.hasReview(weekStart))) return
    const review = await buildWeeklyReview(weekStart)
    await fsManager.saveReview(review)
    mainWindow?.webContents.send('reviews-changed')
    if (!Notification.isSupported()) return
    const notification = new Notification({
      title: 'Your week',
      body: review.text.length > 180 ? `${review.text.slice(0, 177)}…` : review.text
    })
    notification.on('click', () => {
      if (!mainWindow) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      mainWindow.webContents.send('open-history')
    })
    notification.show()
  } catch (err) {
    console.error('Weekly review failed', err)
  } finally {
    reviewing = false
  }
}

/** Adds the next week's copy of each weekly series that has come due (all projects). */
async function materialiseRecurring(projectIds?: string[]): Promise<number> {
  let total = 0
  const today = localDateKey(new Date())
  for (const projectId of projectIds ?? fsManager.getProjects().map((p) => p.id)) {
    try {
      await fsManager.updateProjectData(projectId, async (file) => {
        if (!(file.tasks ?? []).some((task) => task.recurrence)) return null
        const { tasks, created } = materialiseSeries(file.tasks, today, () => randomUUID())
        if (created.length === 0) return null
        total += created.length
        return {
          data: { ...file, tasks },
          notes: created.map((task) => ({
            section: 'Plan Adjustments' as const,
            note: `Created "${task.title}" (due ${task.deadline}) from its weekly series.`
          }))
        }
      })
    } catch (err) {
      console.error(`Recurring tasks for ${projectId} failed`, err)
    }
  }
  if (total > 0) mainWindow?.webContents.send('tasks-changed')
  return total
}

/**
 * Asks the FS manager whether a gentle nudge is warranted (quiet hours +
 * once-per-item-per-day guard live there) and shows a supportive system
 * notification if so. Clicking it focuses the window and opens Start Now.
 */
async function maybeNudge(): Promise<void> {
  try {
    if (!Notification.isSupported()) return
    const nudge = await fsManager.getNudge()
    if (!nudge) return

    const notification = new Notification({
      title: nudge.title,
      body: await personaliseNudge(nudge)
    })
    notification.on('click', () => {
      if (!mainWindow) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      mainWindow.webContents.send('open-focus')
    })
    notification.show()
  } catch (err) {
    console.error('Nudge check failed', err)
  }
}

const CHAT_TIMEOUT_MS = 120_000
const ADJUST_TIMEOUT_MS = 120_000
const EXTRACT_TIMEOUT_MS = 180_000
const SPLIT_TIMEOUT_MS = 60_000

const COACH_TIMEOUT_MESSAGE =
  'The coach took too long to answer. Check that CLIProxyAPI is running, then send again.'
const SPLIT_TIMEOUT_MESSAGE =
  'The coach took too long to split this step. Check that CLIProxyAPI is running, then try again.'
const ADJUST_TIMEOUT_MESSAGE =
  'The coach took too long to change the plan. Check that CLIProxyAPI is running, then try again.'

// In-flight engine calls the renderer can stop, keyed `<kind>:<webContentsId>`.
const engineCalls = new EngineCallRegistry()

// An idle main.py that has already imported LiteLLM, so coach turns, plan
// changes and splits skip ~1.5 s of Python start-up. Started once the app is ready.
let mainSpare: WarmSpare | null = null
function engineShell(scriptName: string): PythonShell | undefined {
  return scriptName === 'main.py' ? mainSpare?.take() : undefined
}

/**
 * One-shot engine call: writes one JSON payload to the script's stdin and
 * resolves with the last JSON line it prints. Used for plan adjustment,
 * document extraction and nudges.
 */
function runPythonWithStdin(scriptName: string, payload: unknown, timeoutMs: number): EngineCall {
  // Python redirects all diagnostic output to stderr so it never corrupts the
  // json-mode stdout stream - surface it so failures aren't invisible.
  return runEngine(join(resolveEngineDir(), scriptName), payload, {
    pythonPath: PYTHON_PATH,
    shell: engineShell(scriptName),
    timeoutMs,
    onStderr: (line) => console.error(`[${scriptName}]`, line)
  })
}

/**
 * Streaming variant for engine/main.py: the script emits NDJSON
 * `{type:'token', text}` lines as it generates, then one
 * `{type:'result', ...EngineResponse}` line, and OPTIONALLY a trailing
 * `{type:'notes', notes, userNotes}` line (durable facts extracted from the
 * turn after the reply was streamed). Tokens go to `onToken`; the promise
 * resolves as soon as the `result` line arrives so the UI commits immediately
 * with no stall, and `onNotes` fires later (fire-and-forget) if a notes line
 * follows.
 */
function runPythonStreaming(
  payload: unknown,
  onToken: (text: string) => void,
  onNotes?: (notes: LedgerNote[], userNotes: UserProfileNote[]) => void
): EngineCall {
  return runEngine(
    join(resolveEngineDir(), 'main.py'),
    { ...(payload as object), stream: true },
    {
      pythonPath: PYTHON_PATH,
      shell: engineShell('main.py'),
      timeoutMs: CHAT_TIMEOUT_MS,
      resolveOn: (message) => message?.type === 'result',
      onMessage: (message) => {
        if (message?.type === 'token') onToken(message.text ?? '')
        else if (message?.type === 'notes') onNotes?.(message.notes ?? [], message.userNotes ?? [])
      },
      onStderr: (line) => console.error('[main.py]', line)
    }
  )
}

// --- Two-level planning (Phase 5) ------------------------------------------------

const PLAN_CANCELLED_MESSAGE = ''

function plannerDeps(trackKey?: string): PlannerDeps {
  return {
    loadProjectData: (id) => fsManager.loadProjectData(id),
    updateProjectData: (id, mutate, tag) => fsManager.updateProjectData(id, mutate, tag),
    getProject: (id) => fsManager.getProjects().find((p) => p.id === id),
    packSource: resolvePackSource(),
    readLedger: (id) => fsManager.readContextLedgerForPrompt(id),
    readProfile: () => fsManager.readUserProfileForPrompt(),
    planModel: async () => {
      const settings = await loadSettings()
      return settings.planModel || settings.chatModel
    },
    estimateRatio: async () => (await fsManager.getEstimateAccuracy())?.ratio,
    runEngine: (payload, timeoutMs) => {
      const call = runPythonWithStdin('main.py', payload, timeoutMs)
      return (trackKey ? engineCalls.track(trackKey, call) : call).promise
    },
    newId: () => randomUUID()
  }
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, ...args)
}

let proxyConfigured = false
let stopProxyPoll: (() => void) | null = null
let offProxyChange: (() => void) | null = null
let fillTimer: ReturnType<typeof setTimeout> | null = null

function proxyView(): ProxyHealthView {
  return toProxyView(proxyConfigured, proxyHealth.current())
}

function publishProxy(): void {
  broadcast('proxy-health', proxyView())
}

/** Poll only while a configured model goes through CLIProxyAPI. No key is read. */
function applyProxyMode(settings: {
  chatModel?: string
  planModel?: string
  digestModel?: string
}): void {
  const configured = [settings.chatModel, settings.planModel, settings.digestModel].some((m) =>
    usesProxy(m)
  )
  proxyConfigured = configured
  stopProxyPoll?.()
  stopProxyPoll = null
  offProxyChange?.()
  offProxyChange = null
  if (!configured) {
    publishProxy()
    return
  }
  offProxyChange = proxyHealth.onChange((up) => {
    publishProxy()
    if (up) scheduleFill()
  })
  stopProxyPoll = proxyHealth.startPolling()
  publishProxy()
}

function scheduleFill(ms = 5_000): void {
  if (fillTimer) clearTimeout(fillTimer)
  fillTimer = setTimeout(() => {
    fillTimer = null
    void runFill()
  }, ms)
  ;(fillTimer as { unref?: () => void }).unref?.()
}

async function runFill(): Promise<void> {
  if (!planQueue) return
  const remaining = BACKGROUND_PLAN_DAILY_CAP - (await whatNext.enqueuedToday())
  if (remaining <= 0) return
  const added = await fillMissing({
    getNextSteps: () => fsManager.getNextSteps(),
    readerStatus: () => readers?.service.status() ?? {},
    dues: () => whatNext.dues(),
    remaining,
    enqueue: async (job) => {
      const data = await fsManager.loadProjectData(job.projectId)
      const task = data?.tasks.find((t) => t.id === job.taskId)
      if (!task || !planQueue) return false
      const built = jobFor(job.projectId, task, true)
      if (!built || 'advance' in built) return false
      return planQueue.enqueue(built)
    }
  })
  if (added > 0) await whatNext.addEnqueues(added)
}

/** Foreground plan / expand / replan from the task page (Stop button = 'plan'). */
async function runPlanIpc(
  senderId: number,
  projectId: string,
  taskId: string,
  mode: PlanMode,
  opts: { answer?: string; request?: string; milestoneId?: string } = {}
): Promise<PlanTaskResult> {
  try {
    const result = await runPlan(plannerDeps(`plan:${senderId}`), projectId, taskId, mode, opts)
    if (result.success) broadcast('tasks-changed')
    return result
  } catch (err) {
    if (err instanceof EngineCancelled) {
      return { success: false, status: 'cancelled', message: PLAN_CANCELLED_MESSAGE }
    }
    if (err instanceof EngineTimeout) {
      return {
        success: false,
        status: 'error',
        message: 'Planning took too long. Check that CLIProxyAPI is running, then try again.'
      }
    }
    console.error('Plan error', err)
    return { success: false, status: 'error', message: "Couldn't reach the planner. Try again." }
  }
}

let planQueue: PlanQueue | null = null

function itemTaskDeps(): ItemTaskDeps {
  return {
    getProject: (id) => fsManager.getProjects().find((p) => p.id === id),
    packSource: resolvePackSource(),
    updateProjectData: (id, mutate) => fsManager.updateProjectData(id, mutate),
    newId: () => randomUUID()
  }
}

/**
 * Digest refreshed (SYNC_PLAN contract 6: Phase 3's ReaderService.onDigest
 * calls this once merged): create or refresh deliverable/goal tasks. The save
 * hook then queues their background plans.
 */
async function onDigestUpdated(projectId: string): Promise<void> {
  try {
    const result = await syncItemTasks(itemTaskDeps(), projectId)
    if (result.added > 0 || result.updated > 0) broadcast('tasks-changed')
  } catch (err) {
    console.error(`Item task sync failed for ${projectId}`, err)
  }
  scheduleFill()
}

function startPlanQueue(): void {
  planQueue = new PlanQueue({
    // One shared proxy-health instance (SYNC_PLAN contract 5).
    health: {
      isUp: () => proxyHealth.current().up ?? proxyHealth.check(),
      onChange: (cb) => proxyHealth.onChange(cb)
    },
    loadProjectData: (id) => fsManager.loadProjectData(id),
    isActive: (id) => fsManager.getProjects().some((p) => p.id === id && p.status === 'active'),
    run: (job) =>
      runPlan(plannerDeps('plan:background'), job.projectId, job.taskId, job.kind, {
        milestoneId: job.milestoneId
      }),
    advance: async (projectId, taskId, from) => {
      await fsManager.updateProjectData(projectId, async (file) => {
        const idx = file.tasks.findIndex((t) => t.id === taskId)
        const next = idx === -1 ? null : advanceTask(file.tasks[idx], from)
        if (!next) return null
        const done = next.milestones?.find((m) => m.id === from)
        file.tasks[idx] = next
        return {
          data: file,
          notes: [
            {
              section: 'Milestones & Completed Work',
              note: `Finished "${done?.title}" (${file.tasks[idx].title}).`
            }
          ]
        }
      })
    },
    notify: (event) => broadcast('plan-status', event),
    tasksChanged: () => broadcast('tasks-changed')
  })
  fsManager.onSaved((projectId, data) => {
    void planQueue?.onProjectSaved(projectId, data)
    scheduleFill()
  })
}

function createWindow(): void {
  // Create the browser window.
  const win = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow = win

  win.on('ready-to-show', () => {
    win.show()
  })

  // Electron persists the per-window zoom level in the session, so a zoom
  // set in a previous run sticks across restarts. With no app menu defined
  // (autoHideMenuBar), the standard Cmd+/Cmd- accelerators are never
  // registered either, so a stuck zoom can't be undone from the keyboard.
  // Reset to 100% on every load and wire up working zoom shortcuts below.
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomLevel(0)
  })

  // Register zoom keybindings directly on the webContents (independent of any
  // app menu). Cmd/Ctrl + '=' or '+' zooms in, '-' zooms out, '0' resets.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const mod = process.platform === 'darwin' ? input.meta : input.control
    if (!mod) return

    const current = win.webContents.getZoomLevel()
    if (input.key === '=' || input.key === '+') {
      win.webContents.setZoomLevel(current + 0.5)
      event.preventDefault()
    } else if (input.key === '-' || input.key === '_') {
      win.webContents.setZoomLevel(current - 0.5)
      event.preventDefault()
    } else if (input.key === '0') {
      win.webContents.setZoomLevel(0)
      event.preventDefault()
    }
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Get Projects for Dashboard
  ipcMain.handle('get-projects', () => {
    return fsManager.getProjects()
  })

  // Create a new project
  // Optional item fields (category etc.); sources are guard-checked
  ipcMain.handle('create-project', async (_event, name, fields) => {
    const created = await fsManager.createProject(
      name,
      fields ? await guardedCreateFields(fields) : undefined
    )
    readers?.sync()
    return created
  })

  // Item discovery, approval and vault choice (src/main/ipc/sources.ts)
  registerSourceHandlers({
    fsManager,
    notifyTasksChanged: () => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('tasks-changed')
      readers?.sync()
    },
    onAccessChanged: () => void vault?.restart()
  })

  ipcMain.handle('save-project-data', (_event, id, data, notes, expectedRev) =>
    fsManager.saveProjectData(id, data, notes, expectedRev)
  )

  ipcMain.handle('load-project-data', (_event, id) => fsManager.loadProjectData(id))

  ipcMain.handle('delete-project', async (_event, id) => {
    readers?.service.cancel(id)
    const result = await fsManager.deleteProject(id)
    readers?.sync()
    return result
  })

  // Deleting an auto-created task dismisses it for good (D1).
  ipcMain.handle('delete-task', async (_event, projectId, taskId) => {
    const data = await fsManager.loadProjectData(projectId)
    const task = data?.tasks.find((t) => t.id === taskId)
    if (!task?.origin) return fsManager.deleteTask(projectId, taskId)
    const saved = await fsManager.updateProjectData(projectId, async (file) => ({
      data: {
        ...file,
        tasks: file.tasks.filter((t) => t.id !== taskId),
        dismissedOrigins: withDismissed(
          file.dismissedOrigins,
          file.tasks.find((t) => t.id === taskId)
        )
      }
    }))
    return saved ?? { success: false, error: 'Project not found' }
  })

  ipcMain.handle('read-context-ledger', (_event, projectId) =>
    fsManager.readContextLedger(projectId)
  )

  ipcMain.handle('save-context-ledger', (_event, projectId, contents) =>
    fsManager.writeContextLedger(projectId, contents)
  )

  ipcMain.handle('read-user-profile', () => fsManager.readUserProfile())

  ipcMain.handle('save-user-profile', (_event, contents: string) =>
    fsManager.writeUserProfile(contents)
  )

  ipcMain.handle('get-upcoming-subtasks', () => fsManager.getUpcomingSubtasks())

  ipcMain.handle('get-activity-stats', () => fsManager.getActivityStats())

  ipcMain.handle('get-estimate-accuracy', () => fsManager.getEstimateAccuracy())

  // Two-level planning (Phase 5)
  ipcMain.handle('plan-task', (event, projectId: string, taskId: string, answer?: string) =>
    runPlanIpc(event.sender.id, projectId, taskId, 'plan', { answer })
  )
  ipcMain.handle(
    'expand-milestone',
    (event, projectId: string, taskId: string, milestoneId?: string) =>
      runPlanIpc(event.sender.id, projectId, taskId, 'expand', { milestoneId })
  )
  ipcMain.handle('replan-task', (event, projectId: string, taskId: string, request?: string) =>
    runPlanIpc(event.sender.id, projectId, taskId, 'replan', { request })
  )
  ipcMain.handle('sync-item-tasks', async (_event, projectId: string) => {
    const result = await syncItemTasks(itemTaskDeps(), projectId)
    if (result.added > 0 || result.updated > 0) broadcast('tasks-changed')
    return result
  })
  ipcMain.handle('get-next-steps', () => fsManager.getNextSteps())
  ipcMain.handle('get-what-next-signals', () => whatNext.signals())
  ipcMain.handle('record-skip', (_event, raw: unknown) => whatNext.recordSkip(raw))
  ipcMain.handle('update-skip-reason', (_event, at: unknown, reason: unknown, undone?: boolean) =>
    whatNext.updateSkipReason(at, reason, undone)
  )
  ipcMain.handle('mark-touched', (_event, itemId: unknown) => whatNext.markTouched(itemId))
  ipcMain.handle('clear-today-skips', () => whatNext.clearToday())
  ipcMain.handle('get-proxy-health', () => proxyView())
  ipcMain.handle('get-plan-queue-status', () => planQueue?.status() ?? null)

  ipcMain.handle('get-settings', () => loadSettings())

  ipcMain.handle('list-reviews', () => fsManager.listReviews())

  // Repeat weekly (weekday 0-6 until a date) or stop repeating (weekday null).
  // Works from the template or any copy in the series.
  ipcMain.handle(
    'set-recurrence',
    async (
      _event,
      projectId: string,
      taskId: string,
      weekday: number | null,
      until: string
    ): Promise<{ success: boolean; error?: string }> => {
      let missing = false
      const saved = await fsManager.updateProjectData(projectId, async (file) => {
        const task = file.tasks.find((t) => t.id === taskId)
        const template = task && seriesTemplate(file.tasks, task)
        const target = template ?? task
        if (!target) {
          missing = true
          return null
        }
        const updated = weekday === null ? stopSeries(target) : startSeries(target, weekday, until)
        const baseTitle = target.recurrence?.baseTitle ?? target.title
        return {
          data: { ...file, tasks: file.tasks.map((t) => (t.id === target.id ? updated : t)) },
          notes: [
            {
              section: 'Plan Adjustments',
              note:
                weekday === null
                  ? `Stopped repeating "${baseTitle}" weekly.`
                  : `"${baseTitle}" now repeats weekly until ${until}.`
            }
          ]
        }
      })
      if (missing) return { success: false, error: 'This task no longer exists.' }
      if (!saved?.success) return { success: false, error: saved?.error }
      if (weekday !== null) await materialiseRecurring([projectId])
      return { success: true }
    }
  )

  ipcMain.handle('get-today-plan', () => fsManager.getTodayPlan())
  ipcMain.handle('save-today-plan', (_event, plan: TodayPlan | null) =>
    fsManager.saveTodayPlan(plan)
  )

  // Plan today → "Add to calendar": the renderer builds the .ics text; this
  // only asks where to save it.
  ipcMain.handle('save-calendar-file', async (event, fileName: string, contents: string) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = {
      defaultPath: join(app.getPath('downloads'), basename(fileName)),
      filters: [{ name: 'Calendar', extensions: ['ics'] }]
    }
    const { canceled, filePath } = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    if (canceled || !filePath) return { saved: false }
    await fs.writeFile(filePath, contents, 'utf-8')
    return { saved: true, filePath }
  })

  ipcMain.handle('open-backups-folder', async () => {
    await fs.ensureDir(BACKUP_DIR)
    const error = await shell.openPath(BACKUP_DIR)
    return error ? { success: false, error } : { success: true }
  })

  // Renderer patches can't change what FocusForge reads (vault, roots, categories)
  ipcMain.handle('save-settings', async (_event, patch) => {
    const next = await saveSettings(sanitizeRendererSettingsPatch(patch))
    invalidateGuard()
    readers?.restart()
    void vault?.restart()
    applyProxyMode(next)
    return next
  })

  ipcMain.handle('reset-all-data', async () => {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Erase all data?',
      message:
        'This will permanently delete every project, task, context ledger, and your user profile. This cannot be undone.',
      buttons: ['Cancel', 'Erase everything'],
      defaultId: 0,
      cancelId: 0
    })
    if (response === 0) return { canceled: true }
    return fsManager.resetAllData()
  })
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('chat-turn', async (event, payload) => {
    try {
      // The renderer never carries ledger/profile content - both are read fresh
      // here server-side, so the engine always sees the latest state regardless
      // of how it changed (chat, attachment, manual edit, or profile update).
      const [contextLedger, userProfile, settings, accuracy] = await Promise.all([
        fsManager.readContextLedgerForPrompt(payload.projectId),
        fsManager.readUserProfileForPrompt(),
        loadSettings(),
        fsManager.getEstimateAccuracy()
      ])
      const enrichedPayload = {
        ...payload,
        contextLedger,
        userProfile,
        planModel: settings.planModel || undefined,
        estimateRatio: accuracy?.ratio
      }

      // Stream the clarifying question token-by-token back to this renderer.
      // Durable facts arrive on a trailing `notes` line (after the reply is
      // committed) and are appended fire-and-forget so they never stall the UI.
      // A newer turn or the Stop button cancels this one; its stray tokens are dropped.
      const key = `chat:${event.sender.id}`
      const call: EngineCall = engineCalls.track(
        key,
        runPythonStreaming(
          enrichedPayload,
          (text) => {
            if (engineCalls.isActive(key, call)) event.sender.send('chat-stream', text)
          },
          (notes, userNotes) => {
            if (notes && notes.length > 0) {
              fsManager
                .appendLedgerNotes(payload.projectId, notes)
                .catch((e) => console.error('Failed to append ledger notes', e))
            }
            if (userNotes && userNotes.length > 0) {
              fsManager
                .appendUserProfileNotes(userNotes)
                .catch((e) => console.error('Failed to append user profile notes', e))
            }
          }
        )
      )

      return await call.promise
    } catch (err) {
      if (err instanceof EngineCancelled) {
        return { status: 'cancelled', message: '', data: null }
      }
      if (err instanceof EngineTimeout) {
        return { status: 'error', message: COACH_TIMEOUT_MESSAGE, data: null }
      }
      console.error('Python error', err)
      throw err
    }
  })

  // Stop button: kills the renderer's in-flight coach turn or plan adjustment.
  ipcMain.handle(
    'cancel-engine-call',
    (event, kind: 'chat' | 'adjust' | 'split' | 'outline' | 'plan') => {
      engineCalls.cancel(`${kind}:${event.sender.id}`)
    }
  )

  ipcMain.handle(
    'select-and-extract-document',
    async (_event, projectId: string, taskTitle: string) => {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Documents', extensions: ['pdf'] }]
      })

      if (canceled || filePaths.length === 0) return null

      const filePath = filePaths[0]
      const fileName = filePath.split('/').pop() ?? filePath
      try {
        const result = await runPythonWithStdin(
          'extract.py',
          { file_path: filePath, query: taskTitle },
          EXTRACT_TIMEOUT_MS
        ).promise
        const extracted = result.context as string

        if (result.error || !extracted || !extracted.trim()) {
          console.error('Document extraction returned no text', result.error ?? '(empty)')
          return { fileName, error: result.error || 'No readable text found in that document.' }
        }

        // Persisted straight into the ledger - no more one-turn-only injection.
        await fsManager.appendLedgerNotes(projectId, [
          {
            section: 'Document Excerpts',
            note: `From "${fileName}":\n${extracted}`
          }
        ])

        return { fileName }
      } catch (err) {
        console.error('Document extraction error', err)
        throw err
      }
    }
  )

  ipcMain.handle(
    'update-checklist',
    async (
      event,
      projectId: string,
      taskId: string,
      request: string,
      currentChecklist: DecompositionResult,
      deadline: string,
      depth: string,
      model: string
    ) => {
      try {
        // Tasks with a milestone plan are adjusted by re-planning the rest,
        // so milestones and finished parts stay consistent.
        const current = (await fsManager.loadProjectData(projectId))?.tasks.find(
          (t) => t.id === taskId
        )
        if (current && hasMilestones(current)) {
          const result = await runPlanIpc(event.sender.id, projectId, taskId, 'replan', {
            request
          })
          if (result.status === 'cancelled') return { success: false, cancelled: true, message: '' }
          return {
            success: result.success,
            message: result.message,
            subtasks: result.task?.subtasks ?? [],
            prerequisites: result.task?.prerequisites ?? []
          }
        }
        const [contextLedger, userProfile, settings, accuracy] = await Promise.all([
          fsManager.readContextLedgerForPrompt(projectId),
          fsManager.readUserProfileForPrompt(),
          loadSettings(),
          fsManager.getEstimateAccuracy()
        ])
        const call = engineCalls.track(
          `adjust:${event.sender.id}`,
          runPythonWithStdin(
            'main.py',
            {
              projectId,
              messages: [{ role: 'user', content: request }],
              deadline,
              depth,
              model,
              // Use the CURRENT settings, not the model the task was created with
              // (which may be a provider the user no longer has set up).
              planModel: settings.planModel || settings.chatModel,
              contextLedger,
              userProfile,
              currentChecklist,
              estimateRatio: accuracy?.ratio
            },
            ADJUST_TIMEOUT_MS
          )
        )
        let response: EngineMessage
        try {
          response = await call.promise
        } catch (err) {
          if (err instanceof EngineCancelled)
            return { success: false, cancelled: true, message: '' }
          if (err instanceof EngineTimeout)
            return { success: false, message: ADJUST_TIMEOUT_MESSAGE }
          throw err
        }

        if (response.status !== 'updated' || !response.data) {
          return { success: false, message: response.message }
        }

        let message = response.message
        let task: ProjectData['tasks'][number] | undefined
        // Merge onto the on-disk state inside the project lock (fresher than the
        // renderer's snapshot, and no save can land between this load and write)
        // so ticks, completedAt and kanban columns survive the restructure.
        const saved = await fsManager.updateProjectData(projectId, async (file) => {
          task = (file.tasks ?? []).find((t) => t.id === taskId)
          const notes = [...(response.notes ?? [])]
          if (!task) return { data: file, notes }
          const merged = mergeChecklist(
            { subtasks: task.subtasks ?? [], prerequisites: task.prerequisites ?? [] },
            {
              subtasks: response.data.subtasks ?? [],
              prerequisites: response.data.prerequisites ?? [],
              completedIds: Array.isArray(response.data.completedIds)
                ? response.data.completedIds
                : []
            },
            { allowDropCompleted: requestsRemovingCompleted(request) }
          )
          task.subtasks = merged.subtasks
          task.prerequisites = merged.prerequisites

          const marked = [...merged.completedSubtasks, ...merged.completedPrerequisites]
          if (marked.length > 0) {
            notes.push({
              section: 'Milestones & Completed Work',
              note: `Marked done (already finished): ${marked.map((r) => `"${r.title}"`).join(', ')}.`
            })
          }
          const restored = [...merged.restoredSubtasks, ...merged.restoredPrerequisites]
          if (restored.length > 0) {
            const titles = restored.map((r) => `"${r.title}"`).join(', ')
            notes.push({
              section: 'Plan Adjustments',
              note: `Kept completed item(s) the AI dropped: ${titles}.`
            })
            message = `${message} (Kept ${restored.length} completed step${restored.length === 1 ? '' : 's'} so your progress isn't lost.)`
          }
          return { data: file, notes }
        })
        if (!saved?.success) {
          return {
            success: false,
            message: saved?.error || "The adjusted plan couldn't be saved. Try again."
          }
        }
        if (response.userNotes && response.userNotes.length > 0) {
          await fsManager.appendUserProfileNotes(response.userNotes)
        }

        return {
          success: true,
          message,
          subtasks: task?.subtasks ?? [],
          prerequisites: task?.prerequisites ?? []
        }
      } catch (err) {
        console.error('Checklist mutation error', err)
        throw err
      }
    }
  )

  // "Stuck?": the engine splits one step into 2-3 smaller ones, spliced in
  // under the project lock. Only that step changes.
  ipcMain.handle(
    'split-step',
    async (
      event,
      projectId: string,
      taskId: string,
      subtaskId: string
    ): Promise<SplitStepResult> => {
      const project = await fsManager.loadProjectData(projectId)
      const task = project?.tasks.find((t) => t.id === taskId)
      const step = task?.subtasks.find((s) => s.id === subtaskId)
      if (!task || !step) {
        return { success: false, message: 'This step no longer exists. Reload and try again.' }
      }
      if (step.isCompleted) {
        return {
          success: false,
          message: 'This step is already done, so there is nothing to split.'
        }
      }
      const [contextLedger, userProfile, settings, accuracy] = await Promise.all([
        fsManager.readContextLedgerForPrompt(projectId),
        fsManager.readUserProfileForPrompt(),
        loadSettings(),
        fsManager.getEstimateAccuracy()
      ])
      const call = engineCalls.track(
        `split:${event.sender.id}`,
        runPythonWithStdin(
          'main.py',
          {
            mode: 'split',
            step: { title: step.title, timeEstimate: step.timeEstimate },
            taskTitle: task.title,
            contextLedger,
            userProfile,
            planModel: settings.planModel || settings.chatModel,
            estimateRatio: accuracy?.ratio
          },
          SPLIT_TIMEOUT_MS
        )
      )
      let response: EngineMessage
      try {
        response = await call.promise
      } catch (err) {
        if (err instanceof EngineCancelled) return { success: false, cancelled: true, message: '' }
        if (err instanceof EngineTimeout) return { success: false, message: SPLIT_TIMEOUT_MESSAGE }
        console.error('Split step error', err)
        return {
          success: false,
          message: "Couldn't reach the coach. Check that CLIProxyAPI is running."
        }
      }
      if (response.status !== 'split') {
        return {
          success: false,
          message: response.message || "The coach couldn't split this step."
        }
      }

      let failure: string | null = null
      let created: Subtask[] = []
      const saved = await fsManager.updateProjectData(projectId, async (file) => {
        const current = file.tasks.find((t) => t.id === taskId)
        const parent = current?.subtasks.find((s) => s.id === subtaskId)
        if (!current || !parent) {
          failure = 'This step no longer exists. Reload and try again.'
          return null
        }
        const parts = normaliseSplit(parent, response.steps)
        if (typeof parts === 'string') {
          failure = parts
          return null
        }
        const spliced = spliceSplit(
          current.subtasks,
          subtaskId,
          parts,
          () => `split-${randomUUID()}`
        )
        if (typeof spliced === 'string') {
          failure = spliced
          return null
        }
        current.subtasks = spliced.subtasks
        created = spliced.created
        const titles = created.map((s) => `"${s.title}"`).join(', ')
        return {
          data: file,
          notes: [{ section: 'Plan Adjustments', note: `Split "${parent.title}" into ${titles}.` }]
        }
      })
      if (failure) return { success: false, message: failure }
      if (!saved?.success) {
        return {
          success: false,
          message: saved?.error || "The smaller steps couldn't be saved. Try again."
        }
      }
      return {
        success: true,
        message:
          (typeof response.message === 'string' && response.message) ||
          'Here it is in smaller pieces.',
        created
      }
    }
  )

  // Course outline import, step 1: pick a PDF and read its assessments.
  // Nothing is saved until the user confirms them (import-assessments).
  ipcMain.handle('read-course-outline', async (event): Promise<OutlineReadResult | null> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Course outline', extensions: ['pdf'] }]
    })
    if (canceled || filePaths.length === 0) return null
    const filePath = filePaths[0]
    const fileName = basename(filePath)
    const settings = await loadSettings()
    const call = engineCalls.track(
      `outline:${event.sender.id}`,
      runPythonWithStdin(
        'syllabus.py',
        {
          file_path: filePath,
          model: settings.planModel || settings.chatModel,
          today: localDateKey(new Date())
        },
        EXTRACT_TIMEOUT_MS
      )
    )
    try {
      const result = await call.promise
      if (result.error) return { fileName, error: String(result.error) }
      return {
        fileName,
        course: typeof result.course === 'string' ? result.course : '',
        assessments: Array.isArray(result.assessments) ? result.assessments : []
      }
    } catch (err) {
      if (err instanceof EngineCancelled) return { fileName, cancelled: true }
      if (err instanceof EngineTimeout) {
        return { fileName, error: 'Reading the outline took too long. Try again.' }
      }
      console.error('Course outline error', err)
      return { fileName, error: "Couldn't read that outline. Try again." }
    }
  })

  // Course outline import, step 2: confirmed assessments become unplanned tasks.
  ipcMain.handle(
    'import-assessments',
    async (
      _event,
      projectId: string,
      source: string,
      course: string,
      items: (OutlineAssessment & { dueDate: string })[]
    ): Promise<{ success: boolean; added: number; error?: string }> => {
      let added = 0
      const saved = await fsManager.updateProjectData(projectId, async (file) => {
        const result = addAssessmentTasks(file.tasks ?? [], items, source, () => randomUUID())
        added = result.added.length
        return {
          data: { ...file, tasks: result.tasks },
          notes: [
            {
              section: 'Constraints & Specifications',
              note: outlineLedgerNote(source, course, items)
            }
          ]
        }
      })
      if (!saved) return { success: false, added: 0, error: 'Project not found.' }
      if (!saved.success) return { success: false, added: 0, error: saved.error }
      return { success: true, added }
    }
  )

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  createWindow()
  readers = initReaders({
    fsManager,
    health: proxyHealth,
    runScript: (script, payload, timeoutMs, onStderr) =>
      runEngine(join(resolveEngineDir(), script), payload, {
        pythonPath: PYTHON_PATH,
        timeoutMs,
        onStderr
      }),
    // Phase 4 -> Phase 3: each item's My notes come back as virtual pack sources.
    virtualRefs: (itemId) => vault?.myNotesRefs(itemId) ?? []
  })
  vault = initVaultSync({ fsManager, readers })
  // Phase 3 -> Phase 5: plans read the stored packs, and every digest refresh
  // creates or refreshes deliverable/goal tasks (SYNC_PLAN contracts 1 and 6).
  registerPackSource(new StorePackSource(readers.store))
  readers.service.onDigest((itemId) => void onDigestUpdated(itemId))
  // QA only (scripts/qa-readers.mjs): lets the isolated run inspect watchers and flip proxy health.
  if (process.env.FOCUSFORGE_QA === '1') {
    ;(globalThis as Record<string, unknown>).__ffReaders = { readers, proxyHealth }
  }
  // After the warm spare and first paint; item packs are then staggered.
  setTimeout(() => void readers?.start().catch(() => undefined), readers.startDelayMs)
  void fsManager.pruneBackups()
  mainSpare = new WarmSpare(join(resolveEngineDir(), 'main.py'), PYTHON_PATH)
  mainSpare.warm()

  // Background planning: rolling expansion on every save, plus a startup scan.
  startPlanQueue()
  void whatNext.prune()
  void loadSettings().then((settings) => applyProxyMode(settings))
  scheduleFill(40_000)
  setTimeout(() => {
    void (async () => {
      const active = fsManager
        .getProjects()
        .filter((p) => p.status === 'active')
        .map((p) => p.id)
      for (const id of active) await onDigestUpdated(id)
      await planQueue?.scan(active)
    })()
  }, 1000 * 25)

  // Gentle procrastination nudges: check shortly after launch, then periodically.
  setTimeout(maybeNudge, 1000 * 30)
  setInterval(maybeNudge, NUDGE_INTERVAL_MS)
  setTimeout(maybeWeeklyReview, 1000 * 45)
  setTimeout(() => void materialiseRecurring(), 1000 * 20)
  setInterval(() => void materialiseRecurring(), NUDGE_INTERVAL_MS)
  setInterval(maybeWeeklyReview, REVIEW_CHECK_INTERVAL_MS)

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('before-quit', () => {
  readers?.stop()
  vault?.dispose()
  engineCalls.cancelAll()
  planQueue?.dispose()
  mainSpare?.dispose()
  if (fillTimer) clearTimeout(fillTimer)
  stopProxyPoll?.()
  offProxyChange?.()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
