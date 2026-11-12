# engine/evals/fixture_pack.py
# Builds Phase 3-shaped context packs from the synthetic folders in
# engine/evals/fixtures/folders, so the planner (Phase 5) can be built and
# evaluated before the real readers exist. Nothing here reads outside the
# fixtures directory.
#
#   build_pack(folder, today) -> (pack, digest)
#       pack   = ContextPack (src/common/readers.ts shape: files with ids,
#                model-safe labels, kinds, git blocks, index, fingerprint)
#       digest = ItemDigest (src/common/digest.ts shape) from the folder's
#                hand-written digest.json, so evals don't depend on a model
#   pack_to_prompt_text(pack, max_chars) -> str
#       the cross-phase prompt format (SYNC_PLAN contract 2):
#       "=== FILE <id>: <label> (<kind>, modified YYYY-MM-DD) ==="
#
#   engine/env/bin/python engine/evals/fixture_pack.py --out /tmp/packs
#       writes <itemId>.json = {"pack": ..., "digest": ...} for the app's
#       FixturePackSource (FOCUSFORGE_PACK_FIXTURES) and QA.
#
# Fixture conventions:
#   - Markdown files are stored as `<name>.md.txt` (the repo never commits
#     *.md); the trailing `.txt` is dropped from labels.
#   - `{{d+N}}` / `{{d-N}}` in any text is replaced with today +/- N days.
#   - meta.json: {"label": folder label, "item": {...}, "modified": {rel: day offset}}.
#   - `gitlog.txt` becomes a GIT block; files under `vault/` get `vault:` labels.

import argparse
import hashlib
import json
import os
import re
from datetime import date, datetime, timedelta

FIXTURES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "folders")
PACK_VERSION = 1
DIGEST_VERSION = 1
BUDGET = {
    "maxChars": 120_000, "perFileChars": 30_000, "maxFiles": 80,
    "gitCommits": 50, "gitChars": 12_000, "vaultChars": 30_000, "briefChars": 30_000,
    "indexChars": 8_000, "maxReadBytesPerBuild": 8 * 1024 * 1024,
}
_AGENT_NAMES = re.compile(
    r"^(claude|agents|gemini|status|recap|todo|decisions|project_summary|readme)\.md$|^(handoff|plan).*\.md$", re.I)
_BRIEF_NAMES = re.compile(r"(spec|brief|rubric|outline|assignment|marking|criteria)", re.I)
_TIER = {"context": 0, "vault": 1, "agent": 2, "brief": 4, "doc": 5, "notebook": 5, "docx": 5, "pdf": 4}
_DATE_TOKEN = re.compile(r"\{\{d([+-]\d+)\}\}")


def _subst(text, today):
    return _DATE_TOKEN.sub(lambda m: (today + timedelta(days=int(m.group(1)))).isoformat(), text)


def _logical(rel):
    return rel[:-4] if rel.endswith(".md.txt") else rel


def _classify(rel):
    """(kind, tier) for a logical relative path, or None to skip."""
    parts = rel.split("/")
    name = parts[-1]
    depth = len(parts) - 1
    if parts[0] == "vault":
        return "vault"
    if rel == "CONTEXT.md":
        return "context"
    if name.endswith(".ipynb"):
        return "notebook"
    if _AGENT_NAMES.match(name) and depth <= 2 and not (name.lower() == "readme.md" and depth > 1):
        return "agent"
    if _BRIEF_NAMES.search(name):
        return "brief"
    if name.endswith((".md", ".txt", ".markdown")):
        return "doc"
    return None


def head_tail(text, limit, head_ratio=0.7):
    if len(text) <= limit:
        return text, False
    head = text[: int(limit * head_ratio)]
    tail = text[-(limit - len(head)):]
    head = head[: head.rfind("\n")] if "\n" in head else head
    tail = tail[tail.find("\n") + 1:] if "\n" in tail else tail
    omitted = len(text) - len(head) - len(tail)
    return f"{head}\n[… {omitted:,} characters omitted …]\n{tail}", True


