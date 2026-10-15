# Engine eval report

_Generated 2026-10-15 13:02 by `engine/evals/report.py` from cached results. 21 cases, judge = `cliproxy/gemini-3.8-flash-high`. Regenerate with `npm run eval -- --report-only --judge-model cliproxy/gemini-3.8-flash-high`._

## Execution phase (forced checklist)

`runs` excludes infra failures (proxy rate limits/quota, timeouts), shown as `+N infra`; `err` is model/engine errors only (bad JSON, rejected request params, wrong status). 
Deterministic checks are pass rates over non-error runs. `hard` = structure, count, time, dates in range, title, prerequisites, and no-redundant-work (when the case has completed ledger work). Judge scores are 1–5 means.

| model | runs | err | hard pass | all pass | med. steps | med. latency | judge mean | specificity | first step | ordering | fit | tone |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `cliproxy/claude-sonnet-4-6` | 42 | 0% | 40% | 31% | 16 | 24.4s | **4.55** | 4.74 | 4.24 | 4.90 | 4.05 | 4.81 |
| `cliproxy/gemini-3-flash` | 42 | 0% | 50% | 38% | 10 | 4.8s | **4.10** | 4.21 | 3.71 | 4.55 | 3.67 | 4.38 |
| `cliproxy/gemini-3.1-flash-lite` | 42 | 0% | 50% | 43% | 10 | 4.3s | **4.06** | 4.07 | 3.67 | 4.57 | 3.67 | 4.31 |
| `cliproxy/gemini-3.5-flash-lite` | 42 | 0% | 50% | 38% | 10 | 4.7s | **4.09** | 4.17 | 3.79 | 4.55 | 3.74 | 4.21 |
| `cliproxy/gemini-3.8-flash-high` | 42 | 0% | 83% | 74% | 12 | 14.7s | **4.65** | 4.81 | 4.43 | 4.81 | 4.74 | 4.48 |
| `cliproxy/gpt-oss-120b-medium` | 42 | 100% | – | – | – | –s | **–** | – | – | – | – | – |

Per-check pass rates:

| model | count | time | 1st≤15m | 1st today | dates | spread | in order | no-vague | title | prereq | no-redund. |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `cliproxy/claude-sonnet-4-6` | 79% | 62% | 76% | 98% | 100% | 95% | 100% | 98% | 100% | 100% | 100% |
| `cliproxy/gemini-3-flash` | 83% | 62% | 86% | 76% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| `cliproxy/gemini-3.1-flash-lite` | 83% | 64% | 86% | 83% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| `cliproxy/gemini-3.5-flash-lite` | 88% | 62% | 81% | 81% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| `cliproxy/gemini-3.8-flash-high` | 100% | 83% | 83% | 83% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| `cliproxy/gpt-oss-120b-medium` | – | – | – | – | – | – | – | – | – | – | – |

## Clarify phase (first streamed turn)

`skip` = jumped straight to a plan on turn 1. `bad skip` = skipped on a case where a good coach must ask (vague asks). `over-ask` = asked on a case that already had enough context. `appropriate` counts `either` cases as always appropriate. Question quality is judge-scored (1–5) on asked turns only. `compound q.` = share of questions that bundle two asks ("X, and what Y?") despite the one-question rule.

| model | runs | err | asked | skip rate | bad skip | over-ask | appropriate | compound q. | q. quality | med. words | med. TTFT | med. latency |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `cliproxy/claude-sonnet-4-6` | 0 (+63 infra) | – | 0 | – | 0/0 | 0/0 | – | – | – | – | –s | –s |
| `cliproxy/gemini-3-flash` | 63 | 0% | 40 | 37% | 1/12 | 7/15 | 87% | 22% | 4.25 | 22 | 2.4s | 2.7s |
| `cliproxy/gemini-3.1-flash-lite` | 63 | 0% | 37 | 41% | 0/12 | 7/15 | 89% | 14% | 4.19 | 21 | 2.4s | 2.7s |
| `cliproxy/gemini-3.5-flash-lite` | 63 | 0% | 36 | 43% | 1/12 | 5/15 | 90% | 25% | 4.47 | 22 | 2.4s | 2.8s |
| `cliproxy/gemini-3.8-flash-high` | 63 | 0% | 56 | 11% | 0/12 | 9/15 | 86% | 70% | 4.00 | 28 | 6.8s | 7.1s |
| `cliproxy/gpt-oss-120b-medium` | 0 (+63 infra) | – | 0 | – | 0/0 | 0/0 | – | – | – | – | –s | –s |

