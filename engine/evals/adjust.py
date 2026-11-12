# engine/evals/adjust.py
# Plan-adjustment (mutation) eval: runs each adjust_cases.json case through
# the real engine with a currentChecklist (exactly the payload the app's
# update-checklist IPC sends), then scores the replacement list both raw and
# after src/common/merge.ts's merge (ported in merge_port.py), because the
# merged list is what the student actually sees.
#
# Deterministic checks (all {"pass", "detail"}):
#   structure            replacement is well-formed (titles, int minutes, ISO dates)
#   done_kept            every done item comes back with the SAME id and title (raw output;
#                        merge.ts would rescue a dropped one, which we count separately)
#   ids_stable           no kept step reappears under a different id ("renumbered")
#   fresh_ids            ids unique; no original id recycled for an unrelated step
#   prereqs_preserved    every prerequisite survives unless the request is about them
#   no_unrequested_drop  no remaining step silently removed beyond what the request allows
#   request_satisfied    the request's concrete effect, checked on the merged list
#   new_dates_valid      (soft) new steps dated within [today, deadline]
#   no_merge_rescue      (soft) merge.ts did not have to restore dropped done items
# hard_pass = all but the two soft checks.

import json
import os
from datetime import date, timedelta

from common import EVALS_DIR, read_json
from engine_runner import _PROXY_DOWN_HINTS, invoke_engine, invocation_error
from merge_port import (
    derive_status, merge_checklist, normalize_title, requests_removing_completed, titles_similar,
)
from scorers import similarity

ADJUST_CASES_PATH = os.path.join(EVALS_DIR, "adjust_cases.json")
ADJUST_HARD = ["structure", "done_kept", "ids_stable", "fresh_ids", "prereqs_preserved",
               "no_unrequested_drop", "request_satisfied"]
ADJUST_SOFT = ["new_dates_valid", "no_merge_rescue"]
_VALID_DIFFICULTY = {"easy", "medium", "hard"}
_RATE_HINTS = ("RateLimitError", "429", "quota", "RESOURCE_EXHAUSTED")


def load_adjust_cases(only_ids=None):
    cases = (read_json(ADJUST_CASES_PATH) or {}).get("cases", [])
    if only_ids:
        cases = [c for c in cases if c["id"] in set(only_ids)]
    return cases


def _check(ok, detail=""):
    return {"pass": bool(ok), "detail": detail}


def _date(s):
    try:
        return date.fromisoformat(str(s))
    except (TypeError, ValueError):
        return None


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def materialize_checklist(case, today):
    """Turns the compact case checklist (day offsets, min, done) into the
    app's DecompositionResult shape."""
    cl = case["checklist"]
    subs = []
    for s in cl["subtasks"]:
        d = today + timedelta(days=int(s.get("day", 0)))
        done = bool(s.get("done"))
        item = {
            "id": s["id"],
            "title": s["title"],
            "difficulty": s.get("difficulty") or ("easy" if s["min"] <= 15 else "medium"),
            "timeEstimate": s["min"],
            "scheduledDate": d.isoformat(),
            "isCompleted": done,
            "status": "done" if done else "todo",
        }
        if done:
            item["completedAt"] = f"{d.isoformat()}T08:00:00.000Z"
        subs.append(item)
    pres = []
    for p in cl.get("prerequisites") or []:
        item = {"id": p["id"], "title": p["title"], "kind": p["kind"], "isCompleted": bool(p.get("done"))}
        if p.get("min") is not None:
            item["timeEstimate"] = p["min"]
        pres.append(item)
    return {"originalTask": cl["originalTask"], "prerequisites": pres, "subtasks": subs}


def build_adjust_payload(case, model, today):
    deadline = (today + timedelta(days=int(case.get("deadline_offset_days", 7)))).isoformat()
    # Mirrors src/main/index.ts 'update-checklist': the request is the ONLY
    # message, no stream flag, planModel = the configured plan/chat model.
    return {
        "projectId": "eval",
        "messages": [{"role": "user", "content": case["request"]}],
        "deadline": deadline,
        "depth": case.get("depth", "Brief"),
        "model": model,
        "planModel": model,
        "contextLedger": case.get("context_ledger") or "",
        "userProfile": case.get("user_profile") or "",
        "currentChecklist": materialize_checklist(case, today),
    }


