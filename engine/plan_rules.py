# engine/plan_rules.py
# Shared constants and pure helpers for two-level planning (planner.py,
# plan_validate.py) and the eval scorers (evals/scorers.py re-exports
# is_vague_title / is_redundant / similarity from here). No I/O, no model calls.

import re
from difflib import SequenceMatcher

STEP_MIN = 5
STEP_MAX = 20
FIRST_MAX = 5
PLAN_STEP_COUNT = (6, 15)
MILESTONE_COUNT = (2, 10)
BATCH_TARGET_MIN = 180
PASSION_HORIZON_DAYS = 28
# Coverage: milestones + prerequisites should reach this share of the expected minimum.
COVERAGE_RATIO = 0.6
OVER_PLANNED_RATIO = 2.0
# Steps of the current batch may exceed the milestone's estimate by this factor.
STEPS_OVER_MILESTONE = 1.15
# D5: effort floor = weight% x 150 h x 0.4 (15% -> 9 h). Minutes per weight point:
EFFORT_FLOOR_MIN_PER_PERCENT = 150 * 60 * 0.4 / 100

# --- vague titles (moved from evals/scorers.py) ---------------------------------

_VAGUE_LEADS = (
    "study", "work on", "research", "look at", "look into", "go over", "think about",
    "revise", "review", "practice", "practise", "prepare", "continue", "finish", "do", "complete",
    "learn", "brainstorm", "plan",
)
_STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "with", "my", "your", "it",
    "its", "into", "from", "up", "all", "each", "any", "via", "by", "at", "is", "be",
}


def is_vague_title(title):
    """
    Flags a vague verb used *on its own*: 'Study', 'Research topic',
    'Work on essay'. A vague lead verb followed by a concrete object of 3+
    content words ('Review lecture 7 slides on eigenvalues') is allowed. 'work on'
    is flagged anywhere since it never names an action.
    """
    t = re.sub(r"[^\w\s'-]", " ", (title or "").lower()).strip()
    words = t.split()
    if not words:
        return True
    if "work on" in t:
        return True
    for lead in _VAGUE_LEADS:
        lead_words = lead.split()
        if words[:len(lead_words)] == lead_words:
            rest = [w for w in words[len(lead_words):] if w not in _STOPWORDS]
            return len(rest) < 3
    return False


# --- redundancy (moved from evals/scorers.py) -------------------------------------

def _tokens(s):
    # Underscores stay inside tokens so identifiers like channels_create and
    # channels_list are different words.
    words = re.findall(r"[a-z0-9_]+", (s or "").lower())
    # Crude plural folding: "notifications" ~ "notification", "tests" ~ "test".
    return {w[:-1] if len(w) > 3 and w.endswith("s") and not w.endswith("ss") else w
            for w in words if w not in _STOPWORDS}


# Verbs that say nothing about WHICH work item it is.
_GENERIC_VERBS = {
    "write", "implement", "set", "do", "make", "draw", "finish", "complete", "start", "read",
    "create", "add", "build", "draft", "get", "check", "review", "solve", "collect", "find",
}
REDUNDANCY_RATIO = 0.75


def similarity(a, b):
    """(character-level ratio, content-token Jaccard), both 0-1."""
    ratio = SequenceMatcher(None, (a or "").lower(), (b or "").lower()).ratio()
    ta, tb = _tokens(a), _tokens(b)
    jac = len(ta & tb) / len(ta | tb) if ta and tb else 0.0
    return ratio, jac


def _numbers(s):
    return set(re.findall(r"\d+", s or ""))


def is_redundant(title, done):
    """(hit, ratio, jaccard): does `title` redo the finished item `done`?"""
    na, nb = _numbers(title), _numbers(done)
    if na and nb and not (na & nb):
        return False, 0.0, 0.0
    ratio, jac = similarity(title, done)
    if ratio >= 0.85:
        return True, ratio, jac
    distinctive = _tokens(done) - _GENERIC_VERBS
    strong = len(distinctive) >= 2 or any(ch.isdigit() for w in distinctive for ch in w)
    covered = strong and distinctive <= _tokens(title)
    return covered and (jac >= 0.5 or ratio >= REDUNDANCY_RATIO), ratio, jac


# --- grounding --------------------------------------------------------------------

