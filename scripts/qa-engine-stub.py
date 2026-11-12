#!/usr/bin/env python3
# QA stand-in for the Python engine. Electron runs this as UNI_AGENT_PYTHON.
# digest.py and doctext.py are handed to the real interpreter (fake digest mode).
# plan, expand and split return a small canned plan so the loop never calls a model.
import json
import os
import sys

LOG = os.environ.get("FOCUSFORGE_QA_LOG", "/tmp/focusforge-qa-loop/engine-calls.jsonl")
REAL = os.environ.get("FOCUSFORGE_REAL_PYTHON", "")


def script_name():
    for arg in sys.argv[1:]:
        if arg.endswith(".py"):
            return os.path.basename(arg)
    return ""


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log_payload(script, payload):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"script": script, "payload": payload}, default=str) + "\n")
    except OSError:
        pass


def canned(payload):
    mode = payload.get("mode")
    today = payload.get("today") or ""
    task = payload.get("task") if isinstance(payload.get("task"), dict) else {}
    title = task.get("title") or "Next step"
    if mode == "split":
        return {
            "status": "split",
            "message": "Split into smaller steps.",
            "steps": [
                {"title": "Read the first line", "timeEstimate": 5, "difficulty": "easy"},
                {"title": "Write one sentence", "timeEstimate": 10, "difficulty": "easy"},
            ],
        }
    if mode == "expand":
        return {
            "status": "expanded",
            "message": "Here are your next steps.",
            "data": {
                "subtasks": [
                    {
                        "title": "Open the notes",
                        "timeEstimate": 5,
                        "difficulty": "easy",
                        "scheduledDate": today,
                    }
                ],
                "coversRest": False,
                "estimateMinutes": 20,
            },
        }
    return {
        "status": "complete",
        "message": "Here's the whole job in 2 parts. The first step is ready.",
        "data": {
            "originalTask": title,
            "milestones": [
                {
                    "id": "m1",
                    "title": "Start",
                    "estimateMinutes": 30,
                    "doneWhen": "The first piece exists.",
                    "status": "active",
                },
                {
                    "id": "m2",
                    "title": "Finish",
                    "estimateMinutes": 120,
                    "doneWhen": "It's handed in.",
                    "status": "todo",
                },
            ],
            "currentMilestoneId": "m1",
            "coversRest": False,
            "prerequisites": [],
            "subtasks": [
                {
                    "title": "Open the brief and read the first heading",
                    "timeEstimate": 5,
                    "difficulty": "easy",
                    "scheduledDate": today,
                    "milestoneId": "m1",
                },
                {
                    "title": "List the three requirements",
                    "timeEstimate": 15,
                    "difficulty": "medium",
                    "scheduledDate": today,
                    "milestoneId": "m1",
                },
            ],
            "assumptions": [],
        },
    }


def main():
    name = script_name()
    if name in ("digest.py", "doctext.py"):
        if not REAL:
            emit({"status": "error", "message": "No real Python for the digest."})
            return
        os.environ["FOCUSFORGE_DIGEST_FAKE"] = "1"
        os.execv(REAL, [REAL, *sys.argv[1:]])
    raw = sys.stdin.read()
    payload = json.loads(raw) if raw.strip() else {}
    log_payload(name, payload)
    if name == "main.py" and payload.get("mode") in ("plan", "expand", "replan", "split"):
        emit(canned(payload))
        return
    if name == "nudge.py":
        emit({"body": ""})
        return
    emit({"status": "ok"})


if __name__ == "__main__":
    main()