def _notebook_text(raw):
    try:
        nb = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    out = []
    for cell in nb.get("cells", []):
        src = "".join(cell.get("source") or [])
        if cell.get("cell_type") == "code":
            src = "\n".join(src.split("\n")[:60])
        out.append(f"# %% [{cell.get('cell_type', 'markdown')}]\n{src}")
    return "\n\n".join(out)


def _escape(text):
    # File content can't forge a block header (Phase 3 escapeFenceLines).
    return "\n".join(("​" + ln) if ln.startswith("===") else ln for ln in text.split("\n"))


def _parse_gitlog(text):
    commits, cur = [], None
    for line in text.splitlines():
        if not line.strip():
            continue
        if line.startswith((" ", "\t")):
            if cur is not None:
                cur["files"].append(line.strip())
            continue
        bits = line.split(" ", 2)
        if len(bits) == 3:
            cur = {"date": bits[0], "hash": bits[1], "subject": bits[2], "files": []}
            commits.append(cur)
    return commits


def _render_git(commits):
    lines = []
    for c in commits:
        lines.append(f"{c['date']} {c['hash']} {c['subject']}")
        lines.extend(f"    {f}" for f in c["files"][:20])
    return "\n".join(lines)


def _mtime_ms(today, offset):
    d = datetime.combine(today + timedelta(days=int(offset)), datetime.min.time()).replace(hour=12)
    return int(d.timestamp() * 1000)


def build_pack(folder, today=None):
    """Returns (pack, digest) for a fixture folder (name or absolute path)."""
    today = today or date.today()
    root = folder if os.path.isabs(folder) else os.path.join(FIXTURES_DIR, folder)
    meta = json.load(open(os.path.join(root, "meta.json")))
    label = meta.get("label") or os.path.basename(root)
    item_id = (meta.get("item") or {}).get("id") or os.path.basename(root)
    modified = meta.get("modified") or {}

    entries, git = [], []
    for dirpath, _dirs, names in os.walk(root):
        for name in sorted(names):
            abs_path = os.path.join(dirpath, name)
            rel_raw = os.path.relpath(abs_path, root).replace(os.sep, "/")
            if rel_raw in ("meta.json", "digest.json"):
                continue
            rel = _logical(rel_raw)
            raw = _subst(open(abs_path, encoding="utf-8").read(), today)
            offset = modified.get(rel, -1)
            if rel == "gitlog.txt":
                commits = _parse_gitlog(raw)[: BUDGET["gitCommits"]]
                text, _ = head_tail(_render_git(commits), BUDGET["gitChars"])
                git.append({"id": f"G{len(git) + 1}", "label": f"git:{label}",
                            "head": commits[0]["hash"] if commits else "", "commits": commits, "text": text})
                continue
            kind = _classify(rel)
            if kind is None:
                continue
            content = _notebook_text(raw) if kind == "notebook" else raw
            excerpt, truncated = head_tail(content, BUDGET["perFileChars"])
            file_label = f"vault:{rel[len('vault/'):]}" if kind == "vault" else f"{label}/{rel}"
            entries.append({
                "label": file_label, "ref": f"fixture:{os.path.basename(root)}/{rel}", "kind": kind,
                "mtimeMs": _mtime_ms(today, offset), "size": len(raw.encode()),
                "hash": hashlib.sha256(raw.encode()).hexdigest(), "chars": len(excerpt),
                "truncated": truncated, "redactions": 0, "changed": False, "text": _escape(excerpt),
            })

    entries.sort(key=lambda e: (_TIER[e["kind"]], -e["mtimeMs"], e["label"].count("/")))
    files, index, total = [], [], sum(len(g["text"]) for g in git)
    for e in entries:
        if len(files) >= BUDGET["maxFiles"] or total + e["chars"] > BUDGET["maxChars"]:
            index.append({"label": e["label"], "date": _date_of(e["mtimeMs"])})
            continue
        e["id"] = f"F{len(files) + 1}"
        files.append(e)
        total += e["chars"]
    newest = max([e["mtimeMs"] for e in entries] or [0])
    fingerprint = hashlib.sha256(json.dumps(
        sorted([(f["label"], f["hash"]) for f in files]) + [g["head"] for g in git]).encode()).hexdigest()
    pack = {
        "version": PACK_VERSION, "itemId": item_id, "builtAt": f"{today.isoformat()}T09:00:00.000Z",
        "budget": BUDGET, "totalChars": total, "truncated": bool(index),
        "sources": [{"ref": f"fixture:{os.path.basename(root)}", "state": "ok" if files else "empty", "files": len(files)}],
        "files": files, "git": git, "index": index, "seen": {},
        "activityAt": (datetime.fromtimestamp(newest / 1000).isoformat() if newest else None),
        "notDownloaded": 0, "conflicts": 0, "fingerprint": fingerprint,
    }
    return pack, _load_digest(root, item_id, today, fingerprint)


