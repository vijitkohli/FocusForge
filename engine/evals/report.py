# engine/evals/report.py
# Aggregates cached raw engine outputs + judge verdicts into REPORT.md and
# results/summary.json. Pure read of the cache - never calls a model, so it
# can be re-run freely after tweaking scorers.
#
#   engine/env/bin/python engine/evals/report.py [--models ...] [--judge-model ...]

import argparse
import glob
import json
import os
import statistics
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (  # noqa: E402
    ANALYSIS_PATH, DEFAULT_JUDGE, JUDGE_DIR, RAW_DIR, REPORT_PATH, RESULTS_DIR,
    judge_path, load_cases, raw_fingerprint, read_json, slug, write_json,
)
from engine_runner import INFRA_ERRORS, classify_error, effective_error  # noqa: E402
from adjust import ADJUST_HARD, adjust_error, load_adjust_cases, score_adjust  # noqa: E402
from judge import ADJUST_DIMENSIONS, COVERAGE_DIMENSION, MULTITURN_DIMENSIONS, PLAN_DIMENSIONS  # noqa: E402
from multiturn import load_multiturn_cases, score_multiturn  # noqa: E402
from scorers import COVERAGE_PASS_RATIO, score_clarify, score_plan  # noqa: E402

MT_COLUMNS = [
    ("plan_built", "plan built"),
    ("turns_in_bounds", "turns ok"),
    ("no_repeat", "no repeat"),
    ("no_already_answered", "no re-ask"),
    ("one_question", "one q."),
    ("notes_recall", "notes recall"),
    ("user_notes_clean", "profile clean"),
    ("no_ledger_renotes", "no re-note"),
    ("notes_filed", "notes filed"),
    ("notes_no_dupes", "no dup notes"),
    ("plan_mentions", "plan uses answers"),
    ("plan_forbidden", "no redo"),
    ("plan_max_minutes", "step limit"),
]
ADJ_COLUMNS = [
    ("structure", "structure"),
    ("done_kept", "done kept"),
    ("ids_stable", "ids stable"),
    ("fresh_ids", "fresh ids"),
    ("prereqs_preserved", "prereqs kept"),
    ("no_unrequested_drop", "no extra drops"),
    ("request_satisfied", "request met"),
    ("new_dates_valid", "new dates ok"),
    ("no_merge_rescue", "no merge rescue"),
]

CHECK_COLUMNS = [
    ("count", "count"),
    ("time_estimates", "time"),
    ("first_step_small", "1st≤15m"),
    ("first_step_today", "1st today"),
    ("dates_in_range", "dates"),
    ("dates_spread", "spread"),
    ("dates_monotonic", "in order"),
    ("no_vague_verbs", "no-vague"),
    ("original_task_ok", "title"),
    ("prerequisites_valid", "prereq"),
    ("no_redundant_work", "no-redund."),
]


def _infra(block):
    return f" (+{block['infra']} infra)" if block.get("infra") else ""


def _pct(num, den):
    return f"{100.0 * num / den:.0f}%" if den else "–"


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return statistics.mean(xs) if xs else None