_EXTENSIONS = (
    "py", "ipynb", "csv", "json", "md", "txt", "pdf", "docx", "doc", "ts", "tsx", "js", "jsx", "mjs",
    "c", "h", "cpp", "hpp", "java", "kt", "sql", "html", "css", "scss", "r", "rmd", "tex", "bib",
    "xlsx", "xls", "pptx", "sh", "yaml", "yml", "toml", "go", "rs", "rb", "php", "swift", "astro",
    "vue", "svelte", "ini", "cfg", "env", "lock", "db", "sqlite", "parquet",
)
_FILE_RE = re.compile(r"(?<![\w/.-])((?:[\w-]+/)*[\w][\w.-]*\.(?:" + "|".join(_EXTENSIONS) + r"))\b", re.I)
_CALL_RE = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]{2,})\(\)")
_SNAKE_RE = re.compile(r"\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b")
_CAMEL_RE = re.compile(r"\b([a-z]+[A-Z][A-Za-z0-9]*)\b")
_PASCAL_RE = re.compile(r"\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)\b")
_SECTION_RE = re.compile(r"\b(Q|Question|Stage|Part|Task|Section|Chapter|Lecture|Exercise|Problem)\s?(\d+(?:\.\d+)?[a-z]?)\b")
_CITE_RE = re.compile(r"\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s(?:et al\.?(?:,?\s\(?\d{4}\)?)?|\(\d{4}\)|,\s\d{4})")

# Names that are fine without appearing in the context: common tools, platforms
# and everyday formats a student uses regardless of the course.
GENERIC_NAMES = {
    "node.js", "next.js", "react.js", "vue.js", "three.js", "d3.js", "chart.js", "express.js",
    "nuxt.js", "socket.io", "asp.net", "vs code", "vscode", "e.g", "i.e", "etc",
    "readme.md", "context.md", "package.json", ".gitignore", "requirements.txt",
    "javascript", "typescript", "github", "gitlab", "youtube", "powerpoint", "onenote", "chatgpt",
    "linkedin", "turnitin", "moodle", "zotero", "overleaf", "notion", "obsidian", "jupyter",
    "pandas", "numpy", "matplotlib", "scikit-learn", "sklearn", "pytest", "vitest", "jest",
    "google docs", "google drive", "google scholar", "microsoft word", "word",
    "dataframe", "powerpoint", "github actions", "postgresql", "mysql", "sqlite", "mongodb",
    "macos", "iphone", "ipad", "youtube", "javascript", "openai",
}
# Well-known library / standard-library API names: real, not invented, even when
# the student's files don't mention them.
LIBRARY_NAMES = {
    # python / pandas / numpy / sklearn / matplotlib
    "read_csv", "to_datetime", "to_numeric", "drop_duplicates", "dropna", "fillna", "groupby", "value_counts",
    "get_dummies", "train_test_split", "linearregression", "logisticregression", "onehotencoder",
    "mean_squared_error", "r2_score", "mean_absolute_error", "cross_val_score", "standardscaler",
    "literal_eval", "json.loads", "isna", "isnull", "notna", "pivot_table", "read_json", "to_csv",
    "describe", "head", "plt.show", "subplots", "savefig", "np.mean", "np.sqrt", "random_state",
    "unittest", "pytest.fixture", "__init__", "__main__", "if __name__",
    # C
    "malloc", "calloc", "realloc", "free", "printf", "scanf", "fgets", "strcmp", "strcpy", "strlen", "sizeof",
    "main", "null", "fopen", "fclose",
    # JS / TS / React
    "usestate", "useeffect", "usememo", "usecallback", "useref", "console.log", "addeventlistener",
    "queryselector", "localstorage", "fetch", "async", "await", "settimeout", "json.parse", "json.stringify",
    "getelementbyid", "innerhtml", "classname", "onclick", "typescript", "darkmode",
}
GENERIC_NAMES = GENERIC_NAMES | LIBRARY_NAMES


