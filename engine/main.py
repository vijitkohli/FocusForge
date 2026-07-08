# engine/main.py
# Three-mode conversational decomposition / mutation engine.
#
# Reads one JSON payload from stdin:
#   { "messages": [{role, content}, ...], "deadline": "YYYY-MM-DD",
#     "depth": "Brief"|"Deep", "model": "...", "contextLedger": "<context_<projectId>.md text>",
#     "currentChecklist": {originalTask, subtasks} | null }
#
# Prints one JSON object to stdout:
#   { "status": "clarifying"|"complete"|"updated", "message": "...",
#     "data": null|DecompositionResult, "notes": [{section, note}, ...] }

import sys, os, json
from litellm import completion
from dotenv import load_dotenv
from datetime import datetime

DEFAULT_MODEL = "gemini/gemini-2.5-flash-lite"
MAX_CLARIFYING_TURNS = 5

# Local LLM (Ollama) support: any model prefixed "ollama/" is routed to a local
# server instead of a cloud provider (no API key needed). Override the address
# with OLLAMA_API_BASE in engine/.env if it isn't on the default port.
OLLAMA_API_BASE = os.getenv("OLLAMA_API_BASE", "http://localhost:11434")


def _complete(**kwargs):
    """
    Thin wrapper around litellm.completion that injects Ollama-specific config
    for local models so every call site stays provider-agnostic. For ollama/*
    models it sets api_base and raises the default context window (num_ctx),
    since our prompts (ledger + profile + transcript) can be long.
    """
    model = kwargs.get("model", "")
    if isinstance(model, str) and model.startswith("ollama/"):
        kwargs["api_base"] = OLLAMA_API_BASE
        kwargs["num_ctx"] = 8192
    return completion(**kwargs)

# Maps a model prefix to the env var LiteLLM needs. ollama/* is local (no key).
_PROVIDER_KEYS = [
    ("ollama/", None, None),
    ("gemini", "GEMINI_API_KEY", "Google Gemini"),
    ("gpt", "OPENAI_API_KEY", "OpenAI"),
    ("openai/", "OPENAI_API_KEY", "OpenAI"),
    ("o1", "OPENAI_API_KEY", "OpenAI"),
    ("claude", "ANTHROPIC_API_KEY", "Anthropic"),
    ("anthropic/", "ANTHROPIC_API_KEY", "Anthropic"),
]


def _missing_api_key(model_name):
    """
    Returns a human-readable error string if the selected model's provider key
    is missing from the environment, else None. Lets the app surface a friendly
    "add your key" message instead of an opaque LiteLLM auth crash.
    """
    name = (model_name or "").lower()
    for prefix, env_var, label in _PROVIDER_KEYS:
        if name.startswith(prefix):
            if env_var is None:
                return None  # local model, no key needed
            if not os.getenv(env_var):
                return (
                    f"No API key found for {label}. Add {env_var} to engine/.env "
                    f"(copy engine/.env.example if you haven't yet), then try again."
                )
            return None
    return None  # unknown provider — let LiteLLM decide


LEDGER_SECTIONS = [
    "Constraints & Specifications",
    "Document Excerpts",
    "Milestones & Completed Work",
    "Plan Adjustments"
]

USER_PROFILE_SECTIONS = [
    "About Me",
    "Preferences",
    "Patterns & Friction"
]

load_dotenv()


def _user_turn_count(messages):
    return sum(1 for m in messages if m.get("role") == "user")


def _resolve_deadline(deadline_str):
    today = datetime.now()
    try:
        deadline = datetime.strptime(deadline_str, "%Y-%m-%d")
        days_remaining = (deadline - today).days + 1
        if days_remaining < 1:
            days_remaining = 1
        return today.strftime("%Y-%m-%d"), deadline_str, days_remaining
    except Exception:
        return today.strftime("%Y-%m-%d"), "Next Week", 7


def _conversation_transcript(messages):
    lines = []
    for m in messages:
        speaker = "User" if m.get("role") == "user" else "Coach"
        lines.append(f"{speaker}: {m.get('content', '')}")
    return "\n".join(lines)


def _ledger_block(context_ledger):
    if not context_ledger or not context_ledger.strip():
        return ""
    return f"\n--- PROJECT CONTEXT LEDGER (everything known so far) ---\n{context_ledger}\n"


