# engine/plan_validate.py
# Pure validation, deterministic fixes and salvage for two-level plans
# (milestones for the whole job + micro-steps for the current milestone).
# No I/O and no model calls: planner.py runs autofix -> validate, sends hard
# issues back to the model once, and salvages if the repair still fails.

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from datetime import date, timedelta

from plan_rules import (
    COVERAGE_RATIO, FIRST_MAX, MILESTONE_COUNT, OVER_PLANNED_RATIO, PASSION_HORIZON_DAYS,
    STEP_MAX, STEP_MIN, STEPS_OVER_MILESTONE, is_redundant, is_vague_title,
    mentions_ai_delegation, ungrounded_names,
)

VALID_DIFFICULTY = {"easy", "medium", "hard"}
VALID_PREREQ_KINDS = {"learn", "acquire", "setup"}
OPENER_MINUTES = 3
SMALL_TASK_MINUTES = 120
HARD, SOFT = "hard", "soft"


@dataclass
class PlanContext:
    today: date
    deadline: date | None = None          # None for passion / no deadline
    deadline_kind: str = "hard"           # hard | tentative | none
    mode: str = "plan"                    # plan | expand | replan
    depth_limits: tuple = (6, 15, STEP_MAX)  # (count_lo, count_hi, step_max)
    expected_min: int | None = None       # from expectedEffortMinutes or effort_floor(assessment)
    expected_max: int | None = None
    pack_text: str = ""                   # grounding haystack: pack + task + digest text
    allowed_names: tuple = ()
    task_title: str = ""
    done_step_titles: list = field(default_factory=list)
    existing_milestone_ids: set = field(default_factory=set)
    target_milestone_id: str | None = None
    ai_banned: bool = False
    done_milestones: list = field(default_factory=list)  # replan/expand: done milestones, verbatim
    existing_step_ids: set = field(default_factory=set)  # expand: ids already used in the task

    @property
    def end(self):
        """Last schedulable day: the deadline, or a rolling horizon without one."""
        if self.deadline and self.deadline_kind != "none" and self.deadline >= self.today:
            return self.deadline
        return self.today + timedelta(days=PASSION_HORIZON_DAYS)


@dataclass
class Issue:
    code: str
    path: str
    msg: str
    severity: str = HARD
    fixed: bool = False

    def as_dict(self):
        return {"code": self.code, "path": self.path, "msg": self.msg, "severity": self.severity, "fixed": self.fixed}


# --- small helpers -------------------------------------------------------------------

def _d(s):
    try:
        return date.fromisoformat(str(s)[:10])
    except (TypeError, ValueError):
        return None


def _int(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float) and v.is_integer():
        return int(v)
    if isinstance(v, str):
        try:
            return int(float(v.strip()))
        except ValueError:
            return None
    return None


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _title(x):
    return (x.get("title") or "").strip() if isinstance(x, dict) else ""


def _milestones(plan):
    ms = plan.get("milestones") if isinstance(plan, dict) else None
    return [m for m in ms if isinstance(m, dict)] if isinstance(ms, list) else []


def _steps(plan):
    st = plan.get("subtasks") if isinstance(plan, dict) else None
    return [s for s in st if isinstance(s, dict)] if isinstance(st, list) else []


def current_milestone_id(plan, ctx):
    if ctx.mode == "expand":
        return ctx.target_milestone_id
    ms = _milestones(plan)
    cur = plan.get("currentMilestoneId")
    if cur and any(str(m.get("id")) == str(cur) and m.get("status") != "done" for m in ms):
        return str(cur)
    first = next((m for m in ms if m.get("status") != "done"), None)
    return str(first["id"]) if first else None


def _milestone(plan, mid):
    return next((m for m in _milestones(plan) if str(m.get("id")) == str(mid)), None)


def planned_minutes(plan, include_done=False):
    """Milestone estimates (remaining unless include_done) + prerequisites."""
    total = 0
    for m in _milestones(plan):
        if m.get("status") == "done" and not include_done:
            continue
        if _is_int(m.get("estimateMinutes")) and m["estimateMinutes"] > 0:
            total += m["estimateMinutes"]
    for p in plan.get("prerequisites") or [] if isinstance(plan, dict) else []:
        if isinstance(p, dict) and _is_int(p.get("timeEstimate")) and p["timeEstimate"] > 0:
            total += p["timeEstimate"]
    return total


