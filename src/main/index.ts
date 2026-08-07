import { app, shell, BrowserWindow, ipcMain, dialog, Notification } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

import { PythonShell } from 'python-shell'
import { FileSystemManager } from './fs-manager'
import {
  reconcileSubtasks,
  reconcilePrerequisites,
  DecompositionResult,
  ProjectData
} from '../common/types'

const fsManager = new FileSystemManager()

let mainWindow: BrowserWindow | null = null

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

    const notification = new Notification({ title: nudge.title, body: nudge.body })
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

/**
 * Spawns a python script, writes one JSON payload to its stdin, closes
 * stdin, and resolves with the single JSON object the script prints to
 * stdout. Used for both chat-turn (engine/main.py) and document
 * extraction (engine/extract.py) - both are stateless, one-shot calls.
 */
function runPythonWithStdin(scriptName: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const scriptPath = join(resolveEngineDir(), scriptName)
    const pyshell = new PythonShell(scriptPath, {
      mode: 'json',
      pythonPath: PYTHON_PATH
    })

    const output: any[] = []
    pyshell.on('message', (message) => output.push(message))

    // Python redirects all diagnostic output to stderr so it never
    // corrupts the json-mode stdout stream - but that means failures
    // (rate limits, retries, etc) were previously invisible. Surface them.
    pyshell.on('stderr', (line) => console.error(`[${scriptName}]`, line))

    pyshell.send(payload as any).end((err) => {
      if (err) reject(err)
      else if (output.length === 0) reject(new Error(`${scriptName} produced no output`))
      else resolve(output[output.length - 1])
    })
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
 * follows. extract.py keeps using the one-shot path above.
 */
function runPythonStreaming(
  payload: unknown,
  onToken: (text: string) => void,
  onNotes?: (notes: any[], userNotes: any[]) => void
): Promise<any> {
  return new Promise((resolve, reject) => {
    const scriptPath = join(resolveEngineDir(), 'main.py')
    const pyshell = new PythonShell(scriptPath, { mode: 'json', pythonPath: PYTHON_PATH })

    let settled = false
    pyshell.on('message', (message) => {
      if (message?.type === 'token') onToken(message.text ?? '')
      else if (message?.type === 'result') {
        settled = true
        resolve(message)
      } else if (message?.type === 'notes') {
        onNotes?.(message.notes ?? [], message.userNotes ?? [])
      }
    })
    pyshell.on('stderr', (line) => console.error('[main.py]', line))

    pyshell.send({ ...(payload as object), stream: true } as any).end((err) => {
      if (settled) return
      reject(err ?? new Error('main.py produced no result'))
    })
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
  ipcMain.handle('create-project', (_event, name) => {
    return fsManager.createProject(name)
  })

  ipcMain.handle('save-project-data', (_event, id, data, notes) =>
    fsManager.saveProjectData(id, data, notes)
  )

  ipcMain.handle('load-project-data', (_event, id) => fsManager.loadProjectData(id))

  ipcMain.handle('delete-project', (_event, id) => fsManager.deleteProject(id))

  ipcMain.handle('delete-task', (_event, projectId, taskId) =>
    fsManager.deleteTask(projectId, taskId)
  )

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
      const [contextLedger, userProfile] = await Promise.all([
        fsManager.readContextLedgerForPrompt(payload.projectId),
        fsManager.readUserProfileForPrompt()
      ])
      const enrichedPayload = { ...payload, contextLedger, userProfile }

      // Stream the clarifying question token-by-token back to this renderer.
      // Durable facts arrive on a trailing `notes` line (after the reply is
      // committed) and are appended fire-and-forget so they never stall the UI.
      const response = await runPythonStreaming(
        enrichedPayload,
        (text) => event.sender.send('chat-stream', text),
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

      return response
    } catch (err) {
      console.error('Python error', err)
      throw err
    }
  })

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
        const result = await runPythonWithStdin('extract.py', {
          file_path: filePath,
          query: taskTitle
        })
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
      _event,
      projectId: string,
      taskId: string,
      request: string,
      currentChecklist: DecompositionResult,
      deadline: string,
      depth: string,
      model: string
    ) => {
      try {
        const [contextLedger, userProfile] = await Promise.all([
          fsManager.readContextLedgerForPrompt(projectId),
          fsManager.readUserProfileForPrompt()
        ])
        const response = await runPythonWithStdin('main.py', {
          projectId,
          messages: [{ role: 'user', content: request }],
          deadline,
          depth,
          model,
          contextLedger,
          userProfile,
          currentChecklist
        })

        if (response.status !== 'updated' || !response.data) {
          return { success: false, message: response.message }
        }

        const file: ProjectData = (await fsManager.loadProjectData(projectId)) || { tasks: [] }
        const task = (file.tasks ?? []).find((t) => t.id === taskId)
        if (task) {
          // Carry over completion/board progress for steps that survive the
          // rewrite, so an AI plan adjustment doesn't wipe what's already done.
          task.subtasks = reconcileSubtasks(task.subtasks ?? [], response.data.subtasks ?? [])
          task.prerequisites = reconcilePrerequisites(
            task.prerequisites ?? [],
            response.data.prerequisites ?? []
          )
        }

        await fsManager.saveProjectData(projectId, file, response.notes)
        if (response.userNotes && response.userNotes.length > 0) {
          await fsManager.appendUserProfileNotes(response.userNotes)
        }

        return {
          success: true,
          message: response.message,
          subtasks: task?.subtasks ?? [],
          prerequisites: task?.prerequisites ?? []
        }
      } catch (err) {
        console.error('Checklist mutation error', err)
        throw err
      }
    }
  )

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  createWindow()

  // Gentle procrastination nudges: check shortly after launch, then periodically.
  setTimeout(maybeNudge, 1000 * 30)
  setInterval(maybeNudge, NUDGE_INTERVAL_MS)

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