def _user_profile_block(user_profile):
    if not user_profile or not user_profile.strip():
        return ""
    return f"\n--- USER PROFILE (who you are coaching) ---\n{user_profile}\nAdapt your tone, depth, and examples to this person. Respect their stated preferences and known friction points.\n"


def _sanitize_notes(raw_notes):
    """
    Keeps only notes whose section matches a known heading, so a
    misbehaving LLM response can't corrupt context_<projectId>.md with bad headings.
    """
    if not isinstance(raw_notes, list):
        return []
    clean = []
    for n in raw_notes:
        if not isinstance(n, dict):
            continue
        section = n.get("section")
        note = n.get("note")
        if section in LEDGER_SECTIONS and isinstance(note, str) and note.strip():
            clean.append({"section": section, "note": note.strip()})
    return clean


def _sanitize_user_notes(raw_notes):
    """
    Same guard for global user-profile notes. Only the three user-editable
    sections are valid targets — 'Projects Overview' is machine-owned.
    """
    if not isinstance(raw_notes, list):
        return []
    clean = []
    for n in raw_notes:
        if not isinstance(n, dict):
            continue
        section = n.get("section")
        note = n.get("note")
        if section in USER_PROFILE_SECTIONS and isinstance(note, str) and note.strip():
            clean.append({"section": section, "note": note.strip()})
    return clean


def run_clarification_phase(messages, deadline_str, days_remaining, context_ledger, user_profile, model_name):
    """
    Strategic-coach pass. Looks for critical gaps (grading criteria, required
    tech, dependencies, personal friction) and asks exactly one targeted
    question, or signals readiness to move to execution. Also recognizes any
    durable facts (constraints, specs, stated milestones) worth recording,
    including durable user-level facts for the global profile.
    """
    transcript = _conversation_transcript(messages)
    profile_block = _user_profile_block(user_profile)
    ledger_block = _ledger_block(context_ledger)

    system_instruction = (
        "You are an expert Productivity Coach conducting a short intake conversation "
        "before breaking a task down into a 'No-Fail' execution checklist.\n\n"
        "Your job right now is NOT to produce the checklist. Your job is to find the "
        "single most important missing piece of information and ask ONE specific, "
        "open-ended question to get it.\n\n"
        "Look for gaps such as: grading criteria or success definition, required tools "
        "or technology, hidden dependencies or prerequisites, scope boundaries, and "
        "personal friction points (what's actually making this feel hard to start).\n\n"
        "If you already have enough to build a genuinely useful, specific checklist, "
        "stop asking questions and signal readiness instead.\n\n"
        "Separately, check the conversation for any durable facts worth permanently recording:\n"
        "  1. Project facts: a constraint/spec the user stated, or work they say is already done → `notes`.\n"
        "  2. User facts: a lasting preference, working-style trait, or friction pattern the user reveals "
        "     about THEMSELVES (not about this specific task) → `userNotes`. "
        "     Only capture genuinely durable user-level insights (e.g. 'I always stall on the first paragraph', "
        "     'I prefer short focused sessions'). Do NOT record task-specific details here.\n"
        "Do NOT invent facts — only record what was explicitly stated this turn.\n\n"
        f"{profile_block}"
        f"--- CONTEXT ---\n"
        f"DEADLINE: {deadline_str} ({days_remaining} days remaining)\n"
        f"{ledger_block}\n"
        "--- CONVERSATION SO FAR ---\n"
        f"{transcript}\n\n"
        "--- JSON FORMAT ---\n"
        "Return ONLY a raw JSON object with this exact structure:\n"
        "{\n"
        '  "action": "ask" | "ready",\n'
        '  "question": "string (your next question if action is ask, otherwise a short closing remark)",\n'
        '  "notes": [{"section": "Constraints & Specifications" | "Milestones & Completed Work", "note": "string"}],\n'
        '  "userNotes": [{"section": "About Me" | "Preferences" | "Patterns & Friction", "note": "string"}]\n'
        "}\n"
        "Both `notes` and `userNotes` may be empty lists if nothing new was stated this turn."
    )

    response = _complete(
        model=model_name,
        messages=[
            {"role": "system", "content": system_instruction},
            {"role": "user", "content": "Decide whether to ask a clarifying question or proceed, and extract any durable facts."}
        ],
        response_format={"type": "json_object"},
        temperature=0.6,
        num_retries=1
    )

    content = response.choices[0].message.content
    parsed = json.loads(content)
    action = parsed.get("action", "ready")
    question = parsed.get("question", "Got it, let's build your plan.")
    notes = _sanitize_notes(parsed.get("notes", []))
    user_notes = _sanitize_user_notes(parsed.get("userNotes", []))
    return action, question, notes, user_notes


