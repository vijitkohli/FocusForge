# engine/evals/common.py
# Shared paths, case loading, cache I/O and a tiny OpenAI-compatible client
# for the judge. Kept dependency-light (stdlib + python-dotenv, which the
# engine venv already has) so the harness runs in the same env that ships.

import json
import os
import re
import urllib.request
import urllib.error
from datetime import date, timedelta

EVALS_DIR = os.path.dirname(os.path.abspath(__file__))
ENGINE_DIR = os.path.dirname(EVALS_DIR)
REPO_ROOT = os.path.dirname(ENGINE_DIR)
ENGINE_MAIN = os.path.join(ENGINE_DIR, "main.py")
DEFAULT_PYTHON = os.path.join(ENGINE_DIR, "env", "bin", "python")
CASES_PATH = os.path.join(EVALS_DIR, "cases.json")
RESULTS_DIR = os.path.join(EVALS_DIR, "results")
RAW_DIR = os.path.join(RESULTS_DIR, "raw")
JUDGE_DIR = os.path.join(RESULTS_DIR, "judge")
REPORT_PATH = os.path.join(EVALS_DIR, "REPORT.md")
ANALYSIS_PATH = os.path.join(EVALS_DIR, "analysis.md")

NO_FOLLOWUP_SENTINEL = "DO NOT ASK FOLLOW UP QUESTIONS"
DEFAULT_MODELS = [
    "cliproxy/gemini-3-flash",
    "cliproxy/gemini-3.5-flash-lite",
    "cliproxy/gemini-3.8-flash-high",
    "cliproxy/claude-sonnet-4-6",
]
# Opus would be the more neutral judge (not a graded model), but its proxy quota
# runs out mid-suite; pass --judge-model cliproxy/claude-opus-4-6-thinking to use it.
DEFAULT_JUDGE = "cliproxy/gemini-3.8-flash-high"
MODES = ("clarify", "execute")


def load_env():
    try:
        from dotenv import load_dotenv
        load_dotenv(os.path.join(ENGINE_DIR, ".env"))
    except ImportError:
        pass


def load_cases(only_ids=None):
    with open(CASES_PATH) as f:
        cases = json.load(f)["cases"]
    if only_ids:
        wanted = set(only_ids)
        unknown = wanted - {c["id"] for c in cases}
        if unknown:
            raise SystemExit(f"Unknown case id(s): {', '.join(sorted(unknown))}")
        cases = [c for c in cases if c["id"] in wanted]
    return cases


def slug(model):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", model)


def raw_path(model, case_id, mode, sample=0):
    return os.path.join(RAW_DIR, slug(model), f"{case_id}.{mode}.{sample}.json")


def judge_path(judge_model, model, case_id, mode, sample=0):
    return os.path.join(JUDGE_DIR, slug(judge_model), slug(model), f"{case_id}.{mode}.{sample}.json")


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2)
    os.replace(tmp, path)


def deadline_for(case, today=None):
    today = today or date.today()
    return (today + timedelta(days=int(case.get("deadline_offset_days", 7)))).isoformat()


def parse_json_loose(text):
    """Tolerates ```json fences and prose around the outermost {...}."""
    text = (text or "").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fenced:
        try:
            return json.loads(fenced.group(1))
        except json.JSONDecodeError:
            pass
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object in text")
    return json.loads(text[start:end + 1])


def chat_completion(model, messages, temperature=0.0, timeout=180):
    """
    Minimal OpenAI-compatible call. Only cliproxy/* is supported for the
    judge (that's where usage is free); the engine itself is always exercised
    through engine/main.py, never through this function.
    """
    if not model.startswith("cliproxy/"):
        raise ValueError("judge model must be a cliproxy/* model")
    base = os.getenv("CLIPROXY_API_BASE", "http://localhost:8317/v1").rstrip("/")
    key = os.getenv("CLIPROXY_API_KEY", "")
    body = json.dumps({
        "model": model[len("cliproxy/"):],
        "messages": messages,
        "temperature": temperature,
    }).encode()
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode())
    return payload["choices"][0]["message"]["content"] or ""
