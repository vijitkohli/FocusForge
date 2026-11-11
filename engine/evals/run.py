# engine/evals/run.py
# One-command eval: run the real engine for every (model, case, mode, sample),
# cache raw outputs, judge them, and write REPORT.md.
#
#   engine/env/bin/python -m engine.evals.run                     # everything, cached
#   engine/env/bin/python engine/evals/run.py --models cliproxy/gemini-3-flash --cases clean-room-today
#   npm run eval -- --modes clarify --samples 3
#   npm run eval -- --report-only
#   npm run eval -- --modes multiturn,adjust --models cliproxy/gemini-3-flash --samples 2
#
# Modes: clarify + execute use cases.json; multiturn (scripted multi-turn
# intake) uses multiturn_cases.json; adjust (plan mutation) uses
# adjust_cases.json. --cases filters across all three files.
#
# Cached results under engine/evals/results/ are reused unless --force /
# --force-judge, so re-scoring after a scorer change costs nothing.

import argparse
import re
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from adjust import load_adjust_cases, run_adjust  # noqa: E402
from common import (  # noqa: E402
    DEFAULT_JUDGE, DEFAULT_JUDGE_FALLBACK, DEFAULT_MODELS, DEFAULT_PYTHON, MODES, REPORT_PATH,
    judge_path, load_cases, load_env, raw_fingerprint, raw_path, read_json, write_json,
)
from engine_runner import INFRA_ERRORS, effective_error, run_engine  # noqa: E402
from judge import (  # noqa: E402
    ADJUST_DIMENSIONS, COVERAGE_DIMENSION, MULTITURN_DIMENSIONS,
    judge_adjust, judge_multiturn, judge_plan, judge_question,
)
from multiturn import load_multiturn_cases, run_multiturn  # noqa: E402
from report import build_report, cached_models, record_error  # noqa: E402

MAX_CONCURRENCY = 4  # keep the proxy's upstream accounts from being throttled
_print_lock = threading.Lock()


def log(msg):
    with _print_lock:
        print(msg, flush=True)


def _split(values):
    out = []
    for v in values or []:
        out.extend(x for x in re.split(r"[,\s]+", v) if x)
    return out


def verdict_is_current(cached, rec, mode):
    """A cached verdict is reusable if it has scores, graded this exact raw
    output (when it recorded which), and - for plans - has the coverage score."""
    if not (cached and cached.get("scores")):
        return False
    fp = cached.get("raw_fingerprint")
    if fp is not None and fp != raw_fingerprint(rec):
        return False
    required = {"execute": [COVERAGE_DIMENSION], "multiturn": MULTITURN_DIMENSIONS, "adjust": ADJUST_DIMENSIONS}
    if any(d not in cached["scores"] for d in required.get(mode, [])):
        return False
    return True


def cases_for(mode, only_ids):
    """Cases for one mode; `only_ids` filters across every case file."""
    if mode == "multiturn":
        cases = load_multiturn_cases()
    elif mode == "adjust":
        cases = load_adjust_cases()
    else:
        cases = load_cases()
    if only_ids:
        cases = [c for c in cases if c["id"] in set(only_ids)]
    return cases


def run_one(python, case, model, mode, sample):
    if mode == "multiturn":
        return run_multiturn(python, case, model, sample)
    if mode == "adjust":
        return run_adjust(python, case, model, sample)
    return run_engine(python, case, model, mode, sample)


def judgeable(rec, mode):
    status = (rec.get("result") or {}).get("status")
    if mode in ("execute", "multiturn"):
        return status == "complete"
    if mode == "clarify":
        return status == "clarifying"  # skipped straight to a plan: nothing to grade
    if mode == "adjust":
        return status == "updated"
    return False


JUDGE_FNS = {"execute": judge_plan, "clarify": judge_question, "multiturn": judge_multiturn, "adjust": judge_adjust}


def _is_quota_error(verdict):
    return bool(verdict.get("judge_error")) and "429" in verdict["judge_error"]


def run_pool(jobs, concurrency, label):
    if not jobs:
        log(f"[{label}] nothing to do (all cached)")
        return
    log(f"[{label}] {len(jobs)} job(s), concurrency {concurrency}")
    done = 0
    start = time.monotonic()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {pool.submit(fn): desc for desc, fn in jobs}
        for fut in as_completed(futures):
            done += 1
            desc = futures[fut]
            try:
                status = fut.result()
            except Exception as e:  # never let one job kill the run
                status = f"CRASH {type(e).__name__}: {e}"
            log(f"[{label} {done}/{len(jobs)} {time.monotonic() - start:5.0f}s] {desc} -> {status}")