### Clarify decisions by case

`A` = asked, `S` = skipped to plan, `E` = error (one letter per sample).

| case | expect | `claude-sonnet-4-6` | `gemini-3-flash` | `gemini-3.1-flash-lite` | `gemini-3.5-flash-lite` | `gemini-3.8-flash-high` | `gpt-oss-120b-medium` |
|---|---|---|---|---|---|---|---|
| cold-war-essay-vague | ask | – | AAA | AAA | SAA | AAA | – |
| cold-war-essay-answered | ready | – | SSS | SSS | SSS | SSS | – |
| comp2521-graph-assignment | ask | – | AAS | AAA | AAA | AAA | – |
| comp1531-group-iteration | either | – | SSS | SSS | SSS | AAA | – |
| chem-lab-report-tomorrow | either | – | AAA | AAA | AAA | AAA | – |
| math1231-exam-revision | either | – | AAA | AAA | AAA | AAA | – |
| comp3311-sql-tomorrow | either | – | SSS | SAS | SSS | AAA | – |
| atlassian-internship-application | either | – | AAA | AAA | AAA | AAA | – |
| clean-room-today | ready | – | ASA | ASA | AAA | AAA | – |
| avoided-supervisor-email | either | – | SSA | SSS | SSS | AAA | – |
| life-together-vague | ask | – | AAA | AAA | AAA | AAA | – |
| help-me-study | ask | – | AAA | AAA | AAA | AAA | – |
| comp6080-exam-tomorrow | either | – | SAA | AAA | AAA | AAA | – |
| honours-lit-review | either | – | SSS | SSS | SSS | ASA | – |
| comp2511-design-patterns-ledger | ready | – | ASS | SAS | SSA | AAA | – |
| mgmt-group-presentation | either | – | AAA | ASA | SAA | AAA | – |
| centrelink-reporting | ready | – | SAA | SAS | SSS | SSS | – |
| psyc-reading-adhd-profile | either | – | SAS | SSS | SSS | AAA | – |
| portfolio-website-3wk | either | – | AAA | AAA | AAA | AAA | – |
| comp1511-spec-avoidance | either | – | AAA | SSS | AAA | AAA | – |
| comp3121-problem-set-tonight | ready | – | SAA | AAA | SAS | AAA | – |

### Errors

- `cliproxy/gpt-oss-120b-medium`: execute:response_format_rejected ×42

## Computed ranking

Execution composite = 0.6·(judge mean−1)/4 + 0.4·hard-pass rate − error rate. Clarify composite = 0.5·appropriate rate + 0.5·(question quality−1)/4 − error rate.

| rank | execution | score | clarify | score |
|---|---|---|---|---|
| 1 | `cliproxy/gemini-3.8-flash-high` | 0.881 | `cliproxy/gemini-3.5-flash-lite` | 0.886 |
| 2 | `cliproxy/claude-sonnet-4-6` | 0.694 | `cliproxy/gemini-3-flash` | 0.843 |
| 3 | `cliproxy/gemini-3-flash` | 0.666 | `cliproxy/gemini-3.1-flash-lite` | 0.843 |
| 4 | `cliproxy/gemini-3.5-flash-lite` | 0.664 | `cliproxy/gemini-3.8-flash-high` | 0.804 |
| 5 | `cliproxy/gemini-3.1-flash-lite` | 0.659 | `cliproxy/claude-sonnet-4-6` | – |
| 6 | `cliproxy/gpt-oss-120b-medium` | – | `cliproxy/gpt-oss-120b-medium` | – |

## Judge agreement

Same execute outputs graded by another judge (diff = primary − other; positive means the primary judge is more generous).

`cliproxy/gemini-3.8-flash-high` vs `cliproxy_claude-opus-4-6-thinking` on 64 plans:

| dimension | mean diff | mean abs diff | within ±1 |
|---|---|---|---|
| specificity | +0.53 | 0.56 | 98% |
| first_step | -0.20 | 0.42 | 97% |
| ordering | +0.17 | 0.45 | 98% |
| fit | +0.30 | 0.89 | 78% |
| tone | +0.75 | 0.75 | 92% |

