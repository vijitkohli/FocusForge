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
    judge_path, load_cases, read_json, slug, write_json,
)
from engine_runner import INFRA_ERRORS, effective_error  # noqa: E402
from judge import PLAN_DIMENSIONS  # noqa: E402
from scorers import score_clarify, score_plan  # noqa: E402

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
            if rec and rec.get("model") == model:
                rec["error"] = effective_error(rec)
                out.append((case, rec))
    return out


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
                j = read_json(judge_path(judge_model, model, case["id"], "execute", rec.get("sample", 0)))
                row["judge"] = j if j and j.get("scores") else None
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
        judged = [r for r in ok if r.get("judge")]
        for d in PLAN_DIMENSIONS:
            m["execute"]["judge"][d] = _mean(r["judge"]["scores"][d]["score"] for r in judged)
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
                j = read_json(judge_path(judge_model, model, case["id"], "clarify", rec.get("sample", 0)))
                row["judge"] = j if j and j.get("scores") else None
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
             "Judge scores are 1–5 means.")
    L.append("")
    L.append("| model | runs | err | hard pass | all pass | med. steps | med. latency | judge mean | specificity | first step | ordering | fit | tone |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for model in models:
        e = summary[model]["execute"]
        ok = e["n"] - e["errors"]
        j = e["judge"]
        L.append(
            f"| `{model}` | {e['n']}{_infra(e)} | {_pct(e['errors'], e['n'])} | {_pct(e['hard_pass'], ok)} | {_pct(e['all_pass'], ok)} | "
            f"{_fmt(e['median_subtasks'], 0)} | {_fmt(e['median_latency_s'], 1)}s | **{_fmt(j.get('mean'))}** | "
            + " | ".join(_fmt(j.get(d)) for d in PLAN_DIMENSIONS) + " |"
        )
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