def main():
    ap = argparse.ArgumentParser(description="FocusForge engine eval harness")
    ap.add_argument("--models", nargs="*", help=f"models (space/comma separated). default: {' '.join(DEFAULT_MODELS)}")
    ap.add_argument("--cases", nargs="*", help="case ids (default: all in cases.json)")
    ap.add_argument("--modes", nargs="*", default=list(MODES), help=f"any of {', '.join(MODES)} (default: all)")
    ap.add_argument("--samples", type=int, default=1, help="samples per (model, case, mode)")
    ap.add_argument("--concurrency", type=int, default=MAX_CONCURRENCY)
    ap.add_argument("--judge-model", default=DEFAULT_JUDGE)
    ap.add_argument("--judge-fallback", default=DEFAULT_JUDGE_FALLBACK,
                    help="judge used when the primary judge keeps returning 429 ('' to disable); recorded per verdict")
    ap.add_argument("--no-judge", action="store_true", help="skip LLM-as-judge")
    ap.add_argument("--force", action="store_true", help="re-run engine calls even if cached")
    ap.add_argument("--retry-errors", action="store_true", help="re-run cached engine calls that failed for infra reasons (rate limit, timeout, ...)")
    ap.add_argument("--force-judge", action="store_true", help="re-run judge calls even if cached")
    ap.add_argument("--report-only", action="store_true", help="only rebuild REPORT.md from the cache")
    ap.add_argument("--python", default=DEFAULT_PYTHON, help="python used to run engine/main.py")
    args = ap.parse_args()

    load_env()
    models = _split(args.models) or DEFAULT_MODELS
    only_ids = _split(args.cases)
    if only_ids:
        known = {c["id"] for m in MODES for c in cases_for(m, None)}
        unknown = set(only_ids) - known
        if unknown:
            raise SystemExit(f"Unknown case id(s): {', '.join(sorted(unknown))}")
    modes = _split(args.modes)
    for m in modes:
        if m not in MODES:
            raise SystemExit(f"unknown mode {m!r} (expected one of {MODES})")
    concurrency = max(1, min(args.concurrency, MAX_CONCURRENCY))
    if args.concurrency > MAX_CONCURRENCY:
        log(f"concurrency capped at {MAX_CONCURRENCY}")
    mode_cases = {m: cases_for(m, only_ids) for m in modes}
    case_by_id = {c["id"]: c for m in modes for c in mode_cases[m]}

    if not args.report_only:
        if not os.path.exists(args.python):
            raise SystemExit(f"{args.python} not found - run `npm run setup:engine` first or pass --python")

        # ---- 1. engine calls --------------------------------------------
        jobs = []
        for model in models:
            for mode in modes:
                for case in mode_cases[mode]:
                    for sample in range(args.samples):
                        path = raw_path(model, case["id"], mode, sample)
                        cached = read_json(path)
                        retry = args.retry_errors and cached and record_error(cached) in INFRA_ERRORS
                        if cached and not args.force and not retry:
                            continue

                        def job(model=model, case=case, mode=mode, sample=sample, path=path):
                            rec = run_one(args.python, case, model, mode, sample)
                            write_json(path, rec)
                            status = (rec.get("result") or {}).get("status")
                            extra = f", {len(rec['questions'])}q" if mode == "multiturn" else ""
                            return f"{rec['error'] or status} ({rec['latency_s']}s{extra})"

                        jobs.append((f"{model} {case['id']} {mode}#{sample}", job))
        run_pool(jobs, concurrency, "engine")

        # ---- 2. judge ------------------------------------------------------
        if not args.no_judge:
            jobs = []
            for model in models:
                for mode in modes:
                    for case in mode_cases[mode]:
                        for sample in range(args.samples):
                            rec = read_json(raw_path(model, case["id"], mode, sample))
                            if not rec or rec.get("error") or not judgeable(rec, mode):
                                continue
                            jpath = judge_path(args.judge_model, model, case["id"], mode, sample)
                            cached = read_json(jpath)
                            if verdict_is_current(cached, rec, mode) and not args.force_judge:
                                continue

                            def job(rec=rec, mode=mode, jpath=jpath):
                                c = case_by_id[rec["case_id"]]
                                fn = JUDGE_FNS[mode]
                                verdict = fn(args.judge_model, rec, c)
                                verdict["judge_model_used"] = args.judge_model
                                if _is_quota_error(verdict) and args.judge_fallback:
                                    fb = fn(args.judge_fallback, rec, c)
                                    if not fb.get("judge_error"):
                                        verdict = fb
                                        verdict["judge_model_used"] = args.judge_fallback
                                        verdict["fallback_reason"] = "primary judge returned 429"
                                verdict["raw_fingerprint"] = raw_fingerprint(rec)
                                write_json(jpath, verdict)
                                used = verdict.get("judge_model_used")
                                return (verdict["judge_error"] or "ok") + ("" if used == args.judge_model else f" (fallback {used})")

                            jobs.append((f"judge {model} {case['id']} {mode}#{sample}", job))
            run_pool(jobs, concurrency, "judge")

    # ---- 3. report ----------------------------------------------------------
    report_models = models if (args.models or not args.report_only) else (cached_models() or models)
    build_report(report_models, load_cases(), args.judge_model)
    log(f"wrote {REPORT_PATH}")


if __name__ == "__main__":
    main()
