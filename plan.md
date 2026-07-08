# Plan (F): Ship-ready as a clone-and-run repo

**Status:** NOT STARTED. Supersedes plans A–E (all shipped; see `PROJECT_SUMMARY.md`).

## Goal
Make the repo reproducible for a **developer who clones and runs locally** in
~2 commands, with BYO LLM API keys. NOT a signed downloadable `.app` yet — that
is an explicit later phase (F7, documented, not built).

Target: **macOS** (dev clone-and-run). Windows/Linux paths handled defensively
but not verified.

## Decisions (from discussion)
- **Engine ships as source + a reproducible venv** (NOT frozen/bundled). Heavy
  deps (`torch`, `sentence-transformers`) install via `pip` — fine for a repo,
  the ~2GB bundling problem only exists when packaging a `.dmg` (deferred).
  Keep the full engine (PDF embeddings included).
- **BYO API key**: user pastes their own key into `engine/.env`. No key shipped.
- **Unsigned**: no code signing / notarization this phase (packaging deferred).

## Current blockers (why a fresh clone fails today)
1. No `requirements.txt` — venv was hand-built; a cloner can't reproduce it.
2. `PYTHON_PATH = join(process.cwd(), 'engine','env','bin','python')` is brittle:
   assumes exact venv location + posix layout, no override, no fallback.
3. No `.env.example`; a missing API key surfaces as an opaque thrown error in the
   renderer, not a readable "add your key" message.
4. `engine/chroma_db/` (sqlite + `*.bin`) and `*.tsbuildinfo` are committed junk.
5. README is electron-vite boilerplate — no real setup steps.

---

## F1 — Reproducible Python env
- **`engine/requirements.txt`** (NEW): pin from the working venv at implement
  time via `engine/env/bin/pip freeze` — capture actual resolved versions of
  `litellm`, `python-dotenv`, `chromadb`, `sentence-transformers`, `torch`,
  `pypdf` (+ their transitive pins). Pinning avoids the torch native-lib break
  noted in `PROJECT_SUMMARY.md`.
- **`scripts/setup-engine.mjs`** (NEW): Node script (so it's cross-platform and
  callable from npm) that:
  - finds a Python 3 interpreter (`python3` then `python`),
  - creates `engine/env` if missing (`python -m venv engine/env`),
  - upgrades pip, `pip install -r engine/requirements.txt`,
  - prints a clear success/next-steps message (copy `.env.example` → `.env`).
  - Idempotent: re-run safe; skips venv creation if present.
- **`package.json` scripts**:
  - `"setup:engine": "node scripts/setup-engine.mjs"`
  - `"setup": "npm install && npm run setup:engine"` (the “npm i”-easy entry).
- Files: `engine/requirements.txt`, `scripts/setup-engine.mjs`, `package.json`.

## F2 — Robust engine path resolution (`src/main/index.ts`)
Replace the two `process.cwd()` hardcodes with small helpers:
- `resolveEngineDir()`: repo `engine/` in dev. Uses a stable base (project root
  derived from `app.getAppPath()` / `__dirname`) instead of `process.cwd()`, so
  it doesn't depend on where the process was launched. (Also the seam packaging
  will later swap to `process.resourcesPath`.)
- `resolvePython()`:
  1. `UNI_AGENT_PYTHON` env override if set,
  2. `engine/env/bin/python` (posix) or `engine/env/Scripts/python.exe` (win)
     if it exists,
  3. fall back to `python3` on PATH.
- `PYTHON_PATH` + both `scriptPath` sites use these helpers.
- Files: `src/main/index.ts`.

## F3 — BYO key: template + graceful "no key" UX
- **`engine/.env.example`** (NEW): documented template —
  `GEMINI_API_KEY=`, `OPENAI_API_KEY=`, `ANTHROPIC_API_KEY=`,
  `# OLLAMA_API_BASE=http://localhost:11434`. (`engine/.env` stays gitignored.)
- **Engine preflight** (`engine/main.py`): before calling `litellm`, map the
  selected `model` → required env var (gemini→`GEMINI_API_KEY`,
  gpt→`OPENAI_API_KEY`, claude→`ANTHROPIC_API_KEY`; `ollama/*`→none). If missing,
  return a structured `{status:"error", message:"No API key for <provider>. Add
  <VAR> to engine/.env"}` on stdout instead of letting litellm throw an ANSI
  banner. (extract.py needs no key.)
- **Main + renderer**: `chat-turn` / `update-checklist` currently `throw` on
  engine failure. Catch the `status:"error"` result and surface `message` to the
  renderer as a friendly inline banner (reuse existing chat error rendering if
  present) rather than an unhandled rejection.
