# Engine eval report

_Generated 2026-10-15 13:35 by `engine/evals/report.py` from cached results. 21 cases, judge = `cliproxy/gemini-3.8-flash-high`. Regenerate with `npm run eval -- --report-only --judge-model cliproxy/gemini-3.8-flash-high`._

## Execution phase (forced checklist)

`runs` excludes infra failures (proxy rate limits/quota, timeouts), shown as `+N infra`; `err` is model/engine errors only (bad JSON, rejected request params, wrong status). 
Deterministic checks are pass rates over non-error runs. `hard` = structure, count, time, dates in range, title, prerequisites, and no-redundant-work (when the case has completed ledger work). Judge scores are 1–5 means.

| model | runs | err | hard pass | all pass | med. steps | med. latency | judge mean | specificity | first step | ordering | fit | tone |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `cliproxy/claude-sonnet-4-6` | 42 | 0% | 40% | 31% | 16 | 24.4s | **4.55** | 4.74 | 4.24 | 4.90 | 4.05 | 4.81 |
| `cliproxy/gemini-3-flash` | 42 | 0% | 95% | 95% | 10 | 4.3s | **4.55** | 4.50 | 4.52 | 4.74 | 4.36 | 4.64 |
| `cliproxy/gemini-3.1-flash-lite` | 42 | 0% | 93% | 90% | 9 | 4.3s | **4.70** | 4.62 | 4.76 | 4.83 | 4.60 | 4.69 |
| `cliproxy/gemini-3.5-flash-lite` | 42 | 0% | 90% | 86% | 9 | 4.4s | **4.60** | 4.36 | 4.69 | 4.64 | 4.60 | 4.71 |
| `cliproxy/gemini-3.8-flash-high` | 42 | 0% | 98% | 98% | 12 | 16.3s | **4.75** | 4.71 | 4.90 | 4.86 | 4.74 | 4.55 |
| `cliproxy/gpt-oss-120b-medium` | 42 | 100% | – | – | – | –s | **–** | – | – | – | – | – |

Per-check pass rates:

| model | count | time | 1st≤15m | 1st today | dates | spread | in order | no-vague | title | prereq | no-redund. |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `cliproxy/claude-sonnet-4-6` | 79% | 62% | 76% | 98% | 100% | 95% | 100% | 98% | 100% | 100% | 100% |
| `cliproxy/gemini-3-flash` | 98% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 98% | 100% |
| `cliproxy/gemini-3.1-flash-lite` | 95% | 100% | 98% | 100% | 100% | 98% | 100% | 100% | 100% | 98% | 100% |
| `cliproxy/gemini-3.5-flash-lite` | 93% | 98% | 98% | 100% | 100% | 95% | 100% | 100% | 100% | 100% | 100% |
| `cliproxy/gemini-3.8-flash-high` | 98% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| `cliproxy/gpt-oss-120b-medium` | – | – | – | – | – | – | – | – | – | – | – |

## Clarify phase (first streamed turn)

`skip` = jumped straight to a plan on turn 1. `bad skip` = skipped on a case where a good coach must ask (vague asks). `over-ask` = asked on a case that already had enough context. `appropriate` counts `either` cases as always appropriate. Question quality is judge-scored (1–5) on asked turns only. `compound q.` = share of questions that bundle two asks ("X, and what Y?") despite the one-question rule.

| model | runs | err | asked | skip rate | bad skip | over-ask | appropriate | compound q. | q. quality | med. words | med. TTFT | med. latency |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `cliproxy/claude-sonnet-4-6` | 0 (+63 infra) | – | 0 | – | 0/0 | 0/0 | – | – | – | – | –s | –s |
| `cliproxy/gemini-3-flash` | 63 | 0% | 16 | 75% | 4/12 | 0/15 | 94% | 0% | 4.62 | 14 | 2.5s | 2.9s |
| `cliproxy/gemini-3.1-flash-lite` | 63 | 0% | 20 | 68% | 3/12 | 3/15 | 90% | 0% | 4.90 | 15 | 2.4s | 2.7s |
| `cliproxy/gemini-3.5-flash-lite` | 63 | 0% | 18 | 71% | 3/12 | 2/15 | 92% | 0% | 4.56 | 14 | 2.4s | 2.7s |
| `cliproxy/gemini-3.8-flash-high` | 63 | 0% | 32 | 49% | 0/12 | 3/15 | 95% | 0% | 4.91 | 13 | 6.7s | 7.4s |
| `cliproxy/gpt-oss-120b-medium` | 0 (+63 infra) | – | 0 | – | 0/0 | 0/0 | – | – | – | – | –s | –s |

### Clarify decisions by case

`A` = asked, `S` = skipped to plan, `E` = error (one letter per sample).

