# engine/evals/judge.py
# LLM-as-judge rubrics. The judge sees the case context (task, depth,
# deadline, ledger, profile, run date) plus the engine output, and returns a
# JSON rubric. Parsing is tolerant: fenced JSON, prose around the object, and
# bare integer scores are all accepted.

import json
import time
import urllib.error

from common import chat_completion, parse_json_loose

PLAN_DIMENSIONS = ["specificity", "first_step", "ordering", "fit", "tone"]
# Asked for alongside PLAN_DIMENSIONS but kept out of the judge mean so means
# stay comparable with verdicts cached before it existed; reported separately.
COVERAGE_DIMENSION = "coverage"
PLAN_JUDGE_DIMENSIONS = PLAN_DIMENSIONS + [COVERAGE_DIMENSION]
CLARIFY_DIMENSIONS = ["question_quality"]
MULTITURN_DIMENSIONS = ["no_repeat", "stop_timing", "plan_uses_answers"]
ADJUST_DIMENSIONS = ["faithfulness"]

_PLAN_RUBRIC = """You are grading an AI productivity coach's output for a university student (UNSW) who procrastinates.
The app's thesis: procrastination is an avoidance problem, so the plan must make STARTING feel easy - tiny, concrete, low-friction steps.

Score each dimension from 1 (bad) to 5 (excellent) with a one-sentence rationale:
- specificity: Are steps concrete actions with a clear object and done-condition (e.g. "Write 3 bullet points for the intro"), not vague verbs ("Study", "Research", "Work on essay")? Do they use details from the task/context?
- first_step: Is the FIRST subtask (or first prerequisite if that is what the user would do first) a genuinely <10-minute, low-friction starter the user could begin right now without deciding anything hard? 5 = trivially startable, 1 = a big intimidating chunk.
- ordering: Is the sequence logical (setup -> core work -> review/submit), dependencies respected, and are scheduledDates sensibly spread across the available days (not all crammed on the deadline, nothing after the deadline)?
- fit: Does the plan match THIS task and context - the stated course/assignment, depth setting, deadline length, things already done in the ledger (must not be redone), and the user profile's friction patterns/preferences? Penalise generic boilerplate and redundant already-done work.
- tone: Are titles warm, encouraging and non-judgmental, appropriate to the user profile, with no guilt-tripping or corporate fluff?
- coverage: If the student did every step (prerequisites + subtasks) and nothing else, would the task be done to a passing standard? Add up the timeEstimates and compare them with how long this work realistically takes a typical student. Penalise plans that silently omit essential work (reading the sources/papers, implementing or testing remaining parts, drafting the remaining words, revision/proofreading, submitting) or that cover only the first slice of a large task without saying so. Tiny steps are fine - but together they must add up to the whole job. 5 = completing the list finishes the task; 3 = most essential work present but clearly under-scoped; 1 = the list is a small fraction of the work.

Be strict and calibrated: reserve 5 for plans you could not meaningfully improve; 3 is "usable but generic".

Return ONLY a JSON object:
{"specificity": {"score": 1-5, "rationale": "..."}, "first_step": {...}, "ordering": {...}, "fit": {...}, "tone": {...}, "coverage": {...}, "worst_issue": "one sentence naming the single biggest problem"}
"""

_CLARIFY_RUBRIC = """You are grading the FIRST clarifying question an AI productivity coach asked a university student (UNSW) who procrastinates, before it builds a task checklist.
A great question targets the single most important missing piece of information for building a specific plan (marking criteria, scope, tools, what's already done, or what's making it hard to start), is ONE question (not a list), is short, warm and easy to answer, and does not ask for things already given in the message, ledger or profile.

Score from 1 (bad) to 5 (excellent).
Return ONLY a JSON object: {"question_quality": {"score": 1-5, "rationale": "one sentence"}}
"""


