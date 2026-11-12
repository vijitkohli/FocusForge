# engine/evals/plan_eval.py
# Two-level planning evals (PHASE5_PLAN §4): runs plan / expand / replan cases
# from plan_cases.json through the real engine with Phase 3-shaped fixture
# packs (fixture_pack.py), scores them deterministically (score_two_level),
# judges them with a rubric that adds `grounding` and `honesty`, and renders
# the "Two-level plans" report section.
#
# expectedEffortMinutes is NOT sent by default, so coverage measures honest
# estimates, not validator-forced ones (--with-expected sets PLAN_WITH_EXPECTED=1).

import json
import os
import re
import statistics
from datetime import date, timedelta

from common import EVALS_DIR, read_json
from engine_runner import _PROXY_DOWN_HINTS, invoke_engine, invocation_error
from fixture_pack import build_pack, pack_to_prompt_text
from scorers import (
    COVERAGE_OVER_RATIO, COVERAGE_PASS_RATIO, _check, _is_int, _parse_date, is_redundant, is_vague_title,
)
from plan_rules import GENERIC_NAMES, extract_names, is_grounded, mentions_ai_delegation  # noqa: E402

PLAN_CASES_PATH = os.path.join(EVALS_DIR, "plan_cases.json")
PLAN_MODES = ("plan", "expand", "replan")
BIG_CASE_MIN = 360
STATUS_FOR = {"plan": "complete", "expand": "expanded", "replan": "updated"}
TWO_LEVEL_HARD = ["structure", "milestone_count", "done_when_present", "current_steps_count", "first_step_small",
                  "first_step_today", "step_sizes", "dates_in_range", "milestone_dates_ordered",
                  "steps_within_milestone", "done_kept", "target_only"]
_RATE_HINTS = ("RateLimitError", "429", "quota", "RESOURCE_EXHAUSTED")


def load_plan_file():
    return read_json(PLAN_CASES_PATH) or {}


def load_plan_cases(mode=None, only_ids=None):
    cases = load_plan_file().get("cases", [])
    if mode:
        cases = [c for c in cases if c.get("mode") == mode]
    if only_ids:
        cases = [c for c in cases if c["id"] in set(only_ids)]
    return cases


def _day(today, offset):
    return (today + timedelta(days=int(offset))).isoformat()


def materialize_plan(existing, today):
    """Case existing_plan (day offsets, min, focus) -> the app's existingPlan payload shape."""
    if not existing:
        return None
    ms = []
    for m in existing.get("milestones") or []:
        v = {k: m[k] for k in ("id", "title", "estimateMinutes", "doneWhen", "status") if k in m}
        if "targetDay" in m:
            v["targetDate"] = _day(today, m["targetDay"])
        if m.get("expanded"):
            v["expanded"] = m["expanded"]
        ms.append(v)
    steps = []
    for s in existing.get("subtasks") or []:
        v = {"id": s["id"], "title": s["title"], "status": s.get("status", "todo"), "timeEstimate": s.get("min"),
             "scheduledDate": _day(today, s.get("day", 0)), "milestoneId": s.get("milestoneId")}
        if s.get("focus"):
            v["focusMinutes"] = s["focus"]
        steps.append(v)
    return {"milestones": ms, "subtasks": steps, "prerequisites": []}