- `cliproxy/gemini-3-flash` (n=42): primary mean 4.10 vs other 3.80
- `cliproxy/gemini-3.5-flash-lite` (n=22): primary mean 4.16 vs other 3.84

## Recommendation (hand-written, run of 2026-10-15)

**Caveats first.**
- Runs: 21 cases. Execute has 2 samples per model and clarify has 3, so a one-case difference in any column is noise.
- The intended judge was `claude-opus-4-6-thinking`, but its proxy quota ran out partway through. The final judge is `gemini-3.8-flash-high`, which is also one of the graded models, so its score for itself may be inflated.
- Calibration against opus on 64 shared plans: gemini scores about +0.3 higher overall, mostly on tone (+0.75) and specificity (+0.5), and stays within ±1 of opus on 78–98% of scores. Both judges rank `gemini-3-flash` and `gemini-3.5-flash-lite` the same way.
- The deterministic checks don't depend on the judge, and they point the same way as the judge scores.
- `claude-sonnet-4-6` has execute data only. Its clarify runs, and every `gpt-oss-120b-medium` clarify run, hit `429 Individual quota reached`. Re-run them with `npm run eval -- --retry-errors` after the quota resets.

**Execution phase: use `cliproxy/gemini-3.8-flash-high`.**
- It is the only model that follows the structural rules reliably: 83% hard pass, against 50% for gemini-3-flash and 3.5-flash-lite and 40% for sonnet.
- Count rule: 100%. Time-box rule: 83%. Median longest Deep step: 15 min, against 40–45 min for every other model.
- Judge mean 4.65, and it leads on fit (4.74).
- Cost: about 15 s per checklist, against about 5 s for the flash models. That's acceptable for a one-time plan generation.
- `claude-sonnet-4-6` writes the warmest, best-ordered plans (tone 4.81, ordering 4.90), but it overshoots badly: median 16 steps, up to 40 on Deep and 14 on Brief. It is also the slowest (about 24 s) and the first to run out of proxy quota.

**Clarify phase: use `cliproxy/gemini-3.5-flash-lite`; `gemini-3-flash` is a close second.**
- Both stream the first token in about 2.4 s and give an appropriate ask/skip decision 87–90% of the time. They wrongly skipped a vague case only once in 12 runs each.
- 3.5-flash-lite had the best question quality (4.47) and fewer over-asks (5/15 vs 7/15).
- Avoid `gemini-3.8-flash-high` for clarify:
  - It almost never skips (11%), including on a problem set due tonight.
  - 70% of its "one question" replies bundle two questions.
  - It is about 3× slower to the first token.
- The engine uses one `model` for every phase. Splitting it into a clarify model and an execution model (e.g. an optional `executionModel` in the payload) gets the strengths of both.

**About the known "gemini-3-flash skips clarification on the cold-war essay" observation.** It did not reproduce on the streaming path: gemini-3-flash asked 3/3 times (and 1/1 in the smoke run). Only `gemini-3.5-flash-lite` skipped it (1/3). The real problem is that decisions are inconsistent, not that models skip:
- At temperature 0.6, the same input often gets ask on one sample and skip on another (`ASA`, `SAA` in the grid above).
- The more common failure is over-asking: "clean my room" got a clarifying question in 2 of 3 runs or more from every model.

## Top prompt weaknesses and suggested edits

Suggestions only. `engine/main.py` was not edited.

1. **The Brief/Deep count rule reads as a minimum, with no ceiling.**
   - Rule 4 says "at least 10+ subtasks if Deep or 5 subtasks if Brief", so models treat 5 as a floor. Brief plans reach 10 steps (gemini) and 14 (sonnet), and Deep plans reach 40 (sonnet).
   - Count pass rate is 79–88% for every model except 3.8-flash-high.
   - Suggested replacement for rule 4: *"QUANTITY: Deep = 10–15 subtasks. Brief = 4–6 subtasks (milestones). Never exceed the upper bound — a long list is itself a reason to procrastinate."*

2. **The time-box isn't stated as a hard limit.**
   - The DEPTH line says "5-10 min increments", but rule 6 only asks for a "realistic" estimate. The time check passes only 62–64% of the time (83% for 3.8), with 45–75-minute Deep steps such as "Write Body Paragraphs 1 and 2 — 60 min".
   - Suggested replacement for rule 6: *"STRICT TIME-BOXING: Deep steps are 5–20 minutes, Brief steps at most 45. If something takes longer, split it into several steps (e.g. 'Write paragraph 1', 'Write paragraph 2') rather than raising the estimate."*