def run_execution_phase(messages, deadline_str, days_remaining, depth, context_ledger, user_profile, model_name):
    """
    Expanded version of the original single-shot decomposition prompt, but
    grounded in the full clarification dialogue and the project's context
    ledger instead of a bare title - so already-completed work and known
    constraints are never re-derived as new subtasks.
    """
    transcript = _conversation_transcript(messages)
    profile_block = _user_profile_block(user_profile)
    ledger_block = _ledger_block(context_ledger)
    today_str = datetime.now().strftime("%Y-%m-%d")

    system_instruction = (
        "You are an expert Productivity Coach focused on building momentum. "
        "Your goal is to break ANY user intent into a 'No-Fail' execution checklist.\n\n"
        "Your goal is to break a large scary task into tiny, non-threatening micro-steps "
        "that make the user want to start IMMEDIATELY.\n\n"

        f"{profile_block}"
        f"--- CONTEXT ---\n"
        f"CURRENT DATE: {today_str}\n"
        f"DEADLINE: {deadline_str} ({days_remaining} days remaining)\n"
        f"DEPTH: {depth} (If 'Deep', provide detailed 5-10 min increments. If 'Brief', high-level milestones).\n"
        f"{ledger_block}\n"
        "--- FULL INTAKE CONVERSATION ---\n"
        "Use everything revealed in this conversation AND in the context ledger above "
        "(grading criteria, tools, dependencies, friction points, and anything already "
        "marked complete) to make the checklist specific, not generic.\n"
        f"{transcript}\n\n"

        "--- CRITICAL INSTRUCTIONS ---\n"
        "1. LEARN -> DO SEPARATION (Gap Analysis): Analyze the request for things the user must "
        "   LEARN, ACQUIRE, or SET UP *before* the real work can start, and put those in a separate "
        "   `prerequisites` array - NOT in `subtasks`. A prerequisite is knowledge/resources/environment "
        "   (e.g. 'Watch lecture 4 on recursion' [learn], 'Buy masking tape' [acquire], 'Install Node.js' "
        "   [setup]). The `subtasks` are the actual execution steps that follow. If there are genuinely no "
        "   prerequisites, return an empty `prerequisites` array.\n"
        "2. THE 10-MINUTE RULE: Break 'big' nebulous tasks into concrete, low-friction actions. "
        "   Avoid vague verbs like 'Study' or 'Work on'. Use specific verbs like 'Read Chapter 1', 'Write Introduction', 'Email X'.\n"
        "3. LOGICAL FLOW: Start with setup/prep tasks (momentum builders), then moving to core work, then review/polishing.\n"
        "4. QUANTITY: Provide at least 10+ subtasks if Depth is 'Deep' or 5 subtasks if Depth is 'Brief'. \n"
        "5. SCHEDULING: Distribute tasks logically across the available days. Do not dump everything on the deadline.\n"
        "6. STRICT TIME-BOXING: Every subtask must have a realistic timeEstimate in minutes; "
        "   keep individual steps small enough to start without dread.\n"
        "7. NO REDUNDANT WORK: If the context ledger says something is already done, do not "
        "   include it (or an equivalent step) in the checklist again.\n\n"

        "--- JSON FORMAT ---\n"
        "Return ONLY a raw JSON object with this exact structure:\n"
        "{\n"
        '  "originalTask": "string — a short, human-readable restatement of the user\'s actual task '
        '(e.g. \'Finish Quiz 4\', \'Write the introduction\'); NEVER an instruction to yourself '
        'such as \'Build the final checklist now.\' or any similar phrase",\n'
        '  "prerequisites": [\n'
        '    { "id": "p1", "title": "Thing to learn/acquire/set up first", "kind": "learn/acquire/setup" }\n'
        '  ],\n'
        '  "subtasks": [\n'
        '    {\n'
        '      "id": "1",\n'
        '      "title": "Micro-step title",\n'
        '      "difficulty": "easy/medium/hard",\n'
        '      "timeEstimate": integer_minutes,\n'
        '      "scheduledDate": "YYYY-MM-DD"\n'
        '    }\n'
        '  ]\n'
        "}"
    )

    response = _complete(
        model=model_name,
        messages=[
            {"role": "system", "content": system_instruction},
            {"role": "user", "content": "Build the final checklist now."}
        ],
        response_format={"type": "json_object"},
        temperature=0.7,
        num_retries=1
    )

    content = response.choices[0].message.content
    parsed = json.loads(content)
    # Guard: if the model echoed the engine's own instruction string, blank it
    # so the renderer falls back to the user's actual first message.
    _BAD_TITLES = {"build the final checklist now", "apply the adjustment now"}
    original = parsed.get("originalTask", "")
    if original.strip().lower().rstrip(".!?") in _BAD_TITLES:
        parsed["originalTask"] = ""
    return parsed


