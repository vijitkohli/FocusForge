# engine/evals/multiturn.py
# Multi-turn intake eval. The harness plays the student with FIXED scripted
# replies from multiturn_cases.json (no model plays the user, so runs are
# comparable): it sends the opening message through the real streaming engine,
# and every time the coach asks a question it appends the question plus the
# next scripted reply and calls the engine again, until it returns a plan.
# Like the app (src/main/index.ts 'chat-turn'), the trailing {"type":"notes"}
# facts are appended to the ledger/profile the NEXT turn sees.
#
# Deterministic checks (all {"pass", "detail"}):
#   plan_built           the conversation ended in a plan (not an error / endless asking)
#   turns_in_bounds      number of questions within the case's [min, max]
#   no_repeat            no two questions are near-duplicates
#   no_already_answered  no question matches a fact's `ask` regex after the student gave it
#   notes_recall         every expected fact (from replies actually sent) was extracted
#   user_notes_clean     no task-specific detail leaked into the global user profile
#   no_ledger_renotes    nothing already in the ledger was recorded again
#   plan_mentions        each expected keyword group appears in some step title
#   plan_forbidden       no step redoes finished work / violates a stated constraint
#   plan_max_minutes     steps respect a stated per-step limit (when the case has one)
#   one_question         (soft) every question is a single question
#   notes_no_dupes       (soft) the extractor didn't record the same fact twice

import os
import re
from datetime import date, timedelta

from common import EVALS_DIR, read_json
from engine_runner import invoke_engine, invocation_error
from scorers import score_plan, similarity

MULTITURN_CASES_PATH = os.path.join(EVALS_DIR, "multiturn_cases.json")
MAX_ENGINE_CALLS = 6  # the engine forces a plan at 5 user turns; 6 catches a broken cap
MT_HARD = ["plan_built", "turns_in_bounds", "no_repeat", "no_already_answered", "notes_recall",
           "user_notes_clean", "no_ledger_renotes", "notes_filed", "plan_mentions", "plan_forbidden", "plan_max_minutes"]
_NOT_DONE_NOTE = re.compile(
    r"\b(not (yet )?(started|begun|done|written)|haven'?t (yet )?(started|begun|done)|hasn'?t (started|begun)|"
    r"yet to|due\b|deadline|needs? to|has to|have to|must|to do|upcoming|will need)\b", re.I)
_DONE_NOTE = re.compile(r"\b(already|done|finished|completed?|did|wrote|written|submitted|collected|made|have the)\b", re.I)
MT_SOFT = ["one_question", "notes_no_dupes"]
LEDGER_TEMPLATE = ("## Constraints & Specifications\n\n## Document Excerpts\n\n"
                   "## Milestones & Completed Work\n\n## Plan Adjustments\n")
PROFILE_TEMPLATE = "## About Me\n\n## Preferences\n\n## Patterns & Friction\n"
_COMPOUND = re.compile(r",?\s+(and|or)\s+(what|how|which|where|when|who|why|do you|are you|is there|have you|did you)\b", re.I)


def load_multiturn_cases(only_ids=None):
    cases = (read_json(MULTITURN_CASES_PATH) or {}).get("cases", [])
    if only_ids:
        cases = [c for c in cases if c["id"] in set(only_ids)]
    return cases


def _check(ok, detail=""):
    return {"pass": bool(ok), "detail": detail}


def append_under_heading(doc, heading, line):
    """Mimics the app's appendUnderHeading: add `line` at the end of `## heading`."""
    lines = doc.rstrip("\n").split("\n") if doc.strip() else []
    try:
        start = lines.index(f"## {heading}")
    except ValueError:
        lines += ["", f"## {heading}", line]
        return "\n".join(lines) + "\n"
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
    insert = end
    while insert > start + 1 and not lines[insert - 1].strip():
        insert -= 1
    lines.insert(insert, line)
    return "\n".join(lines) + "\n"