3. **The first step is not guaranteed to be tiny or scheduled today.**
   - First step is the lowest judge dimension for every model (3.67–4.43).
   - The first step is over 15 minutes in 14–24% of plans and is not scheduled today in 17–24% of gemini plans. For example, the cold-war essay's first step is "Draft working thesis… 30 min" on tomorrow's date.
   - Suggested new rule: *"FIRST STEP: subtasks[0] must be a ≤5-minute, zero-decision starter (open the file/spec/doc, write one sentence, list 3 bullets) with scheduledDate = CURRENT DATE."*

4. **Prerequisites act as an unbounded hidden first step.**
   - They have no `timeEstimate` or date, and the UI pins them above step 1, so heavy work escapes the time-box. Examples: "Gather 4-6 primary and secondary academic sources", "Download every course syllabus", "Search academic databases and save 8 scholarly sources".
   - The judge called these out repeatedly as the worst issue.
   - Suggested addition to rule 1: *"Each prerequisite must be doable in ≤15 minutes. Research, reading and source-gathering are execution work and belong in `subtasks` (split and time-boxed), not in `prerequisites`."* Alternatively, add `timeEstimate` to the prerequisite schema.

5. **Clarify has no rule for urgency or triviality.**
   - 'ready' cases were over-asked 5–9 times out of 15 per model. Examples:
     - "clean my room" got "What does 'clean' specifically need to involve…?"
     - gemini-3.8 asked about the problem set due at 11:59 tonight.
     - Centrelink got "What … gross income amounts are listed on the two payslips?", which the judge scored 1/5.
   - Suggested addition to the streaming clarify prompt: *"If the deadline is today/tomorrow or the task is a simple chore or errand, reply __READY__ unless one fact would change the plan's steps. Never ask for details the user only needs while doing the task (amounts, file contents, exact wording)."*

6. **The "ONE question" rule leaks.**
   - 14–25% of flash questions bundle two asks ("What materials do you have…, and how many hours per week…?"). For 3.8-flash-high it's 70%. The judge marks these down.
   - Suggested edit: *"Ask exactly ONE question: one '?', no 'and/or' joining a second ask, under 25 words."*

7. **The clarify decision is noisy.**
   - The same input flips between ask and skip across samples at temperature 0.6.
   - Suggested change: run the clarify call at temperature ≈0.2. The phrasing can stay varied, because the decision is just whether the reply is the sentinel.

8. **The ledger rule doesn't cover prerequisites.**
   - The deterministic redundancy check found no subtask repeating completed work (60 ledger plans).
   - The judge did flag prerequisites that redo finished setup. Example: "Ensure you can log into VS Code via SSH to CSE", when the ledger says this was set up on 10-09.
   - Suggested edit to rule 7: *"…do not include it, or an equivalent step **or prerequisite**, again."*

9. **Engine robustness (not prompt wording).**
   - `gpt-oss-120b-medium` fails 100% of execution calls: the proxy rejects `response_format={"type":"json_object"}` ("Expected input to contain field: 'json_schema'"). Since `_parse_json` already tolerates prose, retry once without `response_format` on a `BadRequestError` that mentions it.
   - Engine exceptions come back as `status: "clarifying"` with "Something went wrong on my end…". The UI therefore shows an error as if it were a coach question. Return `status: "error"` instead. The eval harness pattern-matches the message to tell them apart.

## Worst examples per model

### `cliproxy/claude-sonnet-4-6`

**life-together-vague** — judge mean 3.4; failed: count (10 subtasks (Brief wants 5-8)); first_step_small (first step = 20 min)
> Judge: The initial prerequisite demands hunting down all syllabus materials across all courses at once, creating an intimidating barrier to entry instead of an effortless under-10-minute starting action.

  - originalTask: 'Get life together for uni this term'
  - [prereq/acquire] Gather all module handbooks, syllabi, and assignment briefs into one place
  - [prereq/setup] Check university portal for deadlines, exam dates, and timetable
  - [prereq/setup] Pick one calendar/planner tool to use (Google Calendar, Notion, paper planner, etc.)
  - Write down every deadline and exam date into your chosen planner — 20 min, 2026-10-15
  - Audit your current finances — open banking app and note income vs. fixed costs for the term — 25 min, 2026-10-16
  - Set up a weekly routine template — block lecture times, study slots, meals, and sleep in your planner — 30 min, 2026-10-17
  - Tidy and organise your physical study space — clear desk, gather stationery, charge devices — 20 min, 2026-10-18
  - Create a master assignment tracker (spreadsheet or Notion table) listing every task, module, and due date — 25 min, 2026-10-19
  - Identify your top 3 highest-priority assignments due before 14 Nov and break each into 3 action steps — 20 min, 2026-10-21
  - … (+4 more)

