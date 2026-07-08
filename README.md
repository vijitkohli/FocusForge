# uni-agent — Flow State OS

An Electron desktop app for beating procrastination. An AI coach breaks any task
into steps small enough that starting feels easy, with gamified momentum
(streaks, deadlines, a focus mode). All your data stays local on disk.

- **App shell:** Electron 39 + React 19 + TypeScript (electron-vite, Tailwind v4)
- **AI engine:** a local Python process (`engine/`) using [LiteLLM](https://github.com/BerriAI/litellm)
  so you can use Gemini, GPT-4o, Claude, or a local Ollama model
- **Storage:** flat files under `~/Documents/FlowState/` — no database, no cloud

> Runs on macOS. Windows/Linux paths are handled defensively but untested. A
> signed, downloadable build is not set up yet — see [Roadmap](#roadmap).

## Prerequisites

- **Node.js** 18+ (`node -v`)
- **Python** 3.10+ (`python3 --version`; on macOS: `brew install python`)
- An **LLM API key** for at least one provider (Gemini is the cheapest default),
  or a local [Ollama](https://ollama.com) install (no key needed)

## Setup

```bash
git clone <this-repo> uni-agent
cd uni-agent
npm run setup
```

`npm run setup` installs the Node dependencies **and** builds the Python engine:
it creates a virtualenv at `engine/env` and installs
[`engine/requirements.txt`](engine/requirements.txt) (this pulls `torch`, so the
first run downloads ~2GB and takes a few minutes).

Then add your API key:

```bash
cp engine/.env.example engine/.env
# open engine/.env and paste a GEMINI_API_KEY (or OpenAI / Anthropic key)
```

- Default model is `gemini/gemini-2.5-flash-lite` → get a free key at
  https://aistudio.google.com/apikey
- The app only needs the key for the model you actually select in its dropdown.
- If a key is missing, the app shows a friendly "add your key" message instead of
  crashing.

## Run

```bash
npm run dev
```

## Where your data lives

Everything is plain files under `~/Documents/FlowState/`:

- `<projectId>/project_data.json` — tasks + subtasks
- `<projectId>/context_<projectId>.md` — per-project context ledger
- `system/` — project registry, nudge log, and your global `user_profile.md`

To wipe everything back to a fresh install, use **Profile → Danger Zone → Reset**
inside the app.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run setup` | Install Node deps + build the Python engine venv |
| `npm run setup:engine` | (Re)build only the Python engine venv |
| `npm run dev` | Run the app in development |
| `npm run build` | Type-check + build renderer/main/preload |
| `npm run typecheck` | Type-check without building |
| `npm run lint` | ESLint |

## Configuration

- **`engine/.env`** — API keys (BYO). Never committed.
- **`UNI_AGENT_PYTHON`** — optional env var: absolute path to a Python
  interpreter to run the engine with, overriding the auto-detected `engine/env`
  venv. Useful if you keep your venv elsewhere.

## Troubleshooting

- **`torch` / `sentence-transformers` import errors** (a native-lib link can
  break on macOS): re-install them in the engine venv —
  ```bash
  engine/env/bin/pip install --force-reinstall torch sentence-transformers
  ```
- **"No API key found for …"** — copy `engine/.env.example` to `engine/.env` and
  paste the key for the model you selected.
- **Engine won't start** — confirm `engine/env` exists (`npm run setup:engine`),
  or set `UNI_AGENT_PYTHON` to a Python 3 interpreter that has the requirements
  installed.

## Roadmap

Not yet built (planned — see `plan.md`, section F7):

- Freeze the engine with PyInstaller so end users need no Python installed
- Bundle a signed, notarized `.dmg` (auto-update)
- In-app Settings UI for API keys (instead of `engine/.env`)
