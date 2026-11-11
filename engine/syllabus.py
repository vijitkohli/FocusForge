# engine/syllabus.py
# Course-outline import: reads a whole course outline PDF and extracts every
# graded assessment (title, due date, weighting) so the app can offer them as
# tasks. Uses pypdf directly (not vault.py) so it doesn't pay the
# ChromaDB/SentenceTransformers cold start - the whole text is sent, capped.
#
# Reads one JSON payload from stdin: { "file_path": "...", "model": "...", "today": "YYYY-MM-DD" }
# Prints one JSON object to stdout:
#   { "assessments": [{title, dueDate|null, when, weight|null, kind, notes}], "course": "..." }
#   or { "error": "..." }

import sys, json, os
from datetime import datetime

MAX_CHARS = 40000
KINDS = {"exam", "assignment", "quiz", "lab", "presentation", "other"}


def extract_text(file_path):
    from pypdf import PdfReader

    if not os.path.exists(file_path):
        raise FileNotFoundError(file_path)
    reader = PdfReader(file_path)
    pages = [page.extract_text() or "" for page in reader.pages]
    text = "\n\n".join(p for p in pages if p.strip())
    return text[:MAX_CHARS]


def _valid_date(value):
    if not isinstance(value, str):
        return None
    try:
        datetime.strptime(value, "%Y-%m-%d")
        return value
    except ValueError:
        return None


def _weight(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and 0 < value <= 100:
        return round(float(value), 1)
    if isinstance(value, str):
        try:
            return _weight(float(value.strip().rstrip("%")))
        except ValueError:
            return None
    return None


def clean_assessments(raw):
    """Keeps well-formed items; invalid dates become null (the user picks one)."""
    out = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        kind = str(item.get("kind") or "other").lower()
        out.append({
            "title": title[:120],
            "dueDate": _valid_date(item.get("dueDate")),
            "when": str(item.get("when") or "").strip()[:80],
            "weight": _weight(item.get("weight")),
            "kind": kind if kind in KINDS else "other",
            "notes": str(item.get("notes") or "").strip()[:300],
        })
    return out


def extract_assessments(text, model_name, today_str):
    from main import _complete, _parse_json

    system_instruction = (
        "You read university course outlines and list every GRADED assessment in them.\n\n"
        f"TODAY: {today_str}\n\n"
        "--- RULES ---\n"
        "1. Include every assessment that counts toward the final mark: assignments, quizzes, labs, "
        "   presentations, mid-terms, final exams. Skip ungraded activities, readings and lectures.\n"
        "2. If an assessment repeats (e.g. 'weekly quizzes'), list it ONCE with the combined weight and "
        "   explain the pattern in `notes`.\n"
        "3. `dueDate` is YYYY-MM-DD ONLY when the outline gives a real calendar date. Use the year printed in "
        "   the outline; if there is none, use the year that puts the date closest to TODAY. If the outline "
        "   only says a week ('Week 5') or 'exam period', set `dueDate` to null and copy that wording into `when`.\n"
        "4. `weight` is the percentage of the final mark as a number (20 for 20%), or null if not stated.\n"
        "5. `kind` is one of: exam, assignment, quiz, lab, presentation, other.\n"
        "6. `notes` is one short line on what's required (length, format, group or individual, topics). "
        "   Never invent details that aren't in the outline.\n"
        "7. Keep the outline's own names (e.g. 'Assignment 1 - Graph algorithms').\n\n"
        "--- JSON FORMAT ---\n"
        "Return ONLY a raw JSON object:\n"
        "{\n"
        '  "course": "course code and name, or empty string",\n'
        '  "assessments": [\n'
        '    { "title": "string", "dueDate": "YYYY-MM-DD or null", "when": "string", "weight": number_or_null, '
        '"kind": "string", "notes": "string" }\n'
        "  ]\n"
        "}\n\n"
        "--- COURSE OUTLINE ---\n"
        f"{text}"
    )
    response = _complete(
        model=model_name,
        messages=[
            {"role": "system", "content": system_instruction},
            {"role": "user", "content": "List the graded assessments now."}
        ],
        response_format={"type": "json_object"},
        temperature=0.1,
        num_retries=1
    )
    parsed = _parse_json(response.choices[0].message.content)
    if not isinstance(parsed, dict):
        raise ValueError("unexpected reply shape")
    return str(parsed.get("course") or "").strip(), clean_assessments(parsed.get("assessments"))


def run(payload):
    from main import _missing_api_key, DEFAULT_MODEL

    model_name = payload.get("model") or DEFAULT_MODEL
    key_error = _missing_api_key(model_name)
    if key_error:
        return {"error": key_error}
    try:
        text = extract_text(payload.get("file_path") or "")
    except Exception as e:
        return {"error": f"Couldn't read that PDF ({e})."}
    if len(text.strip()) < 200:
        return {"error": "That PDF has almost no readable text. If it's a scan, try exporting a text PDF."}
    today_str = payload.get("today") or datetime.now().strftime("%Y-%m-%d")
    try:
        course, assessments = extract_assessments(text, model_name, today_str)
    except Exception as e:
        return {"error": f"Something went wrong reading the outline ({e}). Try again."}
    if not assessments:
        return {"error": "No graded assessments were found in that PDF. Is it the course outline?"}
    return {"course": course, "assessments": assessments}


if __name__ == "__main__":
    raw_input = sys.stdin.read()
    payload = json.loads(raw_input) if raw_input.strip() else {}

    # Dependencies print banners to stdout; keep it clean for the JSON reply.
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        result = run(payload)
    except Exception as e:
        result = {"error": str(e)}
    finally:
        sys.stdout = real_stdout
    print(json.dumps(result))
    sys.stdout.flush()
