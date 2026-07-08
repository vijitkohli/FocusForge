# uni-agent — Project Summary

**What it is:** Electron desktop app ("Flow State OS") for anti-procrastination. Thesis: procrastination is an emotional/avoidance problem, not a discipline problem. An AI chat coach breaks any task (big or small) into steps small enough that starting feels easy. Gamification (progress bars, deadline urgency) reinforces momentum.

Branch: `main-logic/v1`. Most of this work is currently **uncommitted** in the working tree — see `git status` before doing anything destructive.

---

## Stack

- **Electron 39 + React 19 + TypeScript**, bundled with `electron-vite`
- **State:** plain React hooks, no state library
- **Styling:** **Tailwind CSS v4** (`@tailwindcss/vite`, no config file) with `@theme` design tokens + frosted-glass utilities in `src/renderer/src/assets/tailwind.css`. "Zen-browser" dark aesthetic: soft gradient-mesh backdrop, translucent `backdrop-blur` panels (`glass`/`glass-strong` utilities), large radii, pill controls, floating sidebar rail. `base.css` keeps only the Inter font stack + reset. (The old `main.css` was deleted.)
- **AI engine:** separate Python process (`engine/`) invoked from the Electron main process via `python-shell`, using **LiteLLM** as the model-agnostic LLM client (supports Gemini, GPT-4o, Claude)
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

- Default model lowered to `gemini/gemini-2.5-flash-lite` (cheapest current Gemini text model, ~5x cheaper than the previous `gemini-3-flash-preview` default) — set in both `engine/main.py` `DEFAULT_MODEL` and the UI dropdown's initial state.
- Dropdown also offers GPT-4o and `claude-haiku-4-5` (cheapest Claude model) via LiteLLM. Each provider needs its own API key in `engine/.env`: `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (the latter was added as an empty placeholder — needs a real key pasted in before Claude actually works).
- Switching providers is just changing the model string passed to `litellm.completion()` — no other code changes needed.

---



## Known bugs fixed this cycle

- `fs-manager.ts`: `new Date().toISOString` was missing `()` (stored a function reference, not a timestamp).
- `fs-manager.ts`: used `fs.readJSONSync` inside an async function — switched to `await fs.readJSON`.
- Dashboard/project-grid and the deadlines list had no scroll container and would overflow the fixed-height window — added `max-height` + `overflow-y: auto`.
- Chat bubbles inherited a global `user-select: none` on `body`, making chat text uncopyable — scoped `user-select: text` to `.chat-bubble`.
- A litellm error banner (colored ANSI text on stdout, e.g. on rate-limit errors) was corrupting `python-shell`'s JSON-mode parsing and surfacing as an opaque crash. Fixed by redirecting all non-final-result output in both Python scripts to stderr, and reducing `num_retries` from 3→1 so a quota-exhausted call fails fast instead of silently retrying for a long time.
- electron-vite/vite version mismatch broke `npm run dev` (`index.html not found`) — fixed by upgrading electron-vite to a version compatible with the installed vite.

---



## What's still rough / not done

- `ANTHROPIC_API_KEY` in `engine/.env` is currently empty — Claude option in the dropdown won't work until a real key is added.
- **Streaming caveat:** the streamed clarifying turn returns plain prose, so it does **not** extract per-turn ledger `notes` (execution/mutation still do). Stated facts still reach the engine via the saved conversation + ledger.
- ~~**Mutation drops checkbox/board state:** an AI plan adjustment re-emits subtasks/prereqs fresh, resetting their completed/`status` state.~~ **Fixed:** `update-checklist` now runs the replacement checklist through `reconcileSubtasks`/`reconcilePrerequisites` (`common/types.ts`), matching steps by normalized title so surviving steps keep their done/doing state + original `completedAt`; new/renamed steps start `todo`.
- No automated tests anywhere in the repo.
- A handful of `@ts-ignore`s remain in `Dashboard.tsx` around `window.api` calls that are already properly typed (cosmetic cleanup, not a bug).
- `engine/chroma_db/` has a lot of untracked transient collection directories from testing the relevance-filtering pipeline — harmless but could be `.gitignore`d.
- `backdrop-blur` glass panels can be paint-heavy; not yet profiled on low-end hardware.

---



## How to run

```bash
npm run dev
```

Python venv lives at `engine/env/` (already set up). If rebuilding it: needs `litellm`, `python-dotenv`, `chromadb`, `sentence-transformers`, `torch`, `pypdf` — note `torch`/`sentence-transformers` had a broken native-lib link (`libtorch_cpu.dylib`) at one point on this machine; fixed via `pip install --force-reinstall torch sentence-transformers` in that venv.