**cold-war-essay-vague** — judge mean 3.6; failed: count (10 subtasks (Brief wants 5-8))
> Judge: The plan ignores the 'Brief' depth constraint by delivering 10 granular drafting steps instead of ~5 high-level milestones.

  - originalTask: 'Write a 2000-word essay on the Cold War'
  - [prereq/learn] Skim 2–3 reliable sources on the Cold War (e.g. Khan Academy, Britannica, or a textbook chapter) to refresh key events and themes
  - Decide on a focused angle/thesis (e.g. origins, arms race, proxy wars, or ideological conflict) — jot it in one sentence — 15 min, 2026-10-15
  - Build a bullet-point outline: intro, 3–4 body sections, conclusion — label each with its main argument — 20 min, 2026-10-15
  - Write the introduction (~200 words): hook, brief context, and your thesis statement — 25 min, 2026-10-16
  - Write Body Section 1 (~400 words): origins and post-WWII tensions (Truman Doctrine, Marshall Plan, Berlin Blockade) — 35 min, 2026-10-17
  - Write Body Section 2 (~400 words): escalation — arms race, space race, and nuclear brinkmanship (Cuban Missile Crisis) — 35 min, 2026-10-19
  - Write Body Section 3 (~400 words): proxy wars and global spread (Korea, Vietnam, Afghanistan) — 35 min, 2026-10-21
  - … (+4 more)

### `cliproxy/gemini-3-flash`

**help-me-study** — judge mean 2.8; failed: time_estimates (2 over 30min (max 45))
> Judge: The step durations are far too large (mostly 20–45 minutes) for a Deep setting, creating intimidating chunks rather than the tiny 5–10 minute micro-actions needed to overcome avoidance.

  - originalTask: 'Comprehensive study and review plan for upcoming exam'
  - [prereq/acquire] Gather all syllabus documents, textbooks, and lecture notes in one place
  - [prereq/learn] Review the exam grading criteria and weight distribution
  - [prereq/setup] Clear study desk and set up a distraction-free environment
  - List out all topics to be covered and rank them by confidence level (High, Medium, Low) — 15 min, 2026-10-15
  - Create a master schedule assigning specific topics to specific days — 20 min, 2026-10-15
  - Read through Chapter 1 notes and highlight key definitions — 25 min, 2026-10-16
  - Create flashcards for core terms and formulas from Chapter 1 — 20 min, 2026-10-16
  - Read through Chapter 2 notes and summarize each section in one sentence — 30 min, 2026-10-17
  - Complete 5 practice problems related to Chapter 2 concepts — 30 min, 2026-10-17
  - … (+5 more)

**comp1511-spec-avoidance** — judge mean 3.0; failed: time_estimates (2 over 30min (max 40))
> Judge: Subtask durations are 15–40 minutes rather than the required 5–10 minute micro-steps, and the plan includes setup work already recorded as completed in the ledger.

  - originalTask: 'COMP1511 Assignment 1: CS Bricks C program implementation'
  - [prereq/learn] Review COMP1511 style guide rules (indentation, variable naming, function length)
  - [prereq/setup] Ensure you can log into VS Code via SSH to CSE and open your assignment folder
  - Open cs_bricks.c and write down a plain-English list of the first Stage requirements (do not look at the whole spec, just Stage 1) — 15 min, 2026-10-15
  - Draft the main struct definitions needed for the game board and bricks based on Stage 1 — 20 min, 2026-10-15
  - Write the initialization function to set up the starting state of the board — 25 min, 2026-10-16
  - Write a simple print function to display the board state to the terminal so you can test visually — 20 min, 2026-10-16
  - Implement the core logic for Stage 1 user inputs/commands — 30 min, 2026-10-17
  - Compile your code using dcc and manually test Stage 1 commands in the terminal — 15 min, 2026-10-17
  - … (+9 more)

