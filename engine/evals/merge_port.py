# engine/evals/merge_port.py
# Python port of src/common/merge.ts (mergeChecklist + helpers), so the
# adjustment scorers judge what the user would actually SEE after the app
# merges the engine's replacement list onto their progress - not just the raw
# model output. Keep in sync with merge.ts; the rules are:
#   - pair incoming items with previous ones by id first (a completed previous
#     item only pairs when titles are similar), then by normalized title;
#   - a paired completed item is kept verbatim; a paired incomplete item takes
#     the AI's fields but keeps its kanban status;
#   - unpaired incoming items are new, start 'todo', and get a fresh id if the
#     id is missing or collides;
#   - completed items the AI dropped are re-inserted at the front unless the
#     request explicitly asks to remove finished work.
# Differences: timestamps are not stamped, and \p{L}\p{N} is approximated by
# Python's unicode-aware [^\W_].

import re

_NON_ALNUM = re.compile(r"[\W_]+", re.UNICODE)
_REMOVE_COMPLETED = re.compile(
    r"\b(remove|delete|drop|clear|hide|get rid of)\b.{0,30}\b(done|completed?|finished|ticked|checked)\b", re.I
)


def normalize_title(title):
    return _NON_ALNUM.sub(" ", (title or "").lower()).strip()


def titles_similar(a, b):
    na, nb = normalize_title(a), normalize_title(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    if ",".join(re.findall(r"\d+", na)) != ",".join(re.findall(r"\d+", nb)):
        return False
    wa, wb = set(na.split(" ")), set(nb.split(" "))
    shared = len(wa & wb)
    m = min(len(wa), len(wb))
    return shared == m or shared / m >= 0.5


def requests_removing_completed(request):
    return bool(_REMOVE_COMPLETED.search(request or ""))


def derive_status(item):
    return item.get("status") or ("done" if item.get("isCompleted") else "todo")


def _pair(previous, incoming):
    claimed = set()  # indices into previous
    by_id = {}
    for i, p in enumerate(previous):
        by_id.setdefault(str(p.get("id")), i)
    matches = []
    for item in incoming:
        idx = by_id.get(str(item.get("id"))) if item.get("id") is not None else None
        if idx is None or idx in claimed:
            matches.append(None)
            continue
        old = previous[idx]
        if old.get("isCompleted") and not titles_similar(old.get("title"), item.get("title")):
            matches.append(None)
            continue
        claimed.add(idx)
        matches.append(idx)
    for j, item in enumerate(incoming):
        if matches[j] is not None:
            continue
        key = normalize_title(item.get("title"))
        if not key:
            continue
        for i, p in enumerate(previous):
            if i not in claimed and normalize_title(p.get("title")) == key:
                claimed.add(i)
                matches[j] = i
                break
    return matches, claimed


def merge_checklist(previous, incoming, allow_drop_completed=False):
    """previous/incoming: {"subtasks": [...], "prerequisites": [...]} dicts.
    Returns {"subtasks", "prerequisites", "restoredSubtasks", "restoredPrerequisites"}.
    Each merged item carries "_origin": index of the previous item it came
    from (or None for new items) so scorers can trace it."""
    prev_subs = [s for s in previous.get("subtasks") or [] if isinstance(s, dict)]
    prev_pres = [p for p in previous.get("prerequisites") or [] if isinstance(p, dict)]
    used = {str(x.get("id")) for x in prev_subs + prev_pres}
    assigned = set()
    counter = [0]

    def fresh_id(candidate):
        cid = str(candidate).strip() if candidate is not None else ""
        while not cid or cid in used or cid in assigned:
            cid = f"ai-new-{counter[0]}"
            counter[0] += 1
        assigned.add(cid)
        return cid

    def valid(items):
        return [x for x in (items or []) if isinstance(x, dict) and normalize_title(x.get("title"))]

    # "I already did X": open items the reply lists in completedIds are marked done.
    done_ids = {str(i) for i in incoming.get("completedIds") or []}
    in_subs = valid(incoming.get("subtasks"))
    matches, claimed = _pair(prev_subs, in_subs)
    merged = []
    completed = []
    for item, idx in zip(in_subs, matches):
        fields = {k: v for k, v in item.items() if k not in ("isCompleted", "completedAt", "status")}
        if idx is not None:
            old = prev_subs[idx]
            assigned.add(str(old.get("id")))
            status = derive_status(old)
            if status == "done":
                merged.append({**old, "status": "done", "isCompleted": True, "_origin": idx})
            elif str(old.get("id")) in done_ids:
                item_done = {**old, "status": "done", "isCompleted": True, "_origin": idx}
                merged.append(item_done)
                completed.append(item_done)
            else:
                merged.append({**old, **fields, "id": old.get("id"), "status": status,
                               "isCompleted": False, "_origin": idx})
        else:
            merged.append({**fields, "title": str(fields.get("title")), "id": fresh_id(fields.get("id")),
                           "status": "todo", "isCompleted": False, "_origin": None})
    restored_subs = [] if allow_drop_completed else [
        {**s, "_origin": i} for i, s in enumerate(prev_subs) if i not in claimed and derive_status(s) == "done"
    ]
    # Marked done but dropped from the reply: keep it, done (the work happened).
    dropped_done = [{**s, "status": "done", "isCompleted": True, "_origin": i} for i, s in enumerate(prev_subs)
                    if i not in claimed and derive_status(s) != "done" and str(s.get("id")) in done_ids]
    completed += dropped_done
    restored_subs = restored_subs + dropped_done

    in_pres = valid(incoming.get("prerequisites"))
    pmatches, pclaimed = _pair(prev_pres, in_pres)
    merged_pres = []
    for item, idx in zip(in_pres, pmatches):
        fields = {k: v for k, v in item.items() if k != "isCompleted"}
        if idx is not None:
            old = prev_pres[idx]
            assigned.add(str(old.get("id")))
            if old.get("isCompleted"):
                merged_pres.append({**old, "_origin": idx})
            elif str(old.get("id")) in done_ids:
                merged_pres.append({**old, "isCompleted": True, "_origin": idx})
            else:
                merged_pres.append({**old, **fields, "id": old.get("id"), "isCompleted": False, "_origin": idx})
        else:
            merged_pres.append({**fields, "title": str(fields.get("title")), "id": fresh_id(fields.get("id")),
                                "isCompleted": False, "_origin": None})
    restored_pres = [] if allow_drop_completed else [
        {**p, "_origin": i} for i, p in enumerate(prev_pres) if i not in pclaimed and p.get("isCompleted")
    ]
    return {
        "subtasks": restored_subs + merged,
        "prerequisites": restored_pres + merged_pres,
        "restoredSubtasks": [s for s in restored_subs if s not in dropped_done],
        "restoredPrerequisites": restored_pres,
        "completedSubtasks": completed,
    }
