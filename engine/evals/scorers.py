# engine/evals/scorers.py
# Deterministic checks on an execution-phase plan. Each check returns
# {"pass": bool, "detail": str}; score_plan() bundles them. "today" is the
# date the call was made (stored in the raw record), not the date scoring runs,
# so cached results score the same on any day.

import re
from datetime import date, timedelta
from difflib import SequenceMatcher

DEEP_MIN_SUBTASKS = 10
BRIEF_MIN_SUBTASKS = 5
BRIEF_MAX_SUBTASKS = 8
# Deep = "5-10 min increments" in the prompt; allow slack up to 30.
DEEP_MAX_MINUTES = 30
# Brief = "high-level milestones", but the product thesis is still "small
# enough to start without dread" - a milestone over an hour is a wall.
BRIEF_MAX_MINUTES = 60
# The very first step is the anti-procrastination lever; it should be tiny.
FIRST_STEP_MAX_MINUTES = 15
VALID_DIFFICULTY = {"easy", "medium", "hard"}
VALID_KINDS = {"learn", "acquire", "setup"}

_VAGUE_LEADS = (
    "study", "work on", "research", "look at", "look into", "go over", "think about",
    "revise", "review", "practice", "practise", "prepare", "continue", "finish", "do", "complete",
    "learn", "brainstorm", "plan",
)
_BAD_TASK_TITLES = {"build the final checklist now", "apply the adjustment now", "build the checklist", ""}
_STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "with", "my", "your", "it",
    "its", "into", "from", "up", "all", "each", "any", "via", "by", "at", "is", "be",
}


def _parse_date(s):
    try:
        return date.fromisoformat(str(s))
    except (TypeError, ValueError):
        return None


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _check(ok, detail=""):
    return {"pass": bool(ok), "detail": detail}


def is_vague_title(title):
    """
    Flags a vague verb used *on its own*: 'Study', 'Research topic',
    'Work on essay'. A vague lead verb followed by a concrete object of 4+
    words ('Review lecture 7 slides on eigenvalues') is allowed. 'work on'
    is flagged anywhere since it never names an action.
    """
    t = re.sub(r"[^\w\s'-]", " ", (title or "").lower()).strip()
    words = t.split()
    if not words:
        return True
    if "work on" in t:
        return True
    for lead in _VAGUE_LEADS:
        lead_words = lead.split()
        if words[:len(lead_words)] == lead_words:
            rest = [w for w in words[len(lead_words):] if w not in _STOPWORDS]
            return len(rest) < 3
    return False


def _tokens(s):
    # Underscores stay inside tokens so identifiers like channels_create and
    # channels_list are different words.
    words = re.findall(r"[a-z0-9_]+", (s or "").lower())
    # Crude plural folding: "notifications" ~ "notification", "tests" ~ "test".
    return {w[:-1] if len(w) > 3 and w.endswith("s") and not w.endswith("ss") else w
            for w in words if w not in _STOPWORDS}


# Verbs that say nothing about WHICH work item it is.
_GENERIC_VERBS = {
    "write", "implement", "set", "do", "make", "draw", "finish", "complete", "start", "read",
    "create", "add", "build", "draft", "get", "check", "review", "solve", "collect", "find",
}


def similarity(a, b):
    """(character-level ratio, content-token Jaccard), both 0-1."""
    ratio = SequenceMatcher(None, (a or "").lower(), (b or "").lower()).ratio()
    ta, tb = _tokens(a), _tokens(b)
    jac = len(ta & tb) / len(ta | tb) if ta and tb else 0.0
    return ratio, jac


# Either a near-verbatim restatement or heavy content-word overlap counts as
# redoing ledger work. Tuned so "Export the final UML diagram" does NOT match
# "Draw the initial UML diagram" (different work), but "Implement Observer
# pattern for notifications" does match its done counterpart.
REDUNDANCY_RATIO = 0.75  # with full distinctive-word coverage; >= 0.85 matches on its own


def _numbers(s):
    return set(re.findall(r"\d+", s or ""))


def is_redundant(title, done):
    # "Write Q4 recurrence" vs done "Write the recurrence for Q1": different
    # numbered items are different work even when the words overlap.
    na, nb = _numbers(title), _numbers(done)
    if na and nb and not (na & nb):
        return False, 0.0, 0.0
    ratio, jac = similarity(title, done)
    if ratio >= 0.85:
        return True, ratio, jac
    # Otherwise every distinctive word of the done item must reappear in the
    # step (so "Write tests for channels_list" != done "Write tests for
    # channels_create"), plus enough overall overlap.
    distinctive = _tokens(done) - _GENERIC_VERBS
    # A single generic noun ("spec") is too weak a signal unless it's a
    # numbered item ("q1").
    strong = len(distinctive) >= 2 or any(ch.isdigit() for w in distinctive for ch in w)
    covered = strong and distinctive <= _tokens(title)
    return covered and (jac >= 0.5 or ratio >= REDUNDANCY_RATIO), ratio, jac