| case | expect | `claude-sonnet-4-6` | `gemini-3-flash` | `gemini-3.1-flash-lite` | `gemini-3.5-flash-lite` | `gemini-3.8-flash-high` | `gpt-oss-120b-medium` |
|---|---|---|---|---|---|---|---|
| cold-war-essay-vague | ask | – | AAS | SAS | SSA | AAA | – |
| cold-war-essay-answered | ready | – | SSS | SSS | SSS | SSS | – |
| comp2521-graph-assignment | ask | – | SSS | ASA | AAS | AAA | – |
| comp1531-group-iteration | either | – | SSS | SSS | SSS | SSS | – |
| chem-lab-report-tomorrow | either | – | SSS | SSS | SSS | SSS | – |
| math1231-exam-revision | either | – | SSA | SSS | ASS | AAA | – |
| comp3311-sql-tomorrow | either | – | SSS | SSS | SSS | SSS | – |
| atlassian-internship-application | either | – | SSS | SSS | SAS | AAA | – |
| clean-room-today | ready | – | SSS | SSS | SSS | SSS | – |
| avoided-supervisor-email | either | – | SSS | SSS | SSS | SSS | – |
| life-together-vague | ask | – | AAA | AAA | AAA | AAA | – |
| help-me-study | ask | – | AAA | AAA | AAA | AAA | – |
| comp6080-exam-tomorrow | either | – | SSS | SSS | SSS | SSS | – |
| honours-lit-review | either | – | SSS | SSS | SSS | SSS | – |
| comp2511-design-patterns-ledger | ready | – | SSS | AAA | AAS | AAA | – |
| mgmt-group-presentation | either | – | SAA | SAA | ASS | AAA | – |
| centrelink-reporting | ready | – | SSS | SSS | SSS | SSS | – |
| psyc-reading-adhd-profile | either | – | SSS | SSS | SSS | AAS | – |
| portfolio-website-3wk | either | – | AAS | AAA | SSA | AAA | – |
| comp1511-spec-avoidance | either | – | AAA | AAA | AAA | AAA | – |
| comp3121-problem-set-tonight | ready | – | SSS | SSS | SSS | SSS | – |

### Errors

- `cliproxy/gpt-oss-120b-medium`: execute:response_format_rejected ×42

## Computed ranking

Execution composite = 0.6·(judge mean−1)/4 + 0.4·hard-pass rate − error rate. Clarify composite = 0.5·appropriate rate + 0.5·(question quality−1)/4 − error rate.

| rank | execution | score | clarify | score |
|---|---|---|---|---|
| 1 | `cliproxy/gemini-3.8-flash-high` | 0.953 | `cliproxy/gemini-3.8-flash-high` | 0.964 |
| 2 | `cliproxy/gemini-3.1-flash-lite` | 0.926 | `cliproxy/gemini-3.1-flash-lite` | 0.940 |
| 3 | `cliproxy/gemini-3-flash` | 0.914 | `cliproxy/gemini-3-flash` | 0.921 |
| 4 | `cliproxy/gemini-3.5-flash-lite` | 0.902 | `cliproxy/gemini-3.5-flash-lite` | 0.905 |
| 5 | `cliproxy/claude-sonnet-4-6` | 0.694 | `cliproxy/claude-sonnet-4-6` | – |
| 6 | `cliproxy/gpt-oss-120b-medium` | – | `cliproxy/gpt-oss-120b-medium` | – |

## Judge agreement

Same execute outputs graded by another judge (diff = primary − other; positive means the primary judge is more generous).

`cliproxy/gemini-3.8-flash-high` vs `cliproxy_claude-opus-4-6-thinking` on 64 plans:

| dimension | mean diff | mean abs diff | within ±1 |
|---|---|---|---|
| specificity | +0.72 | 0.84 | 83% |
| first_step | +0.72 | 0.88 | 75% |
| ordering | +0.33 | 0.55 | 97% |
| fit | +1.03 | 1.19 | 59% |
| tone | +1.06 | 1.06 | 77% |

- `cliproxy/gemini-3-flash` (n=42): primary mean 4.55 vs other 3.80
- `cliproxy/gemini-3.5-flash-lite` (n=22): primary mean 4.65 vs other 3.84

> **Status (2026-10-15):** suggestions 1–9 below were applied to `engine/main.py`, plus a "when you must ask" rule after the first re-run showed the no-ask rules made flash models skip vague cases. `REPORT.baseline.md` is the pre-change run; the tables above are post-change. Defaults set to `gemini-3.8-flash-high` for both chat and plan (`src/common/models.ts`).

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

