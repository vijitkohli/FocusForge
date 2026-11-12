# engine/doctext.py
# Text from a PDF or .docx for the context pack (Phase 3 readers).
#
# Reads one JSON payload from stdin: { "kind": "pdf"|"docx", "data_b64": "...", "max_chars": 15000 }
# Prints one JSON object to stdout: { "text": "..." } or { "error": "<code>" }
#
# It takes bytes, never a path, so Python never opens an owner path (the app's
# path guard read them). Stdlib + pypdf only: it never imports vault.py, which
# loads chromadb and torch at import time. No network. Errors are generic
# codes; document text is never written to stderr.

import base64
import io
import json
import logging
import re
import sys
import warnings
import zipfile
import xml.etree.ElementTree as ET

DEFAULT_MAX_CHARS = 15000
W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def pdf_text(data, max_chars):
    # pypdf logs parse warnings that can quote document bytes; keep stderr content-free.
    logging.disable(logging.CRITICAL)
    warnings.filterwarnings("ignore")
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    parts = []
    used = 0
    for page in reader.pages:
        try:
            t = page.extract_text() or ""
        except Exception:
            t = ""
        if t.strip():
            parts.append(t)
            used += len(t)
        if used >= max_chars:
            break
    return "\n\n".join(parts)


def docx_text(data, max_chars):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        info = z.getinfo("word/document.xml")
        if info.file_size > 50 * 1024 * 1024:
            raise ValueError("too-large")
        xml = z.read("word/document.xml")
    root = ET.fromstring(xml)
    paras = []
    used = 0
    for p in root.iter(W_NS + "p"):
        chunks = []
        for node in p.iter():
            if node.tag == W_NS + "t" and node.text:
                chunks.append(node.text)
            elif node.tag == W_NS + "tab":
                chunks.append("\t")
            elif node.tag in (W_NS + "br", W_NS + "cr"):
                chunks.append("\n")
        line = "".join(chunks).strip()
        if line:
            paras.append(line)
            used += len(line)
        if used >= max_chars:
            break
    return "\n".join(paras)


def run(payload):
    kind = payload.get("kind")
    try:
        max_chars = int(payload.get("max_chars") or DEFAULT_MAX_CHARS)
    except (TypeError, ValueError):
        max_chars = DEFAULT_MAX_CHARS
    max_chars = max(100, min(max_chars, 200000))
    try:
        data = base64.b64decode(payload.get("data_b64") or "", validate=True)
    except Exception:
        return {"error": "bad-input"}
    if not data:
        return {"error": "bad-input"}
    try:
        if kind == "pdf":
            text = pdf_text(data, max_chars)
        elif kind == "docx":
            text = docx_text(data, max_chars)
        else:
            return {"error": "bad-input"}
    except Exception:
        return {"error": "unreadable"}
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not text:
        return {"error": "empty"}
    return {"text": text[:max_chars]}


if __name__ == "__main__":
    raw = sys.stdin.read()
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        payload = json.loads(raw) if raw.strip() else {}
        result = run(payload if isinstance(payload, dict) else {})
    except Exception:
        result = {"error": "internal"}
    finally:
        sys.stdout = real_stdout
    print(json.dumps(result))
    sys.stdout.flush()