def run_adjust(python, case, model, sample=0):
    today = date.today()
    payload = build_adjust_payload(case, model, today)
    record = {"case_id": case["id"], "model": model, "mode": "adjust", "sample": sample,
              "run_date": today.isoformat(), "payload": payload, "tokens": 0, "ttft_s": None,
              "latency_s": None, "result": None, "error": None, "stderr_tail": "", "bad_lines": []}
    inv = invoke_engine(python, payload)
    if inv.get("spawn_error"):
        record.update(error="spawn_failed", stderr_tail=inv["spawn_error"])
        return record
    for k in ("tokens", "ttft_s", "latency_s", "stderr_tail", "bad_lines", "result"):
        record[k] = inv[k]
    record["error"] = adjust_error(inv["result"], invocation_error(inv))
    return record


def adjust_error(result, base_error):
    """The mutation path reports failures as status 'error' (not the clarify
    path's apology prose), so re-split rate limits out as infra here."""
    if result and result.get("status") == "error":
        msg = result.get("message") or ""
        if any(h in msg for h in _RATE_HINTS) or "quota" in msg.lower():
            return "rate_limited"
        if any(h in msg for h in _PROXY_DOWN_HINTS):
            return "proxy_unavailable"
        if "LLM Provider NOT provided" in msg:
            return "engine_misconfigured"
        if any(h in msg for h in ("JSONDecodeError", "Expecting value", "no JSON", "Unterminated string")):
            return "json_parse_failure"
        return "engine_error"
    if base_error:
        return base_error
    if (result or {}).get("status") != "updated":
        return "unexpected_status"
    if not isinstance((result or {}).get("data"), dict):
        return "no_data"
    return None


def _strict_similar(a, b):
    """Same step, possibly lightly reworded (stricter than merge.ts's loose
    titles_similar, which treats 'Write intro' ~ 'Write conclusion')."""
    if normalize_title(a) == normalize_title(b):
        return True
    ratio, jac = similarity(a, b)
    return ratio >= 0.8 or jac >= 0.7


def _classify(orig_items, out_items, reuse_ok, all_orig_ids):
    """Labels each output item kept / renumbered / recycled / new, and lists
    original items that vanished. Returns (labels, dropped_orig, renumbered_pairs)."""
    by_id = {str(o["id"]): o for o in orig_items}
    labels = []
    id_hit = set()
    for o in out_items:
        oid = str(o.get("id"))
        x = by_id.get(oid)
        if x is not None and (titles_similar(x["title"], o.get("title")) or _strict_similar(x["title"], o.get("title"))
                              or oid in reuse_ok):
            labels.append(("kept", x))
            id_hit.add(str(x["id"]))
        elif oid in all_orig_ids:
            labels.append(("recycled", by_id.get(oid)))
        else:
            labels.append(("new", None))
    renumbered = []
    for i, (lab, _x) in enumerate(labels):
        if lab not in ("new", "recycled"):
            continue
        title = out_items[i].get("title")
        for x in orig_items:
            if (str(x["id"]) not in id_hit and str(x["id"]) not in reuse_ok
                    and str(x["id"]) != str(out_items[i].get("id")) and _strict_similar(x["title"], title)):
                renumbered.append((x, out_items[i]))
                id_hit.add(str(x["id"]))
                if lab == "new":
                    labels[i] = ("renumbered", x)
                break
    dropped = [x for x in orig_items if str(x["id"]) not in id_hit]
    return labels, dropped, renumbered


def next_weekday_after(today, weekday):
    """The coming <weekday> strictly after today (Mon=0 ... Fri=4)."""
    ahead = (weekday - today.weekday()) % 7
    return today + timedelta(days=ahead or 7)