_MULTITURN_RUBRIC = """You are grading a full intake conversation between an AI productivity coach and a university student (UNSW) who procrastinates, plus the checklist the coach built at the end. The student's replies were FIXED in advance (scripted), so do not penalise the coach for a reply that doesn't quite answer its question - judge what the coach did with what it was told.
Rules the coach is meant to follow: ask at most ONE short question per turn; ask only when the answer would materially change the plan; never ask for anything already stated (in the conversation, the project ledger or the user profile); stop and build the plan once it has enough (a simple chore, or a deadline of today/tomorrow, needs no questions); be warm and never guilt-trip.

Score each dimension from 1 (bad) to 5 (excellent) with a one-sentence rationale:
- no_repeat: Did the coach avoid repeating a question and avoid asking for information the student had already given (anywhere: earlier messages, ledger, profile)? 5 = every question asked for something genuinely new; 1 = it re-asked something clearly stated.
- stop_timing: Did the coach stop asking at the right time - not building a generic plan while a crucial piece was missing, and not interrogating the student once it had enough (or once the student signalled they had nothing more to add)? 5 = ideal number of questions for this case.
- plan_uses_answers: Does the final checklist visibly use the specific things the student said (requirements, constraints, finished work, friction points, preferences) rather than being a generic plan that ignores the conversation? Penalise steps that redo work the student said was done or that contradict a stated constraint.

Return ONLY a JSON object:
{"no_repeat": {"score": 1-5, "rationale": "..."}, "stop_timing": {...}, "plan_uses_answers": {...}, "worst_issue": "one sentence naming the single biggest problem"}
"""

_ADJUST_RUBRIC = """You are grading how an AI productivity coach adjusted a university student's EXISTING checklist after one request. In the ORIGINAL checklist, items with "status": "done" are finished work and must come back unchanged (same id and title; the reply format has no status field, so a missing status in the reply is NOT a change), unless the student explicitly asked to remove finished work. Prerequisites must be kept unless the request is about them. Kept steps should keep their ids; new steps get new ids. The coach also returns a one-line summary message.

Score from 1 (bad) to 5 (excellent) with a one-sentence rationale:
- faithfulness: Did the coach do exactly what was asked - fully - and nothing else? Penalise (a) not doing the request or doing it only partly (e.g. "shorter" but the same number of remaining steps; dates not actually moved; the step to expand left as one big step), (b) unrequested changes (dropping, rewording, re-dating or reordering steps the request didn't touch; touching done items; dropping prerequisites), and (c) a summary message that misdescribes what changed. 5 = precisely the requested change; 3 = request mostly done but with notable collateral changes or gaps; 1 = request ignored or the plan was rewritten wholesale.

Return ONLY a JSON object: {"faithfulness": {"score": 1-5, "rationale": "one sentence"}, "worst_issue": "one sentence naming the single biggest problem (or 'none')"}
"""


def _context_block(record, case):
    p = record["payload"]
    convo = "\n".join(f"{'User' if m['role'] == 'user' else 'Coach'}: {m['content']}" for m in case["messages"])
    parts = [
        f"TODAY: {record.get('run_date')}",
        f"DEADLINE: {p['deadline']}",
        f"DEPTH: {p['depth']} (Deep = detailed 5-10 min steps, >=10 of them; Brief = ~5 high-level milestones)",
        f"CONVERSATION:\n{convo}",
    ]
    if case.get("context_ledger"):
        parts.append(f"PROJECT CONTEXT LEDGER:\n{case['context_ledger']}")
    if case.get("user_profile"):
        parts.append(f"USER PROFILE:\n{case['user_profile']}")
    return "\n\n".join(parts)


def _coerce_scores(parsed, dims):
    out = {}
    for d in dims:
        v = parsed.get(d)
        score, rationale = None, ""
        if isinstance(v, dict):
            score, rationale = v.get("score"), v.get("rationale", "")
        elif isinstance(v, (int, float, str)):
            score = v
        try:
            score = int(round(float(score)))
        except (TypeError, ValueError):
            score = None
        if score is not None:
            score = max(1, min(5, score))
        out[d] = {"score": score, "rationale": str(rationale)[:400]}
    return out


