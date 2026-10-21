#!/usr/bin/env python3
"""Print JSON about the owner's WhatsApp conversation with Hermes so a phone call can join it:
   {"session_id", "session_key", "recent": [{"role","text"}...], "profile": "..."}
Usage: wa_session_info.py <owner phone digits> [max_messages]. Read-only. Prints {} when nothing is found."""
import json, os, re, sqlite3, sys

HOME = os.environ.get("HERMES_HOME", "/opt/data")
owner = re.sub(r"\D", "", sys.argv[1] if len(sys.argv) > 1 else "")
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 14
out = {}
try:
    if not owner:
        raise ValueError("no owner")
    db = sqlite3.connect("file:%s/state.db?mode=ro" % HOME, uri=True, timeout=5)
    key = "agent:main:whatsapp:dm:" + owner
    row = db.execute("SELECT id, model, model_config FROM sessions WHERE session_key=? AND source='whatsapp' AND ended_at IS NULL "
                     "ORDER BY coalesce(last_activity_at, started_at) DESC LIMIT 1", (key,)).fetchone()
    if row:
        sid = row[0]
        mc = {}
        try:
            mc = json.loads(row[2] or "{}")
        except Exception:
            pass
        out_model = mc.get("model") or row[1]
        out_provider = mc.get("provider")
        msgs = db.execute("SELECT role, content FROM messages WHERE session_id=? AND role IN ('user','assistant') "
                          "AND coalesce(content,'')!='' ORDER BY id DESC LIMIT ?", (sid, max(limit * 3, 60))).fetchall()
        recent = []
        for role, content in reversed(msgs):
            t = str(content)
            t = re.sub(r"^\[[^\]]{150,}\]\s*", "", t)          # injected context blocks (style notes, contact inbox, ...)
            t = re.sub(r"\s+", " ", t).strip()
            if not t or t.startswith("[Reaction") or t.startswith("[Voice call"):
                continue
            recent.append({"role": role, "text": t[:300]})
        styles = []
        for role, content in reversed(msgs):                 # how he writes to the owner: his own latest short replies
            if role != "assistant":
                continue
            t = re.sub(r"\s+", " ", str(content)).strip()
            if 15 <= len(t) <= 260 and not t.startswith("[") and "```" not in t:
                styles.append(t)
            if len(styles) >= 8:
                break
        out = {"session_id": sid, "session_key": key, "recent": recent[-limit:], "style": list(reversed(styles)),
               "model": out_model, "provider": out_provider}
    try:
        soul = open(os.path.join(HOME, "SOUL.md"), encoding="utf-8").read()
        soul = re.sub(r"<!--.*?-->", "", soul, flags=re.S)
        soul = re.sub(r"\n{3,}", "\n\n", soul).strip()
        out["soul"] = soul[:3200]
    except OSError:
        pass
    try:
        prof = open(os.path.join(HOME, "memories", "USER.md"), encoding="utf-8").read()
        out["profile"] = re.sub(r"\s*§\s*", "; ", prof).strip()[:2600]
    except OSError:
        pass
    try:
        mem = open(os.path.join(HOME, "memories", "MEMORY.md"), encoding="utf-8").read()
        out["memory"] = re.sub(r"\s*§\s*", "; ", mem).strip()[:3600]
    except OSError:
        pass
except Exception as exc:
    out = {"error": str(exc)[:120]}
print(json.dumps(out, ensure_ascii=False))