def score_adjust(record, case):
    result = record.get("result") or {}
    data = result.get("data") if isinstance(result.get("data"), dict) else {}
    payload = record["payload"]
    orig = payload["currentChecklist"]
    request = payload["messages"][-1]["content"]
    today = _date(record.get("run_date")) or date.today()
    deadline = _date(payload.get("deadline")) or today + timedelta(days=7)
    expect = case.get("expect") or {}
    reuse_ok = {str(i) for i in case.get("id_reuse_ok") or []}
    checks = {}

    out_subs = [s for s in (data.get("subtasks") or []) if isinstance(s, dict)]
    out_pres = [p for p in (data.get("prerequisites") or []) if isinstance(p, dict)] \
        if isinstance(data.get("prerequisites"), list) else []
    orig_subs, orig_pres = orig["subtasks"], orig.get("prerequisites") or []
    all_orig_ids = {str(x["id"]) for x in orig_subs + orig_pres}

    # -- structure -----------------------------------------------------------
    problems = []
    if not out_subs:
        problems.append("no subtasks")
    if data.get("prerequisites") is not None and not isinstance(data.get("prerequisites"), list):
        problems.append("prerequisites not a list")
    for i, s in enumerate(out_subs):
        if not (isinstance(s.get("title"), str) and s["title"].strip()):
            problems.append(f"subtask[{i}] no title")
        if s.get("id") in (None, ""):
            problems.append(f"subtask[{i}] no id")
        if not (_is_int(s.get("timeEstimate")) and s["timeEstimate"] > 0):
            problems.append(f"subtask[{i}] timeEstimate={s.get('timeEstimate')!r}")
        if _date(s.get("scheduledDate")) is None:
            problems.append(f"subtask[{i}] scheduledDate={s.get('scheduledDate')!r}")
        if s.get("difficulty") not in _VALID_DIFFICULTY:
            problems.append(f"subtask[{i}] difficulty={s.get('difficulty')!r}")
    checks["structure"] = _check(not problems, "; ".join(problems[:4]))

    # -- done items kept verbatim (raw output) -------------------------------
    remove_done = expect.get("type") == "remove_done"
    done_orig = [("sub", s) for s in orig_subs if derive_status(s) == "done"] + \
                [("pre", p) for p in orig_pres if p.get("isCompleted")]
    missing = []
    for kind, x in done_orig:
        pool = out_subs if kind == "sub" else out_pres
        if not any(str(o.get("id")) == str(x["id"]) and (o.get("title") or "").strip() == x["title"].strip() for o in pool):
            near = next((o for o in pool if str(o.get("id")) == str(x["id"])), None)
            missing.append(f"{x['id']}:{x['title']!r}" + (f" -> {near.get('title')!r}" if near else " (dropped)"))
    if remove_done:
        checks["done_kept"] = _check(True, "n/a: request removes finished work")
    else:
        checks["done_kept"] = _check(not missing, "; ".join(missing[:3]))

    # -- id stability ----------------------------------------------------------
    sub_labels, sub_dropped, sub_renum = _classify(orig_subs, out_subs, reuse_ok, all_orig_ids)
    pre_labels, pre_dropped, pre_renum = _classify(orig_pres, out_pres, reuse_ok, all_orig_ids)
    renum = sub_renum + pre_renum
    checks["ids_stable"] = _check(
        not renum, "; ".join(f"{x['id']}:{x['title']!r} came back as id {o.get('id')!r}" for x, o in renum[:3]))
    out_ids = [str(o.get("id")) for o in out_subs + out_pres]
    dup = sorted({i for i in out_ids if out_ids.count(i) > 1})
    recycled = [(out_subs + out_pres)[i] for i, (lab, _x) in enumerate(sub_labels + pre_labels) if lab == "recycled"]
    detail = []
    if dup:
        detail.append(f"duplicate ids {dup[:4]}")
    if recycled:
        detail.append("; ".join(f"id {o.get('id')!r} reused for new step {o.get('title')!r}" for o in recycled[:2]))
    checks["fresh_ids"] = _check(not dup and not recycled, "; ".join(detail))

    # -- prerequisites preserved ---------------------------------------------
    if case.get("prereq_change_ok"):
        checks["prereqs_preserved"] = _check(True, "n/a: request is about prerequisites")
    else:
        lost = [p for p in pre_dropped]
        checks["prereqs_preserved"] = _check(not lost, "; ".join(f"{p['id']}:{p['title']!r} dropped" for p in lost[:3]))

    # -- no unrequested drops ----------------------------------------------------
    allowed = case.get("allowed_drops", [])
    todo_dropped = [x for x in sub_dropped if derive_status(x) != "done"]
    if allowed == "any":
        checks["no_unrequested_drop"] = _check(True, f"{len(todo_dropped)} remaining step(s) removed (allowed)")
    else:
        bad = [x for x in todo_dropped if str(x["id"]) not in {str(a) for a in allowed}]
        checks["no_unrequested_drop"] = _check(not bad, "; ".join(f"{x['id']}:{x['title']!r}" for x in bad[:3]))

    # -- the merged view (what the app shows) -----------------------------------
    allow_drop = requests_removing_completed(request)
    merged = merge_checklist(orig, {"subtasks": out_subs, "prerequisites": out_pres,
                                    "completedIds": data.get("completedIds") or []},
                             allow_drop_completed=allow_drop)
    m_todo = [s for s in merged["subtasks"] if derive_status(s) != "done"]
    o_todo = [s for s in orig_subs if derive_status(s) != "done"]
    o_idx = {str(s["id"]): i for i, s in enumerate(orig_subs)}
    restored = len(merged["restoredSubtasks"]) + len(merged["restoredPrerequisites"])

    def mins(items):
        return sum(s["timeEstimate"] for s in items if _is_int(s.get("timeEstimate")))

    t = expect.get("type")
    ok, why = False, f"unknown expect type {t!r}"
    if t == "shorter":
        nb, na, mb, ma = len(o_todo), len(m_todo), mins(o_todo), mins(m_todo)
        ok = na < nb or ma <= 0.8 * mb
        why = f"remaining steps {nb} -> {na}, minutes {mb} -> {ma}"
    elif t == "expand":
        ti = o_idx[str(expect["target"])]
        pieces = [s for s in m_todo if s["_origin"] is None or s["_origin"] == ti]
        target_left = [s for s in m_todo if s["_origin"] == ti]
        kw = [k.lower() for k in expect.get("keywords") or []]
        related = [s for s in pieces if any(k in (s.get("title") or "").lower() for k in kw)]
        grew = len(m_todo) >= len(o_todo) + 1
        ok = len(pieces) >= 2 and bool(related) and grew
        why = (f"{len(pieces)} piece(s) replacing step {expect['target']} ({len(related)} on-topic), "
               f"target {'kept/reworded' if target_left else 'removed'}, remaining {len(o_todo)} -> {len(m_todo)}")
    elif t == "remove":
        still = []
        for tid in expect["targets"]:
            ti = o_idx[str(tid)]
            ttitle = orig_subs[ti]["title"]
            if any(s["_origin"] == ti or _strict_similar(ttitle, s.get("title")) for s in m_todo):
                still.append(ttitle)
        ok = not still
        why = f"still in plan: {still}" if still else "removed"
    elif t == "dates_after_weekday":
        pivot = next_weekday_after(today, int(expect.get("weekday", 4)))
        bad = [(s.get("title"), s.get("scheduledDate")) for s in m_todo
               if not (_date(s.get("scheduledDate")) and pivot < _date(s["scheduledDate"]) <= deadline)]
        ok = not bad and bool(m_todo)
        why = f"{len(bad)}/{len(m_todo)} remaining step(s) not in ({pivot}, {deadline}]" + (f" e.g. {bad[:2]}" if bad else "")
    elif t == "dates_from_today":
        bad = [(s.get("title"), s.get("scheduledDate")) for s in m_todo
               if not (_date(s.get("scheduledDate")) and today <= _date(s["scheduledDate"]) <= deadline)]
        first = _date(m_todo[0].get("scheduledDate")) if m_todo else None
        ok = not bad and first == today
        why = f"{len(bad)}/{len(m_todo)} outside [{today}, {deadline}]; first remaining step on {first}" + (f"; e.g. {bad[:2]}" if bad else "")
    elif t == "add":
        groups = [[k.lower() for k in g] for g in expect["keyword_groups"]]
        new = [s for s in m_todo if s["_origin"] is None]
        hits = [s for s in new if all(any(k in (s.get("title") or "").lower() for k in g) for g in groups)]
        ok = bool(hits)
        why = f"{len(new)} new step(s); matching: {[s.get('title') for s in hits][:2] or [s.get('title') for s in new][:2]}"
    elif t == "max_minutes":
        cap = int(expect["max"])
        over = [(s.get("title"), s.get("timeEstimate")) for s in m_todo
                if not (_is_int(s.get("timeEstimate")) and s["timeEstimate"] <= cap)]
        mb, ma = mins(o_todo), mins(m_todo)
        enough = ma >= float(expect.get("min_total_ratio", 0.7)) * mb
        ok = not over and enough
        why = f"{len(over)} step(s) over {cap} min" + (f" e.g. {over[:2]}" if over else "") + f"; minutes {mb} -> {ma}"
    elif t == "order":
        bi, ai = o_idx[str(expect["before"])], o_idx[str(expect["after"])]
        pos_b = next((k for k, s in enumerate(merged["subtasks"]) if s["_origin"] == bi and derive_status(s) != "done"), None)
        pos_a = next((k for k, s in enumerate(merged["subtasks"]) if s["_origin"] == ai and derive_status(s) != "done"), None)
        if pos_b is None or pos_a is None:
            ok, why = False, f"step {'before' if pos_b is None else 'after'} lost its id/title"
        else:
            db, da = _date(merged["subtasks"][pos_b].get("scheduledDate")), _date(merged["subtasks"][pos_a].get("scheduledDate"))
            ok = pos_b < pos_a and db is not None and da is not None and db <= da
            why = f"positions {pos_b} vs {pos_a}, dates {db} vs {da}"
    elif t == "remove_done":
        raw_done = [o.get("title") for o in out_subs
                    if any(str(o.get("id")) == str(x["id"]) or normalize_title(o.get("title")) == normalize_title(x["title"])
                           for _k, x in done_orig)]
        left = [s.get("title") for s in merged["subtasks"] if derive_status(s) == "done"]
        ok = not raw_done and not left and allow_drop
        why = (f"raw output still lists done: {raw_done[:2]}; " if raw_done else "") + \
              f"after merge {len(left)} done shown; app regex allowDropCompleted={allow_drop}"
    elif t == "mark_done":
        # "I already did X": the step must end up DONE (with credit), not just vanish.
        marked = {str(s.get("id")) for s in merged.get("completedSubtasks") or []}
        missing = [str(tid) for tid in expect["targets"] if str(tid) not in marked]
        others = [s.get("title") for s in merged.get("completedSubtasks") or []
                  if str(s.get("id")) not in {str(x) for x in expect["targets"]}]
        ok = not missing and not others
        why = (f"not marked done: {missing}; " if missing else "") + (f"also marked: {others}" if others else "") \
            or f"marked done: {sorted(marked)}"
    elif t == "remove_prereq":
        still = []
        for tid in expect["targets"]:
            x = next(p for p in orig_pres if str(p["id"]) == str(tid))
            if any(str(o.get("id")) == str(tid) or _strict_similar(x["title"], o.get("title")) for o in out_pres + out_subs):
                still.append(x["title"])
        others = [p for p in pre_dropped if str(p["id"]) not in {str(i) for i in expect["targets"]}]
        ok = not still and not others
        why = (f"still present: {still}; " if still else "") + (f"also dropped {[p['title'] for p in others]}" if others else "")
    checks["request_satisfied"] = _check(ok, why)

    # -- soft ---------------------------------------------------------------------
    new_items = [s for s in m_todo if s["_origin"] is None]
    bad_new = [(s.get("title"), s.get("scheduledDate")) for s in new_items
               if not (_date(s.get("scheduledDate")) and today <= _date(s["scheduledDate"]) <= deadline)]
    checks["new_dates_valid"] = _check(not bad_new, f"{len(bad_new)} new step(s) outside [{today}, {deadline}]" + (f" e.g. {bad_new[:2]}" if bad_new else ""))
    checks["no_merge_rescue"] = _check(restored == 0, f"merge.ts restored {restored} dropped done item(s)" if restored else "")

    hard_pass = all(checks[k]["pass"] for k in ADJUST_HARD)
    return {
        "checks": checks,
        "hard_pass": hard_pass,
        "all_pass": hard_pass and all(checks[k]["pass"] for k in ADJUST_SOFT),
        "todo_before": len(o_todo),
        "todo_after": len(m_todo),
        "restored": restored,
        "new_steps": len(new_items),
    }


def checklist_view(cl, with_status=True):
    """Compact JSON for the judge prompt. The engine's reply format has no
    status field (the app re-derives it by id on merge), so the reply is shown
    without statuses rather than as if done items had lost theirs."""
    def sv(s):
        status = derive_status(s) if with_status and ("status" in s or "isCompleted" in s) else None
        v = {"id": s.get("id"), "title": s.get("title"), "min": s.get("timeEstimate"), "date": s.get("scheduledDate")}
        if status:
            v["status"] = status
        return v
    return json.dumps({
        "prerequisites": [{"id": p.get("id"), "title": p.get("title"), "kind": p.get("kind"),
                           **({"status": "done" if p.get("isCompleted") else "todo"} if with_status and "isCompleted" in p else {})}
                          for p in (cl or {}).get("prerequisites") or [] if isinstance(p, dict)],
        "subtasks": [sv(s) for s in (cl or {}).get("subtasks") or [] if isinstance(s, dict)],
    }, indent=1)
