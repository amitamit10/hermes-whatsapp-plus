#!/usr/bin/env python3
"""Read-only MemPalace lookup for the live voice (JSON lines on stdin -> JSON lines on stdout).

Runs in the Hermes venv so it can import mempalace; it only searches, it never writes to the palace.
  {"id": 1, "op": "search", "query": "...", "limit": 4}   -> semantic search over the stored memories
  {"id": 2, "op": "kg", "entity": "..."}                   -> facts about an entity from the knowledge graph
"""
import json
import os
import re
import sys
import time

HOME = os.environ.get("HERMES_HOME", "/opt/data")


def env_value(name):
    """Read one variable from Hermes's .env by name (the rest of the file is never looked at)."""
    try:
        with open(os.path.join(HOME, ".env"), encoding="utf-8") as f:
            for line in f:
                if line.startswith(name + "="):
                    return line.split("=", 1)[1].strip().strip("'\"")
    except OSError:
        pass
    return ""


for _k in ("MEMPALACE_EMBEDDING_API_KEY", "MEMPALACE_EMBEDDING_API_URL", "MEMPALACE_EMBEDDING_API_MODEL"):
    if not os.environ.get(_k):
        _v = env_value(_k)
        if _v:
            os.environ[_k] = _v

from mempalace.query_sanitizer import sanitize_query  # noqa: E402
from mempalace.searcher import search_memories  # noqa: E402


def palace_path():
    p = os.environ.get("MEMPALACE_PALACE_PATH", "").strip()
    if p:
        return p
    try:
        with open(os.path.join(os.path.expanduser("~"), ".mempalace", "config.json"), encoding="utf-8") as f:
            return json.load(f).get("palace_path") or ""
    except (OSError, ValueError):
        return os.path.expanduser("~/.mempalace/palace")


PALACE = palace_path()
_kg = None
_SECRETS = re.compile(r"(sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|[A-Za-z0-9_-]{32,})")


def clean(text, limit):
    text = _SECRETS.sub("<hidden>", re.sub(r"\s+", " ", str(text or "")).strip())
    return text if len(text) <= limit else text[: limit - 3] + "..."


def do_search(query, limit):
    q = sanitize_query(query)["clean_query"]
    res = search_memories(q, palace_path=PALACE, n_results=max(1, min(int(limit or 4), 8)), max_distance=1.3)
    items = res.get("results", []) if isinstance(res, dict) else []
    if not items:
        return "No stored memory matches that."
    out = []
    for r in items:
        tag = "[%s/%s] " % (r.get("wing", ""), r.get("room", "")) if r.get("wing") else ""
        out.append(tag + clean(r.get("text"), 420))
    return "\n---\n".join(out)


def do_kg(entity):
    global _kg
    from mempalace.config import sanitize_kg_value
    from mempalace.knowledge_graph import KnowledgeGraph
    if _kg is None:
        _kg = KnowledgeGraph(db_path=os.path.join(os.path.dirname(PALACE), "knowledge_graph.sqlite3"))
    facts = _kg.query_entity(sanitize_kg_value(entity, "entity"), direction="both")
    if not facts:
        return "No facts about that in the knowledge graph."
    return "\n".join(clean(json.dumps(f, ensure_ascii=False, default=str), 260) for f in facts[:12])


def main():
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        t0 = time.time()
        try:
            if req.get("op") == "kg":
                text = do_kg(req.get("entity", ""))
            else:
                text = do_search(req.get("query", ""), req.get("limit"))
            resp = {"id": req.get("id"), "ok": True, "text": text}
        except Exception as e:  # keep serving; the caller falls back to ask_hermes
            resp = {"id": req.get("id"), "ok": False, "text": "memory search failed: " + str(e)[:120]}
        resp["ms"] = int((time.time() - t0) * 1000)
        print(json.dumps(resp, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