def build_plan_payload(case, model, today, with_expected=False):
    pack, digest = (build_pack(case["pack_folder"], today) if case.get("pack_folder") else (None, None))
    item = case.get("item")
    if not item and case.get("pack_folder"):
        meta = read_json(os.path.join(EVALS_DIR, "fixtures", "folders", case["pack_folder"], "meta.json")) or {}
        item = meta.get("item")
    t = dict(case.get("task") or {})
    task = {"id": "t1", "title": t.get("title"), "scope": t.get("scope", "deliverable"),
            "deadline": _day(today, t["deadline_offset_days"]) if t.get("deadline_offset_days") is not None else None,
            "deadlineKind": t.get("deadlineKind", "hard" if t.get("deadline_offset_days") is not None else "none"),
            "assessment": t.get("assessment")}
    payload = {
        "mode": case["mode"],
        "planModel": model,
        "model": model,
        "today": today.isoformat(),
        "item": item or {},
        "task": task,
        "siblings": [{"title": s["title"], "deadline": _day(today, s["deadline_offset_days"])}
                     for s in case.get("siblings") or []],
        "contextPack": ({"text": pack_to_prompt_text(pack, 120_000),
                         "files": [{"id": f["id"], "label": f["label"], "kind": f["kind"]} for f in pack["files"]],
                         "git": [{"id": g["id"], "label": g["label"]} for g in pack["git"]],
                         "index": pack["index"]} if pack else None),
        "digest": digest,
        "contextLedger": case.get("ledger") or "",
        "userProfile": load_plan_file().get("profile") or "",
        "existingPlan": materialize_plan(case.get("existing_plan"), today),
    }
    if case.get("estimate_ratio") is not None:
        payload["estimateRatio"] = case["estimate_ratio"]
    if case.get("milestone_id"):
        payload["milestoneId"] = case["milestone_id"]
    if case.get("request"):
        payload["request"] = case["request"]
    if with_expected and case.get("expected_effort_minutes"):
        payload["expectedEffortMinutes"] = case["expected_effort_minutes"]
    return payload


def plan_error(result, base_error, mode, case):
    if result and result.get("status") == "error":
        msg = result.get("message") or ""
        if any(h in msg for h in _RATE_HINTS) or "quota" in msg.lower():
            return "rate_limited"
        if any(h in msg for h in _PROXY_DOWN_HINTS):
            return "proxy_unavailable"
        return "engine_error"
    if base_error and base_error not in ("bad_status",):
        return base_error
    status = (result or {}).get("status")
    if status == "clarifying":
        return None  # scored (over-ask or correct ask), not an error
    if status != STATUS_FOR[mode]:
        return "unexpected_status"
    if not isinstance((result or {}).get("data"), dict):
        return "no_data"
    return None


def run_plan(python, case, model, sample=0):
    today = date.today()
    payload = build_plan_payload(case, model, today, with_expected=os.getenv("PLAN_WITH_EXPECTED") == "1")
    record = {"case_id": case["id"], "model": model, "mode": case["mode"], "sample": sample,
              "run_date": today.isoformat(), "payload": payload, "tokens": 0, "ttft_s": None,
              "latency_s": None, "result": None, "error": None, "stderr_tail": "", "bad_lines": []}
    inv = invoke_engine(python, payload)
    if inv.get("spawn_error"):
        record.update(error="spawn_failed", stderr_tail=inv["spawn_error"])
        return record
    for k in ("tokens", "ttft_s", "latency_s", "stderr_tail", "bad_lines", "result"):
        record[k] = inv[k]
    record["error"] = plan_error(inv["result"], invocation_error(inv), case["mode"], case)
    return record


# --- scoring --------------------------------------------------------------------------------------

def planned_minutes_two_level(data, include_done=False):
    if not isinstance(data, dict):
        return 0
    total = 0
    for m in data.get("milestones") or []:
        if isinstance(m, dict) and (include_done or m.get("status") != "done") and _is_int(m.get("estimateMinutes")):
            total += max(0, m["estimateMinutes"])
    for p in data.get("prerequisites") or []:
        if isinstance(p, dict) and _is_int(p.get("timeEstimate")) and p["timeEstimate"] > 0:
            total += p["timeEstimate"]
    return total


def _coverage(total, case):
    rng = case.get("expected_effort_minutes")
    if not (isinstance(rng, list) and len(rng) == 2):
        return None
    lo, hi = int(rng[0]), int(rng[1])
    ratio = total / lo if lo else None
    return {"pass": ratio is not None and ratio >= COVERAGE_PASS_RATIO, "planned_minutes": total, "expected": [lo, hi],
            "ratio": round(ratio, 3) if ratio is not None else None, "over": total > COVERAGE_OVER_RATIO * hi,
            "big": lo >= BIG_CASE_MIN,
            "detail": f"{total} min planned vs expected {lo}-{hi} ({ratio:.0%} of min)"}


