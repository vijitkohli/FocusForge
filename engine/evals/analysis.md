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