- Files: `engine/.env.example`, `engine/main.py`, `src/main/index.ts`,
  `src/renderer/src/components/ProjectWorkspace.tsx` (error display).

## F4 — Repo hygiene
- **`.gitignore`**: add `engine/chroma_db/`, `*.tsbuildinfo`.
- **Untrack committed junk**: `git rm -r --cached engine/chroma_db`
  `tsconfig.node.tsbuildinfo` `tsconfig.web.tsbuildinfo` (keep on disk, stop
  tracking). Note: this is in the implement step, not a plan file change.
- **Remove dev scratch**: delete `engine/retrieve_test.py` (manual REPL test
  against the removed permanent collection; not part of the live pipeline).
- Files: `.gitignore`, delete `engine/retrieve_test.py`.

## F5 — README rewrite (real setup)
Replace boilerplate with:
- **Prerequisites**: Node 18+, Python 3.10+ (mac: `brew install python`).
- **Setup**: `npm run setup` (installs node deps + builds the Python venv).
- **API key**: `cp engine/.env.example engine/.env`, paste a Gemini key (default
  model is `gemini/gemini-2.5-flash-lite`); optional OpenAI/Anthropic/Ollama.
- **Run**: `npm run dev`.
- **Where data lives**: `~/Documents/FlowState/` (projects, ledgers, profile).
- **Troubleshooting**: torch native-lib break →
  `engine/env/bin/pip install --force-reinstall torch sentence-transformers`;
  reset app state via Profile → Danger Zone.
- Files: `README.md`.

## F6 — Metadata cleanup (light)
Fix obviously-placeholder identity fields so the repo isn't literal boilerplate.
Packaging config left mostly as-is (deferred), but harmless to correct now:
- `package.json`: real `description`, `author`, drop/fix `homepage`
  (electron-vite.org placeholder).
- `electron-builder.yml`: `appId` `com.electron.app` → a real reverse-DNS id;
  leave `publish`/signing as-is (deferred).
- Files: `package.json`, `electron-builder.yml`.

---

## F7 — DEFERRED (documented, NOT built this phase)
For when you want a downloadable app:
- **Freeze engine** with PyInstaller (`engine/main.py` + `extract.py` → one
  binary) so end users need no Python. Revisit **slim vs full** then (drop
  `torch`/`sentence-transformers` to cut ~2GB; PDF filter degrades to full-text,
  which your `RELEVANCE_FILTER_THRESHOLD` already does for short docs).
- **Bundle** the frozen binary via `electron-builder` `extraResources`; swap
  `resolveEngineDir()` to `process.resourcesPath` when `app.isPackaged`.
- **chroma_db** must move to `app.getPath('userData')` (packaged resources are
  read-only) — `vault.py DB_DIR` becomes an env var passed from main.
- **In-app Settings key UI** (store keys in `userData`, pass to python via env)
  instead of `engine/.env`.
- **Code signing + notarization** (Apple Developer cert) + auto-update
  (`publish` provider). Until then, unsigned `.dmg` needs right-click→Open.

## Out of scope (this phase)
Automated tests / CI, `@ts-ignore` cleanup in `Dashboard.tsx`, perf-profiling
the glass panels. (Noted in `PROJECT_SUMMARY.md`.)

---

## Verify (F1–F6)
On a **fresh clone** (or `rm -rf node_modules engine/env`):
1. `npm run setup` → node deps install, `engine/env` builds, deps install clean.
2. `cp engine/.env.example engine/.env`, paste a Gemini key.
3. `npm run dev` → app launches, create a project, chat → streamed coach reply.
4. Remove the key from `.env`, restart → chat shows a friendly "add your key"
   banner, not an opaque crash.
5. Attach a PDF → extraction works (embeddings load from the venv).
6. `git status` clean of `chroma_db`/`*.tsbuildinfo`.

## Files touched (F1–F6)
`engine/requirements.txt` (new), `scripts/setup-engine.mjs` (new),
`engine/.env.example` (new), `package.json`, `src/main/index.ts`,
`engine/main.py`, `src/renderer/src/components/ProjectWorkspace.tsx`,
`.gitignore`, `README.md`, `electron-builder.yml`,
delete `engine/retrieve_test.py`.

## Order
F4 (hygiene, quick) → F1 (env reproducible) → F2 (paths) → F3 (keys + UX) →
F5 (README) → F6 (metadata). F1–F3 are the real "runs on clone" work.
