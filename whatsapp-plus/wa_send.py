#!/usr/bin/env python3
"""Send a WhatsApp message/file to a number, saved contact name, or group through the local bridge (audit log + rate limit).
Usage:
  wa_send.py [--dry] [--file PATH] <number|name|jid> [message...]   (message is the caption when --file is used)
  wa_send.py --contacts | --add NAME NUMBER | --remove NAME
  wa_send.py --backfill [group]   (ask the phone for ~50 older group messages)
  wa_send.py --groups   |   --poll <group|number> <question> <opt1> <opt2> ... [--multi]
  wa_send.py --delete <number|name|group-jid|message-id>   (retract the last message we sent there / that message)
Numbers: +972501234567, 972501234567 or Israeli local 0501234567 (leading 0 -> 972). A JID (...@g.us / @s.whatsapp.net) is used as is."""
import json, os, random, re, sys, time, urllib.error, urllib.request

BRIDGE = "http://127.0.0.1:3000"
STATE = "/opt/data/state"
LOG = STATE + "/wa_outbound.log"
TEMP = STATE + "/wa_temp_contacts.json"
BOOK = STATE + "/wa_contacts.json"
CC = "972"
MAX_PER_HOUR = 30
TEMP_HOURS = 48
KNOWN = STATE + "/wa_known_recipients.json"
NEW_PER_DAY = 10
LINK = re.compile(r"(https?://|www\.)", re.I)
BLOCKED = ("/opt/data/.env", "auth.json", "google_token", "/whatsapp/session", "/.ssh/", "/etc/", ".pem", ".key", "id_rsa",
           "/.mempalace/", "credentials", "/proc/", "/sys/")
MEDIA = {**dict.fromkeys(("jpg", "jpeg", "png", "webp", "gif"), "image"), **dict.fromkeys(("mp4", "mov", "3gp", "webm", "mkv"), "video"),
         **dict.fromkeys(("ogg", "opus", "mp3", "m4a", "wav"), "audio")}


def load(p, d):
    try:
        return json.load(open(p))
    except Exception:
        return d


def save(p, o):
    os.makedirs(STATE, exist_ok=True)
    tmp = p + ".tmp"
    json.dump(o, open(tmp, "w"), ensure_ascii=False, indent=1)
    os.replace(tmp, p)


def to_number(t):
    d = re.sub(r"\D", "", t)
    if t.strip().startswith("+"):
        pass
    elif d.startswith("00"):
        d = d[2:]
    elif d.startswith("0"):
        d = CC + d[1:]
    return d if 8 <= len(d) <= 15 else None


def bridge_get(path):
    try:
        return json.load(urllib.request.urlopen(BRIDGE + path, timeout=15))
    except Exception:
        return None


def resolve(t):
    t = t.strip()
    if "@" in t:
        return t, None
    if re.fullmatch(r"\d{16,22}", t):  # longer than any phone number: a bare group id (#102348)
        return t + "@g.us", None
    n = to_number(t) if re.fullmatch(r"[+\d\s()-]{8,}", t) else None
    if n:
        return n + "@s.whatsapp.net", None
    book = load(BOOK, {})
    low = {k.lower(): (k, v) for k, v in book.items()}
    hit = low.get(t.lower())
    if not hit:
        part = [kv for k, kv in low.items() if t.lower() in k]
        hit = part[0] if len(part) == 1 else None
    if hit:
        return to_number(hit[1]) + "@s.whatsapp.net", hit[0]
    groups = bridge_get("/groups") or []
    gm = [g for g in groups if (g.get("name") or "").lower() == t.lower()] or [g for g in groups if t.lower() in (g.get("name") or "").lower()]
    if len(gm) == 1:
        return gm[0]["id"], gm[0].get("name")
    sys.exit("ERROR: '%s' is not a number or a saved contact. Saved contacts: %s" % (t, ", ".join(book) or "(none)"))


def log_group(to, msg):
    """Record our own message in the group history (only for groups that are already being logged)."""
    try:
        import sqlite3
        db = sqlite3.connect(STATE + "/wa_group_history.db", timeout=3)
        row = db.execute("SELECT MAX(chat_name) FROM msgs WHERE chat=?", (to,)).fetchone()
        if row and (row[0] is None) and to.endswith("@s.whatsapp.net"):
            row = (to.split("@")[0],)  # a 1:1 chat is logged too (searchable with whatsapp_history include_dms)
        if row and (row[0] is not None):
            now = time.time()
            db.execute("INSERT OR IGNORE INTO msgs(id,ts,chat,chat_name,sender,sender_name,body,quoted,handled) VALUES (?,?,?,?,?,?,?,?,1)", ("out-%s-%s" % (to, now), now, to, row[0], "hermes", "Hermes", msg[:4000], ""))
            db.commit()
        db.close()
    except Exception:
        pass


