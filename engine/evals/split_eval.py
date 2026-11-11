# engine/evals/split_eval.py
# Deterministic eval for the "Stuck?" split mode. Runs each case in
# split_cases.json through the real engine (mode=split) and checks the parts
# the app would splice in. No judge: the rules are mechanical.
#
#   engine/env/bin/python engine/evals/split_eval.py [--models m1,m2] [--samples 2]

import argparse
import json
import os
import re
import subprocess
import sys
import time

from common import DEFAULT_PYTHON, ENGINE_DIR, ENGINE_MAIN, EVALS_DIR

CASES = os.path.join(EVALS_DIR, "split_cases.json")
DEFAULT_SPLIT_MODELS = ["cliproxy/gemini-3.8-flash-high", "cliproxy/gemini-3-flash"]


def _norm(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def score(case, result):
    """Returns a list of (check, ok, detail)."""
    steps = (result or {}).get("steps") or []
    parent = case["step"]
    estimate = parent.get("timeEstimate")
    titles = [s.get("title", "") for s in steps if isinstance(s, dict)]
    minutes = [s.get("timeEstimate") for s in steps if isinstance(s, dict)]
    ints = all(isinstance(m, int) and m > 0 for m in minutes)
    checks = [
        ("status", (result or {}).get("status") == "split", (result or {}).get("message", "")[:120]),
        ("2-3 parts", 2 <= len(steps) <= 3, f"{len(steps)} parts"),
        ("integer minutes", ints, str(minutes)),
        ("first <= 5 min", bool(minutes) and isinstance(minutes[0], int) and minutes[0] <= 5, str(minutes[:1])),
        ("no restated step", all(_norm(t) != _norm(parent["title"]) for t in titles), ""),
        ("titles present", all(t.strip() for t in titles) and bool(titles), ""),
    ]
    if isinstance(estimate, int) and ints:
        total = sum(minutes)
        checks.append(("total <= 1.2x", total <= max(5, round(estimate * 1.2)), f"{total} vs {estimate}"))
    return checks


def run_case(python, case, model):
    payload = {
        "mode": "split",
        "model": model,
        "planModel": model,
        "taskTitle": case["task"],
        "step": case["step"],
        "contextLedger": "",
        "userProfile": "",
    }
    start = time.monotonic()
    proc = subprocess.run(
        [python, ENGINE_MAIN], cwd=ENGINE_DIR, input=json.dumps(payload),
        capture_output=True, text=True, timeout=180
    )
    lines = [l for l in proc.stdout.splitlines() if l.strip()]
    result = json.loads(lines[-1]) if lines else None
    return result, round(time.monotonic() - start, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=",".join(DEFAULT_SPLIT_MODELS))
    ap.add_argument("--samples", type=int, default=1)
    ap.add_argument("--python", default=DEFAULT_PYTHON)
    args = ap.parse_args()

    cases = json.load(open(CASES))["cases"]
    failures = 0
    for model in args.models.split(","):
        passed = total = 0
        for case in cases:
            for sample in range(args.samples):
                result, secs = run_case(args.python, case, model)
                checks = score(case, result)
                ok = all(c[1] for c in checks)
                total += 1
                passed += ok
                bad = "; ".join(f"{n} ({d})" for n, good, d in checks if not good)
                titles = " | ".join(s.get("title", "") for s in (result or {}).get("steps") or [])
                print(f"{'PASS' if ok else 'FAIL'} {model} {case['id']}#{sample} {secs}s  {titles}" + (f"  -> {bad}" if bad else ""))
        failures += total - passed
        print(f"== {model}: {passed}/{total} passed\n")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