def _names_haystack(record):
    p = record["payload"]
    parts = [(p.get("contextPack") or {}).get("text") or "", json.dumps(p.get("digest") or {}), json.dumps(p.get("task") or {}),
             json.dumps(p.get("existingPlan") or {}), p.get("contextLedger") or "", p.get("request") or "",
             json.dumps(p.get("item") or {})]
    labels = [f.get("label", "") for f in (p.get("contextPack") or {}).get("files") or []]
    return "\n".join(parts + labels).lower()


def score_two_level(record, case):
    mode = case["mode"]
    result = record.get("result") or {}
    status = result.get("status")
    expect = case.get("expect_clarify", "ready")
    checks = {}
    if expect == "ask" or status == "clarifying":
        asked = status == "clarifying"
        q = result.get("message", "") if asked else ""
        compound = bool(re.search(r",?\s+(and|or)\s+(what|how|which|where|when|who|why|do you|are you|is there|have you)\b", q, re.I))
        checks["clarify_ok"] = _check(asked == (expect == "ask"), f"{'asked' if asked else 'planned'}; expected {expect}")
        checks["one_question"] = _check(not asked or (q.count("?") <= 1 and not compound), q[:120])
        return {"checks": checks, "hard_pass": checks["clarify_ok"]["pass"] and checks["one_question"]["pass"],
                "clarify": True, "asked": asked, "expect": expect, "question": q, "coverage": None}

    data = result.get("data") if isinstance(result.get("data"), dict) else {}
    today = _parse_date(record.get("run_date")) or date.today()
    task = record["payload"].get("task") or {}
    deadline = _parse_date(task.get("deadline"))
    kind = task.get("deadlineKind") or "none"
    end = deadline if (deadline and kind != "none") else today + timedelta(days=28)
    ms = [m for m in data.get("milestones") or [] if isinstance(m, dict)]
    steps = [s for s in data.get("subtasks") or [] if isinstance(s, dict)]
    existing = record["payload"].get("existingPlan") or {}
    cur = data.get("currentMilestoneId") if mode != "expand" else case.get("milestone_id")

    problems = []
    if mode != "expand" and not ms:
        problems.append("no milestones")
    if not steps:
        problems.append("no steps")
    for i, s in enumerate(steps):
        if not (isinstance(s.get("title"), str) and s["title"].strip()):
            problems.append(f"step[{i}] title")
        if _parse_date(s.get("scheduledDate")) is None:
            problems.append(f"step[{i}] date")
    checks["structure"] = _check(not problems, "; ".join(problems[:4]))

    if mode != "expand":
        open_ms = [m for m in ms if m.get("status") != "done"]
        lo = 1 if case.get("small") else 2
        checks["milestone_count"] = _check(lo <= len(ms) <= 10, f"{len(ms)} milestones")
        missing = [m.get("title") for m in open_ms if not str(m.get("doneWhen") or "").strip()]
        checks["done_when_present"] = _check(not missing, f"missing doneWhen: {missing[:2]}" if missing else "")
        tds = [_parse_date(m.get("targetDate")) for m in open_ms]
        checks["milestone_dates_ordered"] = _check(all(tds) and all(a <= b for a, b in zip(tds, tds[1:])),
                                                   f"{[str(x) for x in tds]}")
        if deadline and kind == "hard" and tds and all(tds) and (deadline - today).days >= 2:
            checks["buffer_before_deadline"] = _check(tds[-1] < deadline, f"last target {tds[-1]} vs deadline {deadline}")
    else:
        checks["milestone_count"] = _check(True, "n/a")
        checks["done_when_present"] = _check(True, "n/a")
        checks["milestone_dates_ordered"] = _check(True, "n/a")

    n = len(steps)
    lo_n = 1 if case.get("small") else (2 if mode == "expand" else 4)
    checks["current_steps_count"] = _check(lo_n <= n <= 15, f"{n} steps")
    first = steps[0] if steps else {}
    checks["first_step_small"] = _check(_is_int(first.get("timeEstimate")) and 0 < first["timeEstimate"] <= 5,
                                        f"first step {first.get('timeEstimate')} min")
    checks["first_step_today"] = _check(_parse_date(first.get("scheduledDate")) == today, f"first step {first.get('scheduledDate')}")
    bad = [(s.get("title"), s.get("timeEstimate")) for s in steps[1:]
           if not (_is_int(s.get("timeEstimate")) and 5 <= s["timeEstimate"] <= 20)]
    checks["step_sizes"] = _check(not bad, f"{len(bad)} outside 5-20: {bad[:2]}" if bad else "")
    out = [s.get("scheduledDate") for s in steps if not (_parse_date(s.get("scheduledDate")) and today <= _parse_date(s["scheduledDate"]) <= end)]
    out += [m.get("targetDate") for m in ms if m.get("status") != "done" and not (
        _parse_date(m.get("targetDate")) and today <= _parse_date(m["targetDate"]) <= end)]
    checks["dates_in_range"] = _check(not out, f"{len(out)} outside {today}..{end}: {out[:3]}" if out else "")
    foreign = [s.get("title") for s in steps if cur is not None and str(s.get("milestoneId")) != str(cur)]
    checks["steps_within_milestone"] = _check(not foreign, f"{len(foreign)} steps not in {cur}" if foreign else "")
    vague = [s.get("title") for s in steps if is_vague_title(s.get("title", ""))]
    checks["no_vague_verbs"] = _check(not vague, f"{vague[:2]}" if vague else "")

    # grounding
    hay = _names_haystack(record)
    texts = [s.get("title", "") for s in steps] + [m.get("title", "") for m in ms if m.get("status") != "done"] \
        + [str(m.get("doneWhen") or "") for m in ms if m.get("status") != "done"] \
        + [p.get("title", "") for p in data.get("prerequisites") or [] if isinstance(p, dict)]
    allowed = case.get("allowed_names") or []
    ungrounded = sorted({nm for t in texts for nm in extract_names(t) if not is_grounded(nm, hay, allowed)})
    forbidden_hits = [f for f in case.get("forbidden_names") or [] if any(f.lower() in t.lower() for t in texts)
                      and f.lower() not in hay]
    checks["grounded"] = _check(not ungrounded and not forbidden_hits,
                                (f"ungrounded {ungrounded[:4]}" if ungrounded else "") + (f" forbidden {forbidden_hits}" if forbidden_hits else ""))
    if case.get("ai_banned"):
        hits = [t for t in texts if mentions_ai_delegation(t)]
        checks["no_ai_delegation"] = _check(not hits, f"{hits[:2]}" if hits else "")
    if case.get("done_items"):
        dupes = []
        for t in [s.get("title", "") for s in steps]:
            for d in case["done_items"]:
                if is_redundant(t, d)[0]:
                    dupes.append(f"{t!r} ~ {d!r}")
                    break
        checks["no_redundant_work"] = _check(not dupes, "; ".join(dupes[:2]))
    if case.get("must_mention"):
        alltext = " ".join(texts).lower()
        miss = [g for g in case["must_mention"] if not any(k in alltext for k in g)]
        checks["mentions"] = _check(not miss, f"missing {miss}" if miss else "")

    if mode == "replan":
        done_ms = [m for m in existing.get("milestones") or [] if m.get("status") == "done"]
        lost = [m["title"] for m in done_ms if not any(str(x.get("id")) == str(m["id"]) and x.get("status") == "done"
                                                       and x.get("title") == m["title"] for x in ms)]
        checks["done_kept"] = _check(not lost, f"lost done milestones {lost}" if lost else "")
        if case.get("request") and "lighter" in case["request"]:
            week_end = today + timedelta(days=6 - today.weekday())
            week_min = sum(s.get("timeEstimate") or 0 for s in steps if _parse_date(s.get("scheduledDate")) and _parse_date(s["scheduledDate"]) <= week_end)
            checks["lighter_this_week"] = _check(week_min <= 150, f"{week_min} min of steps by {week_end}")
    else:
        checks["done_kept"] = _check(True, "n/a")
    if mode == "expand":
        target = case.get("milestone_id")
        wrong = [s.get("title") for s in steps if str(s.get("milestoneId")) != str(target)]
        checks["target_only"] = _check(not wrong and "milestones" not in data, f"{len(wrong)} steps outside {target}")
    else:
        checks["target_only"] = _check(True, "n/a")

    coverage = None if mode == "expand" else _coverage(planned_minutes_two_level(data), case)
    validation = result.get("validation") or {}
    pre = validation.get("preRepair") or {}
    pre_cov = None if mode == "expand" or not coverage else _coverage(pre.get("plannedMinutes") or 0, case)
    hard_pass = all(checks[k]["pass"] for k in TWO_LEVEL_HARD if k in checks)
    return {
        "checks": checks, "hard_pass": hard_pass, "all_pass": all(c["pass"] for c in checks.values()),
        "clarify": False, "coverage": coverage, "pre_repair_coverage": pre_cov,
        "repaired": bool(validation.get("repaired")), "salvaged": bool(validation.get("salvaged")),
        "pre_repair_hard": pre.get("hard"), "steps": n, "milestones": len(ms),
        "planned_minutes": planned_minutes_two_level(data),
    }


