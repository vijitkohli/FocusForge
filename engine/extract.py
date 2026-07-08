# engine/extract.py
# Attach-time document extraction. Invoked once per file attachment, not per
# chat turn - decouples the slow embedding cold-load from chat latency.
#
# Reads one JSON payload from stdin: { "file_path": "...", "query": "..." }
# Prints one JSON object to stdout: { "context": "..." }

import sys, json
from vault import extract_pages, relevant_chunks

# Below this many characters, just return the whole document - no need to
# spend time embedding/filtering a short syllabus or assignment brief.
RELEVANCE_FILTER_THRESHOLD = 6000
TOP_N_CHUNKS = 5


def extract_context(file_path, query):
    pages = extract_pages(file_path)

    if not pages:
        return ""

    full_text = "\n\n".join(pages)
    if len(full_text) <= RELEVANCE_FILTER_THRESHOLD:
        return full_text

    chunks = relevant_chunks(pages, query, n=TOP_N_CHUNKS)
    return "\n\n".join(chunks)


if __name__ == "__main__":
    raw_input = sys.stdin.read()
    payload = json.loads(raw_input) if raw_input.strip() else {}

    file_path = payload.get("file_path")
    query = payload.get("query", "")

    # chromadb/sentence-transformers print model-download notices, tqdm
    # progress bars, etc straight to stdout, which corrupts python-shell's
    # json-mode parsing (one JSON object expected per stdout line). Redirect
    # everything but our final result line to stderr.
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        context = extract_context(file_path, query)
        result = {"context": context}
    except Exception as e:
        result = {"context": "", "error": str(e)}
    finally:
        sys.stdout = real_stdout

    print(json.dumps(result))
    sys.stdout.flush()