def score_plan(record, case):
    """Runs every deterministic check against an execute-mode record."""
    result = record.get("result") or {}
    data = result.get("data")
    today = _parse_date(record.get("run_date")) or date.today()
    deadline = _parse_date(record["payload"]["deadline"]) or today + timedelta(days=7)
    depth = record["payload"].get("depth", "Brief")
    checks = {}

    # -- structure -------------------------------------------------------
    problems = []
    if not isinstance(data, dict):
        problems.append("data is not an object")
        subtasks, prereqs = [], []
    else:
        subtasks = data.get("subtasks")
        prereqs = data.get("prerequisites", [])
        if not isinstance(data.get("originalTask"), str):
            problems.append("originalTask missing/not a string")
        if not isinstance(subtasks, list) or not subtasks:
            problems.append("subtasks missing/empty")
            subtasks = subtasks if isinstance(subtasks, list) else []
        ids = []
        for i, s in enumerate(subtasks):
            if not isinstance(s, dict):
                problems.append(f"subtask[{i}] not an object")
                continue
            if not isinstance(s.get("title"), str) or not s["title"].strip():
                problems.append(f"subtask[{i}] missing title")
            if s.get("id") in (None, ""):
                problems.append(f"subtask[{i}] missing id")
            ids.append(str(s.get("id")))
            if s.get("difficulty") not in VALID_DIFFICULTY:
                problems.append(f"subtask[{i}] difficulty={s.get('difficulty')!r}")
            if _parse_date(s.get("scheduledDate")) is None:
                problems.append(f"subtask[{i}] scheduledDate={s.get('scheduledDate')!r}")
        if len(set(ids)) != len(ids):
            problems.append("duplicate subtask ids")
    subtasks = [s for s in subtasks if isinstance(s, dict)]
    checks["structure"] = _check(not problems, "; ".join(problems[:4]))

    n = len(subtasks)
    # -- count vs depth -------------------------------------------------
    if depth == "Deep":
        checks["count"] = _check(n >= DEEP_MIN_SUBTASKS, f"{n} subtasks (Deep needs >= {DEEP_MIN_SUBTASKS})")
    else:
        checks["count"] = _check(BRIEF_MIN_SUBTASKS <= n <= BRIEF_MAX_SUBTASKS,
                                 f"{n} subtasks (Brief wants {BRIEF_MIN_SUBTASKS}-{BRIEF_MAX_SUBTASKS})")

    # -- time estimates -------------------------------------------------
    cap = DEEP_MAX_MINUTES if depth == "Deep" else BRIEF_MAX_MINUTES
    non_int = [s.get("timeEstimate") for s in subtasks if not _is_int(s.get("timeEstimate"))]
    too_big = [s.get("timeEstimate") for s in subtasks if _is_int(s.get("timeEstimate")) and s["timeEstimate"] > cap]
    non_pos = [s.get("timeEstimate") for s in subtasks if _is_int(s.get("timeEstimate")) and s["timeEstimate"] <= 0]
    detail = []
    if non_int:
        detail.append(f"non-int: {non_int[:3]}")
    if too_big:
        detail.append(f"{len(too_big)} over {cap}min (max {max(too_big)})")
    if non_pos:
        detail.append("non-positive estimate")
    checks["time_estimates"] = _check(n > 0 and not non_int and not too_big and not non_pos, "; ".join(detail))

    first = subtasks[0].get("timeEstimate") if subtasks else None
    checks["first_step_small"] = _check(_is_int(first) and 0 < first <= FIRST_STEP_MAX_MINUTES,
                                        f"first step = {first} min")

    # -- dates ----------------------------------------------------------
    dates = [_parse_date(s.get("scheduledDate")) for s in subtasks]
    valid_dates = [d for d in dates if d]
    out_of_range = [d.isoformat() for d in valid_dates if d < today or d > deadline]
    checks["dates_in_range"] = _check(
        n > 0 and len(valid_dates) == n and not out_of_range,
        f"{len(out_of_range)} outside [{today}, {deadline}]" + (f" e.g. {out_of_range[:2]}" if out_of_range else ""),
    )
    span_days = (deadline - today).days + 1
    distinct = len(set(valid_dates))
    if span_days >= 2 and n >= 4:
        checks["dates_spread"] = _check(distinct >= 2, f"{distinct} distinct day(s) across a {span_days}-day window")
    else:
        checks["dates_spread"] = _check(True, "single-day window")
    # The whole point is starting NOW: the first step should land on today.
    first_date = valid_dates[0] if valid_dates else None
    checks["first_step_today"] = _check(first_date == today, f"first step scheduled {first_date}")
    ordered = all(a <= b for a, b in zip(valid_dates, valid_dates[1:]))
    checks["dates_monotonic"] = _check(ordered, "" if ordered else "scheduledDate goes backwards in list order")

    # -- vague verbs ----------------------------------------------------
    vague = [s.get("title", "") for s in subtasks if is_vague_title(s.get("title", ""))]
    checks["no_vague_verbs"] = _check(not vague, f"{len(vague)} vague: {vague[:3]}" if vague else "")

    # -- originalTask ---------------------------------------------------
    orig = (data or {}).get("originalTask", "") if isinstance(data, dict) else ""
    orig_norm = (orig or "").strip().lower().rstrip(".!?")
    echo = (
        orig_norm in _BAD_TASK_TITLES
        or "do not ask follow up" in orig_norm
        or orig_norm.startswith("build the")
        or "checklist now" in orig_norm
    )
    checks["original_task_ok"] = _check(not echo, f"originalTask={orig!r}")

    # -- prerequisites --------------------------------------------------
    pre_problems = []
    if not isinstance(prereqs, list):
        pre_problems.append("prerequisites not a list")
        prereqs = []
    for i, p in enumerate(prereqs):
        if not isinstance(p, dict):
            pre_problems.append(f"prereq[{i}] not an object")
            continue
        if not isinstance(p.get("title"), str) or not p["title"].strip():
            pre_problems.append(f"prereq[{i}] missing title")
        if p.get("kind") not in VALID_KINDS:
            pre_problems.append(f"prereq[{i}] kind={p.get('kind')!r}")
    checks["prerequisites_valid"] = _check(not pre_problems, "; ".join(pre_problems[:3]))

    # -- no redundant work ---------------------------------------------
    done_items = case.get("done_items") or []
    if done_items:
        dupes = []
        items = [s.get("title", "") for s in subtasks] + [p.get("title", "") for p in prereqs if isinstance(p, dict)]
        for title in items:
            for done in done_items:
                hit, ratio, jac = is_redundant(title, done)
                if hit:
                    dupes.append(f"{title!r} ~ {done!r} (ratio {ratio:.2f}, jaccard {jac:.2f})")
                    break
        checks["no_redundant_work"] = _check(not dupes, "; ".join(dupes[:3]))
    # (no check at all when the case has no done_items - it isn't applicable)

    hard = ["structure", "count", "time_estimates", "dates_in_range", "original_task_ok", "prerequisites_valid"]
    if "no_redundant_work" in checks:
        hard.append("no_redundant_work")
    all_pass = all(checks[k]["pass"] for k in checks)
    hard_pass = all(checks[k]["pass"] for k in hard)
    return {
        "checks": checks,
        "subtask_count": n,
        "prereq_count": len(prereqs),
        "total_minutes": sum(s["timeEstimate"] for s in subtasks if _is_int(s.get("timeEstimate"))),
        "hard_pass": hard_pass,
        "all_pass": all_pass,
    }


def score_clarify(record, case):
    """Did the first turn ask a question or skip straight to a plan?"""
    result = record.get("result") or {}
    status = result.get("status")
    asked = status == "clarifying" and not record.get("error")
    skipped = status == "complete" and not record.get("error")
    expect = case.get("expect_clarify", "either")
    if expect == "ask":
        appropriate = asked
    elif expect == "ready":
        appropriate = skipped
    else:
        appropriate = asked or skipped
    question = result.get("message", "") if asked else ""
    q_marks = question.count("?")
    # "What's the prompt, and what citation style?" is two questions in one.
    compound = bool(re.search(r",?\s+(and|or)\s+(what|how|which|where|when|who|why|do you|are you|is there|have you|did you)\b", question, re.I))
    return {
        "asked": asked,
        "skipped": skipped,
        "expect": expect,
        "appropriate": appropriate,
        "question": question,
        "multi_question": q_marks > 1 or compound,
        "question_words": len(question.split()),
    }