**cold-war-essay-vague** — judge mean 3.6; failed: prerequisites_valid (prereq[0] kind=None)
> Judge: The initial prerequisite demands finding 5 academic sources in 15 minutes for an undecided subtopic, creating an intimidating and unrealistic roadblock right at the start.

  - originalTask: 'Write a 2000-word essay on the Cold War'
  - [prereq/None] Gather 3 primary sources and 2 secondary sources on the chosen Cold War subtopic
  - Open a blank document, set standard MLA/APA formatting, and write a 5-bullet point outline — 10 min, 2026-10-15
  - Draft the introductory paragraph including the thesis statement — 30 min, 2026-10-17
  - Write Body Paragraphs 1-4 covering the origins and early escalation (approx. 800 words) — 60 min, 2026-10-19
  - Write Body Paragraphs 5-8 covering proxy conflicts and détente (approx. 800 words) — 60 min, 2026-10-21
  - Write the conclusion and finalize citations (approx. 400 words) — 45 min, 2026-10-23
  - Perform final proofread, check word count, and export the document — 20 min, 2026-10-24

**cold-war-essay-answered** — judge mean 3.6
> Judge: Setting the prerequisite as locating 8 scholarly sources creates an intimidating initial hurdle that completely undermines low-friction starting.

  - originalTask: 'Write a 2000-word Cold War essay for HIST1010'
  - [prereq/acquire] Locate 8 scholarly sources via library database
  - Open a blank document, save as 'HIST1010_Essay', and type the thesis statement placeholder — 5 min, 2026-10-15
  - Write a 3-sentence roadmap/intro focusing only on the inevitability question, ignoring perfection — 30 min, 2026-10-17
  - Draft the body paragraphs integrating evidence from the 8 scholarly sources with Chicago footnotes — 60 min, 2026-10-20
  - Draft the conclusion summarizing the argument and check word count progress — 30 min, 2026-10-22
  - Review against marking criteria (argument, evidence, writing) and format Chicago footnotes — 45 min, 2026-10-24

Bad clarify skips: cold-war-essay-vague, comp2521-graph-assignment

Weakest question (cold-war-essay-vague, 3/5): “What is your specific thesis or main argument for the essay?” — While narrowing the broad topic is important, asking a procrastinating student for their specific thesis right away creates high cognitive friction if they haven't even chosen a prompt or started researching yet.

### `cliproxy/gemini-3.1-flash-lite`

**help-me-study** — judge mean 4.0
> Judge: Several subtasks are estimated at 15 to 20 minutes, deviating from the Deep depth setting's requirement of micro 5-10 minute steps.

  - originalTask: 'Study for upcoming exams and review course material'
  - [prereq/acquire] Gather all syllabi, textbooks, and notes into one stack
  - Open your primary study tracker or notebook and write down the top 3 priority topics — 5 min, 2026-10-15
  - Review the table of contents for Subject 1 and highlight confusing sections — 15 min, 2026-10-15
  - Read pages 1 through 10 of the Subject 1 core chapter, taking no notes yet — 20 min, 2026-10-16
  - Write 3 flashcards summarizing the main concepts from those pages — 15 min, 2026-10-16
  - Review Subject 2 syllabus and identify the single hardest upcoming concept — 10 min, 2026-10-17
  - Watch one 15-minute lecture or summary video on that hardest concept — 15 min, 2026-10-17
  - … (+6 more)

**help-me-study** — judge mean 4.0
> Judge: Because the user provided no course context, the plan relies on generic 'Topic 1/2/3' placeholders and would benefit from prompting the student on what specific exam they are facing.

  - originalTask: 'Study for upcoming exams'
  - [prereq/acquire] Gather all syllabus documents, notes, and textbook chapters into one folder
  - Open your study materials and write down a list of the top 3 core topics you need to master — 5 min, 2026-10-15
  - Read through Topic 1 summary notes once without taking notes, just absorbing concepts — 15 min, 2026-10-15
  - Create 5 flashcards or quick-reference bullet points for the hardest formulas or definitions in Topic 1 — 15 min, 2026-10-16
  - Complete 2 practice problems or review questions for Topic 1 without looking at the answer key — 15 min, 2026-10-16
  - Review Topic 2 notes, highlighting key terms and potential exam questions — 15 min, 2026-10-17
  - Write a 3-sentence summary of Topic 2 in your own words to test your comprehension — 10 min, 2026-10-17
  - … (+5 more)

Bad clarify skips: cold-war-essay-vague, comp2521-graph-assignment

Weakest question (comp2521-graph-assignment, 4/5): “What are the core functional requirements or algorithms you need to implement for this route planner?” — A solid scoping question that directly targets the technical requirements needed for a detailed plan, though asking a procrastinating student to outline core algorithms might require them to dig through a spec they haven't read yet.

### `cliproxy/gemini-3.5-flash-lite`