def recent():
    try:
        cut = time.time() - 3600
        return sum(1 for l in open(LOG) if l[:1].isdigit() and float(l.split("\t", 1)[0]) > cut and "\tSENT\t" in l)
    except OSError:
        return 0


def post(path, body):
    req = urllib.request.Request(BRIDGE + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=120))
    except urllib.error.HTTPError as e:
        try:
            r = json.loads(e.read().decode() or "{}")
        except Exception:
            r = {}
        r["success"] = False
        r.setdefault("error", "bridge HTTP %s" % e.code)
        return r


def contacts_cmd(a):
    book = load(BOOK, {})
    if a[0] == "--contacts":
        print("\n".join("%s: %s" % kv for kv in book.items()) or "(no saved contacts)")
    elif a[0] == "--add" and len(a) >= 3:
        num = to_number(a[-1])
        if not num:
            sys.exit("ERROR: bad number")
        book[" ".join(a[1:-1])] = num
        save(BOOK, book)
        print("saved %s -> %s" % (" ".join(a[1:-1]), num))
    elif a[0] == "--remove" and len(a) >= 2:
        k = " ".join(a[1:])
        print("removed" if book.pop(k, None) else "not found")
        save(BOOK, book)
    else:
        sys.exit(__doc__)


def main():
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    if a[0] in ("--contacts", "--add", "--remove"):
        return contacts_cmd(a)
    if a[0] == "--backfill":
        import sqlite3
        want = " ".join(a[1:]).strip()
        try:
            db = sqlite3.connect(STATE + "/wa_group_history.db", timeout=3)
            row = db.execute("SELECT id, ts, chat, sender FROM msgs WHERE id NOT LIKE 'out-%' AND id NOT LIKE 'note-%' "
                             "AND (?='' OR chat=? OR chat_name LIKE ?) ORDER BY ts ASC LIMIT 1", (want, want, "%" + want + "%")).fetchone()
        except Exception:
            row = None
        if not row:
            sys.exit("ERROR: no logged group message to anchor on yet")
        try:
            r = post("/backfill", {"chatId": row[2], "messageId": row[0], "participant": row[3] if row[3] != "hermes" else None,
                                   "fromMe": row[3] == "hermes", "ts": row[1], "count": 50})
        except Exception as e:
            r = {"success": False, "error": str(e)[:120]}
        print("Requested up to 50 older messages (before %s) from the phone - they arrive in a few seconds if the phone is online." % time.strftime("%Y-%m-%d %H:%M", time.localtime(row[1]))
              if r.get("success") else "FAILED: %s" % r.get("error"))
        sys.exit(0 if r.get("success") else 1)
    if a[0] == "--groups":
        gs = bridge_get("/groups")
        print("\n".join("%s  %s  (%d members)" % (g.get("name") or "(no name)", g["id"], g.get("participants", 0)) for g in gs) if gs else "no groups (bridge not reachable?)")
        return
    if a[0] == "--poll":
        multi = "--multi" in a
        a = [x for x in a if x != "--multi"]
        if len(a) < 5:
            sys.exit("usage: wa_send.py --poll <group|number> <question> <option1> <option2> [...] [--multi]")
        to, label = resolve(a[1])
        question, options = a[2].strip(), [o.strip() for o in a[3:]]
        if not question or len(options) < 2 or len(options) > 12 or any(not o for o in options) or len({o.lower() for o in options}) != len(options):
            sys.exit("ERROR: a poll needs a question and 2-12 distinct, non-empty options")
        if recent() >= MAX_PER_HOUR:
            sys.exit("ERROR: rate limit (%d messages/hour) reached - tell the owner" % MAX_PER_HOUR)
        r = post("/send-poll", {"chatId": to, "question": question, "options": options, "selectableCount": len(options) if multi else 1})
        os.makedirs(STATE, exist_ok=True)
        with open(LOG, "a") as f:
            f.write("%d\t%s\t%s\t%s\t%s\n" % (time.time(), "SENT" if r.get("success") else "FAILED", to, r.get("messageId") or r.get("error") or "", "[poll] " + question[:70]))
        print(("SENT poll to %s" % to) if r.get("success") else "FAILED: %s" % r.get("error"))
        sys.exit(0 if r.get("success") else 1)
    if a[0] == "--delete":
        if len(a) < 2:
            sys.exit(__doc__)
        t = a[1].strip()
        body = {"messageId": t} if (re.fullmatch(r"[A-Za-z0-9]{16,}", t) and not t.isdigit()) else {"chatId": resolve(t)[0]}
        try:
            r = post("/delete", body)
        except urllib.error.HTTPError as e:
            r = json.loads(e.read().decode() or "{}")
        except Exception as e:
            r = {"success": False, "error": str(e)[:120]}
        os.makedirs(STATE, exist_ok=True)
        with open(LOG, "a") as f:
            f.write("%d\t%s\t%s\t%s\t%s\n" % (time.time(), "DELETED" if r.get("success") else "DELETE_FAILED", r.get("chatId", t), r.get("messageId", ""), r.get("error", "")))
        print(("DELETED message %s in %s" % (r.get("messageId"), r.get("chatId"))) if r.get("success") else "FAILED: %s" % r.get("error"))
        sys.exit(0 if r.get("success") else 1)
    dry = "--dry" in a
    allow_links = "--allow-links" in a
    a = [x for x in a if x not in ("--dry", "--allow-links")]
    path = None
    if "--file" in a:
        i = a.index("--file")
        path = a[i + 1]
        a = a[:i] + a[i + 2:]
    if not a:
        sys.exit(__doc__)
    to, label = resolve(a[0])
    msg = " ".join(a[1:]).strip() if len(a) > 1 else ("" if path else sys.stdin.read().strip())
    if not msg and not path:
        sys.exit("ERROR: empty message")
    if msg and LINK.search(msg) and not allow_links:
        sys.exit("ERROR: the message contains a link; links sent to people who did not ask for them raise WhatsApp ban risk. "
                 "Confirm with the user, then resend with allow_links=true (--allow-links)")
    if path:
        rp = os.path.realpath(path)
        if any(b in rp for b in BLOCKED):
            sys.exit("ERROR: refusing to send that file (sensitive location)")
        if not os.path.isfile(rp):
            sys.exit("ERROR: file not found: %s" % path)
        if os.path.getsize(rp) > 60 * 1024 * 1024:
            sys.exit("ERROR: file too large (max 60 MB)")
    shown = to + (" (%s)" % label if label else "")
    if dry:
        print("DRY RUN -> %s : %s%s" % (shown, msg, " [file: %s]" % os.path.basename(path) if path else "")); return
    num = to.split("@")[0]
    known = load(KNOWN, {})
    if to.endswith("@s.whatsapp.net") and num not in known and label is None:
        fresh = [k for k, v in known.items() if float(v) > time.time() - 86400]
        if len(fresh) >= NEW_PER_DAY:
            sys.exit("ERROR: new-number limit reached (%d new numbers per 24h, WhatsApp ban protection) - tell the owner" % NEW_PER_DAY)
    if recent() >= MAX_PER_HOUR:
        sys.exit("ERROR: rate limit (%d messages/hour) reached - tell the owner" % MAX_PER_HOUR)
    time.sleep(random.uniform(2, 6))  # human-like pacing
    try:
        if path:
            ext = rp.lower().rsplit(".", 1)[-1]
            r = post("/send-media", {"chatId": to, "filePath": rp, "mediaType": MEDIA.get(ext, "document"),
                                     "caption": msg or None, "fileName": os.path.basename(rp)})
        else:
            r = post("/send", {"chatId": to, "message": msg})
        status = "SENT" if r.get("success") else "FAILED"
        detail = r.get("messageId") or r.get("error") or ""
    except Exception as e:
        status, detail = "FAILED", str(e)[:120]
    os.makedirs(STATE, exist_ok=True)
    with open(LOG, "a") as f:
        f.write("%d\t%s\t%s\t%s\t%s\n" % (time.time(), status, to, detail, (("[file %s] " % os.path.basename(path)) if path else "") + msg[:80].replace("\n", " ")))
    if status == "SENT" and to.endswith("@g.us"):
        log_group(to, msg or "[file]")
    if status == "SENT" and to.endswith("@s.whatsapp.net"):
        try:
            known[num] = time.time()
            save(KNOWN, known)
            d = load(TEMP, {})
            now = time.time()
            d = {k: v for k, v in d.items() if float((v or {}).get("exp", 0) if isinstance(v, dict) else v) > now}
            entry = {"exp": now + TEMP_HOURS * 3600, "sent": (msg or "[file]")[:300], "at": now}
            try:  # a limited-access person asked for this send: remember their chat so replies go back there
                hint = load(STATE + "/wa_origin_hint.json", {})
                if hint.get("origin") and now - float(hint.get("ts", 0)) < 120:
                    entry["origin"] = hint["origin"]
            except Exception:
                pass
            d[to.split("@")[0]] = entry
            save(TEMP, d)
        except Exception:
            pass
    print("%s to %s %s" % (status, shown, detail))
    sys.exit(0 if status == "SENT" else 1)


main()
