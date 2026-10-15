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
CLARIFY_DIMENSIONS = ["question_quality"]

_PLAN_RUBRIC = """You are grading an AI productivity coach's output for a university student (UNSW) who procrastinates.
The app's thesis: procrastination is an avoidance problem, so the plan must make STARTING feel easy - tiny, concrete, low-friction steps.

Score each dimension from 1 (bad) to 5 (excellent) with a one-sentence rationale:
- specificity: Are steps concrete actions with a clear object and done-condition (e.g. "Write 3 bullet points for the intro"), not vague verbs ("Study", "Research", "Work on essay")? Do they use details from the task/context?
- first_step: Is the FIRST subtask (or first prerequisite if that is what the user would do first) a genuinely <10-minute, low-friction starter the user could begin right now without deciding anything hard? 5 = trivially startable, 1 = a big intimidating chunk.
- ordering: Is the sequence logical (setup -> core work -> review/submit), dependencies respected, and are scheduledDates sensibly spread across the available days (not all crammed on the deadline, nothing after the deadline)?
- fit: Does the plan match THIS task and context - the stated course/assignment, depth setting, deadline length, things already done in the ledger (must not be redone), and the user profile's friction patterns/preferences? Penalise generic boilerplate and redundant already-done work.
- tone: Are titles warm, encouraging and non-judgmental, appropriate to the user profile, with no guilt-tripping or corporate fluff?

Be strict and calibrated: reserve 5 for plans you could not meaningfully improve; 3 is "usable but generic".

Return ONLY a JSON object:
{"specificity": {"score": 1-5, "rationale": "..."}, "first_step": {...}, "ordering": {...}, "fit": {...}, "tone": {...}, "worst_issue": "one sentence naming the single biggest problem"}
"""

_CLARIFY_RUBRIC = """You are grading the FIRST clarifying question an AI productivity coach asked a university student (UNSW) who procrastinates, before it builds a task checklist.
A great question targets the single most important missing piece of information for building a specific plan (marking criteria, scope, tools, what's already done, or what's making it hard to start), is ONE question (not a list), is short, warm and easy to answer, and does not ask for things already given in the message, ledger or profile.

Score from 1 (bad) to 5 (excellent).
Return ONLY a JSON object: {"question_quality": {"score": 1-5, "rationale": "one sentence"}}
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
    return _ask(judge_model, _PLAN_RUBRIC, user, PLAN_DIMENSIONS, extra_keys=("worst_issue",))


def judge_question(judge_model, record, case):
    question = (record.get("result") or {}).get("message", "")
    user = _context_block(record, case) + f"\n\nCOACH'S QUESTION TO GRADE:\n{question}"
    return _ask(judge_model, _CLARIFY_RUBRIC, user, CLARIFY_DIMENSIONS)


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
