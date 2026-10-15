# engine/evals/run.py
# One-command eval: run the real engine for every (model, case, mode, sample),
# cache raw outputs, judge them, and write REPORT.md.
#
#   engine/env/bin/python -m engine.evals.run                     # everything, cached
#   engine/env/bin/python engine/evals/run.py --models cliproxy/gemini-3-flash --cases clean-room-today
#   npm run eval -- --modes clarify --samples 3
#   npm run eval -- --report-only
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

from common import (  # noqa: E402
    DEFAULT_JUDGE, DEFAULT_MODELS, DEFAULT_PYTHON, MODES, REPORT_PATH,
    judge_path, load_cases, load_env, raw_path, read_json, write_json,
)
from engine_runner import INFRA_ERRORS, effective_error, run_engine  # noqa: E402
from judge import judge_plan, judge_question  # noqa: E402
from report import build_report, cached_models  # noqa: E402

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
    ap.add_argument("--modes", nargs="*", default=list(MODES), help="clarify and/or execute")
    ap.add_argument("--samples", type=int, default=1, help="samples per (model, case, mode)")
    ap.add_argument("--concurrency", type=int, default=MAX_CONCURRENCY)
    ap.add_argument("--judge-model", default=DEFAULT_JUDGE)
    ap.add_argument("--no-judge", action="store_true", help="skip LLM-as-judge")
    ap.add_argument("--force", action="store_true", help="re-run engine calls even if cached")
    ap.add_argument("--retry-errors", action="store_true", help="re-run cached engine calls that failed for infra reasons (rate limit, timeout, ...)")
    ap.add_argument("--force-judge", action="store_true", help="re-run judge calls even if cached")
    ap.add_argument("--report-only", action="store_true", help="only rebuild REPORT.md from the cache")
    ap.add_argument("--python", default=DEFAULT_PYTHON, help="python used to run engine/main.py")
    args = ap.parse_args()

    load_env()
    models = _split(args.models) or DEFAULT_MODELS
    cases = load_cases(_split(args.cases))
    modes = _split(args.modes)
    for m in modes:
        if m not in MODES:
            raise SystemExit(f"unknown mode {m!r} (expected one of {MODES})")
    concurrency = max(1, min(args.concurrency, MAX_CONCURRENCY))
    if args.concurrency > MAX_CONCURRENCY:
        log(f"concurrency capped at {MAX_CONCURRENCY}")
    case_by_id = {c["id"]: c for c in cases}

    if not args.report_only:
        if not os.path.exists(args.python):
            raise SystemExit(f"{args.python} not found - run `npm run setup:engine` first or pass --python")

        # ---- 1. engine calls --------------------------------------------
        jobs = []
        for model in models:
            for case in cases:
                for mode in modes:
                    for sample in range(args.samples):
                        path = raw_path(model, case["id"], mode, sample)
                        cached = read_json(path)
                        retry = args.retry_errors and cached and effective_error(cached) in INFRA_ERRORS
                        if cached and not args.force and not retry:
                            continue

                        def job(model=model, case=case, mode=mode, sample=sample, path=path):
                            rec = run_engine(args.python, case, model, mode, sample)
                            write_json(path, rec)
                            status = (rec.get("result") or {}).get("status")
                            return f"{rec['error'] or status} ({rec['latency_s']}s)"

                        jobs.append((f"{model} {case['id']} {mode}#{sample}", job))
        run_pool(jobs, concurrency, "engine")

        # ---- 2. judge ------------------------------------------------------
        if not args.no_judge:
            jobs = []
            for model in models:
                for case in cases:
                    for mode in modes:
                        for sample in range(args.samples):
                            rec = read_json(raw_path(model, case["id"], mode, sample))
                            if not rec or rec.get("error"):
                                continue
                            status = (rec.get("result") or {}).get("status")
                            if mode == "execute" and status != "complete":
                                continue
                            if mode == "clarify" and status != "clarifying":
                                continue  # skipped straight to a plan: nothing to grade
                            jpath = judge_path(args.judge_model, model, case["id"], mode, sample)
                            cached = read_json(jpath)
                            if cached and cached.get("scores") and not args.force_judge:
                                continue

                            def job(rec=rec, mode=mode, jpath=jpath):
                                c = case_by_id[rec["case_id"]]
                                fn = judge_plan if mode == "execute" else judge_question
                                verdict = fn(args.judge_model, rec, c)
                                write_json(jpath, verdict)
                                return verdict["judge_error"] or "ok"

                            jobs.append((f"judge {model} {case['id']} {mode}#{sample}", job))
            run_pool(jobs, concurrency, "judge")

    # ---- 3. report ----------------------------------------------------------
    report_models = models if (args.models or not args.report_only) else (cached_models() or models)
    build_report(report_models, load_cases(), args.judge_model)
    log(f"wrote {REPORT_PATH}")


if __name__ == "__main__":
    main()