def run_multiturn(python, case, model, sample=0):
    today = date.today()
    deadline = (today + timedelta(days=int(case.get("deadline_offset_days", 7)))).isoformat()
    ledger = case.get("context_ledger") or ""
    profile = case.get("user_profile") or ""
    messages = [{"role": "user", "content": case["opening"]}]
    replies = list(case.get("replies") or [])
    record = {"case_id": case["id"], "model": model, "mode": "multiturn", "sample": sample,
              "run_date": today.isoformat(), "payload": None, "turns": [], "questions": [],
              "messages": None, "result": None, "error": None, "tokens": 0, "ttft_s": None,
              "latency_s": 0.0, "ledger_final": None, "profile_final": None, "stderr_tail": ""}
    for _call in range(MAX_ENGINE_CALLS):
        payload = {
            "projectId": "eval",
            "messages": [dict(m) for m in messages],
            "deadline": deadline,
            "depth": case.get("depth", "Brief"),
            "model": model,
            "contextLedger": ledger,
            "userProfile": profile,
            "stream": True,
        }
        record["payload"] = payload
        inv = invoke_engine(python, payload)
        err = invocation_error(inv)
        res = inv["result"] or {}
        notes = [n for line in inv["notes_lines"] for n in line["notes"]]
        user_notes = [n for line in inv["notes_lines"] for n in line["userNotes"]]
        record["turns"].append({
            "user": messages[-1]["content"], "status": res.get("status"), "message": res.get("message"),
            "notes": notes, "userNotes": user_notes, "latency_s": inv["latency_s"], "ttft_s": inv["ttft_s"],
            "tokens": inv["tokens"], "error": err,
        })
        record["tokens"] += inv["tokens"]
        record["latency_s"] = round(record["latency_s"] + (inv["latency_s"] or 0), 3)
        if record["ttft_s"] is None and inv["ttft_s"] is not None:
            record["ttft_s"] = inv["ttft_s"]
        record["stderr_tail"] = inv["stderr_tail"]
        for n in notes:
            ledger = append_under_heading(ledger or LEDGER_TEMPLATE, n["section"], f"- [{today.isoformat()}] {n['note']}")
        for n in user_notes:
            profile = append_under_heading(profile or PROFILE_TEMPLATE, n["section"], f"- {n['note']}")
        record["result"] = inv["result"]
        if err:
            record["error"] = err
            break
        if res.get("status") == "complete":
            break
        # clarifying: the coach asked; the scripted student answers.
        question = res.get("message") or ""
        record["questions"].append(question)
        messages.append({"role": "assistant", "content": question})
        messages.append({"role": "user", "content": replies.pop(0) if replies else case.get("fallback_reply", "Just make the plan.")})
    else:
        record["error"] = "no_plan"
    record["messages"] = messages
    record["ledger_final"] = ledger
    record["profile_final"] = profile
    return record


def _groups_match(text, groups):
    # groups is a list of keyword lists; a flat list of strings would silently
    # match single characters, so refuse it.
    if not all(isinstance(g, (list, tuple)) for g in groups):
        raise ValueError(f"keyword groups must be a list of lists, got {groups!r}")
    t = (text or "").lower()
    return all(any(k.lower() in t for k in g) for g in groups)


def _all_notes(record, field):
    return [n for t in record.get("turns") or [] for n in (t.get(field) or [])]