Bad clarify skips: comp2521-graph-assignment

Weakest question (centrelink-reporting, 1/5): “What specific date range and gross income amounts are listed on the two payslips you need to report?” — Asking the student to provide specific gross income figures and date ranges creates unnecessary friction by demanding exact data entry rather than identifying actionable planning obstacles, such as whether the payslips have even been downloaded yet.

### `cliproxy/gemini-3.1-flash-lite`

**comp1511-spec-avoidance** — judge mean 2.6; failed: time_estimates (4 over 30min (max 45))
> Judge: The plan ignores completed work by telling the student to create an empty file instead of using their existing starter code, while providing 30-45 minute chunks rather than the requested 5-10 minute micro-steps.

  - originalTask: 'Complete COMP1511 Assignment 1 (CS Bricks)'
  - Open VS Code via SSH and create your empty cs_bricks.c file — 10 min, 2026-10-15
  - Write a basic main() function that prints 'Hello, CS Bricks!' and compile it using dcc — 15 min, 2026-10-15
  - Define the 2D array representation for the game grid in your code — 25 min, 2026-10-16
  - Write a function to initialize the grid with empty spaces and standard bricks — 30 min, 2026-10-16
  - Write a function to print the game grid cleanly to the terminal — 30 min, 2026-10-17
  - Implement Stage 1 input reading for placing the paddle and ball — 40 min, 2026-10-18
  - … (+8 more)

**help-me-study** — judge mean 2.8
> Judge: Task durations range from 15 to 30 minutes, failing the Deep depth criteria of tiny, low-friction 5-10 minute steps to overcome procrastination.

  - originalTask: 'Comprehensive Study Session Execution'
  - [prereq/acquire] Gather all syllabus documents, textbooks, and lecture notes into one workspace
  - [prereq/learn] Review the upcoming exam format, grading rubric, or test objectives
  - [prereq/setup] Install and test any required study apps, flashcard software, or digital PDFs
  - List out all specific topics and chapters that need to be covered — 15 min, 2026-10-15
  - Review lecture slides for Topic 1 and highlight core concepts — 25 min, 2026-10-15
  - Create 10 flashcards summarizing the main definitions of Topic 1 — 15 min, 2026-10-16
  - Read assigned pages for Topic 2 and take bullet-point notes — 30 min, 2026-10-17
  - Attempt 3 practice problems or review questions for Topic 2 — 20 min, 2026-10-17
  - Review study materials for Topic 3 and outline complex formulas or frameworks — 30 min, 2026-10-18
  - … (+4 more)

Weakest question (cold-war-essay-vague, 2/5): “What is the required citation style and do you already have your primary sources gathered?” — This is a double-barrelled question that prioritizes minor details like citation style over critical missing information such as the specific essay prompt or scope.

### `cliproxy/gemini-3.5-flash-lite`

**cold-war-essay-vague** — judge mean 2.8; failed: count (9 subtasks (Brief wants 5-8)); first_step_small (first step = 20 min); first_step_today (first step scheduled 2026-10-16)
> Judge: The plan disregards the 'Brief' depth setting by generating 9 subtasks instead of ~5 milestones, while also kicking off with an intimidating research prerequisite.

  - originalTask: '2000 word essay on the Cold War'
  - [prereq/acquire] Gather 4-5 reliable sources or textbook chapters covering the chosen Cold War era
  - Draft a simple 3-sentence thesis statement outlining your main argument — 20 min, 2026-10-16
  - Outline the essay structure: Introduction, 4 body paragraphs, and Conclusion — 30 min, 2026-10-17
  - Write the introduction paragraph and thesis statement — 30 min, 2026-10-18
  - Write Body Paragraphs 1 and 2 (approx. 500 words) — 60 min, 2026-10-19
  - Write Body Paragraphs 3 and 4 (approx. 500 words) — 60 min, 2026-10-20
  - Write Body Paragraphs 5 and 6 to reach the core argument depth (approx. 500 words) — 60 min, 2026-10-21
  - … (+3 more)

