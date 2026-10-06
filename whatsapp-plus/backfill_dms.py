"""Rebuild the 1:1 contact conversations in wa_group_history.db from Hermes' own session store and the outbound send log (idempotent).
Run as the hermes user:  python backfill_dms.py"""
import os, re, sqlite3, time

HOME = os.environ.get("HERMES_HOME", "/opt/data")
HIST = HOME + "/state/wa_group_history.db"
LABEL = re.compile(r"\[EXTERNAL CONTACT (.*?) \(\+(\d+)\):")
names, n = {}, 0
src = sqlite3.connect("file:%s/state.db?mode=ro" % HOME, uri=True)
db = sqlite3.connect(HIST, timeout=5)
db.execute("CREATE TABLE IF NOT EXISTS msgs(id TEXT PRIMARY KEY, ts REAL, chat TEXT, chat_name TEXT, sender TEXT, sender_name TEXT, body TEXT, quoted TEXT)")
cols = {r[1] for r in db.execute("PRAGMA table_info(msgs)")}
for c, ddl in (("handled", "INTEGER DEFAULT 0"), ("media", "TEXT DEFAULT ''")):
    if c not in cols:
        db.execute("ALTER TABLE msgs ADD COLUMN %s %s" % (c, ddl))
ins = "INSERT OR IGNORE INTO msgs(id,ts,chat,chat_name,sender,sender_name,body,quoted,handled) VALUES (?,?,?,?,?,?,?,?,1)"
for sid, in src.execute("SELECT id FROM sessions WHERE source='whatsapp' AND chat_id NOT LIKE '%@g.us'").fetchall():
    rows = src.execute("SELECT id, role, timestamp, content FROM messages WHERE session_id=? AND role IN ('user','assistant') AND coalesce(content,'')!='' ORDER BY id", (sid,)).fetchall()
    who = None
    for _id, role, ts, content in rows:  # find who this session is with (the first labelled turn)
        m = LABEL.search(content) if role == "user" else None
        if m:
            who = (m.group(1), m.group(2)); break
    if not who:
        continue  # a person with a normal chat (owner/limited user/...), not an outside contact
    nm, num = who
    names[num] = nm
    jid = num + "@s.whatsapp.net"
    for _id, role, ts, content in rows:
        if role == "user":
            if "[EXTERNAL CONTACT" not in content:
                continue
            body = content.split("automatically.]\n", 1)[-1] if "automatically.]\n" in content else content
            db.execute(ins, ("bf-%s" % _id, ts, jid, nm, jid, nm, body.strip()[:4000], "")); n += 1
        else:
            db.execute(ins, ("bf-%s" % _id, ts, jid, nm, "hermes", "Hermes", content.strip()[:4000], "")); n += 1
try:  # messages sent with the whatsapp_send tool
    for line in open(HOME + "/state/wa_outbound.log", encoding="utf-8", errors="replace"):
        p = line.rstrip("\n").split("\t", 4)
        if len(p) == 5 and p[1] == "SENT" and p[2].endswith("@s.whatsapp.net") and p[0].replace(".", "").isdigit():
            num = p[2].split("@")[0]
            db.execute(ins, ("bfo-%s" % p[3], float(p[0]), p[2], names.get(num, num), "hermes", "Hermes", p[4][:4000], "")); n += 1
except OSError:
    pass
db.commit()
print("backfilled up to %d rows for %d contacts: %s" % (n, len(names), ", ".join("%s (+%s)" % (v, k) for k, v in names.items())))
