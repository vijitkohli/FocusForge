# engine/evals/engine_runner.py
# Invokes the real engine (engine/main.py) as a subprocess with the exact
# streaming NDJSON contract the Electron app uses, and records the outcome,
# latency and any failure for one (model, case, mode, sample).

import json
import subprocess
import time
from datetime import date

from common import ENGINE_MAIN, ENGINE_DIR, NO_FOLLOWUP_SENTINEL, deadline_for

ENGINE_TIMEOUT_S = 300
ENGINE_ERROR_PREFIX = "Something went wrong on my end"
_JSON_ERROR_HINTS = ("JSONDecodeError", "Expecting value", "Expecting property", "no JSON", "Extra data", "Unterminated string")


def split_model(model):
    """'A+fast=B' runs model A with B drafting questions (the app's fast-question mode)."""
    if "+fast=" in model:
        main_model, fast_model = model.split("+fast=", 1)
        return main_model, fast_model
    return model, None


def build_payload(case, model, mode, today=None):
    model, fast_model = split_model(model)
    messages = [dict(m) for m in case["messages"]]
    if mode == "execute":
        # Force the checklist: the engine skips clarification when any user
        # message ends with the sentinel (same thing the app's skip button sends).
        last_user = max(i for i, m in enumerate(messages) if m["role"] == "user")
        messages[last_user]["content"] = messages[last_user]["content"].rstrip() + " " + NO_FOLLOWUP_SENTINEL
    payload = {
        "messages": messages,
        "deadline": deadline_for(case, today),
        "depth": case.get("depth", "Brief"),
        "model": model,
        "contextLedger": case.get("context_ledger") or "",
        "userProfile": case.get("user_profile") or "",
        "stream": True,
    }
    if case.get("estimate_ratio") is not None:
        payload["estimateRatio"] = case["estimate_ratio"]
    if fast_model:
        payload["fastModel"] = fast_model
    return payload


# Failures of the proxy/environment rather than of the model: reported
# separately (not counted against a model's error rate) and re-runnable with
# --retry-errors.
INFRA_ERRORS = {"rate_limited", "timeout", "no_result_line", "engine_misconfigured", "spawn_failed"}


def classify_error(result):
    """Returns an error kind string, or None if the engine produced a usable result."""
    if result is None:
        return "no_result_line"
    status = result.get("status")
    message = result.get("message") or ""
    if status == "error":
        return "engine_error"
    if status == "clarifying" and message.startswith(ENGINE_ERROR_PREFIX):
        if "RateLimitError" in message or "429" in message or "quota" in message.lower():
            return "rate_limited"
        if "LLM Provider NOT provided" in message:
            return "engine_misconfigured"
        if "json_schema" in message or "response_format" in message:
            return "response_format_rejected"
        if any(h in message for h in _JSON_ERROR_HINTS):
            return "json_parse_failure"
        return "engine_exception"
    if status not in ("clarifying", "complete", "updated"):
        return "bad_status"
    return None


def effective_error(record):
    """Re-derives the error kind with the current rules so old caches stay comparable."""
    err = record.get("error")
    if err in ("engine_exception", "json_parse_failure", "engine_error"):
        return classify_error(record.get("result")) or err
    return err


def run_engine(python, case, model, mode, sample=0):
    today = date.today()
    payload = build_payload(case, model, mode, today)
    record = {
        "case_id": case["id"],
        "model": model,
        "mode": mode,
        "sample": sample,
        "run_date": today.isoformat(),
        "payload": payload,
        "tokens": 0,
        "ttft_s": None,
        "latency_s": None,
        "result": None,
        "error": None,
        "stderr_tail": "",
        "bad_lines": [],
    }

    start = time.monotonic()
    try:
        proc = subprocess.Popen(
            [python, ENGINE_MAIN],
            cwd=ENGINE_DIR,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except OSError as e:
        record["error"] = "spawn_failed"
        record["stderr_tail"] = str(e)
        return record

    # stdin is small; write it, then read stdout line-by-line so we can time
    # the first streamed token like the UI would see it.
    try:
        proc.stdin.write(json.dumps(payload))
        proc.stdin.close()
    except BrokenPipeError:
        pass

    result = None
    timed_out = False
    try:
        for line in proc.stdout:
            if time.monotonic() - start > ENGINE_TIMEOUT_S:
                timed_out = True
                proc.kill()
                break
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                record["bad_lines"].append(line[:300])
                continue
            if obj.get("type") == "token":
                if record["ttft_s"] is None:
                    record["ttft_s"] = round(time.monotonic() - start, 3)
                record["tokens"] += 1
            elif obj.get("type") == "result":
                result = {k: v for k, v in obj.items() if k != "type"}
            elif "type" not in obj:
                # Non-streaming shape (no "type") - accept it as the result.
                result = obj
            # Other typed lines (the trailing {"type": "notes"}) are not the result.
        stderr = proc.stderr.read()
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
        stderr = ""
        timed_out = True

    record["latency_s"] = round(time.monotonic() - start, 3)
    record["stderr_tail"] = (stderr or "")[-1500:]
    record["result"] = result
    if timed_out:
        record["error"] = "timeout"
    elif record["bad_lines"]:
        record["error"] = "invalid_ndjson"
    elif proc.returncode not in (0, None) and result is None:
        record["error"] = f"nonzero_exit_{proc.returncode}"
    else:
        record["error"] = classify_error(result)
        if record["error"] is None and mode == "execute" and result.get("status") != "complete":
            record["error"] = "unexpected_status"
    return record