def _date_of(ms):
    return datetime.fromtimestamp(ms / 1000).date().isoformat()


def _load_digest(root, item_id, today, fingerprint):
    path = os.path.join(root, "digest.json")
    if not os.path.exists(path):
        return None
    raw = json.loads(_subst(open(path, encoding="utf-8").read(), today))
    digest = {
        "version": DIGEST_VERSION, "itemId": item_id, "generatedAt": f"{today.isoformat()}T09:00:00.000Z",
        "model": "fixture", "mode": "full", "incrementalSinceFull": 0, "packFingerprint": fingerprint,
        "promptVersion": 1,
        "goal": "", "currentState": "", "openItems": [], "dueDates": [], "recentProgress": [],
        "candidateTasks": [], "constraints": [], "suggestedKind": None, "warnings": [],
    }
    digest.update(raw)
    return digest


def pack_to_prompt_text(pack, max_chars=120_000):
    """Contract-2 prompt text: FILE blocks in id order, then GIT blocks, then the INDEX."""
    if not pack:
        return ""
    blocks, used = [], 0
    for f in pack.get("files") or []:
        block = (f"=== FILE {f['id']}: {f['label']} ({f['kind']}, modified {_date_of(f['mtimeMs'])}) ===\n"
                 f"{f['text']}\n=== END {f['id']} ===")
        if used + len(block) > max_chars:
            break
        blocks.append(block)
        used += len(block)
    for g in pack.get("git") or []:
        block = f"=== GIT {g['id']}: {g['label']} ===\n{g['text']}\n=== END {g['id']} ==="
        if used + len(block) > max_chars:
            break
        blocks.append(block)
        used += len(block)
    if pack.get("index"):
        lines = "\n".join(f"{i['label']} · {i['date']}" for i in pack["index"])
        blocks.append(f"=== INDEX (files not shown) ===\n{lines[:8000]}\n=== END INDEX ===")
    return "\n\n".join(blocks)


def pack_labels(pack):
    """Every label the planner may name (files, git, index)."""
    if not pack:
        return []
    return [f["label"] for f in pack.get("files") or []] + [g["label"] for g in pack.get("git") or []] \
        + [i["label"] for i in pack.get("index") or []]


def list_folders():
    return sorted(d for d in os.listdir(FIXTURES_DIR) if os.path.isfile(os.path.join(FIXTURES_DIR, d, "meta.json")))


def main():
    ap = argparse.ArgumentParser(description="Write fixture packs as <itemId>.json for FixturePackSource")
    ap.add_argument("--out", required=True)
    ap.add_argument("--today", help="YYYY-MM-DD (default: today)")
    args = ap.parse_args()
    today = date.fromisoformat(args.today) if args.today else date.today()
    os.makedirs(args.out, exist_ok=True)
    for name in list_folders():
        pack, digest = build_pack(name, today)
        meta = json.load(open(os.path.join(FIXTURES_DIR, name, "meta.json")))
        out = {"pack": pack, "digest": digest, "item": meta.get("item")}
        with open(os.path.join(args.out, f"{pack['itemId']}.json"), "w") as f:
            json.dump(out, f, indent=1)
        print(f"{name} -> {pack['itemId']}.json ({len(pack['files'])} files, {pack['totalChars']} chars)")


if __name__ == "__main__":
    main()