def run_mutation_phase(messages, current_checklist, context_ledger, user_profile, model_name):
    """
    Reshapes an existing checklist on request (e.g. "make this shorter",
    "expand step 3"). Returns a complete replacement subtask list rather
    than a patch - merge semantics on an AI-restructured plan are far more
    error-prone than just re-rendering a fresh list.
    """
    latest_request = next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "")
    profile_block = _user_profile_block(user_profile)
    ledger_block = _ledger_block(context_ledger)
    checklist_json = json.dumps(current_checklist)

    system_instruction = (
        "You are an expert Productivity Coach. The user already has a checklist for "
        "their task and is asking you to adjust it. Apply their request faithfully "
        "while respecting all known project constraints from the context ledger.\n\n"
        f"{profile_block}"
        f"--- CURRENT CHECKLIST ---\n{checklist_json}\n\n"
        f"{ledger_block}\n"
        f"--- USER'S ADJUSTMENT REQUEST ---\n{latest_request}\n\n"
        "--- INSTRUCTIONS ---\n"
        "1. Return the FULL replacement checklist (not just the changed parts).\n"
        "2. Keep the same level of time-boxing and specificity as the original.\n"
        "3. Do not reintroduce anything the context ledger says is already done.\n"
        "4. PRESERVE the `prerequisites` (learn/acquire/setup) from the current checklist unless the "
        "   request is specifically about them - do not silently drop the learn phase.\n"
        "5. Briefly summarize what you changed in `message` (e.g. 'Condensed from 11 to 6 steps').\n\n"
        "--- JSON FORMAT ---\n"
        "Return ONLY a raw JSON object with this exact structure:\n"
        "{\n"
        '  "message": "string - short summary of what changed",\n'
        '  "originalTask": "string",\n'
        '  "prerequisites": [\n'
        '    { "id": "p1", "title": "Thing to learn/acquire/set up first", "kind": "learn/acquire/setup" }\n'
        '  ],\n'
        '  "subtasks": [\n'
        '    {\n'
        '      "id": "1",\n'
        '      "title": "Micro-step title",\n'
        '      "difficulty": "easy/medium/hard",\n'
        '      "timeEstimate": integer_minutes,\n'
        '      "scheduledDate": "YYYY-MM-DD"\n'
        '    }\n'
        '  ]\n'
        "}"
    )

    response = _complete(
        model=model_name,
        messages=[
            {"role": "system", "content": system_instruction},
            {"role": "user", "content": "Apply the adjustment now."}
        ],
        response_format={"type": "json_object"},
        temperature=0.6,
        num_retries=1
    )

    content = response.choices[0].message.content
    parsed = json.loads(content)
    summary = parsed.pop("message", "Plan updated.")
    return summary, parsed


CLARIFY_SENTINEL = "__READY__"
NO_FOLLOWUP_SENTINEL = "DO NOT ASK FOLLOW UP QUESTIONS"