**comp1511-spec-avoidance** — judge mean 3.0
> Judge: The plan ignores that starter code is already present and defers all autotesting until the end, rather than guiding the beginner through incrementally writing and testing Stage 1 using `1511 autotest`.

  - originalTask: 'Complete COMP1511 Assignment 1 (CS Bricks)'
  - Open VS Code, connect to CSE via SSH, and open your `cs_bricks.c` file — 5 min, 2026-10-15
  - Write a basic main function that just prints 'Hello CS Bricks' and compile it using `dcc -o cs_bricks cs_bricks.c` — 10 min, 2026-10-15
  - List out the stages of the assignment from the spec on a piece of paper (Stage 1: simple grid, Stage 2: movement, etc.) — 10 min, 2026-10-16
  - Write the struct definitions needed for the game board and bricks, referencing the spec data structures — 15 min, 2026-10-16
  - Draft the initialization function to set up the starting grid and print it to the terminal — 20 min, 2026-10-17
  - Compile and run your initialization function, fixing any immediate compiler warnings — 10 min, 2026-10-17
  - … (+8 more)

**life-together-vague** — judge mean 3.6
> Judge: The schedule crunches all five tasks into the first five days without pacing or utilizing the month-long timeframe up to the deadline.

  - originalTask: 'Get life together for university this term'
  - [prereq/acquire] Gather all syllabus documents and login passwords
  - Open your university portal and download this week's schedule — 5 min, 2026-10-15
  - Create a master to-do list categorizing all current assignments by deadline — 30 min, 2026-10-16
  - Clear and organize your physical study desk to remove distractions — 20 min, 2026-10-17
  - Complete the single highest-priority pending reading assignment — 45 min, 2026-10-18
  - Draft a weekly routine incorporating dedicated study and rest blocks — 30 min, 2026-10-19

Bad clarify skips: cold-war-essay-vague, comp2521-graph-assignment

Weakest question (atlassian-internship-application, 3/5): “What specific projects or experiences do you plan to highlight on your resume to match the role?” — While relevant to tailoring, asking the student to list specific projects requires high cognitive effort upfront instead of first establishing their starting point (e.g., whether they already have an existing general resume ready to update).

### `cliproxy/gemini-3.8-flash-high`

**comp3311-sql-tomorrow** — judge mean 4.0
> Judge: The PL/pgSQL syntax review prerequisite is placed at the very start of the workflow instead of right before the function questions (Q8-Q10), creating unnecessary upfront friction when the user only needs to write SQL views first.

  - originalTask: 'Complete and submit COMP3311 Assignment 1 (Q4 to Q10)'
  - [prereq/learn] Review PL/pgSQL function syntax and return type boilerplate
  - Open ass1.sql in your editor and read the Q4 prompt — 5 min, 2026-10-15
  - Draft and test the SQL view for Q4 against the database — 15 min, 2026-10-15
  - Draft and test the SQL view for Q5 — 15 min, 2026-10-15
  - Read Q6 prompt and write the core SELECT query — 15 min, 2026-10-15
  - Verify Q6 output against expected results and wrap in view — 10 min, 2026-10-15
  - Draft and test the SQL query and view for Q7 — 15 min, 2026-10-15
  - … (+7 more)

**centrelink-reporting** — judge mean 4.2
> Judge: Entering reporting numbers on day one but scheduling the summary review and submission for the next day fails to account for myGov session timeouts.

  - originalTask: 'Report fortnightly income and upload payslips for Centrelink Youth Allowance'
  - [prereq/acquire] Download digital copies of your last two payslips from your payroll portal or email
  - [prereq/setup] Ensure your myGov login details and two-factor authentication device are ready
  - Log in to myGov and open the linked Centrelink dashboard — 5 min, 2026-10-15
  - Note down gross income and hours worked from the two payslips for the reporting window — 10 min, 2026-10-15
  - Select 'Report income' and enter your hours and gross earnings for the fortnight — 15 min, 2026-10-15
  - Navigate to 'Upload documents' in Centrelink and attach the two payslip files — 10 min, 2026-10-16
  - Review summary screen, submit reporting, and save or screenshot the receipt number — 5 min, 2026-10-16

Weakest question (math1231-exam-revision, 4/5): “What specific target grade or outcome are you aiming for on this exam?” — Asking for the target grade is a solid, focused question that clarifies scope, though asking about available study materials or current study habits might have been slightly more actionable for building immediate 5-10 minute steps.

### `cliproxy/gpt-oss-120b-medium`

Error `response_format_rejected` on cold-war-essay-vague (execute): `Something went wrong on my end (litellm.BadRequestError: OpenAIException - Expected input to contain field: 'json_schema'.). Could you try that again?`

Error `response_format_rejected` on cold-war-essay-vague (execute): `Something went wrong on my end (litellm.BadRequestError: OpenAIException - Expected input to contain field: 'json_schema'.). Could you try that again?`