def _count_limits(plan, ctx, mid):
    lo, hi, _step_max = ctx.depth_limits
    m = _milestone(plan, mid) if mid else None
    est = m.get("estimateMinutes") if m and _is_int(m.get("estimateMinutes")) else None
    if ctx.mode == "expand" and isinstance(plan.get("estimateMinutes"), int):
        est = plan["estimateMinutes"]
    if est:
        # A small milestone can't hold 6 steps of 5-20 minutes.
        lo = min(lo, max(1, est // STEP_MAX))
    return lo, hi


def _grounding_text(plan):
    parts = []
    for m in _milestones(plan):
        if m.get("status") == "done":
            continue
        parts.append(_title(m))
        parts.append(str(m.get("doneWhen") or ""))
    parts += [_title(s) for s in _steps(plan)]
    parts += [_title(p) for p in plan.get("prerequisites") or [] if isinstance(p, dict)]
    return parts


# --- validate ----------------------------------------------------------------------------

def validate(plan, ctx):
    issues = []
    add = lambda code, path, msg, sev=HARD: issues.append(Issue(code, path, msg, sev))  # noqa: E731

    if not isinstance(plan, dict):
        add("SHAPE", "$", "reply is not a JSON object")
        return issues
    if ctx.mode != "expand":
        if not isinstance(plan.get("milestones"), list):
            add("SHAPE", "milestones", "milestones missing or not a list")
    if not isinstance(plan.get("subtasks"), list):
        add("SHAPE", "subtasks", "subtasks missing or not a list")

    ms = _milestones(plan)
    steps = _steps(plan)

    # -- milestones ---------------------------------------------------------------------
    if ctx.mode != "expand":
        open_ms = [m for m in ms if m.get("status") != "done"]
        if not ms:
            add("NO_MILESTONES", "milestones", "no milestones")
        else:
            total = planned_minutes(plan, include_done=True)
            small = (ctx.expected_max is not None and ctx.expected_max <= SMALL_TASK_MINUTES) or \
                (ctx.expected_max is None and total <= SMALL_TASK_MINUTES)
            lo = 1 if small else MILESTONE_COUNT[0]
            if not (lo <= len(ms) <= MILESTONE_COUNT[1]):
                add("MILESTONE_COUNT", "milestones", f"{len(ms)} milestones (want {lo}-{MILESTONE_COUNT[1]})")
            if not open_ms and ctx.mode == "plan":
                add("MILESTONE_COUNT", "milestones", "every milestone is marked done")
        ids = []
        for i, m in enumerate(ms):
            path = f"milestones[{i}]"
            if not str(m.get("id") or "").strip():
                add("MILESTONE_FIELD", path, "missing id")
            ids.append(str(m.get("id")))
            if not _title(m):
                add("MILESTONE_FIELD", path, "missing title")
            if not (_is_int(m.get("estimateMinutes")) and m["estimateMinutes"] > 0):
                add("MILESTONE_FIELD", path, f"estimateMinutes={m.get('estimateMinutes')!r} (want an integer > 0)")
            if not str(m.get("doneWhen") or "").strip():
                add("MILESTONE_FIELD", path, "missing doneWhen")
        if len(set(ids)) != len(ids):
            add("DUP_ID", "milestones", "duplicate milestone ids")
        cur = plan.get("currentMilestoneId")
        cm = _milestone(plan, cur) if cur is not None else None
        if ms and (cm is None or cm.get("status") == "done"):
            add("BAD_CURRENT", "currentMilestoneId", f"currentMilestoneId={cur!r} is missing or done")

        # dates on milestones
        dates = []
        for i, m in enumerate(ms):
            if m.get("status") == "done":
                continue
            td = _d(m.get("targetDate"))
            if td is None:
                add("DATE_RANGE", f"milestones[{i}].targetDate", f"targetDate={m.get('targetDate')!r} is not a date")
                continue
            if td < ctx.today or td > ctx.end:
                add("DATE_RANGE", f"milestones[{i}].targetDate", f"{td} outside {ctx.today}..{ctx.end}")
            dates.append(td)
        if any(a > b for a, b in zip(dates, dates[1:])):
            add("DATE_ORDER", "milestones", "milestone targetDates go backwards")
        if dates and ctx.deadline and ctx.deadline_kind == "hard" and dates[-1] >= ctx.deadline \
                and (ctx.deadline - ctx.today).days >= 2:
            add("LAST_MILESTONE_LATE", "milestones[-1]", "last milestone lands on the deadline; leave a day of buffer", SOFT)

    # -- steps ---------------------------------------------------------------------------
    mid = current_milestone_id(plan, ctx)
    step_max = ctx.depth_limits[2]
    step_ids = []
    if steps or ctx.mode == "expand":
        lo, hi = _count_limits(plan, ctx, mid)
        if not (lo <= len(steps) <= hi):
            add("STEP_COUNT", "subtasks", f"{len(steps)} steps (want {lo}-{hi})")
    for i, s in enumerate(steps):
        path = f"subtasks[{i}]"
        step_ids.append(str(s.get("id")))
        if not _title(s):
            add("SHAPE", path, "missing title")
        if mid is not None and str(s.get("milestoneId")) != str(mid):
            add("STEP_MILESTONE", path, f"milestoneId={s.get('milestoneId')!r} is not the current milestone {mid!r}")
        est = s.get("timeEstimate")
        if not _is_int(est):
            add("STEP_SIZE", path, f"timeEstimate={est!r} is not an integer")
        elif i == 0:
            if not (1 <= est <= FIRST_MAX):
                add("FIRST_STEP_SIZE", path, f"first step is {est} min (max {FIRST_MAX})")
        elif not (STEP_MIN <= est <= step_max):
            add("STEP_SIZE", path, f"{est} min (want {STEP_MIN}-{step_max})")
        sd = _d(s.get("scheduledDate"))
        if sd is None:
            add("DATE_RANGE", f"{path}.scheduledDate", f"scheduledDate={s.get('scheduledDate')!r} is not a date")
        else:
            if i == 0 and sd != ctx.today:
                add("FIRST_STEP_DATE", path, f"first step is on {sd}, not today ({ctx.today})")
            if sd < ctx.today or sd > ctx.end:
                add("DATE_RANGE", f"{path}.scheduledDate", f"{sd} outside {ctx.today}..{ctx.end}")
        if s.get("difficulty") not in VALID_DIFFICULTY:
            add("SHAPE", path, f"difficulty={s.get('difficulty')!r}")
        if is_vague_title(_title(s)):
            add("VAGUE_TITLE", path, f"vague title {_title(s)!r}", SOFT)
        for done in ctx.done_step_titles:
            if is_redundant(_title(s), done)[0]:
                add("REDUNDANT", path, f"{_title(s)!r} repeats finished work {done!r}", SOFT)
                break
        if ctx.ai_banned and mentions_ai_delegation(_title(s)):
            add("AI_DELEGATION", path, f"{_title(s)!r} hands work to AI, which this course forbids")
    sdates = [_d(s.get("scheduledDate")) for s in steps]
    sdates = [x for x in sdates if x]
    if any(a > b for a, b in zip(sdates, sdates[1:])):
        add("DATE_ORDER", "subtasks", "step dates go backwards in list order")
    if len(set(step_ids)) != len(step_ids):
        add("DUP_ID", "subtasks", "duplicate step ids")
    if ctx.mode == "expand":
        clash = sorted(set(step_ids) & {str(x) for x in ctx.existing_step_ids})
        if clash:
            add("DUP_ID", "subtasks", f"step ids already used in this task: {clash[:3]}")

    m = _milestone(plan, mid) if mid else None
    est = (m or {}).get("estimateMinutes") if m else plan.get("estimateMinutes")
    batch = sum(s["timeEstimate"] for s in steps if _is_int(s.get("timeEstimate")))
    if _is_int(est) and est > 0 and batch > STEPS_OVER_MILESTONE * est:
        add("STEPS_EXCEED_MILESTONE", "subtasks", f"steps total {batch} min > milestone estimate {est} min")

    # -- prerequisites --------------------------------------------------------------------
    for i, p in enumerate(plan.get("prerequisites") or []):
        if not isinstance(p, dict) or not _title(p):
            add("SHAPE", f"prerequisites[{i}]", "missing title")
        elif p.get("kind") not in VALID_PREREQ_KINDS:
            add("SHAPE", f"prerequisites[{i}]", f"kind={p.get('kind')!r}")

    # -- grounding -------------------------------------------------------------------------
    hay = "\n".join([ctx.pack_text or "", ctx.task_title or ""])
    seen = set()
    for text in _grounding_text(plan):
        for name in ungrounded_names(text, hay, ctx.allowed_names):
            if name.lower() in seen:
                continue
            seen.add(name.lower())
            add("UNGROUNDED_NAME", "names", f"{name!r} does not appear in the context; describe it generically")

    # -- coverage ------------------------------------------------------------------------------
    if ctx.mode != "expand":
        total = planned_minutes(plan)
        if ctx.expected_min and total < COVERAGE_RATIO * ctx.expected_min:
            add("COVERAGE_LOW", "milestones",
                f"milestones total {total} min, but this work realistically needs at least ~{ctx.expected_min} min; "
                "add the missing work (reading, building each part, testing, revising, submitting) or raise "
                "estimates that are too optimistic", SOFT)
        if ctx.expected_max and total > OVER_PLANNED_RATIO * ctx.expected_max:
            add("OVER_PLANNED", "milestones", f"milestones total {total} min, far above ~{ctx.expected_max} min", SOFT)
    return issues


def score_validity(issues):
    """(hard, soft) counts of unfixed issues, for choosing between candidates."""
    hard = sum(1 for i in issues if i.severity == HARD and not i.fixed)
    soft = sum(1 for i in issues if i.severity == SOFT and not i.fixed)
    return hard, soft


def hard_issues(issues):
    return [i for i in issues if i.severity == HARD and not i.fixed]


def format_for_repair(issues):
    lines = [f"{n}. [{i.code}] {i.path}: {i.msg}" for n, i in enumerate(
        [i for i in issues if not i.fixed], start=1)]
    return "\n".join(lines)


# --- autofix --------------------------------------------------------------------------------

def _opener(first_title, ctx, mid):
    short = first_title if len(first_title) <= 60 else first_title[:57].rstrip() + "..."
    return {
        "id": "s0",
        "title": f"Open what you need for \"{short}\" and put it on screen",
        "difficulty": "easy",
        "timeEstimate": OPENER_MINUTES,
        "scheduledDate": ctx.today.isoformat(),
        **({"milestoneId": mid} if mid else {}),
    }


def _fresh_id(prefix, taken):
    n = 1
    while f"{prefix}{n}" in taken:
        n += 1
    taken.add(f"{prefix}{n}")
    return f"{prefix}{n}"


def _distribute_targets(ms, ctx):
    """targetDates proportional to cumulative estimates over today..end (less a buffer)."""
    open_ms = [m for m in ms if m.get("status") != "done"]
    if not open_ms:
        return
    end = ctx.end
    if ctx.deadline and ctx.deadline_kind == "hard" and (end - ctx.today).days >= 2:
        end = end - timedelta(days=1)
    span = max(0, (end - ctx.today).days)
    weights = [m["estimateMinutes"] if _is_int(m.get("estimateMinutes")) and m["estimateMinutes"] > 0 else 60
               for m in open_ms]
    total = sum(weights) or 1
    acc = 0
    for m, w in zip(open_ms, weights):
        acc += w
        m["targetDate"] = (ctx.today + timedelta(days=round(span * acc / total))).isoformat()


def autofix(plan, ctx):
    """Deterministic, safe fixes. Returns (plan, fixes) where each fix is an Issue with fixed=True."""
    fixes = []
    fix = lambda code, path, msg, sev=HARD: fixes.append(Issue(code, path, msg, sev, fixed=True))  # noqa: E731
    if not isinstance(plan, dict):
        return plan, fixes
    plan = copy.deepcopy(plan)

    # -- milestones --------------------------------------------------------------------------
    if ctx.mode != "expand":
        raw = plan.get("milestones")
        ms = [m for m in raw if isinstance(m, dict) and _title(m)] if isinstance(raw, list) else []
        if isinstance(raw, list) and len(ms) != len(raw):
            fix("SHAPE", "milestones", "dropped milestones without a title")
        taken = set()
        for i, m in enumerate(ms):
            est = _int(m.get("estimateMinutes"))
            if est is not None and est != m.get("estimateMinutes"):
                m["estimateMinutes"] = est
            mid = str(m.get("id") or "").strip()
            if not mid or mid in taken:
                m["id"] = _fresh_id("m", taken | {str(x.get("id")) for x in ms})
                fix("MILESTONE_FIELD", f"milestones[{i}]", "assigned a missing or duplicate id")
            else:
                m["id"] = mid
            taken.add(m["id"])
            if m.get("status") not in ("todo", "active", "done"):
                m["status"] = "todo"
            if ctx.mode == "plan" and m["status"] == "done":
                m["status"] = "todo"
        # replan: done milestones come back verbatim, in their original order, first.
        if ctx.mode == "replan" and ctx.done_milestones:
            by_id = {str(m.get("id")): m for m in ms}
            restored = []
            for dm in ctx.done_milestones:
                cur = by_id.get(str(dm.get("id")))
                if cur is None or cur.get("status") != "done" or _title(cur) != _title(dm):
                    fix("DONE_MILESTONE_CHANGED", "milestones", f"kept finished part {_title(dm)!r} unchanged")
                restored.append(copy.deepcopy(dm))
            done_ids = {str(dm.get("id")) for dm in ctx.done_milestones}
            rest = [m for m in ms if str(m.get("id")) not in done_ids]
            for m in rest:
                if m.get("status") == "done":
                    m["status"] = "todo"
            ms = restored + rest
        plan["milestones"] = ms
        cur = plan.get("currentMilestoneId")
        cm = _milestone(plan, cur) if cur is not None else None
        if cm is None or cm.get("status") == "done":
            first = next((m for m in ms if m.get("status") != "done"), None)
            if first is not None:
                plan["currentMilestoneId"] = first["id"]
                if cur is not None:
                    fix("BAD_CURRENT", "currentMilestoneId", f"pointed currentMilestoneId at {first['id']!r}")
        else:
            plan["currentMilestoneId"] = str(cur)
        for m in ms:
            if m.get("status") == "done":
                continue
            m["status"] = "active" if str(m["id"]) == str(plan.get("currentMilestoneId")) else "todo"

    mid = current_milestone_id(plan, ctx)

    # -- steps -----------------------------------------------------------------------------------
    raw_steps = plan.get("subtasks")
    steps = [s for s in raw_steps if isinstance(s, dict) and _title(s)] if isinstance(raw_steps, list) else []
    if isinstance(raw_steps, list) and len(steps) != len(raw_steps):
        fix("SHAPE", "subtasks", "dropped steps without a title")
    taken = {str(x) for x in ctx.existing_step_ids}
    for i, s in enumerate(steps):
        est = _int(s.get("timeEstimate"))
        if est is not None and est != s.get("timeEstimate"):
            s["timeEstimate"] = est
        if s.get("difficulty") not in VALID_DIFFICULTY:
            s["difficulty"] = "medium"
        sid = str(s.get("id") or "").strip()
        if not sid or sid in taken:
            s["id"] = _fresh_id("s", taken)
        else:
            s["id"] = sid
            taken.add(sid)
        if mid is not None and not s.get("milestoneId"):
            s["milestoneId"] = mid
        sd = _d(s.get("scheduledDate"))
        if sd is None or sd < ctx.today:
            s["scheduledDate"] = ctx.today.isoformat()
            fix("DATE_RANGE", f"subtasks[{i}].scheduledDate", "moved to today")
        elif sd > ctx.end:
            s["scheduledDate"] = ctx.end.isoformat()
            fix("DATE_RANGE", f"subtasks[{i}].scheduledDate", f"clamped to {ctx.end}")
    # Stable sort by date keeps the model's order within a day.
    ordered = sorted(steps, key=lambda s: s["scheduledDate"])
    if [id(s) for s in ordered] != [id(s) for s in steps]:
        fix("DATE_ORDER", "subtasks", "sorted steps by date")
    steps = ordered

    if steps:
        first = steps[0]
        est = first.get("timeEstimate")
        if not (_is_int(est) and 1 <= est <= FIRST_MAX) or first.get("scheduledDate") != ctx.today.isoformat():
            opener = _opener(_title(first), ctx, mid)
            opener["id"] = _fresh_id("s", taken)
            steps.insert(0, opener)
            fix("FIRST_STEP_SIZE", "subtasks[0]", "added a 3-minute opener as the first step")
    plan["subtasks"] = steps

    # -- prerequisites ------------------------------------------------------------------------------
    pres = plan.get("prerequisites")
    if isinstance(pres, list):
        clean = []
        for p in pres:
            if not isinstance(p, dict) or not _title(p):
                continue
            if p.get("kind") not in VALID_PREREQ_KINDS:
                p["kind"] = "setup"
            est = _int(p.get("timeEstimate"))
            if est is not None:
                p["timeEstimate"] = est
            if not p.get("id"):
                p["id"] = _fresh_id("p", taken)
            clean.append(p)
        plan["prerequisites"] = clean
    elif ctx.mode != "expand":
        plan["prerequisites"] = []

    # -- steps vs milestone estimate (steps are a lower bound, so raise the estimate) ----------------------
    batch = sum(s["timeEstimate"] for s in steps if _is_int(s.get("timeEstimate")))
    target = _milestone(plan, mid) if (mid and ctx.mode != "expand") else None
    if target is not None and _is_int(target.get("estimateMinutes")) and batch > target["estimateMinutes"]:
        fix("STEPS_EXCEED_MILESTONE", "milestones", f"raised {target['id']} estimate to {batch} min to cover its steps")
        target["estimateMinutes"] = batch
    if ctx.mode == "expand" and _is_int(plan.get("estimateMinutes")) and batch > plan["estimateMinutes"]:
        plan["estimateMinutes"] = batch

    # -- milestone target dates ------------------------------------------------------------------------------
    if ctx.mode != "expand":
        ms = plan["milestones"]
        open_dates = [_d(m.get("targetDate")) for m in ms if m.get("status") != "done"]
        bad = any(x is None or x < ctx.today or x > ctx.end for x in open_dates) or \
            any(a > b for a, b in zip(open_dates, open_dates[1:]))
        if bad and open_dates:
            _distribute_targets(ms, ctx)
            fix("DATE_RANGE", "milestones", "recomputed milestone target dates from the estimates")
    if "coversRest" not in plan or not isinstance(plan.get("coversRest"), bool):
        plan["coversRest"] = False
    return plan, fixes


# --- salvage -------------------------------------------------------------------------------------------

_STEP_DROP = {"STEP_SIZE", "STEP_MILESTONE", "AI_DELEGATION", "SHAPE"}


def _drop_ungrounded(plan, ctx):
    hay = "\n".join([ctx.pack_text or "", ctx.task_title or ""])

    def bad(text):
        return bool(ungrounded_names(text, hay, ctx.allowed_names))
    if ctx.mode != "expand":
        plan["milestones"] = [m for m in _milestones(plan)
                              if m.get("status") == "done" or not (bad(_title(m)) or bad(str(m.get("doneWhen") or "")))]
    plan["subtasks"] = [s for s in _steps(plan) if not bad(_title(s))]
    plan["prerequisites"] = [p for p in plan.get("prerequisites") or [] if isinstance(p, dict) and not bad(_title(p))]


def _drop_bad_items(plan, ctx):
    issues = validate(plan, ctx)
    bad_steps = {int(i.path.split("[")[1].split("]")[0]) for i in issues
                 if i.path.startswith("subtasks[") and i.code in _STEP_DROP}
    plan["subtasks"] = [s for k, s in enumerate(_steps(plan)) if k not in bad_steps]
    if ctx.mode != "expand":
        bad_ms = {int(i.path.split("[")[1].split("]")[0]) for i in issues
                  if i.path.startswith("milestones[") and i.code == "MILESTONE_FIELD"}
        plan["milestones"] = [m for k, m in enumerate(_milestones(plan)) if k not in bad_ms]


def salvage(candidates, ctx):
    """
    Best valid parts of the candidates: the one with fewer hard issues, minus
    invalid milestones and steps. Keeps valid milestones even if no step
    survives (the app then offers "Get next steps"). Returns (plan or None, issues).
    """
    scored = []
    for c in candidates:
        if not isinstance(c, dict):
            continue
        fixed, _ = autofix(c, ctx)
        scored.append((score_validity(validate(fixed, ctx)), fixed))
    if not scored:
        return None, [Issue("SHAPE", "$", "no usable reply")]
    scored.sort(key=lambda x: x[0])
    plan = copy.deepcopy(scored[0][1])

    _drop_ungrounded(plan, ctx)
    _drop_bad_items(plan, ctx)
    plan, _ = autofix(plan, ctx)
    issues = validate(plan, ctx)
    step_trouble = [i for i in hard_issues(issues) if i.path.startswith("subtasks") or i.code in (
        "FIRST_STEP_SIZE", "FIRST_STEP_DATE", "STEP_COUNT", "STEPS_EXCEED_MILESTONE")]
    if step_trouble and (ctx.mode == "expand" or _milestones(plan)):
        plan["subtasks"] = []
        plan["coversRest"] = False
        issues = validate(plan, ctx)
        if ctx.mode != "expand":
            issues = [i for i in issues if i.code != "STEP_COUNT"]
    if ctx.mode == "expand":
        if not _steps(plan):
            return None, issues
    elif not [m for m in _milestones(plan) if m.get("status") != "done"]:
        return None, issues
    milestone_trouble = [i for i in hard_issues(issues) if i.path.startswith("milestones") or i.code in (
        "NO_MILESTONES", "BAD_CURRENT", "SHAPE")]
    if milestone_trouble and ctx.mode != "expand":
        return None, issues
    return plan, issues