def _user_wants_no_followup(messages):
    """
    True if any user message ends with the skip phrase. Tolerant of case and
    trailing punctuation/whitespace (e.g. "...do not ask follow up questions.").
    """
    for m in messages:
        if m.get("role") != "user":
            continue
        text = m.get("content", "").strip().upper().rstrip(".!?;: \t\n")
        if text.endswith(NO_FOLLOWUP_SENTINEL):
            return True
    return False


def run_clarification_streaming(messages, deadline_str, days_remaining, context_ledger, user_profile, model_name, emit):
    """
    Streaming variant of the clarification pass: streams the next question to
    the UI token-by-token for perceived speed. The model replies with plain
    prose (one question) OR the exact sentinel `__READY__` when it has enough to
    build the checklist. Tokens are buffered until the sentinel is ruled out, so
    a readiness signal never flashes on screen. Returns (ready, question).

    Note: unlike the structured clarification pass, this path does not extract
    per-turn ledger `notes` or `userNotes` - the streamed reply is plain prose.
    Stated facts still reach the engine via the saved conversation + context ledger.
    """
    transcript = _conversation_transcript(messages)
    profile_block = _user_profile_block(user_profile)
    ledger_block = _ledger_block(context_ledger)

    system_instruction = (
        "You are an expert Productivity Coach conducting a short intake conversation "
        "before breaking a task into a 'No-Fail' execution checklist.\n\n"
        "Find the single most important missing piece of information (grading criteria, "
        "required tools, hidden dependencies, scope, or personal friction) and ask ONE "
        "specific, open-ended question in plain prose.\n\n"
        f"If you already have enough to build a genuinely useful, specific checklist, reply "
        f"with EXACTLY this and nothing else: {CLARIFY_SENTINEL}\n\n"
        "Reply with plain text only - no JSON, no preamble.\n\n"
        f"{profile_block}"
        f"--- CONTEXT ---\n"
        f"DEADLINE: {deadline_str} ({days_remaining} days remaining)\n"
        f"{ledger_block}\n"
        "--- CONVERSATION SO FAR ---\n"
        f"{transcript}\n"
    )

    response = _complete(
        model=model_name,
        messages=[
            {"role": "system", "content": system_instruction},
            {"role": "user", "content": "Ask your next question, or reply with the readiness sentinel."}
        ],
        stream=True,
        temperature=0.6,
        num_retries=1
    )

    full = ""
    buffer = ""
    emitting = False
    for chunk in response:
        delta = (chunk.choices[0].delta.content or "")
        if not delta:
            continue
        full += delta
        if emitting:
            emit({"type": "token", "text": delta})
            continue
        buffer += delta
        stripped = buffer.lstrip()
        # Still possibly the sentinel? keep buffering until we can tell.
        if CLARIFY_SENTINEL.startswith(stripped[:len(CLARIFY_SENTINEL)]):
            if len(stripped) < len(CLARIFY_SENTINEL):
                continue
            # It is the sentinel - readiness. Don't emit anything.
            break
        # Not the sentinel: flush what we buffered and stream the rest.
        emit({"type": "token", "text": buffer})
        emitting = True

    ready = full.strip() == CLARIFY_SENTINEL
    return ready, full.strip()


def handle_chat_turn_streaming(payload, emit):
    """
    Same decision logic as handle_chat_turn, but streams the clarifying
    question token-by-token via `emit`, then emits one final
    {"type":"result", ...} line carrying the usual EngineResponse. Execution
    and mutation are structured (not token-streamed); they only emit the final
    result.
    """
    messages = payload.get("messages", [])
    deadline_str = payload.get("deadline", datetime.now().strftime("%Y-%m-%d"))
    depth = payload.get("depth", "Brief")
    model_name = payload.get("model") or DEFAULT_MODEL
    context_ledger = payload.get("contextLedger")
    user_profile = payload.get("userProfile")
    current_checklist = payload.get("currentChecklist")

    _today_str, resolved_deadline_str, days_remaining = _resolve_deadline(deadline_str)

    key_error = _missing_api_key(model_name)
    if key_error:
        emit({"type": "result", "status": "error", "message": key_error, "data": None, "notes": [], "userNotes": []})
        return

    try:
        if current_checklist:
            # Mutation: structured, emit final result only.
            result = handle_chat_turn(payload)
            emit({"type": "result", **result})
            return

        turn = _user_turn_count(messages)
        if turn < MAX_CLARIFYING_TURNS and not _user_wants_no_followup(messages):
            ready, question = run_clarification_streaming(
                messages, resolved_deadline_str, days_remaining, context_ledger, user_profile, model_name, emit
            )
            if not ready:
                emit({"type": "result", "status": "clarifying", "message": question, "data": None, "notes": [], "userNotes": []})
                return
            # ready -> fall through to execution (no tokens for the checklist)

        result = run_execution_phase(
            messages, resolved_deadline_str, days_remaining, depth, context_ledger, user_profile, model_name
        )
        emit({
            "type": "result",
            "status": "complete",
            "message": "Here's your plan. Let's build momentum.",
            "data": result,
            "notes": [],
            "userNotes": []
        })
    except Exception as e:
        emit({
            "type": "result",
            "status": "clarifying",
            "message": f"Something went wrong on my end ({str(e)}). Could you try that again?",
            "data": None,
            "notes": [],
            "userNotes": []
        })