# --- judge -----------------------------------------------------------------------------------------

TWO_LEVEL_DIMENSIONS = ["specificity", "first_step", "ordering", "fit", "tone", "coverage", "grounding", "honesty"]

TWO_LEVEL_RUBRIC = """You are grading an AI coach's TWO-LEVEL plan for a university student who procrastinates: milestones that should cover the WHOLE job with honest estimates, plus tiny startable steps for the current milestone only (later milestones intentionally have no steps yet). You also see the context excerpts from the student's files the coach was given.

Score each dimension from 1 (bad) to 5 (excellent) with a one-sentence rationale:
- specificity: are the current steps concrete actions with a clear object, using details from the context (not "Study", "Work on")?
- first_step: is the first step a genuinely <=5-minute, zero-decision starter the student could begin right now?
- ordering: is the milestone sequence logical with sensible target dates up to the deadline (buffer before a hard deadline), and are the current steps in a sensible order spread over the coming days?
- fit: does the plan match THIS task and context (spec, rubric, constraints such as AI bans, work already done, the item kind - passion projects should feel fun)? Penalise redone work and generic boilerplate.
- tone: warm, plain, never guilt-tripping.
- coverage: if the student completed every milestone, would the job be done to a passing standard? Penalise milestone lists that silently omit essential parts of the work (a question, stage, section, reading, testing, revision, submission).
- grounding: does every named file, function, section, question, stage, paper or reading appear in the context? 5 = everything named is real or described generically; 1 = invents several names.
- honesty: are the milestone estimates realistic for this student and this work (total effort, not just the first steps)? 1 = wildly under (or over) the real effort; 5 = what an experienced tutor would estimate.

Be strict and calibrated: reserve 5 for plans you could not meaningfully improve.
Return ONLY a JSON object:
{"specificity": {"score": 1-5, "rationale": "..."}, "first_step": {...}, "ordering": {...}, "fit": {...}, "tone": {...}, "coverage": {...}, "grounding": {...}, "honesty": {...}, "worst_issue": "one sentence"}
"""


