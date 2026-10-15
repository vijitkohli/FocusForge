# Engine evals

Measures plan quality of `engine/main.py` across models, so prompt/model changes are judged on data.
The harness runs the **real engine** as a subprocess (`engine/env/bin/python engine/main.py`) with the same streaming NDJSON payload the app sends, so it tests exactly what ships.

## Run

```bash
npm run eval                                   # all cases × default models, clarify + execute, judged, REPORT.md
npm run eval -- --models cliproxy/gemini-3-flash --cases clean-room-today help-me-study
npm run eval -- --modes clarify --samples 3    # more samples for the (stochastic) ask-vs-skip decision
npm run eval -- --report-only                  # re-score + rebuild REPORT.md from cache, no model calls
npm run eval -- --force                        # ignore cached engine outputs (e.g. after a prompt edit)
```

Same thing without npm: `engine/env/bin/python -m engine.evals.run ...` (from the repo root) or `engine/env/bin/python engine/evals/run.py ...`.

Requires the CLIProxyAPI server from `engine/.env` (`CLIPROXY_API_BASE`, `CLIPROXY_API_KEY`). Concurrency is capped at 4 in-flight calls so the proxy's upstream accounts aren't throttled.

## What it does

| file | role |
|---|---|
| `cases.json` | ~20 cases for the target user (UNSW student who procrastinates): essays, COMP assignments, labs, exams, group work, job apps, chores, vague asks, today/tomorrow and 3+ week deadlines, ledgers with completed work (`done_items`), profiles with friction patterns. Deadlines are `deadline_offset_days` relative to the run date. `expect_clarify` = `ask` / `ready` / `either`. |
| `engine_runner.py` | One subprocess call per (model, case, mode, sample). **clarify** = first streamed turn as-is (did it ask, or skip straight to a plan?). **execute** = sentinel `DO NOT ASK FOLLOW UP QUESTIONS` appended to force the checklist. Records latency, time-to-first-token, and error kind (`json_parse_failure`, `engine_exception`, `invalid_ndjson`, `timeout`, ...). The engine reports its own exceptions as `status: clarifying` + "Something went wrong on my end", which is classified as an error, not a question. |
| `scorers.py` | Deterministic checks: structure, subtask count vs depth (Deep ≥ 10, Brief 5–8), integer time estimates under a cap (Deep ≤ 30 min, Brief ≤ 60 min), first step ≤ 15 min, dates within [run date, deadline], spread over > 1 day when the window allows, dates non-decreasing, vague-verb titles, `originalTask` not an echo of the engine's instruction, prerequisite `kind` ∈ learn/acquire/setup, and no step that fuzzily matches ledger-completed work. |
| `judge.py` | LLM-as-judge (default `cliproxy/gemini-3.8-flash-high`; `--judge-model cliproxy/claude-opus-4-6-thinking` is more neutral since it is not a graded model, but its proxy quota ran out mid-suite. When verdicts from two judges exist, the report prints their agreement): 1–5 + rationale for specificity, first-step startability, ordering, fit to task/context, tone; and 1–5 question quality for clarify turns. Tolerant JSON parsing, 3 retries. |
| `report.py` | Aggregates the cache into `REPORT.md` (+ `results/summary.json`). Splices in the hand-written `analysis.md` (recommendations and prompt suggestions). |

Raw outputs are cached in `results/raw/<model>/<case>.<mode>.<sample>.json` and verdicts in `results/judge/<judge>/<model>/...` (gitignored). Scoring always uses the run date stored in each raw record, so cached results score the same on any day. Delete `results/` or pass `--force` / `--force-judge` to re-run calls.

## Adding a case

Append to `cases.json`. Give an `expect_clarify` only when it's clear-cut (vague → `ask`, fully specified or trivial chore → `ready`), and list completed ledger work in `done_items` so the redundancy check can see it.
