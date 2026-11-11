# engine/review.py
# Writes the weekly review: a warm 2-3 sentence look back plus ONE concrete
# suggestion drawn from the profile's "Patterns & Friction". The main process
# computes the numbers and a template version; on any failure it keeps the
# template, so a review is never lost to a flaky model call.
#
# Reads: { "summary": {...WeekSummary}, "template": {"text", "suggestion"},
#          "userProfile": "...", "model": "..." }
# Prints: { "text": "...", "suggestion": "..." }  (or the template + "error")

import sys, json

MAX_TEXT = 400
MAX_SUGGESTION = 220


def write_review(payload):
    from main import _complete, _missing_api_key, _parse_json, _user_profile_block, DEFAULT_MODEL

    template = payload.get("template") or {}
    model_name = payload.get("model") or DEFAULT_MODEL
    if _missing_api_key(model_name):
        return template

    summary = payload.get("summary") or {}
    system_instruction = (
        "You write a short weekly review for a university student who procrastinates. "
        "Procrastination is an emotional/avoidance problem, so the tone is warm, specific and "
        "never guilt-tripping: no 'you should have', no 'only', no failure language, no "
        "exclamation-mark hype. A quiet week is fine and said kindly.\n\n"
        f"THIS WEEK'S NUMBERS (Monday to Sunday): {json.dumps(summary)}\n"
        f"{_user_profile_block(payload.get('userProfile'))}\n"
        f"FALLBACK (same facts, generic wording): {json.dumps(template)}\n\n"
        "Write:\n"
        f"- `text`: 2-3 sentences (under {MAX_TEXT} characters) noticing what went well, using the real numbers.\n"
        f"- `suggestion`: ONE concrete, small thing to try next week (under {MAX_SUGGESTION} characters). "
        "If the profile lists patterns or friction, base it on one of them; otherwise base it on the numbers "
        "(carried-over steps, estimate ratio).\n"
        'Return ONLY a raw JSON object: {"text": "...", "suggestion": "..."}'
    )
    response = _complete(
        model=model_name,
        messages=[
            {"role": "system", "content": system_instruction},
            {"role": "user", "content": "Write this week's review."}
        ],
        response_format={"type": "json_object"},
        temperature=0.7,
        num_retries=0,
        timeout=20
    )
    parsed = _parse_json(response.choices[0].message.content)
    text = str(parsed.get("text") or "").strip()
    suggestion = str(parsed.get("suggestion") or "").strip()
    if not text or not suggestion or len(text) > MAX_TEXT * 1.5 or len(suggestion) > MAX_SUGGESTION * 1.5:
        return template
    return {"text": text, "suggestion": suggestion}


if __name__ == "__main__":
    raw_input = sys.stdin.read()
    payload = json.loads(raw_input) if raw_input.strip() else {}

    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        result = write_review(payload)
    except Exception as e:
        result = {**(payload.get("template") or {}), "error": str(e)}
    finally:
        sys.stdout = real_stdout

    print(json.dumps(result))
    sys.stdout.flush()