def judge_two_level(judge_model, record, case):
    from judge import _ask
    p = record["payload"]
    text = ((p.get("contextPack") or {}).get("text") or "")[:60_000]
    parts = [
        f"TODAY: {record.get('run_date')}",
        f"MODE: {case['mode']}",
        f"ITEM: {json.dumps(p.get('item'))}",
        f"TASK: {json.dumps(p.get('task'))}",
    ]
    if p.get("request"):
        parts.append(f"STUDENT'S REQUEST: {p['request']}")
    if p.get("digest"):
        d = {k: p["digest"].get(k) for k in ("goal", "openItems", "dueDates", "constraints", "recentProgress")}
        parts.append("DIGEST: " + json.dumps(d))
    parts.append("CONTEXT EXCERPTS:\n" + (text or "(none)"))
    if p.get("contextLedger"):
        parts.append("LEDGER:\n" + p["contextLedger"])
    if p.get("existingPlan"):
        parts.append("EXISTING PLAN BEFORE THIS CALL:\n" + json.dumps(p["existingPlan"], indent=1))
    parts.append("PLAN TO GRADE (JSON):\n" + json.dumps((record.get("result") or {}).get("data"), indent=1))
    return _ask(judge_model, TWO_LEVEL_RUBRIC, "\n\n".join(parts), TWO_LEVEL_DIMENSIONS, extra_keys=("worst_issue",))