**help-me-study** — judge mean 2.8; failed: time_estimates (5 over 30min (max 60))
> Judge: The plan fails the Deep depth specification by scheduling intimidating 30-to-60-minute study blocks instead of bite-sized 5-to-10-minute low-friction actions.

  - originalTask: 'Comprehensive Study Session Execution'
  - [prereq/acquire] Gather all required textbooks, lecture notes, and syllabus
  - [prereq/setup] Set up a clean, distraction-free study space with water and lighting
  - [prereq/learn] Review the core exam or assignment guidelines to understand grading criteria
  - Review syllabus and list out every specific topic or chapter that needs to be covered — 15 min, 2026-10-15
  - Organize study materials into chronological piles or digital folders by day — 15 min, 2026-10-15
  - Read and take active summary notes on Topic/Chapter 1 — 45 min, 2026-10-16
  - Complete practice problems or end-of-chapter review questions for Topic 1 — 30 min, 2026-10-16
  - Read and take active summary notes on Topic/Chapter 2 — 45 min, 2026-10-17
  - Complete practice problems or flashcard review for Topic 2 — 30 min, 2026-10-17
  - … (+5 more)

Bad clarify skips: cold-war-essay-vague

Weakest question (math1231-exam-revision, 2/5): “What specific materials do you have available to study from (e.g., lecture recordings, textbook, past exams, or assignment solutions), and how many hours per week can you realistically dedicate to this?” — The coach bundles two distinct questions together (available study materials and weekly time commitment), violating the rule to ask only a single, focused question.

### `cliproxy/gemini-3.8-flash-high`

**cold-war-essay-vague** — judge mean 3.4; failed: first_step_small (first step = 30 min); first_step_today (first step scheduled 2026-10-16)
> Judge: The plan prompts the student to narrow their topic to a specific angle in the prerequisites, yet the writing milestones lock them into a broad, chronological overview of the entire Cold War.

  - originalTask: 'Write a 2,000-word essay on the Cold War'
  - [prereq/learn] Select specific Cold War angle (e.g., proxy wars, nuclear arms race, or ideological conflict)
  - [prereq/acquire] Gather 4-6 primary and secondary academic sources
  - [prereq/setup] Create a document template with required citation style (APA/MLA)
  - Draft working thesis and outline 4 central body arguments — 30 min, 2026-10-16
  - Write Section 1: Origins and Ideological Division (500 words) — 60 min, 2026-10-18
  - Write Section 2: Key Crises and Proxy Conflicts (500 words) — 60 min, 2026-10-20
  - Write Section 3: Détente and Economic/Internal Collapse (500 words) — 60 min, 2026-10-22
  - Draft Introduction, Conclusion, and transitions (500 words) — 45 min, 2026-10-23
  - Perform final proofread, check citations, and verify bibliography — 45 min, 2026-10-24

**life-together-vague** — judge mean 3.4; failed: first_step_small (first step = 25 min)
> Judge: Requiring the user to locate and download every syllabus across all courses up front creates too much friction for an overwhelmed student looking to get started.

  - originalTask: 'Organize and reset academic workflow for the university term'
  - [prereq/setup] Log into university LMS (Canvas/Blackboard) and download every course syllabus
  - [prereq/setup] Choose and set up a single primary planning tool (Google Calendar, Notion, or physical planner)
  - Input all syllabus exam dates and major project deadlines into primary calendar — 25 min, 2026-10-15
  - Audit current grades and identify any missing or pending assignments across all modules — 20 min, 2026-10-16
  - Design a weekly time-block routine reserving dedicated non-negotiable study hours — 20 min, 2026-10-17
  - Create clean digital folders (e.g., Google Drive/Desktop) organized by course code — 15 min, 2026-10-18
  - Conduct end-of-week routine review to troubleshoot schedule friction and adjust time blocks — 15 min, 2026-10-23
  - Complete a 30-day deadline preparation audit and outline milestones for upcoming major deliverables — 30 min, 2026-11-02

Weakest question (comp2521-graph-assignment, 2/5): “What specific milestones or parts does the assignment specification break the project into, and what starter code or ADTs have you been given?” — This is a compound, double-barreled question that demands high cognitive effort to answer rather than asking a single, focused question.

### `cliproxy/gpt-oss-120b-medium`

Error `response_format_rejected` on cold-war-essay-vague (execute): `Something went wrong on my end (litellm.BadRequestError: OpenAIException - Expected input to contain field: 'json_schema'.). Could you try that again?`

Error `response_format_rejected` on cold-war-essay-vague (execute): `Something went wrong on my end (litellm.BadRequestError: OpenAIException - Expected input to contain field: 'json_schema'.). Could you try that again?`