def judge_plan(judge_model, record, case):
    data = (record.get("result") or {}).get("data")
    user = _context_block(record, case) + "\n\nPLAN TO GRADE (JSON):\n" + json.dumps(data, indent=1)
    return _ask(judge_model, _PLAN_RUBRIC, user, PLAN_JUDGE_DIMENSIONS, extra_keys=("worst_issue",))


def judge_question(judge_model, record, case):
    question = (record.get("result") or {}).get("message", "")
    user = _context_block(record, case) + f"\n\nCOACH'S QUESTION TO GRADE:\n{question}"
    return _ask(judge_model, _CLARIFY_RUBRIC, user, CLARIFY_DIMENSIONS)


def judge_multiturn(judge_model, record, case):
    from multiturn import transcript
    p = record["payload"]
    parts = [
        f"TODAY: {record.get('run_date')}",
        f"DEADLINE: {p['deadline']}",
        f"DEPTH: {p['depth']} (Deep = detailed 5-10 min steps, >=10 of them; Brief = ~5 high-level milestones)",
    ]
    if case.get("context_ledger"):
        parts.append(f"PROJECT CONTEXT LEDGER (known before the conversation):\n{case['context_ledger']}")
    if case.get("user_profile"):
        parts.append(f"USER PROFILE:\n{case['user_profile']}")
    parts.append(f"CONVERSATION ({len(record.get('questions') or [])} coach question(s)):\n{transcript(record)}")
    data = (record.get("result") or {}).get("data")
    parts.append("FINAL CHECKLIST (JSON):\n" + json.dumps(data, indent=1))
    return _ask(judge_model, _MULTITURN_RUBRIC, "\n\n".join(parts), MULTITURN_DIMENSIONS, extra_keys=("worst_issue",))


def judge_adjust(judge_model, record, case):
    from adjust import checklist_view
    p = record["payload"]
    result = record.get("result") or {}
    user = "\n\n".join([
        f"TODAY: {record.get('run_date')}",
        f"DEADLINE: {p['deadline']}",
        f"ORIGINAL CHECKLIST:\n{checklist_view(p['currentChecklist'])}",
        f"STUDENT'S REQUEST: {p['messages'][-1]['content']}",
        f"COACH'S SUMMARY MESSAGE: {result.get('message')}",
        f"ADJUSTED CHECKLIST RETURNED BY THE COACH (its format has no status field; the app keeps finished items finished by matching id + title):\n{checklist_view(result.get('data'), with_status=False)}",
    ])
    return _ask(judge_model, _ADJUST_RUBRIC, user, ADJUST_DIMENSIONS, extra_keys=("worst_issue",))


def _ask(judge_model, system, user, dims, extra_keys=()):
    last_err = None
    for attempt in range(4):
        if attempt:
            time.sleep(10 * attempt)  # back off; the proxy 429s under load
        try:
            text = chat_completion(judge_model, [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ])
            parsed = parse_json_loose(text)
            scores = _coerce_scores(parsed, dims)
            if any(s["score"] is None for s in scores.values()):
                raise ValueError(f"missing score(s) in judge reply: {text[:200]}")
            out = {"scores": scores, "judge_error": None}
            for k in extra_keys:
                out[k] = str(parsed.get(k, ""))[:400]
            return out
        except Exception as e:  # network, parse, missing fields - retry
            last_err = f"{type(e).__name__}: {e}"
            if isinstance(e, urllib.error.HTTPError) and e.code == 429 and attempt >= 1:
                break  # quota exhausted, not a blip: stop; a plain rerun retries uncached verdicts
    return {"scores": None, "judge_error": last_err}