# --- report ------------------------------------------------------------------------------------------

def _pct(a, b):
    return f"{100.0 * a / b:.0f}%" if b else "–"


def _fmt(x, nd=2):
    return "–" if x is None else f"{x:.{nd}f}"


def _median(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return statistics.mean(xs) if xs else None


def aggregate_two_level(model, judge_model, load_records, load_verdict, record_error, infra_errors):
    out = {}
    for mode in PLAN_MODES:
        cases = load_plan_cases(mode)
        rows, infra = [], 0
        for rec in load_records(model, cases, mode):
            err = record_error(rec)
            if err in infra_errors:
                infra += 1
                continue
            case = next(c for c in cases if c["id"] == rec["case_id"])
            score = score_two_level(rec, case) if not err else None
            verdict = load_verdict(judge_model, model, rec["case_id"], mode, rec) if score and not score.get("clarify") else None
            rows.append({"case_id": rec["case_id"], "sample": rec.get("sample", 0), "error": err, "score": score,
                         "judge": verdict, "latency": rec.get("latency_s"), "record": rec})
        out[mode] = {"rows": rows, "infra": infra}
    return out


def render_two_level(models, agg, judge_model):
    if not any(agg[m][mode]["rows"] for m in models for mode in PLAN_MODES):
        return []
    L = ["## Two-level plans (plan / expand / replan)", ""]
    L.append("Cases in `plan_cases.json` over synthetic fixture packs (`fixtures/folders`, built by `fixture_pack.py`). "
             f"`big cov.` = share of big-case runs (expected lo >= {BIG_CASE_MIN} min) whose remaining milestone total "
             f"reaches {COVERAGE_PASS_RATIO:.0%} of the expected minimum (ship bar >= 80%); `pre-repair` is the same on the "
             "model's first reply, before the validator's repair call. `hard` = structure, milestone count, doneWhen, step "
             "count, first step <=5 min and today, step sizes 5-20, dates, milestone order, steps in the current milestone, "
             "done milestones kept (replan), target milestone only (expand). `grounded` fails on any name not in the "
             "context and on any planted forbidden name. Judge dimensions 1-5; `grounding` and `honesty` are new. "
             "expectedEffortMinutes is not sent to the engine.")
    L.append("")
    L.append("| model | mode | runs | err | hard | big cov. | pre-repair | med. ratio | over | 1st<=5 | 1st today | grounded | forbidden hits | AI hits | clarify ok | repaired | med. latency | judge cov. | honesty | first step | grounding | judge mean |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for model in models:
        for mode in PLAN_MODES:
            rows = agg[model][mode]["rows"]
            if not rows and not agg[model][mode]["infra"]:
                continue
            scored = [r for r in rows if r["score"] and not r["score"].get("clarify")]
            clar = [r for r in rows if r["score"] and r["score"].get("clarify")]
            big = [r for r in scored if r["score"]["coverage"] and r["score"]["coverage"]["big"]]
            pre_big = [r for r in big if r["score"].get("pre_repair_coverage")]
            ratios = [r["score"]["coverage"]["ratio"] for r in scored if r["score"]["coverage"]]
            over = [r for r in scored if r["score"]["coverage"] and r["score"]["coverage"]["over"]]
            ch = lambda k: [r["score"]["checks"][k]["pass"] for r in scored if k in r["score"]["checks"]]  # noqa: E731
            forb = sum(1 for r in scored if "forbidden" in r["score"]["checks"]["grounded"]["detail"])
            ai = [x for x in ch("no_ai_delegation")]
            judged = [r for r in scored if r.get("judge")]
            jm = lambda d: _mean(r["judge"]["scores"][d]["score"] for r in judged if d in r["judge"]["scores"])  # noqa: E731
            mean = _mean(_mean(r["judge"]["scores"][d]["score"] for d in TWO_LEVEL_DIMENSIONS if d in r["judge"]["scores"]) for r in judged)
            errs = sum(1 for r in rows if r["error"])
            infra = agg[model][mode]["infra"]
            L.append(
                f"| `{model}` | {mode} | {len(rows)}{f' (+{infra} infra)' if infra else ''} | {_pct(errs, len(rows))} | "
                f"{_pct(sum(r['score']['hard_pass'] for r in scored), len(scored))} | "
                f"{_pct(sum(r['score']['coverage']['pass'] for r in big), len(big))} | "
                f"{_pct(sum(r['score']['pre_repair_coverage']['pass'] for r in pre_big), len(pre_big))} | "
                f"{_fmt(_median(ratios))} | {_pct(len(over), len([r for r in scored if r['score']['coverage']]))} | "
                f"{_pct(sum(ch('first_step_small')), len(ch('first_step_small')))} | {_pct(sum(ch('first_step_today')), len(ch('first_step_today')))} | "
                f"{_pct(sum(ch('grounded')), len(ch('grounded')))} | {forb} | {len(ai) - sum(ai)}/{len(ai)} | "
                f"{_pct(sum(r['score']['hard_pass'] for r in clar), len(clar))} | "
                f"{_pct(sum(r['score']['repaired'] for r in scored), len(scored))} | "
                f"{_fmt(_median([r['latency'] for r in rows]), 1)}s | {_fmt(jm('coverage'))} | {_fmt(jm('honesty'))} | "
                f"{_fmt(jm('first_step'))} | {_fmt(jm('grounding'))} | **{_fmt(mean)}** |")
    L.append("")
    L.append("Per case (median planned minutes vs expected; `✓`/`✗` = hard checks; `g✗` = grounding failed; `A`/`P` = asked / planned on a clarify case; judge coverage, honesty in brackets):")
    L.append("")
    L.append("| case | mode | expected | " + " | ".join(f"`{m.split('/')[-1]}`" for m in models) + " |")
    L.append("|---|---|---|" + "---|" * len(models))
    for mode in PLAN_MODES:
        for case in load_plan_cases(mode):
            exp = case.get("expected_effort_minutes")
            cells = []
            for m in models:
                rs = [r for r in agg[m][mode]["rows"] if r["case_id"] == case["id"]]
                if not rs:
                    cells.append("–")
                    continue
                bits = []
                for r in rs:
                    s = r["score"]
                    if not s:
                        bits.append(f"E({r['error']})")
                    elif s.get("clarify"):
                        bits.append(("A" if s["asked"] else "P") + ("✓" if s["hard_pass"] else "✗"))
                    else:
                        cov = s["coverage"]
                        b = (f"{cov['planned_minutes']}" if cov else f"{s['planned_minutes']}") + ("✓" if s["hard_pass"] else "✗")
                        if not s["checks"]["grounded"]["pass"]:
                            b += " g✗"
                        if cov and not cov["pass"]:
                            b += " cov✗"
                        if r.get("judge"):
                            sc = r["judge"]["scores"]
                            b += f" ({sc['coverage']['score']},{sc['honesty']['score']})"
                        bits.append(b)
                cells.append(" · ".join(bits))
            L.append(f"| {case['id']} | {mode} | {f'{exp[0]}–{exp[1]}' if exp else '–'} | " + " | ".join(cells) + " |")
    L.append("")
    for m in models:
        for mode in PLAN_MODES:
            for r in agg[m][mode]["rows"]:
                s = r["score"]
                if not s or s.get("clarify"):
                    continue
                fails = [f"{k} ({c['detail']})" for k, c in s["checks"].items() if not c["pass"]]
                if fails:
                    L.append(f"- `{m.split('/')[-1]}` **{r['case_id']}**#{r['sample']}: " + "; ".join(fails)[:400])
            for r in [r for r in agg[m][mode]["rows"] if r["error"]][:3]:
                msg = ((r["record"].get("result") or {}).get("message") or r["record"].get("stderr_tail", ""))[:200]
                L.append(f"- `{m.split('/')[-1]}` error `{r['error']}` on {r['case_id']}: `{msg}`")
    L.append("")
    return L


GENERIC = GENERIC_NAMES  # re-export for tests/debugging
