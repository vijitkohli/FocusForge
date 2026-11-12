# engine/evals/show_plan.py
# Prints a cached two-level plan result (milestones, steps, validation) for a
# quick look while tuning prompts:
#   engine/env/bin/python engine/evals/show_plan.py <model> <case_id> [mode] [sample]

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import raw_path, read_json  # noqa: E402


def main():
    model, case_id = sys.argv[1], sys.argv[2]
    mode = sys.argv[3] if len(sys.argv) > 3 else "plan"
    sample = int(sys.argv[4]) if len(sys.argv) > 4 else 0
    rec = read_json(raw_path(model, case_id, mode, sample))
    if not rec:
        raise SystemExit("no cached result")
    res = rec.get("result") or {}
    print(rec.get("error"), rec.get("latency_s"), res.get("status"), "-", res.get("message"))
    data = res.get("data") or {}
    for m in data.get("milestones") or []:
        print(f"  M {m.get('id')} {m.get('status')} {m.get('estimateMinutes')}m {m.get('targetDate')} {m.get('title')} | {m.get('doneWhen')}")
    for p in data.get("prerequisites") or []:
        print(f"  P {p.get('timeEstimate')}m {p.get('title')}")
    for s in data.get("subtasks") or []:
        print(f"  S {s.get('timeEstimate')}m {s.get('scheduledDate')} {s.get('milestoneId')} {s.get('title')}")
    if data.get("assumptions"):
        print("  assumptions:", data["assumptions"])
    v = res.get("validation") or {}
    print("  validation:", json.dumps({k: v.get(k) for k in ("repaired", "salvaged", "preRepair")}))
    for i in v.get("issues") or []:
        if not i.get("fixed"):
            print("   -", i.get("code"), i.get("path"), i.get("msg")[:120])


if __name__ == "__main__":
    main()