def _norm(s):
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def extract_names(text):
    """
    Specific names a plan step could invent: file names (with or without a
    path), function calls `foo()`, snake_case / camelCase / PascalCase
    identifiers, numbered sections (Q4, Stage 3, Section 2.1) and author
    citations (Smith et al. 2020). Returns a set of the names as written.
    """
    text = text or ""
    names = set()
    for m in _FILE_RE.finditer(text):
        names.add(m.group(1))
    for rx in (_CALL_RE, _SNAKE_RE, _CAMEL_RE, _PASCAL_RE):
        for m in rx.finditer(text):
            names.add(m.group(1))
    for m in _SECTION_RE.finditer(text):
        names.add(f"{m.group(1)} {m.group(2)}" if len(m.group(1)) > 1 else f"{m.group(1)}{m.group(2)}")
    for m in _CITE_RE.finditer(text):
        names.add(m.group(1))
    return {n for n in names if _norm(n) not in GENERIC_NAMES and not _norm(n).startswith(("e.g", "i.e"))}


def _section_variants(name):
    """'Q4' should match 'Q4' or 'Question 4'; 'Stage 3' matches 'Stage 3'/'stage3'."""
    m = re.match(r"^(Q|Question)\s?(\S+)$", name, re.I)
    if m:
        n = m.group(2)
        return [f"q{n}", f"q {n}", f"question {n}"]
    m = re.match(r"^([A-Za-z]+)\s?(\d\S*)$", name)
    if m:
        return [f"{m.group(1).lower()} {m.group(2)}", f"{m.group(1).lower()}{m.group(2)}"]
    return [name.lower()]


def is_grounded(name, haystack_lower, extra=()):
    """True if `name` (or its basename / section variants) appears in the context."""
    n = _norm(name)
    if not n or n in GENERIC_NAMES:
        return True
    if any(_norm(e) == n for e in extra):
        return True
    candidates = {n, n.split("/")[-1], n.strip("()")}
    if n.endswith("()"):
        candidates.add(n[:-2])
    candidates.update(_section_variants(name))
    for c in candidates:
        if not c:
            continue
        if re.match(r"^(q|question|stage|part|task|section|chapter|lecture|exercise|problem)\s?\d", c):
            # Word-bounded: "q1" must not match inside "q10".
            if re.search(r"(?<![a-z0-9])" + re.escape(c) + r"(?![0-9])", haystack_lower):
                return True
        elif c in haystack_lower:
            return True
    return False


def ungrounded_names(text, haystack, extra=()):
    hay = (haystack or "").lower()
    return sorted(n for n in extract_names(text) if not is_grounded(n, hay, extra))


# --- AI delegation ----------------------------------------------------------------

_AI = r"(?:chat\s?gpt|gpt-?\d*|claude|copilot|gemini|bard|an?\s+ai(?:\s+(?:tool|assistant|chatbot))?|the\s+ai|ai|llm|a\s+chatbot|generative\s+ai)"
AI_DELEGATION_RE = re.compile(
    r"\b(?:ask|have|get|use|using|prompt|let|paste\s+(?:it|.{0,30})\s+into)\s+" + _AI + r"\b.{0,60}?\b"
    r"(?:write|writes|fix|fixes|solve|generate|code|debug|draft|complete|answer|explain|do|check|correct)"
    r"|\b" + _AI + r"\s+(?:to\s+)?(?:write|fix|generate|solve|debug|draft|explain)\b"
    r"|\bai[- ](?:generated|written)\b",
    re.I,
)
_AI_BAN_RE = re.compile(
    r"\b(?:no|not|never|forbid\w*|prohibit\w*|banned?|may not|must not|cannot|can't)\b.{0,60}\b(?:ai|chat\s?gpt|copilot|generative|llm)\b"
    r"|\b(?:ai|chat\s?gpt|copilot|generative ai|llm)s?\b.{0,40}\b(?:not (?:allowed|permitted)|forbidden|prohibited|banned|may not|must not)\b",
    re.I,
)


def mentions_ai_delegation(title):
    return bool(AI_DELEGATION_RE.search(title or ""))


def ai_banned(constraints_text):
    """True when the constraints / context forbid AI help."""
    return bool(_AI_BAN_RE.search(constraints_text or ""))


# --- effort floor -----------------------------------------------------------------

def effort_floor(assessment):
    """Minutes of honest effort implied by an assessment's weight (D5), or None."""
    if not isinstance(assessment, dict):
        return None
    w = assessment.get("weight")
    try:
        w = float(w)
    except (TypeError, ValueError):
        return None
    if w <= 0:
        return None
    return int(round(min(w, 100) * EFFORT_FLOOR_MIN_PER_PERCENT))
