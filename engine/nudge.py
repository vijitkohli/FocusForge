# engine/nudge.py
# Personalises a procrastination-nudge notification. The main process has
# already decided WHO/WHAT to nudge (quiet hours, once-per-day guard) and built
# a safe template message; this only rewrites the copy so it fits the user.
#
# Reads one JSON payload from stdin:
#   { "draft": "<template message>", "subject": "<step or project name>",
#     "reason": "overdue"|"idle", "currentStreak": int,
#     "userProfile": "<user_profile.md text>", "model": "..." }
# Prints one JSON object to stdout: { "body": "..." }
# On any failure it returns the draft unchanged, so a nudge is never lost.

import sys, json

MAX_BODY_CHARS = 180


def personalise(payload):
    from main import _complete, _missing_api_key, _user_profile_block, DEFAULT_MODEL

    draft = payload.get("draft", "")
    model_name = payload.get("model") or DEFAULT_MODEL
    if _missing_api_key(model_name):
        return draft

    streak = payload.get("currentStreak") or 0
    reason = payload.get("reason", "idle")
    situation = (
        f'The step "{payload.get("subject", "")}" is past its planned date.'
        if reason == "overdue"
        else f'The project "{payload.get("subject", "")}" has had no activity for a couple of days.'
    )

    system_instruction = (
        "You write a single desktop notification for someone who procrastinates. "
        "Procrastination is an emotional/avoidance problem, so the tone is warm, light, and "
        "never guilt-tripping: no 'you should', no mention of failing or being behind, no "
        "exclamation-mark hype. Invite ONE tiny, concrete starting action (~5-10 minutes).\n\n"
        f"SITUATION: {situation}\n"
        f"CURRENT STREAK: {streak} day(s) in a row with at least one completed step"
        f"{' (mention protecting it, gently)' if streak >= 2 else ''}.\n"
        f"{_user_profile_block(payload.get('userProfile'))}\n"
        f"FALLBACK MESSAGE (same intent, generic): {draft}\n\n"
        f"Reply with the notification text only, plain text, under {MAX_BODY_CHARS} characters, "
        "must include the step/project name."
    )

    response = _complete(
        model=model_name,
        messages=[
            {"role": "system", "content": system_instruction},
            {"role": "user", "content": "Write the notification."}
        ],
        temperature=0.8,
        num_retries=0,
        timeout=20
    )
    body = (response.choices[0].message.content or "").strip().strip('"').strip()
    if not body or len(body) > MAX_BODY_CHARS * 1.5:
        return draft
    return body


if __name__ == "__main__":
    raw_input = sys.stdin.read()
    payload = json.loads(raw_input) if raw_input.strip() else {}

    # Same stdout discipline as main.py: only our final JSON line on stdout.
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        result = {"body": personalise(payload)}
    except Exception as e:
        result = {"body": payload.get("draft", ""), "error": str(e)}
    finally:
        sys.stdout = real_stdout

    print(json.dumps(result))
    sys.stdout.flush()