def _median(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def _fmt(x, nd=2):
    return "–" if x is None else f"{x:.{nd}f}"


def _load_verdict(judge_model, model, case_id, mode, rec):
    """Cached verdict for this exact raw output, or None (stale verdicts from a
    since-overwritten engine run are ignored when they recorded a fingerprint)."""
    j = read_json(judge_path(judge_model, model, case_id, mode, rec.get("sample", 0)))
    if not (j and j.get("scores")):
        return None
    fp = j.get("raw_fingerprint")
    if fp is not None and fp != raw_fingerprint(rec):
        return None
    return j


def _cov_score(r):
    s = (r.get("judge") or {}).get("scores", {}).get(COVERAGE_DIMENSION) or {}
    return s.get("score")


def cached_models():
    if not os.path.isdir(RAW_DIR):
        return []
    models = set()
    for path in glob.glob(os.path.join(RAW_DIR, "*", "*.json")):
        rec = read_json(path)
        if rec and rec.get("model"):
            models.add(rec["model"])
    return sorted(models)


def load_records(model, cases, mode):
    out = []
    for case in cases:
        pattern = os.path.join(RAW_DIR, slug(model), f"{case['id']}.{mode}.*.json")
        for path in sorted(glob.glob(pattern)):
            rec = read_json(path)
            if rec and rec.get("model") == model and rec.get("mode", mode) == mode:
                rec["error"] = record_error(rec)
                out.append((case, rec))
    return out


def _render_two_level(models, judge_model):
    """Two-level plan section (plan_eval.py); empty when no plan-mode results are cached."""
    from plan_eval import aggregate_two_level, render_two_level

    def records(model, cases, mode):
        return [rec for _case, rec in load_records(model, cases, mode)]
    agg = {m: aggregate_two_level(m, judge_model, records, _load_verdict, record_error, INFRA_ERRORS) for m in models}
    return render_two_level(models, agg, judge_model)


def record_error(rec):
    """Error kind re-derived with the current rules, for every mode."""
    mode = rec.get("mode")
    if mode in ("plan", "expand", "replan"):
        return rec.get("error")
    if mode == "adjust":
        if rec.get("error") in ("engine_error", "json_parse_failure", "rate_limited", "proxy_unavailable"):
            return adjust_error(rec.get("result"), None)
        return rec.get("error")
    if mode == "multiturn":
        if rec.get("error") in ("engine_error", "engine_exception", "json_parse_failure"):
            return classify_error(rec.get("result")) or rec["error"]
        return rec.get("error")
    return effective_error(rec)


def _aggregate_scored(model, cases, mode, judge_model, score_fn, columns, dims):
    """Shared aggregation for the multiturn and adjust modes."""
    recs = load_records(model, cases, mode)
    infra = sum(1 for _c, r in recs if r["error"] in INFRA_ERRORS)
    rows = []
    for case, rec in recs:
        if rec["error"] in INFRA_ERRORS:
            continue
        row = {"case_id": case["id"], "case": case, "sample": rec.get("sample", 0), "error": rec.get("error"),
               "record": rec, "latency_s": rec.get("latency_s")}
        # multiturn: a conversation that errored mid-way is still scored (plan_built fails)
        if not rec.get("error") or mode == "multiturn":
            row["score"] = score_fn(rec, case)
            row["judge"] = _load_verdict(judge_model, model, case["id"], mode, rec)
        rows.append(row)
    scored = [r for r in rows if r.get("score")]
    ok = [r for r in rows if not r["error"]]
    judged = [r for r in rows if r.get("judge")]
    out = {
        "n": len(rows), "infra": infra, "errors": len(rows) - len(ok),
        "error_kinds": _count(r["error"] for r in rows if r["error"]),
        "scored": len(scored),
        "hard_pass": sum(r["score"]["hard_pass"] for r in scored),
        "all_pass": sum(r["score"]["all_pass"] for r in scored),
        "checks": {k: {"pass": sum(r["score"]["checks"][k]["pass"] for r in scored if k in r["score"]["checks"]),
                       "n": sum(1 for r in scored if k in r["score"]["checks"])} for k, _l in columns},
        "judge": {d: _mean(r["judge"]["scores"][d]["score"] for r in judged) for d in dims},
        "judged": len(judged),
        "judged_by_fallback": sum(1 for r in judged if r["judge"].get("judge_model_used") not in (None, judge_model)),
        "median_latency_s": _median(r["latency_s"] for r in ok),
    }
    out["judge"]["mean"] = _mean(_mean(r["judge"]["scores"][d]["score"] for d in dims) for r in judged)
    return out, rows


def aggregate(models, cases, judge_model):
    summary = {}
    for model in models:
        m = {"model": model}

        # ---- execute -----------------------------------------------------
        ex = load_records(model, cases, "execute")
        infra_ex = sum(1 for _c, r in ex if r["error"] in INFRA_ERRORS)
        ex = [(c, r) for c, r in ex if r["error"] not in INFRA_ERRORS]
        rows = []
        for case, rec in ex:
            row = {"case_id": case["id"], "sample": rec.get("sample", 0), "latency_s": rec.get("latency_s"),
                   "error": rec.get("error"), "record": rec}
            if not rec.get("error"):
                row["score"] = score_plan(rec, case)
                row["judge"] = _load_verdict(judge_model, model, case["id"], "execute", rec)
            rows.append(row)
        ok = [r for r in rows if not r["error"]]
        m["execute"] = {
            "n": len(rows),
            "infra": infra_ex,
            "errors": len(rows) - len(ok),
            "error_kinds": _count(r["error"] for r in rows if r["error"]),
            "hard_pass": sum(r["score"]["hard_pass"] for r in ok),
            "all_pass": sum(r["score"]["all_pass"] for r in ok),
            "checks": {},
            "judge": {},
            "median_latency_s": _median(r["latency_s"] for r in rows if not r["error"]),
            "median_subtasks": _median(r["score"]["subtask_count"] for r in ok),
        }
        for key, _label in CHECK_COLUMNS:
            applicable = [r for r in ok if key in r["score"]["checks"]]
            m["execute"]["checks"][key] = {
                "pass": sum(r["score"]["checks"][key]["pass"] for r in applicable),
                "n": len(applicable),
            }
        cov = [r["score"]["coverage"] for r in ok if r["score"].get("coverage")]
        m["execute"]["coverage"] = {
            "n": len(cov),
            "pass": sum(c["pass"] for c in cov),
            "over": sum(c["over"] for c in cov),
            "median_ratio": _median(c["ratio"] for c in cov),
            "median_planned_minutes": _median(c["planned_minutes"] for c in cov),
            "median_expected_min": _median(c["expected"][0] for c in cov),
        }
        judged = [r for r in ok if r.get("judge")]
        for d in PLAN_DIMENSIONS:
            m["execute"]["judge"][d] = _mean(r["judge"]["scores"][d]["score"] for r in judged)
        m["execute"]["judge"][COVERAGE_DIMENSION] = _mean(_cov_score(r) for r in judged)
        m["execute"]["judge_coverage_n"] = sum(_cov_score(r) is not None for r in judged)
        m["execute"]["judge"]["mean"] = _mean(
            _mean(r["judge"]["scores"][d]["score"] for d in PLAN_DIMENSIONS) for r in judged
        )
        m["execute"]["judged"] = len(judged)
        m["_rows_execute"] = rows

        # ---- clarify -----------------------------------------------------
        cl = load_records(model, cases, "clarify")
        infra_cl = sum(1 for _c, r in cl if r["error"] in INFRA_ERRORS)
        cl = [(c, r) for c, r in cl if r["error"] not in INFRA_ERRORS]
        crow = []
        for case, rec in cl:
            row = {"case_id": case["id"], "sample": rec.get("sample", 0), "latency_s": rec.get("latency_s"),
                   "ttft_s": rec.get("ttft_s"), "error": rec.get("error"), "record": rec}
            row["c"] = score_clarify(rec, case)
            if row["c"]["asked"]:
                row["judge"] = _load_verdict(judge_model, model, case["id"], "clarify", rec)
            crow.append(row)
        cok = [r for r in crow if not r["error"]]
        expect_ask = [r for r in cok if r["c"]["expect"] == "ask"]
        expect_ready = [r for r in cok if r["c"]["expect"] == "ready"]
        qjudged = [r for r in cok if r.get("judge")]
        m["clarify"] = {
            "n": len(crow),
            "infra": infra_cl,
            "errors": len(crow) - len(cok),
            "error_kinds": _count(r["error"] for r in crow if r["error"]),
            "asked": sum(r["c"]["asked"] for r in cok),
            "skipped": sum(r["c"]["skipped"] for r in cok),
            "expect_ask_n": len(expect_ask),
            "expect_ask_skipped": sum(r["c"]["skipped"] for r in expect_ask),
            "expect_ready_n": len(expect_ready),
            "expect_ready_asked": sum(r["c"]["asked"] for r in expect_ready),
            "appropriate": sum(r["c"]["appropriate"] for r in cok),
            "multi_question": sum(r["c"]["multi_question"] for r in cok),
            "question_quality": _mean(r["judge"]["scores"]["question_quality"]["score"] for r in qjudged),
            "median_question_words": _median(r["c"]["question_words"] for r in cok if r["c"]["asked"]),
            # TTFT only exists when a question streamed; skips go straight to execution.
            "median_ttft_s": _median(r["ttft_s"] for r in cok if r["c"]["asked"]),
            "median_latency_asked_s": _median(r["latency_s"] for r in cok if r["c"]["asked"]),
        }
        m["_rows_clarify"] = crow

        # ---- multiturn / adjust ----------------------------------------------
        mt_cases, adj_cases = load_multiturn_cases(), load_adjust_cases()
        m["multiturn"], m["_rows_multiturn"] = _aggregate_scored(
            model, mt_cases, "multiturn", judge_model, score_multiturn, MT_COLUMNS, MULTITURN_DIMENSIONS)
        mts = [r for r in m["_rows_multiturn"] if r.get("score")]
        m["multiturn"]["median_questions"] = _median(r["score"]["questions"] for r in mts)
        m["multiturn"]["notes_hits"] = sum(r["score"]["notes_hits"] for r in mts)
        m["multiturn"]["notes_expected"] = sum(r["score"]["notes_expected"] for r in mts)
        m["multiturn"]["plan_hard"] = sum(1 for r in mts if r["score"]["plan_hard"])
        m["multiturn"]["plans"] = sum(1 for r in mts if r["score"]["plan_hard"] is not None)
        m["adjust"], m["_rows_adjust"] = _aggregate_scored(
            model, adj_cases, "adjust", judge_model, score_adjust, ADJ_COLUMNS, ADJUST_DIMENSIONS)
        m["adjust"]["restored"] = sum(r["score"]["restored"] for r in m["_rows_adjust"] if r.get("score"))
        summary[model] = m
    return summary


def _count(items):
    out = {}
    for i in items:
        out[i] = out.get(i, 0) + 1
    return out


def _excerpt_plan(rec, k=6):
    data = (rec.get("result") or {}).get("data") or {}
    lines = [f"  - originalTask: {data.get('originalTask')!r}"]
    for p in (data.get("prerequisites") or [])[:3]:
        if isinstance(p, dict):
            lines.append(f"  - [prereq/{p.get('kind')}] {p.get('title')}")
    subs = data.get("subtasks") or []
    for s in subs[:k]:
        if isinstance(s, dict):
            lines.append(f"  - {s.get('title')} — {s.get('timeEstimate')} min, {s.get('scheduledDate')}")
    if len(subs) > k:
        lines.append(f"  - … (+{len(subs) - k} more)")
    return "\n".join(lines)


def _composite_exec(m):
    e = m["execute"]
    ok = e["n"] - e["errors"]
    if not ok or e["judge"].get("mean") is None:
        return None
    # judge mean (1-5) normalised to 0-1, blended with deterministic hard-pass
    # rate and penalised by error rate.
    return round(0.6 * (e["judge"]["mean"] - 1) / 4 + 0.4 * e["hard_pass"] / ok - (e["errors"] / e["n"]), 3)


def _composite_clarify(m):
    c = m["clarify"]
    ok = c["n"] - c["errors"]
    if not ok:
        return None
    q = c["question_quality"]
    qn = (q - 1) / 4 if q is not None else 0.5
    return round(0.5 * c["appropriate"] / ok + 0.5 * qn - (c["errors"] / c["n"]), 3)


def judge_agreement(models, cases, judge_model):
    """
    Cross-judge calibration: wherever another judge also graded the same
    execute output, compare its scores with the primary judge's.
    """
    out = []
    if not os.path.isdir(JUDGE_DIR):
        return out
    for other_dir in sorted(os.listdir(JUDGE_DIR)):
        if other_dir == slug(judge_model):
            continue
        pairs = []
        for model in models:
            for case in cases:
                for path in glob.glob(os.path.join(JUDGE_DIR, other_dir, slug(model), f"{case['id']}.execute.*.json")):
                    sample = int(path.rsplit(".", 2)[-2])
                    a = read_json(judge_path(judge_model, model, case["id"], "execute", sample))
                    b = read_json(path)
                    if a and b and a.get("scores") and b.get("scores"):
                        pairs.append((model, a["scores"], b["scores"]))
        if len(pairs) < 5:
            continue
        dims = {}
        for d in PLAN_DIMENSIONS:
            diffs = [pa[d]["score"] - pb[d]["score"] for _m, pa, pb in pairs]
            dims[d] = {
                "mean_diff": statistics.mean(diffs),
                "mad": statistics.mean(abs(x) for x in diffs),
                "within1": sum(abs(x) <= 1 for x in diffs) / len(diffs),
            }
        per_model = {}
        for m, pa, pb in pairs:
            per_model.setdefault(m, []).append((_mean(pa[d]["score"] for d in PLAN_DIMENSIONS), _mean(pb[d]["score"] for d in PLAN_DIMENSIONS)))
        out.append({"other": other_dir, "n": len(pairs), "dims": dims,
                    "per_model": {m: (_mean(a for a, _b in v), _mean(b for _a, b in v), len(v)) for m, v in per_model.items()}})
    return out


def render(summary, cases, judge_model):
    models = list(summary)
    L = []
    L.append("# Engine eval report")
    L.append("")
    L.append(f"_Generated {datetime.now().strftime('%Y-%m-%d %H:%M')} by `engine/evals/report.py` from cached results. "
             f"{len(cases)} cases, judge = `{judge_model}`. Regenerate with `npm run eval -- --report-only --judge-model {judge_model}`._")
    L.append("")
    L.append("## Execution phase (forced checklist)")
    L.append("")
    L.append("`runs` excludes infra failures (proxy rate limits/quota, timeouts), shown as `+N infra`; `err` is model/engine "
             "errors only (bad JSON, rejected request params, wrong status). ")
    L.append("Deterministic checks are pass rates over non-error runs. `hard` = structure, count, time, dates in range, "
             "title, prerequisites, and no-redundant-work (when the case has completed ledger work). "
             "Judge scores are 1–5 means; `judge mean` averages the five original dimensions only. "
             f"`coverage` (deterministic) = share of plans whose total planned minutes (subtasks + prerequisites) reach "
             f"{COVERAGE_PASS_RATIO:.0%} of the case's `expected_effort_minutes` lower bound; `med. cov.` is the median of "
             "planned ÷ expected-min. `judge cov.` is the judge's 1–5 coverage score (\"would doing every step finish the task?\"). "
             "Neither coverage measure is part of `hard`, `all`, the judge mean or the composite, so older numbers stay comparable.")
    L.append("")
    L.append("| model | runs | err | hard pass | all pass | coverage | med. cov. | med. steps | med. latency | judge mean | specificity | first step | ordering | fit | tone | judge cov. |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for model in models:
        e = summary[model]["execute"]
        ok = e["n"] - e["errors"]
        j = e["judge"]
        cv = e["coverage"]
        L.append(
            f"| `{model}` | {e['n']}{_infra(e)} | {_pct(e['errors'], e['n'])} | {_pct(e['hard_pass'], ok)} | {_pct(e['all_pass'], ok)} | "
            f"{_pct(cv['pass'], cv['n'])} | {_fmt(cv['median_ratio'] * 100 if cv['median_ratio'] is not None else None, 0)}% | "
            f"{_fmt(e['median_subtasks'], 0)} | {_fmt(e['median_latency_s'], 1)}s | **{_fmt(j.get('mean'))}** | "
            + " | ".join(_fmt(j.get(d)) for d in PLAN_DIMENSIONS) + f" | {_fmt(j.get(COVERAGE_DIMENSION))} |"
        )
    L.append("")
    L.append("### Coverage by case")
    L.append("")
    L.append("Median total planned minutes (subtasks + prerequisites) per case vs the expected range for a typical "
             "UNSW student (`cases.json` → `expected_effort_minutes`, rationale in `effort_rationale`). "
             "`✗` = below the coverage threshold; judge coverage mean in brackets.")
    L.append("")
    L.append("| case | depth | expected (min) | " + " | ".join(f"`{m.split('/')[-1]}`" for m in models) + " |")
    L.append("|---|---|---|" + "---|" * len(models))
    for case in cases:
        rng = case.get("expected_effort_minutes")
        if not rng:
            continue
        cells = []
        for model in models:
            rs = [r for r in summary[model]["_rows_execute"]
                  if r["case_id"] == case["id"] and not r["error"] and r["score"].get("coverage")]
            if not rs:
                cells.append("–")
                continue
            med = _median(r["score"]["coverage"]["planned_minutes"] for r in rs)
            fails = sum(not r["score"]["coverage"]["pass"] for r in rs)
            jc = _mean(_cov_score(r) for r in rs)
            cells.append(f"{med:.0f}" + (" ✗" if fails else "") + (f" ({jc:.1f})" if jc is not None else ""))
        L.append(f"| {case['id']} | {case.get('depth', 'Brief')} | {rng[0]}–{rng[1]} | " + " | ".join(cells) + " |")
    L.append("")
    L.append("Per-check pass rates:")
    L.append("")
    L.append("| model | " + " | ".join(lbl for _k, lbl in CHECK_COLUMNS) + " |")
    L.append("|---|" + "---|" * len(CHECK_COLUMNS))
    for model in models:
        ch = summary[model]["execute"]["checks"]
        L.append(f"| `{model}` | " + " | ".join(_pct(ch[k]["pass"], ch[k]["n"]) for k, _l in CHECK_COLUMNS) + " |")
    L.append("")

    L.append("## Clarify phase (first streamed turn)")
    L.append("")
    L.append("`skip` = jumped straight to a plan on turn 1. `bad skip` = skipped on a case where a good coach must ask "
             "(vague asks). `over-ask` = asked on a case that already had enough context. `appropriate` counts "
             "`either` cases as always appropriate. Question quality is judge-scored (1–5) on asked turns only. `compound q.` = share of questions that bundle two asks (\"X, and what Y?\") despite the one-question rule.")
    L.append("")
    L.append("| model | runs | err | asked | skip rate | bad skip | over-ask | appropriate | compound q. | q. quality | med. words | med. TTFT | med. latency |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for model in models:
        c = summary[model]["clarify"]
        ok = c["n"] - c["errors"]
        L.append(
            f"| `{model}` | {c['n']}{_infra(c)} | {_pct(c['errors'], c['n'])} | {c['asked']} | {_pct(c['skipped'], ok)} | "
            f"{c['expect_ask_skipped']}/{c['expect_ask_n']} | {c['expect_ready_asked']}/{c['expect_ready_n']} | "
            f"{_pct(c['appropriate'], ok)} | {_pct(c['multi_question'], c['asked'])} | {_fmt(c['question_quality'])} | "
            f"{_fmt(c['median_question_words'], 0)} | {_fmt(c['median_ttft_s'], 1)}s | {_fmt(c['median_latency_asked_s'], 1)}s |"
        )
    L.append("")

    # ---- skip breakdown by case ----------------------------------------
    L.append("### Clarify decisions by case")
    L.append("")
    L.append("`A` = asked, `S` = skipped to plan, `E` = error (one letter per sample).")
    L.append("")
    L.append("| case | expect | " + " | ".join(f"`{m.split('/')[-1]}`" for m in models) + " |")
    L.append("|---|---|" + "---|" * len(models))
    for case in cases:
        cells = []
        for model in models:
            rs = [r for r in summary[model]["_rows_clarify"] if r["case_id"] == case["id"]]
            cells.append("".join("E" if r["error"] else ("A" if r["c"]["asked"] else "S") for r in rs) or "–")
        L.append(f"| {case['id']} | {case.get('expect_clarify', 'either')} | " + " | ".join(cells) + " |")
    L.append("")

    # ---- errors ----------------------------------------------------------
    any_err = any(summary[m]["execute"]["error_kinds"] or summary[m]["clarify"]["error_kinds"] for m in models)
    if any_err:
        L.append("### Errors")
        L.append("")
        for model in models:
            ek = {**{f"execute:{k}": v for k, v in summary[model]["execute"]["error_kinds"].items()},
                  **{f"clarify:{k}": v for k, v in summary[model]["clarify"]["error_kinds"].items()}}
            if ek:
                L.append(f"- `{model}`: " + ", ".join(f"{k} ×{v}" for k, v in sorted(ek.items())))
        L.append("")

    L.extend(render_multiturn(summary, judge_model))
    L.extend(render_adjust(summary, judge_model))
    L.extend(_render_two_level(models, judge_model))

    # ---- recommendation (computed) ----------------------------------------
    L.append("## Computed ranking")
    L.append("")
    L.append("Execution composite = 0.6·(judge mean−1)/4 + 0.4·hard-pass rate − error rate. "
             "Clarify composite = 0.5·appropriate rate + 0.5·(question quality−1)/4 − error rate.")
    L.append("")
    ex_rank = sorted(((m, _composite_exec(summary[m])) for m in models), key=lambda t: -(t[1] if t[1] is not None else -9))
    cl_rank = sorted(((m, _composite_clarify(summary[m])) for m in models), key=lambda t: -(t[1] if t[1] is not None else -9))
    L.append("| rank | execution | score | clarify | score |")
    L.append("|---|---|---|---|---|")
    for i in range(len(models)):
        L.append(f"| {i + 1} | `{ex_rank[i][0]}` | {_fmt(ex_rank[i][1], 3)} | `{cl_rank[i][0]}` | {_fmt(cl_rank[i][1], 3)} |")
    L.append("")

    agreement = judge_agreement(models, cases, judge_model)
    if agreement:
        L.append("## Judge agreement")
        L.append("")
        L.append("Same execute outputs graded by another judge (diff = primary − other; positive means the primary judge is more generous).")
        L.append("")
        for ag in agreement:
            L.append(f"`{judge_model}` vs `{ag['other']}` on {ag['n']} plans:")
            L.append("")
            L.append("| dimension | mean diff | mean abs diff | within ±1 |")
            L.append("|---|---|---|---|")
            for d, v in ag["dims"].items():
                L.append(f"| {d} | {v['mean_diff']:+.2f} | {v['mad']:.2f} | {v['within1'] * 100:.0f}% |")
            L.append("")
            for m, (a, b, n) in ag["per_model"].items():
                L.append(f"- `{m}` (n={n}): primary mean {a:.2f} vs other {b:.2f}")
            L.append("")

    if os.path.exists(ANALYSIS_PATH):
        with open(ANALYSIS_PATH) as f:
            L.append(f.read().rstrip())
        L.append("")

    # ---- worst examples ----------------------------------------------------
    L.append("## Worst examples per model")
    L.append("")
    for model in models:
        L.append(f"### `{model}`")
        L.append("")
        rows = [r for r in summary[model]["_rows_execute"] if not r["error"]]

        def badness(r):
            jm = _mean(r["judge"]["scores"][d]["score"] for d in PLAN_DIMENSIONS) if r.get("judge") else 3.0
            fails = sum(not c["pass"] for c in r["score"]["checks"].values())
            return (jm, -fails)

        for r in sorted(rows, key=badness)[:2]:
            fails = [f"{k} ({c['detail']})" for k, c in r["score"]["checks"].items() if not c["pass"]]
            jm = badness(r)[0]
            L.append(f"**{r['case_id']}** — judge mean {jm:.1f}" + (f"; failed: {'; '.join(fails)}" if fails else ""))
            if r.get("judge"):
                L.append(f"> Judge: {r['judge'].get('worst_issue', '')}")
            L.append("")
            L.append(_excerpt_plan(r["record"]))
            L.append("")
        cov_rows = sorted((r for r in rows if r["score"].get("coverage")),
                          key=lambda r: r["score"]["coverage"]["ratio"])
        if cov_rows:
            L.append("Lowest coverage (planned ÷ expected-min):")
            L.append("")
            for r in cov_rows[:3]:
                cv = r["score"]["coverage"]
                js = ((r.get("judge") or {}).get("scores") or {}).get(COVERAGE_DIMENSION) or {}
                line = f"- **{r['case_id']}**#{r['sample']}: {cv['detail']}"
                if js.get("score") is not None:
                    line += f"; judge coverage {js['score']}/5 — {js.get('rationale', '')}"
                L.append(line)
            L.append("")
        bad_skips = [r for r in summary[model]["_rows_clarify"] if not r["error"] and r["c"]["expect"] == "ask" and r["c"]["skipped"]]
        if bad_skips:
            L.append(f"Bad clarify skips: {', '.join(sorted({r['case_id'] for r in bad_skips}))}")
            L.append("")
        qs = [r for r in summary[model]["_rows_clarify"] if r.get("judge")]
        if qs:
            worst_q = min(qs, key=lambda r: r["judge"]["scores"]["question_quality"]["score"])
            s = worst_q["judge"]["scores"]["question_quality"]
            L.append(f"Weakest question ({worst_q['case_id']}, {s['score']}/5): “{worst_q['c']['question']}” — {s['rationale']}")
            L.append("")
        errs = [r for r in summary[model]["_rows_execute"] + summary[model]["_rows_clarify"] if r["error"]]
        for r in errs[:2]:
            msg = ((r["record"].get("result") or {}).get("message") or r["record"].get("stderr_tail", ""))[:240]
            L.append(f"Error `{r['error']}` on {r['case_id']} ({r['record']['mode']}): `{msg}`")
            L.append("")
    return "\n".join(L) + "\n"


def _fallback_note(block, judge_model):
    fb = block.get("judged_by_fallback")
    return f" ({fb} of {block['judged']} verdicts by the fallback judge after `{judge_model}` returned 429)" if fb else ""


def _cells(rows, case_id, fmt):
    rs = [r for r in rows if r["case_id"] == case_id]
    return " ".join(fmt(r) for r in sorted(rs, key=lambda r: r["sample"])) or "–"


def render_multiturn(summary, judge_model):
    models = list(summary)
    if not any(summary[m]["multiturn"]["n"] or summary[m]["multiturn"]["infra"] for m in models):
        return []
    L = ["## Multi-turn intake (scripted student)", ""]
    L.append("Each case replays fixed student replies (`multiturn_cases.json`) through the real streaming engine until it "
             "returns a plan; notes the engine emits are appended to the ledger/profile for the next turn, like the app. "
             "`hard` = plan built, question count within the case's bounds, no repeated or already-answered question, "
             "every expected note extracted, no task details in the user profile, no re-recorded ledger facts, plan uses the "
             "answers (keyword groups), no redone work, stated step limit respected. `notes` = expected facts extracted / "
             "applicable (facts only count once the reply stating them was actually sent). Judge (1–5): `no repeat` (never "
             "re-asks), `stop timing` (asks enough, then stops), `uses answers` (plan reflects the replies)."
             + "".join(_fallback_note(summary[m]["multiturn"], judge_model) for m in models[:1]))
    L.append("")
    L.append("| model | runs | err | hard pass | med. questions | notes | plan hard (exec checks) | med. total latency | judge mean | no repeat | stop timing | uses answers |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for model in models:
        b = summary[model]["multiturn"]
        j = b["judge"]
        L.append(f"| `{model}` | {b['n']}{_infra(b)} | {_pct(b['errors'], b['n'])} | {_pct(b['hard_pass'], b['scored'])} | "
                 f"{_fmt(b['median_questions'], 1)} | {b['notes_hits']}/{b['notes_expected']} | {b['plan_hard']}/{b['plans']} | "
                 f"{_fmt(b['median_latency_s'], 1)}s | **{_fmt(j.get('mean'))}** | "
                 + " | ".join(_fmt(j.get(d)) for d in MULTITURN_DIMENSIONS) + " |")
    L.append("")
    L.append("| model | " + " | ".join(lbl for _k, lbl in MT_COLUMNS) + " |")
    L.append("|---|" + "---|" * len(MT_COLUMNS))
    for model in models:
        ch = summary[model]["multiturn"]["checks"]
        L.append(f"| `{model}` | " + " | ".join(_pct(ch[k]["pass"], ch[k]["n"]) for k, _l in MT_COLUMNS) + " |")
    L.append("")
    L.append("Questions asked per sample (`✓` = all hard checks passed, `✗` = some failed, `E` = engine error):")
    L.append("")
    L.append("| case | expected | " + " | ".join(f"`{m.split('/')[-1]}`" for m in models) + " |")
    L.append("|---|---|" + "---|" * len(models))

    def mt_cell(r):
        if not r.get("score"):
            return "E"
        return f"{r['score']['questions']}{'✓' if r['score']['hard_pass'] else '✗'}"
    for case in load_multiturn_cases():
        lo, hi = case.get("questions", [0, 4])
        L.append(f"| {case['id']} | {lo}–{hi} | " + " | ".join(_cells(summary[m]["_rows_multiturn"], case["id"], mt_cell) for m in models) + " |")
    L.append("")
    for model in models:
        rows = [r for r in summary[model]["_rows_multiturn"] if r.get("score")]
        bad = sorted(rows, key=lambda r: (sum(c["pass"] for c in r["score"]["checks"].values()),
                                          _mean(r["judge"]["scores"][d]["score"] for d in MULTITURN_DIMENSIONS) if r.get("judge") else 3))[:2]
        for r in bad:
            fails = [f"{k} ({c['detail']})" for k, c in r["score"]["checks"].items() if not c["pass"]]
            if not fails and not r.get("judge"):
                continue
            L.append(f"- `{model.split('/')[-1]}` **{r['case_id']}**#{r['sample']}: " + ("; ".join(fails) if fails else "all checks pass")
                     + (f" — judge: {r['judge'].get('worst_issue', '')}" if r.get("judge") else ""))
    L.append("")
    return L


def render_adjust(summary, judge_model):
    models = list(summary)
    if not any(summary[m]["adjust"]["n"] or summary[m]["adjust"]["infra"] for m in models):
        return []
    L = ["## Plan adjustments (mutation)", ""]
    L.append("Each case (`adjust_cases.json`) sends a checklist with finished items plus one request, exactly like the app's "
             "`update-checklist` call, then scores the raw reply and the list after the app's merge (`merge_port.py`, a port "
             "of `src/common/merge.ts`). `hard` = " + ", ".join(ADJUST_HARD) + ". `done kept` checks the raw reply "
             "(same id and title); `no merge rescue` = merge.ts didn't have to restore a dropped done item (`restored` counts "
             "them). `request met` is checked on the merged list. Judge `faithfulness` (1–5): did exactly what was asked, and nothing else."
             + "".join(_fallback_note(summary[m]["adjust"], judge_model) for m in models[:1]))
    L.append("")
    L.append("| model | runs | err | hard pass | all pass | request met | restored | med. latency | faithfulness |")
    L.append("|---|---|---|---|---|---|---|---|---|")
    for model in models:
        b = summary[model]["adjust"]
        rq = b["checks"]["request_satisfied"]
        L.append(f"| `{model}` | {b['n']}{_infra(b)} | {_pct(b['errors'], b['n'])} | {_pct(b['hard_pass'], b['scored'])} | "
                 f"{_pct(b['all_pass'], b['scored'])} | {_pct(rq['pass'], rq['n'])} | {b['restored']} | "
                 f"{_fmt(b['median_latency_s'], 1)}s | **{_fmt(b['judge'].get('faithfulness'))}** |")
    L.append("")
    L.append("| model | " + " | ".join(lbl for _k, lbl in ADJ_COLUMNS) + " |")
    L.append("|---|" + "---|" * len(ADJ_COLUMNS))
    for model in models:
        ch = summary[model]["adjust"]["checks"]
        L.append(f"| `{model}` | " + " | ".join(_pct(ch[k]["pass"], ch[k]["n"]) for k, _l in ADJ_COLUMNS) + " |")
    L.append("")
    L.append("Per case (`✓`/`✗` = all hard checks, then the faithfulness score; `E` = engine error):")
    L.append("")
    L.append("| case | request | " + " | ".join(f"`{m.split('/')[-1]}`" for m in models) + " |")
    L.append("|---|---|" + "---|" * len(models))

    def adj_cell(r):
        if not r.get("score"):
            return "E"
        f = r["judge"]["scores"]["faithfulness"]["score"] if r.get("judge") else None
        return ("✓" if r["score"]["hard_pass"] else "✗") + (str(f) if f is not None else "")
    for case in load_adjust_cases():
        L.append(f"| {case['id']} | {case['request'][:60]} | " + " | ".join(_cells(summary[m]["_rows_adjust"], case["id"], adj_cell) for m in models) + " |")
    L.append("")
    for model in models:
        rows = [r for r in summary[model]["_rows_adjust"] if r.get("score")]
        bad = sorted(rows, key=lambda r: (r["score"]["hard_pass"],
                                          r["judge"]["scores"]["faithfulness"]["score"] if r.get("judge") else 3))[:3]
        for r in bad:
            fails = [f"{k} ({c['detail']})" for k, c in r["score"]["checks"].items() if not c["pass"]]
            if not fails and not (r.get("judge") and r["judge"]["scores"]["faithfulness"]["score"] < 4):
                continue
            L.append(f"- `{model.split('/')[-1]}` **{r['case_id']}**#{r['sample']}: " + ("; ".join(fails) if fails else "all checks pass")
                     + (f" — judge {r['judge']['scores']['faithfulness']['score']}/5: {r['judge'].get('worst_issue', '')}" if r.get("judge") else ""))
        errs = [r for r in summary[model]["_rows_adjust"] if r["error"]]
        for r in errs[:2]:
            msg = ((r["record"].get("result") or {}).get("message") or r["record"].get("stderr_tail", ""))[:200]
            L.append(f"- `{model.split('/')[-1]}` error `{r['error']}` on {r['case_id']}: `{msg}`")
    L.append("")
    return L


def build_report(models, cases, judge_model):
    summary = aggregate(models, cases, judge_model)
    with open(REPORT_PATH, "w") as f:
        f.write(render(summary, cases, judge_model))
    slim = {m: {k: v for k, v in s.items() if not k.startswith("_")} for m, s in summary.items()}
    write_json(os.path.join(RESULTS_DIR, "summary.json"), slim)
    return slim


def main():
    ap = argparse.ArgumentParser(description="Aggregate cached eval results into REPORT.md")
    ap.add_argument("--models", nargs="*", help="models to include (default: all cached)")
    ap.add_argument("--cases", nargs="*", help="case ids to include (default: all)")
    ap.add_argument("--judge-model", default=DEFAULT_JUDGE)
    args = ap.parse_args()
    models = args.models or cached_models()
    cases = load_cases(args.cases)
    slim = build_report(models, cases, args.judge_model)
    print(json.dumps({m: {"execute_judge_mean": s["execute"]["judge"].get("mean")} for m, s in slim.items()}, indent=1))
    print(f"wrote {REPORT_PATH}")


if __name__ == "__main__":
    main()
