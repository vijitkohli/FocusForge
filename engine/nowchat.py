# engine/nowchat.py
# "Now" chat: helps the student find ONE thing to start right now.
#
# Payload: { mode: "nowchat", model, messages: [{role, content}], steps: [{id, item, kind,
#            task, step, minutes, difficulty, due, dueKind, touched}], now, doneToday,
#            userProfile }
# Reply:   { status: "ok", message, pick: <step id> | null, replies: [str] }
#          { status: "error", message }
#
# The pick must be one of the given step ids; anything else is dropped, so the
# app can always show the suggestion in the "What next?" card.

from main import _complete, _parse_json, _missing_api_key, DEFAULT_MODEL

MAX_REPLIES = 3


def _step_line(s):
    parts = [
        s.get("id", ""),
        f"{s.get('item', '')} ({s.get('kind', '')} item)",
        s.get("task", ""),
        s.get("step", ""),
        f"{s.get('minutes') or '?'} min",
        s.get("difficulty", ""),
    ]
    due = s.get("due")
    if due:
        parts.append(f"due {due}" + (" (tentative)" if s.get("dueKind") == "tentative" else ""))
    if s.get("touched"):
        parts.append(f"last touched {s['touched']}")
    return " | ".join(p for p in parts if p)


def build_prompt(payload):
    steps = payload.get("steps") or []
    lines = "\n".join(_step_line(s) for s in steps) or "(no steps available)"
    profile = (payload.get("userProfile") or "").strip()
    profile_block = f"\n--- ABOUT THE STUDENT ---\n{profile}\n" if profile else ""
    return (
        "You help a university student who procrastinates pick ONE thing to start right now.\n"
        "They talk to you when they don't want to choose for themselves. Your job is to get them "
        "started: suggest a single step that is (a) worth doing and (b) something they can get "
        "themselves to do in their current state.\n\n"
        f"NOW: {payload.get('now', '')}. Steps finished today: {payload.get('doneToday', 0)}.\n"
        f"{profile_block}"
        "--- STEPS YOU CAN SUGGEST (id | item | task | step | size | difficulty | due | last touched) ---\n"
        f"{lines}\n\n"
        "--- RULES ---\n"
        "1. Suggest exactly one step by its id, or none when you genuinely need one short answer first.\n"
        "2. Read their state from the conversation: energy, mood, time they have, things they said no to. "
        "Never suggest an item or kind of work they just said they don't want.\n"
        "3. A confirmed deadline within 2 days wins unless they refused it. Otherwise favour what fits "
        "their energy; when they're tired of deadline work, favour passion items and short, easy steps.\n"
        "4. If they want a short break, respect it: say so in a few words and offer a small step for after.\n"
        "5. message: at most 2 short sentences, plain and warm, addressed to them. Say what to do and why it "
        "fits right now. No lists, no exclamation marks, no guilt, no pep talk, no restating the whole plan.\n"
        "6. replies: 2 or 3 short things they might tap next (max 4 words each), e.g. 'Something else', "
        "'Smaller, please', 'I have 10 min'.\n\n"
        "Return ONLY JSON: {\"message\": string, \"pick\": string or null, \"replies\": [string]}"
    )


def handle_now_chat(payload):
    model = payload.get("model") or DEFAULT_MODEL
    key_error = _missing_api_key(model)
    if key_error:
        return {"status": "error", "message": key_error}
    messages = [
        {"role": m.get("role"), "content": str(m.get("content", ""))[:2000]}
        for m in (payload.get("messages") or [])
        if m.get("role") in ("user", "assistant")
    ][-20:]
    if not messages:
        messages = [{"role": "user", "content": "Pick something for me."}]
    try:
        response = _complete(
            model=model,
            messages=[{"role": "system", "content": build_prompt(payload)}] + messages,
            response_format={"type": "json_object"},
            temperature=0.4,
            num_retries=1,
        )
        parsed = _parse_json(response.choices[0].message.content)
    except Exception as e:
        return {"status": "error", "message": f"Couldn't reach the coach ({type(e).__name__})."}
    return normalise(parsed, payload)


def normalise(parsed, payload):
    ids = {s.get("id") for s in (payload.get("steps") or [])}
    message = str((parsed or {}).get("message") or "").strip()[:600]
    pick = (parsed or {}).get("pick")
    if pick not in ids:
        pick = None
    replies = [
        str(r).strip()[:40]
        for r in ((parsed or {}).get("replies") or [])
        if isinstance(r, str) and r.strip()
    ][:MAX_REPLIES]
    if not message:
        message = "Here's one to start with." if pick else "What would help right now?"
    return {"status": "ok", "message": message, "pick": pick, "replies": replies}
