// Builds the Python engine venv and installs its dependencies.
// Run via `npm run setup:engine` (or `npm run setup` for node deps too).
// Idempotent: safe to re-run; skips venv creation if it already exists.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE_DIR = join(ROOT, 'engine')
const VENV_DIR = join(ENGINE_DIR, 'env')
const isWin = process.platform === 'win32'
const venvPython = join(VENV_DIR, isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python')
const requirements = join(ENGINE_DIR, 'requirements.txt')

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (res.error) throw res.error
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with code ${res.status}`)
  }
}

// Find a Python 3 interpreter on PATH.
function findSystemPython() {
  for (const cand of isWin ? ['python', 'py'] : ['python3', 'python']) {
    const res = spawnSync(cand, ['--version'], { encoding: 'utf8' })
    if (res.status === 0 && /Python 3/.test((res.stdout || '') + (res.stderr || ''))) {
      return cand
    }
  }
  return null
}

function main() {
  if (!existsSync(requirements)) {
    console.error(`Cannot find ${requirements}`)
    process.exit(1)
  }

  if (!existsSync(venvPython)) {
    const py = findSystemPython()
    if (!py) {
      console.error(
        '\nNo Python 3 found on PATH. Install Python 3.10+ (macOS: `brew install python`) and re-run.\n'
      )
      process.exit(1)
    }
    console.log(`Creating virtualenv at engine/env using "${py}"...`)
    run(py, ['-m', 'venv', VENV_DIR])
  } else {
    console.log('engine/env already exists — reusing it.')
  }

  console.log('Upgrading pip...')
  run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'])

  console.log('Installing engine dependencies (this can take a few minutes — torch is large)...')
  run(venvPython, ['-m', 'pip', 'install', '-r', requirements])

  const envExample = join(ENGINE_DIR, '.env.example')
  const envFile = join(ENGINE_DIR, '.env')
  console.log('\n✅ Engine ready.')
  if (existsSync(envExample) && !existsSync(envFile)) {
    console.log('\nNext: add your LLM API key:')
    console.log('  cp engine/.env.example engine/.env')
    console.log('  # then paste a GEMINI_API_KEY (or OpenAI/Anthropic) into engine/.env')
  }
  console.log('\nThen run the app:  npm run dev\n')
}

try {
  main()
} catch (err) {
  console.error('\nEngine setup failed:', err.message)
  process.exit(1)
}