def handle_chat_turn(payload):
    messages = payload.get("messages", [])
    deadline_str = payload.get("deadline", datetime.now().strftime("%Y-%m-%d"))
    depth = payload.get("depth", "Brief")
    model_name = payload.get("model") or DEFAULT_MODEL
    context_ledger = payload.get("contextLedger")
    user_profile = payload.get("userProfile")
    current_checklist = payload.get("currentChecklist")

    _today_str, resolved_deadline_str, days_remaining = _resolve_deadline(deadline_str)

    key_error = _missing_api_key(model_name)
    if key_error:
        return {"status": "error", "message": key_error, "data": None, "notes": [], "userNotes": []}

    try:
        # Mutation mode: a checklist already exists and the user is asking to adjust it
        if current_checklist:
            latest_request = next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "")
            summary, new_checklist = run_mutation_phase(messages, current_checklist, context_ledger, user_profile, model_name)
            return {
                "status": "updated",
                "message": summary,
                "data": new_checklist,
                "notes": [{
                    "section": "Plan Adjustments",
                    "note": f"Request: \"{latest_request}\" -> {summary}"
                }],
                "userNotes": []
            }

        turn = _user_turn_count(messages)

        if turn < MAX_CLARIFYING_TURNS and not _user_wants_no_followup(messages):
            action, question, notes, user_notes = run_clarification_phase(
                messages, resolved_deadline_str, days_remaining, context_ledger, user_profile, model_name
            )
            if action == "ask":
                return {"status": "clarifying", "message": question, "data": None, "notes": notes, "userNotes": user_notes}
            # action == "ready" falls through to execution below, but still
            # carries forward any notes recognized on this turn
        else:
            notes = []
            user_notes = []

        result = run_execution_phase(
            messages, resolved_deadline_str, days_remaining, depth, context_ledger, user_profile, model_name
        )
        return {
            "status": "complete",
            "message": "Here's your plan. Let's build momentum.",
            "data": result,
            "notes": notes,
            "userNotes": user_notes
        }

    except Exception as e:
        return {
            "status": "clarifying",
            "message": f"Something went wrong on my end ({str(e)}). Could you try that again?",
            "data": None,
            "notes": [],
            "userNotes": []
        }


if __name__ == "__main__":
    raw_input = sys.stdin.read()
    payload = json.loads(raw_input) if raw_input.strip() else {}

    # litellm (and other deps) print diagnostic/error banners straight to
    # stdout on failures (e.g. the colored "Give Feedback / Get Help"
    # notice). python-shell's json mode parses every stdout line as JSON,
    # so any stray line breaks the whole response. Redirect all output
    # produced while processing to stderr, and only ever print our own
    # final result line to the real stdout.
    real_stdout = sys.stdout
    sys.stdout = sys.stderr

    def emit(obj):
        # Write one JSON line to the real stdout (python-shell json mode parses
        # per line); keep sys.stdout pointed at stderr so dependency banners
        # never corrupt the stream.
        real_stdout.write(json.dumps(obj) + "\n")
        real_stdout.flush()

    try:
        if payload.get("stream"):
            handle_chat_turn_streaming(payload, emit)
        else:
            result = handle_chat_turn(payload)
            emit(result)
    finally:
        sys.stdout = real_stdout