def score_multiturn(record, case):
    result = record.get("result") or {}
    questions = record.get("questions") or []
    n_q = len(questions)
    user_msgs = [m for m in record.get("messages") or [] if m["role"] == "user"]
    last_turn = len(user_msgs) - 1  # index of the last user message actually sent
    checks = {}
    built = result.get("status") == "complete" and not record.get("error")
    checks["plan_built"] = _check(built, f"ended {result.get('status')!r} after {n_q} question(s)" + (f" ({record.get('error')})" if record.get("error") else ""))

    lo, hi = case.get("questions", [0, 4])
    checks["turns_in_bounds"] = _check(lo <= n_q <= hi, f"{n_q} question(s), expected {lo}-{hi}")

    # -- repeats -------------------------------------------------------------
    reps = []
    for i in range(n_q):
        for j in range(i):
            ratio, jac = similarity(questions[i], questions[j])
            if ratio >= 0.75 or jac >= 0.6:
                reps.append(f"Q{j + 1}~Q{i + 1} (ratio {ratio:.2f}, jaccard {jac:.2f})")
    checks["no_repeat"] = _check(not reps, "; ".join(reps[:2]))

    # -- already answered ---------------------------------------------------------
    # Question k (0-based) is asked after user message k.
    hits = []
    for k, q in enumerate(questions):
        for fact in case.get("answered") or []:
            if fact["turn"] <= k and re.search(fact["ask"], q, re.I):
                src = "ledger/profile" if fact["turn"] < 0 else f"message {fact['turn']}"
                hits.append(f"Q{k + 1} re-asks {fact['topic']} (given in {src}): {q[:90]!r}")
    checks["no_already_answered"] = _check(not hits, "; ".join(hits[:2]))

    checks["one_question"] = _check(
        all(q.count("?") <= 1 and not _COMPOUND.search(q) for q in questions),
        "; ".join(repr(q[:80]) for q in questions if q.count("?") > 1 or _COMPOUND.search(q))[:240])

    # -- notes ---------------------------------------------------------------------
    notes, user_notes = _all_notes(record, "notes"), _all_notes(record, "userNotes")
    applicable = [f for f in case.get("expected_notes") or [] if f.get("from_turn", 0) <= last_turn]
    missed = []
    for f in applicable:
        pool = notes if f["field"] == "notes" else user_notes if f["field"] == "userNotes" else notes + user_notes
        if f.get("sections"):
            pool = [n for n in pool if n.get("section") in f["sections"]]
        if not any(_groups_match(n.get("note"), f["groups"]) for n in pool):
            missed.append(f"{f['field']}:{'+'.join('/'.join(g) for g in f['groups'])}")
    checks["notes_recall"] = _check(not missed, f"{len(applicable) - len(missed)}/{len(applicable)} expected facts" + (f"; missed {missed[:3]}" if missed else ""))
    record_recall = (len(applicable) - len(missed), len(applicable))

    leaked = [n["note"] for n in user_notes
              if any(w.lower() in (n.get("note") or "").lower() for w in case.get("forbidden_user_notes") or [])]
    checks["user_notes_clean"] = _check(not leaked, f"task details in userNotes: {leaked[:2]}" if leaked else "")

    renoted = [n["note"] for n in notes
               if any(_groups_match(n.get("note"), groups) for groups in case.get("forbidden_notes") or [])]
    checks["no_ledger_renotes"] = _check(not renoted, f"re-recorded ledger facts: {renoted[:2]}" if renoted else "")

    # Facts about unstarted / upcoming work must not land under completed work
    # (e.g. "Has an essay due, not started" filed as a milestone).
    misfiled = [n["note"] for n in notes if n.get("section") == "Milestones & Completed Work"
                and _NOT_DONE_NOTE.search(n.get("note") or "")
                and not _DONE_NOTE.search(_NOT_DONE_NOTE.sub(" ", n.get("note") or ""))]
    checks["notes_filed"] = _check(not misfiled, f"unstarted work filed as completed: {misfiled[:2]}" if misfiled else "")

    dupes = []
    all_n = [(n.get("section"), n.get("note") or "") for n in notes + user_notes]
    for i in range(len(all_n)):
        for j in range(i):
            ratio, jac = similarity(all_n[i][1], all_n[j][1])
            if ratio >= 0.8 or jac >= 0.7:
                dupes.append(all_n[i][1][:60])
                break
    checks["notes_no_dupes"] = _check(not dupes, f"{len(dupes)} duplicate note(s): {dupes[:2]}" if dupes else "")

    # -- plan ------------------------------------------------------------------------
    data = result.get("data") if built and isinstance(result.get("data"), dict) else {}
    items = [x for k in ("subtasks", "prerequisites") for x in (data.get(k) or []) if isinstance(x, dict)]
    titles = [x.get("title") or "" for x in items]
    if built:
        mentions = [m for m in case.get("plan_mentions") or [] if m.get("from_turn", 0) <= last_turn]
        absent = ["/".join(m["groups"][0]) if len(m["groups"]) == 1 else str(m["groups"])
                  for m in mentions if not any(_groups_match(t, m["groups"]) for t in titles)]
        checks["plan_mentions"] = _check(not absent, f"{len(mentions) - len(absent)}/{len(mentions)} groups" + (f"; missing {absent}" if absent else ""))
        bad = []
        for rule in case.get("plan_forbidden") or []:
            rx, ft = (rule, 0) if isinstance(rule, str) else (rule["regex"], rule.get("from_turn", 0))
            if ft <= last_turn:
                bad += [t for t in titles if re.search(rx, t, re.I)]
        checks["plan_forbidden"] = _check(not bad, f"forbidden step(s): {bad[:2]}" if bad else "")
        cap = case.get("plan_max_minutes")
        if cap and cap.get("from_turn", 0) <= last_turn:
            over = [(s.get("title"), s.get("timeEstimate")) for s in data.get("subtasks") or []
                    if isinstance(s, dict) and not (isinstance(s.get("timeEstimate"), int) and s["timeEstimate"] <= cap["max"])]
            checks["plan_max_minutes"] = _check(not over, f"{len(over)} step(s) over {cap['max']} min" + (f" e.g. {over[:2]}" if over else ""))
        else:
            checks["plan_max_minutes"] = _check(True, "n/a")
        plan_score = score_plan(record, case)
    else:
        for k in ("plan_mentions", "plan_forbidden", "plan_max_minutes"):
            checks[k] = _check(False, "no plan")
        plan_score = None

    hard_pass = all(checks[k]["pass"] for k in MT_HARD)
    return {
        "checks": checks,
        "hard_pass": hard_pass,
        "all_pass": hard_pass and all(checks[k]["pass"] for k in MT_SOFT),
        "questions": n_q,
        "notes_hits": record_recall[0],
        "notes_expected": record_recall[1],
        "plan_hard": plan_score["hard_pass"] if plan_score else None,
        "subtasks": plan_score["subtask_count"] if plan_score else None,
    }


def transcript(record):
    return "\n".join(f"{'Student' if m['role'] == 'user' else 'Coach'}: {m['content']}" for m in record.get("messages") or [])
