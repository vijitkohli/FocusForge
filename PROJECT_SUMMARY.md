# uni-agent — Project Summary

**What it is:** Electron desktop app ("Flow State OS") for anti-procrastination. Thesis: procrastination is an emotional/avoidance problem, not a discipline problem. An AI chat coach breaks any task (big or small) into steps small enough that starting feels easy. Gamification (progress bars, deadline urgency) reinforces momentum.

Branch: `main` (PR #1 `main-logic/v1` merged). Check `git status` before doing anything destructive.

---

## Stack

- **Electron 39 + React 19 + TypeScript**, bundled with `electron-vite`
- **State:** plain React hooks, no state library
- **Styling:** **Tailwind CSS v4** (`@tailwindcss/vite`, no config file) with `@theme` design tokens + frosted-glass utilities in `src/renderer/src/assets/tailwind.css`. "Zen-browser" dark aesthetic: soft gradient-mesh backdrop, translucent `backdrop-blur` panels (`glass`/`glass-strong` utilities), large radii, pill controls, floating sidebar rail. `base.css` keeps only the Inter font stack + reset. (The old `main.css` was deleted.)
- **AI engine:** separate Python process (`engine/`) invoked from the Electron main process via `python-shell`, using **LiteLLM** as the model-agnostic LLM client. Primary route is a local **CLIProxyAPI** server (`cliproxy/<model>`, see Models); direct Gemini/OpenAI/Anthropic keys and Ollama still work.
- **Storage:** flat files on disk under `~/Documents/FlowState/{projectId}/` — no database
  - `project_data.json` — tasks + subtasks
  - `context.md` — per-project ledger (see below)
- **PDF/doc pipeline:** ChromaDB + SentenceTransformers for relevance-filtered document extraction (`engine/vault.py`, `engine/extract.py`)

---



## Architecture

```
Renderer (React)
  ↕ window.api.*  (preload contextBridge)
Main process (Electron, src/main/index.ts)
  ↕ stdin/stdout JSON
Python engine (engine/main.py, engine/extract.py)
  ↕ litellm.completion()
LLM provider (Gemini / GPT-4o / Claude)
```

- `runPythonWithStdin()` in `src/main/index.ts` spawns a python process per call, writes one JSON payload to stdin, reads one JSON object back from stdout. Used for `extract.py` and the AI checklist-mutation call. All other Python output (litellm error banners, model-download noise) is redirected to stderr inside the Python scripts so it can never corrupt the JSON contract — and stderr is logged by the main process (`pyshell.on('stderr', ...)`).
- `runPythonStreaming()` is the **streaming** sibling used by `chat-turn`: `engine/main.py` emits NDJSON `{type:"token"}` lines as it generates, then one `{type:"result", ...}` line. Tokens are pushed to the renderer over the `chat-stream` event channel for live typing; the promise resolves on the result line. (`extract.py` + mutation stay one-shot.)
- `FileSystemManager` (`src/main/fs-manager.ts`) owns all disk I/O: project registry, `project_data.json`, the per-project `context_<projectId>.md` ledger, plus derived reads (`getUpcomingSubtasks`, `getActivityStats`) and the nudge log (`system/nudges.json`).

---



## Core feature: conversational task decomposition

Originally a single-shot form (title → deadline → depth → model → instant checklist). Rebuilt into a **three-mode engine** (`engine/main.py`):

1. **Clarification phase** — acts as a "strategic coach," asks one targeted question at a time (grading criteria, tools, dependencies, friction points), up to `MAX_CLARIFYING_TURNS = 5` user turns, then forces progression.
2. **Execution phase** — once enough context exists (or the turn cap is hit), generates the final checklist: 10-minute-rule micro-steps, gap analysis for hidden dependencies, logical setup→work→review ordering, dates distributed across the deadline.
3. **Mutation phase** — triggered when the payload includes `currentChecklist`; lets the user ask the AI to reshape an *existing* plan ("make this shorter," "expand step 3"). Always returns a **full replacement** checklist, never a patch (merge semantics on an AI-restructured plan are too error-prone).

UI (`ProjectWorkspace.tsx`): bottom-anchored chat stream replaces the old static form. Deadline/depth/model stay as **explicit controls** (not asked conversationally — scheduling needs a reliable machine date). On completion, the chat fades and hands off to `TaskDetail` (checklist view).

---



## Persistent context ledger (`context.md`)

One markdown file per **project** (not per task) — the single combined source of truth for a course/project across all its assignments/labs. Sections: Constraints & Specifications, Document Excerpts, Milestones & Completed Work, Plan Adjustments.

- Read in full by the main process before **every** `chat-turn` call and injected into the engine — replaces an earlier broken design where attached-document text was only injected for one turn and then forgotten.
- Every state-changing action is "self-describing": AI-recognized constraints/milestones, document attachments, AI plan mutations, and manual checklist edits all append a note to the matching section in the same write that updates `project_data.json` — so the ledger and the saved data can never drift apart.
- This is what fixes the original "AI regenerates steps for already-completed work" bug: the execution/mutation prompts are explicitly instructed not to reintroduce anything the ledger says is done.
- Read-only viewer added in the workspace header ("View Project Context").



## Document attachment

Attach button → native file picker → `engine/extract.py` pulls PDF text (page-by-page via `pypdf`); if it's large, relevance-filters down to the most relevant chunks using a **transient** ChromaDB collection (never a shared permanent one, to avoid cross-document contamination) before writing the result straight into `context.md`'s Document Excerpts section. No more "inject once per turn" pattern — it's now permanent project memory.

## Manual checklist overrides (`TaskDetails.tsx`)

Inline add / edit / delete / toggle-complete on subtasks, fully offline (no LLM call) — bypasses the AI loop for quick fixes, but still writes a ledger note on every change so the AI is never out of sync with manual edits.

## Dashboard deadline view

`FileSystemManager.getUpcomingTasks()` aggregates tasks across **all** projects on read (no denormalized cache to keep in sync), computes date-only `daysRemaining`, sorts soonest-first. Urgency colors reuse the existing difficulty-border CSS classes: `<3` days = red (`border-hard`), `3–7` = amber (`border-medium`), `>7` = green (`border-easy`). Completed tasks are excluded from the main list and tucked into a collapsed "Completed (n)" dropdown.

---



## Features added this cycle



### App shell + Zen revamp

- App is now a **floating frosted rail + floating page**: `App.tsx` renders a slim left nav rail (Home / Start Now) and the active view inside a `glass-strong` rounded container over the gradient backdrop. Routing state (`activeProjectId` / `focus`) unchanged — the rail just drives it.
- All panels/cards/toolbars migrated from solid `bg-bg-2` to the `glass` utility; buttons are pill-shaped; radii bumped. Earlier clip/overflow bug (vertical-centering + `#root overflow:hidden`) is fixed; views are top-aligned, page-scroll.



### "Start Now" single-action mode (`FocusMode.tsx`)

- Full-screen, distraction-free view showing exactly ONE next micro-step (overwhelm is the thesis's enemy). Done auto-advances + a session momentum counter; Skip, Open-full-task, Exit. Queue reuses `getUpcomingSubtasks()`; completion reuses `loadProjectData`/`saveProjectData` + ledger note (no new IPC, no engine call). Entry: pinned Start Now card on the dashboard (global) + "Focus next step" in TaskDetail (task-scoped). Also opened by clicking a nudge notification.



### Streaks + progress visualization (`Momentum.tsx`)

- `Subtask` gained `completedAt` (ISO). `withCompletion`/`setSubtaskStatus` keep `isCompleted`/`completedAt`/`status` in lockstep across every completion site (manual toggle, Start Now, board, AI-mutation reset) so nothing drifts.
- `FileSystemManager.getActivityStats()` derives current/longest **streak** + a per-day completion map from `completedAt` across all projects (nothing extra persisted). Dashboard "Momentum" strip shows the streak, a GitHub-style **calendar heatmap**, and done/this-week chips. `TaskDetails` shows an inline-SVG **burndown** (ideal vs actual) with an on-track / behind / overdue label. All dependency-free.



### Prerequisite "learn → do" phase

- The execution prompt now returns a separate `prerequisites[]` (kind: learn/acquire/setup) instead of folding them into the flat checklist; mutation preserves them. Persisted on `ProjectTask`, rendered as a pinned "Before you start" card above the steps (counts toward one progress number).



### Kanban board (`KanbanBoard.tsx`)

- `Subtask.status` (`todo`/`doing`/`done`) drives a 3-column board, toggled List ⇄ Board in the TaskDetail header. Native HTML5 drag-and-drop (no lib); a drop reuses the same `persistSubtasks` + ledger-note path as the checkbox. `status` is kept in lockstep with `isCompleted`/`completedAt` (via `setSubtaskStatus`) and derived from `isCompleted` for older subtasks, so streaks/progress/burndown/`getUpcomingSubtasks` keep working — "Doing" simply reads as incomplete.



### Editable context ledger

- "View Project Context" is now Edit/Save/Cancel (`writeContextLedger` + `save-context-ledger` IPC). Save warns if any of the four `##`  section headings are missing (they're needed by `appendLedgerNotes`).



### Procrastination nudges (supportive)

- `FileSystemManager.getNudge()` picks one nudge-worthy item (most overdue step, else a project idle ≥2 days with open work), respecting quiet hours (08:00–22:00) and a once-per-item-per-day guard in `system/nudges.json`. The main process shows a warm, never-guilty Electron `Notification` on launch + every 6h; clicking it focuses the window and opens Start Now (`open-focus` event). Copy is static templates (reliable, no API key needed).

---



## Models

- **CLIProxyAPI** (local OpenAI-compatible proxy over subscription logins, `http://localhost:8317/v1`) replaced the rate-limited API keys. `engine/main.py` `_complete()` rewrites `cliproxy/<name>` → LiteLLM `openai/<name>` with `CLIPROXY_API_BASE`/`CLIPROXY_API_KEY` from `engine/.env`.
  - The proxy does **not** enforce `response_format: json_object` (Gemini 3 Flash fences JSON, Claude adds prose), so all JSON replies go through tolerant `_parse_json()`. Backends that reject `response_format` outright (gpt-oss) are retried without it.
- **Two model roles**, persisted in `system/settings.json` (`src/main/settings.ts`, edited on Profile → AI): `chatModel` (intake questions, fast) and optional `planModel` (builds/adjusts checklists; engine payload `planModel`). Both default to `cliproxy/gemini-3.8-flash-high` (evals: best plans, 98% hard-pass, and the only model with 0/12 skipped must-ask questions; ~7 s to first token). `cliproxy/gemini-3-flash` is the fast chat alternative (~2.5 s, but skips ~1/3 of must-ask cases). Model list lives in `src/common/models.ts`.
- Direct-key options (Gemini/OpenAI/Anthropic/Ollama) are still in the dropdown; each needs its key in `engine/.env`.

---



## Known bugs fixed this cycle

- `fs-manager.ts`: `new Date().toISOString` was missing `()` (stored a function reference, not a timestamp).
- `fs-manager.ts`: used `fs.readJSONSync` inside an async function — switched to `await fs.readJSON`.
- Dashboard/project-grid and the deadlines list had no scroll container and would overflow the fixed-height window — added `max-height` + `overflow-y: auto`.
- Chat bubbles inherited a global `user-select: none` on `body`, making chat text uncopyable — scoped `user-select: text` to `.chat-bubble`.
- A litellm error banner (colored ANSI text on stdout, e.g. on rate-limit errors) was corrupting `python-shell`'s JSON-mode parsing and surfacing as an opaque crash. Fixed by redirecting all non-final-result output in both Python scripts to stderr, and reducing `num_retries` from 3→1 so a quota-exhausted call fails fast instead of silently retrying for a long time.
- electron-vite/vite version mismatch broke `npm run dev` (`index.html not found`) — fixed by upgrading electron-vite to a version compatible with the installed vite.

---



## Features added in the CLIProxy cycle (Oct 2026)

- **AI plan changes keep progress** (`src/common/merge.ts` `mergeChecklist`): the mutation prompt sees each step's status and is told to keep ids; the main process merges the AI's list onto the on-disk task by id (title-similarity-guarded for done items; numbered siblings like Q1/Q2 never match) then normalized title. Done steps the AI drops are restored unless the user explicitly asked to remove them (`requestsRemovingCompleted`), because streaks/heatmap/burndown derive from `completedAt`.
- **Streamed chat now records facts:** `extract_turn_notes()` runs concurrently with the streamed question (no added latency) and returns ledger `notes` + profile `userNotes`.
- **Eval-driven prompt rules:** count limits (Deep 10–15, Brief 4–6), time-box caps (Deep 5–20 min, Brief ≤60, split don't inflate), first step ≤5 min/zero-decision/today, prerequisites ≤15 min with `timeEstimate`, no-ask rules for same/next-day deadlines, chores, and look-up-while-doing details, one short question, clarify temperature 0.2. Engine exceptions now return `status: "error"` (shown as a banner, not a fake coach question).
- **"Re-plan from today"** (`src/common/schedule.ts` `rescheduleOverdue`): banner in TaskDetail when steps slip past their day; moves overdue steps forward in order with a ~60 min/day budget, no LLM call.
- **AI-personalised nudges** (`engine/nudge.py`): `getNudge()` still picks the item deterministically; the copy is rewritten with the user's profile + streak, falling back to the template on failure/timeout (25 s). Toggle on Profile → AI. `getNudge` now moves on to the next overdue step if the most overdue was already nudged today.
- **Local-date fixes:** deadline redistribution, the workspace's default deadline, `getUpcomingTasks/Subtasks` deadline parsing, and ledger note timestamps all used UTC (`toISOString()` / `new Date('YYYY-MM-DD')`) and were off by a day in Sydney or west of UTC.
- **Workspace split:** `ProjectWorkspace` → `ChatThread`, `ContextLedgerPanel`, `SavedTaskList`, `ModelSelect`.

## Testing

- **Unit tests:** `npm test` (vitest, `vitest.config.ts`, TZ pinned to Australia/Sydney). Covers `types.ts` helpers, `merge.ts`, `schedule.ts`, and `fs-manager.ts` derived reads (electron mocked to a temp dir; never touches `~/Documents/FlowState`).
- **LLM evals:** `npm run eval` (`engine/evals/`, see its README) — 21 realistic cases run through the real engine, deterministic scorers + LLM judge, writes `engine/evals/REPORT.md`. `REPORT.baseline.md` is the pre-prompt-change baseline.

## What's still rough / not done

- ~21 pre-existing ESLint errors (mostly `any` in `src/main/index.ts`, missing return types in TaskDetails/ProjectWorkspace, `react-hooks/purity` on `Date.now()` in the Burndown).
- Claude/gpt-oss via the proxy have separate quotas that can run out (429 "Individual quota reached"); the eval harness tags these as `infra` and `--retry-errors` re-runs them.
- Merge edge cases: a heavily reworded done step that keeps its id becomes a near-duplicate (history kept); restored done steps go to the top of the list.
- `backdrop-blur` glass panels can be paint-heavy; not yet profiled on low-end hardware.

---



## How to run

```bash
npm run dev
```

Python venv lives at `engine/env/` (already set up). If rebuilding it: needs `litellm`, `python-dotenv`, `chromadb`, `sentence-transformers`, `torch`, `pypdf` — note `torch`/`sentence-transformers` had a broken native-lib link (`libtorch_cpu.dylib`) at one point on this machine; fixed via `pip install --force-reinstall torch sentence-transformers` in that venv.