import asyncio, json, os, sqlite3, time, logging
os.environ["WHATSAPP_ALLOWED_USERS"] = "972500000001"
logging.disable(logging.CRITICAL)
from hermes_cli.plugins import discover_plugins
discover_plugins()
from gateway.platform_registry import platform_registry
from gateway.config import load_gateway_config, Platform
ad = platform_registry.create_adapter("whatsapp", load_gateway_config().platforms[Platform.WHATSAPP])
os.environ["HERMES_HOME"] = "/tmp/hp2"           # state files from now on go to scratch
os.makedirs("/tmp/hp2/state", exist_ok=True)
import importlib; mod = importlib.import_module("hermes_plugins.whatsapp_plus.adapter_plus") if False else None
G = "120363000000000001@g.us"
OWNER = os.environ.get("WHATSAPP_ALLOWED_USERS", "").split(",")[0] or "972500000001"
def d(sender, body, **kw):
    x = {"chatId": G, "isGroup": True, "chatName": "Test Group", "senderId": sender, "senderName": sender[:4], "body": body,
         "messageId": "m%s" % time.time(), "timestamp": time.time(), "mentionedIds": [], "botIds": [], "hasMedia": False}
    x.update(kw); return x
run = lambda c: asyncio.run(c)
print("owner id used:", OWNER[:3] + "…")
# 1. a non-owner's unaddressed message: no event, kept as context + logged
e = run(ad._build_message_event(d("100000000000001@lid", "מי בא מחר?")))
def pend(): 
    db = sqlite3.connect("/tmp/hp2/state/wa_group_history.db"); r = db.execute("select count(*) from msgs where chat=? and handled=0 and id not like 'out-%' and id not like 'note-%'", (G,)).fetchone()[0]; db.close(); return r
print("1 other member unaddressed  -> event:", e, "| pending kept:", pend() == 1)
# 1b. the bridge extension's contextOnly event: context + history, never a trigger
e = run(ad._build_message_event(dict(d("100000000000001@lid", "הודעה מהבריידג"), contextOnly=True)))
print("1b contextOnly event        -> event:", e, "| pending now:", pend() == 2)
# 2. a non-owner who writes 'hermes': still context only
e = run(ad._build_message_event(d("100000000000001@lid", "hermes מה דעתך")))
print("2 other member says hermes  -> event:", e)
# 3. owner says hermes: event with context
e = run(ad._build_message_event(d(OWNER + "@s.whatsapp.net", "hermes מה דעתך")))
print("3 owner says hermes         -> event:", e is not None, "| has context:", e is not None and "Chat messages since your last reply" in e.text and "מי בא מחר" in e.text)
# 4. history-only note
e = run(ad._build_message_event(dict(d("100000000000001@lid", '[reacted 👍 to: "x"]'), historyOnly=True)))
print("4 history-only note         -> event:", e)
db = sqlite3.connect("/tmp/hp2/state/wa_group_history.db"); print("  history rows:", db.execute("select count(*) from msgs").fetchone()[0])
# 5. mute blocks the owner too; bot list blocks a sender
json.dump({"mute": {G: time.time() + 600}}, open("/tmp/hp2/state/wa_group_control.json", "w"))
e = run(ad._build_message_event(d(OWNER + "@s.whatsapp.net", "hermes hello")))
print("5 muted group, owner        -> event:", e)
json.dump({"bots": ["100000000000002@lid"]}, open("/tmp/hp2/state/wa_group_control.json", "w"))
e = run(ad._build_message_event(d("100000000000002@lid", "hermes @bot tag loop")))
print("6 known bot says hermes     -> event:", e)
# 7. settings: style notes + extra trigger + disable context
json.dump({"style_notes": "קצר בעברית", "name_triggers": ["jarvis"], "context_messages": 0}, open("/tmp/hp2/state/wa_settings.json", "w"))
import hermes_plugins.whatsapp_plus.adapter_plus as ap; ap._SET_CACHE = (0.0, {})
e = run(ad._build_message_event(d(OWNER + "@s.whatsapp.net", "hey Jarvis what now")))
print("7 owner + settings          -> event:", e is not None, "| style:", e is not None and "Style notes" in e.text, "| context off:", e is not None and "Chat messages since your last reply" not in e.text)
# 8. temporary contact DM gets the untrusted label
json.dump({"972501112222": {"exp": time.time() + 3600, "sent": "שלום, פתוחים בשישי?"}}, open("/tmp/hp2/state/wa_temp_contacts.json", "w"))
dm = {"chatId": "972501112222@s.whatsapp.net", "isGroup": False, "senderId": "972501112222@s.whatsapp.net", "senderName": "Store", "body": "כן, פתוח עד 14:00",
      "messageId": "dm1", "timestamp": time.time(), "mentionedIds": [], "botIds": [], "hasMedia": False}
ad._wa_notify_owner = lambda text: asyncio.sleep(0)
e = run(ad._build_message_event(dm))
print("8 temp contact DM           -> event:", e is not None, "| labelled untrusted:", e is not None and "EXTERNAL CONTACT" in e.text and "פתוחים בשישי" in e.text)
dm2 = dict(dm, senderId="972509999999@s.whatsapp.net", chatId="972509999999@s.whatsapp.net")
print("9 stranger DM               -> event:", run(ad._build_message_event(dm2)))

# 10. outbound logging: streaming partial then final text replace the same row (cursor stripped)
ad._log_group_outbound(G, "בדקתי עכשיו — מע ▉", "WAID1")
ad._log_group_outbound(G, "בדקתי עכשיו — מעולה, הכל תקין", "WAID1")
db = sqlite3.connect("/tmp/hp2/state/wa_group_history.db")
rows = db.execute("select body from msgs where id='out-WAID1'").fetchall()
print("10 outbound row replaced     ->", rows == [("בדקתי עכשיו — מעולה, הכל תקין",)], rows)
# 11. pending history: markers, relative time, shown once, then handled
import hermes_plugins.whatsapp_plus.adapter_plus as ap2; ap2._SET_CACHE = (time.time(), {})
db = sqlite3.connect("/tmp/hp2/state/wa_group_history.db"); db.execute("UPDATE msgs SET handled=1 WHERE chat=?", (G,))
db.execute("INSERT INTO msgs(id,ts,chat,chat_name,sender,sender_name,body,quoted,handled,media) VALUES ('p1',?,?,'Test',?,'Dana','מי בא?','',0,'')", (time.time() - 300, G, "100000000000001@lid"))
db.execute("INSERT INTO msgs(id,ts,chat,chat_name,sender,sender_name,body,quoted,handled,media) VALUES ('p2',?,?,'Test',?,'Dana','תמונה','',0,'/tmp/hp2/img1.jpg')", (time.time() - 60, G, "100000000000001@lid"))
db.commit(); db.close(); open("/tmp/hp2/img1.jpg", "wb").write(b"x")
json.dump({"limited_users": ["100000000000001@lid"]}, open("/tmp/hp2/state/wa_group_control.json", "w"))
out, imgs = ad._pending_block({"isGroup": True, "chatId": G, "messageId": "cur1"}, "q")
print("11 pending block             ->", "Dana [5m ago]: מי בא?" in out and ad._PENDING_MARK in out and ad._CURRENT_MARK in out and out.endswith("q"), "| images:", imgs == ["/tmp/hp2/img1.jpg"], "| roster:", "Dana (limited access)" in out)
out2, imgs2 = ad._pending_block({"isGroup": True, "chatId": G, "messageId": "cur2"}, "q2")
print("11b not repeated             ->", "מי בא?" not in out2 and ad._PENDING_MARK not in out2 and imgs2 == [])
print("11c slash command untouched  ->", ad._pending_block({"isGroup": True, "chatId": G}, "/status") == ("/status", []))
# 11d limit + survives a new adapter instance (DB, not RAM)
db = sqlite3.connect("/tmp/hp2/state/wa_group_history.db")
for i in range(60): db.execute("INSERT INTO msgs(id,ts,chat,chat_name,sender,sender_name,body,quoted,handled,media) VALUES (?,?,?,'Test','x@lid','X',?,'',0,'')", ("b%d" % i, time.time() - 600 + i, G, "msg%d" % i))
db.commit(); db.close()
ad2 = type(ad)(ad.config)
o3, _ = ad2._pending_block({"isGroup": True, "chatId": G, "messageId": "cur3"}, "q3")
print("11d limit 50 + persistence   ->", o3.count("X [") == 50 and "msg59" in o3 and "msg9]" not in o3 and "msg10:" not in o3)
# 11e hours window
db = sqlite3.connect("/tmp/hp2/state/wa_group_history.db")
db.execute("INSERT INTO msgs(id,ts,chat,chat_name,sender,sender_name,body,quoted,handled,media) VALUES ('old1',?,?,'Test','x@lid','X','ancient','',0,'')", (time.time() - 30 * 3600, G)); db.commit(); db.close()
o4, _ = ad._pending_block({"isGroup": True, "chatId": G, "messageId": "cur4"}, "q4")
print("11e 24h window               ->", "ancient" not in o4)
# 11f migration of a pre-existing 8-column table marks old rows handled
os.makedirs("/tmp/hp3/state", exist_ok=True); import sqlite3 as _s
if os.path.exists("/tmp/hp3/state/wa_group_history.db"): os.remove("/tmp/hp3/state/wa_group_history.db")
c = _s.connect("/tmp/hp3/state/wa_group_history.db"); c.execute("CREATE TABLE msgs(id TEXT PRIMARY KEY, ts REAL, chat TEXT, chat_name TEXT, sender TEXT, sender_name TEXT, body TEXT, quoted TEXT)")
c.execute("INSERT INTO msgs VALUES ('o',1,'c','n','s','S','b','')"); c.commit(); c.close()
os.environ["HERMES_HOME"] = "/tmp/hp3"; m = ap2._history_db(); mig = m.execute("select handled from msgs").fetchone()[0]; m.close(); os.environ["HERMES_HOME"] = "/tmp/hp2"
print("11f migration marks handled  ->", mig == 1)
# 11g voice notes of trusted senders become text
import tools.transcription_tools as tt
tt.transcribe_audio = lambda path, model=None, source=None: {"success": True, "transcript": "שלום הרמס"}
vd = d(OWNER + "@s.whatsapp.net", "", hasMedia=True, mediaUrls=["/tmp/hp2/v.ogg"], mediaTypes=["audio/ogg"]); run(ad._transcribe_group_voice(vd))
print("11g voice transcribed        ->", vd["body"] == "[voice note] שלום הרמס" and vd["mediaUrls"] == [])
vs = d("99999@lid", "", hasMedia=True, mediaUrls=["/tmp/hp2/v.ogg"], mediaTypes=["audio/ogg"]); run(ad._transcribe_group_voice(vs))
print("11h stranger voice untouched ->", vs["body"] == "")

# ---- collaboration mode ----
BOT = "100000000000002@lid"
def wctl(c): json.dump(c, open("/tmp/hp2/state/wa_group_control.json", "w"))
wctl({"collab_bots": [BOT]})
ad._collab_turns = {}
e = run(ad._build_message_event(d(BOT, "הרמס מה דעתך על הבדיקה?")))
print("12 collab bot addresses him  -> event:", e is not None, "| collab label:", e is not None and "[BOT COLLAB MODE" in e.text and "[NO_REPLY]" in e.text)
e = run(ad._build_message_event(d(BOT, "סתם הודעה בלי תיוג")))
print("13 collab bot unaddressed    -> event:", e)
wctl({"collab_bots": [BOT], "collab_max_consecutive": 100})  # isolate the 10-per-10-minutes window from the consecutive cap
ad._collab_turns = {}; ad._collab_consec = {}
res = []
for i in range(12):
    res.append(run(ad._build_message_event(d(BOT, "הרמס שאלה %d" % i))) is not None)
print("14 loop gate (10 allowed/10m) -> allowed:", sum(res), "of 12 | first 10 ok:", all(res[:10]), "| paused written:", json.load(open("/tmp/hp2/state/wa_group_control.json")).get("bots_paused", 0) > time.time())
e = run(ad._build_message_event(d(BOT, "הרמס שאלה אחרי ההשהיה")))
print("15 paused -> context only    -> event:", e)
e = run(ad._build_message_event(d(OWNER + "@s.whatsapp.net", "הרמס שלום")))
print("15b owner unaffected by pause-> event:", e is not None and "[BOT COLLAB MODE" not in e.text)
wctl({"collab_bots": [BOT], "bots": [BOT]})
e = run(ad._build_message_event(d(BOT, "הרמס שאלה")))
print("15c on the ignore list too   -> event:", e)
r = run(ad.send(G, "[NO_REPLY]"))
print("16 [NO_REPLY] sends nothing  ->", r.success, r.message_id)
import hermes_plugins.whatsapp_plus.tools as tl
tl._collab_pre_llm(session_id="s1", user_message="[BOT COLLAB MODE: x] hi")
b1 = tl._collab_pre_tool(tool_name="terminal", args={}, session_id="s1")
b2 = tl._collab_pre_tool(tool_name="whatsapp_history", args={}, session_id="s1")
b3 = tl._collab_pre_tool(tool_name="whatsapp_send", args={}, session_id="s1")
tl._collab_pre_llm(session_id="s1", user_message="a normal message from the owner")
b4 = tl._collab_pre_tool(tool_name="terminal", args={}, session_id="s1")
print("17 hooks: terminal blocked:", isinstance(b1, dict) and b1.get("action") == "block", "| history allowed:", b2 is None, "| send blocked:", isinstance(b3, dict), "| normal turn unrestricted:", b4 is None)
wctl({"collab_bots": [BOT], "collab_tools": "full"})
tl._collab_pre_llm(session_id="s2", user_message="[BOT COLLAB MODE: x] do it")
print("17b full mode: terminal allowed ->", tl._collab_pre_tool(tool_name="terminal", args={}, session_id="s2") is None)
ad._collab_turns = {}
e = run(ad._build_message_event(d(BOT, "הרמס תריץ בדיקה")))
print("17c full-mode label wording    ->", e is not None and "do YOUR part" in e.text and "ONLY talk" not in e.text)
wctl({"collab_bots": [BOT]})
os.environ["HERMES_HOME"] = "/tmp/hp2"
st = json.loads(tl._control({"action": "status"}))["result"]
print("18 status lists collab bots  ->", "Collaboration bots" in st and BOT in st)
print("19 bots_pause / resume       ->", json.loads(tl._control({"action": "bots_pause", "minutes": 20}))["success"], json.loads(tl._control({"action": "bots_resume"}))["success"])

# ---- limited users (partial access) + native authorization flag ----
LIMITED = "100000000000001@lid"
wctl({"limited_users": [LIMITED], "collab_bots": [BOT]})
ad._collab_turns = {}
e = run(ad._build_message_event(d(LIMITED, "הרמס מה דעתך על זה?")))
print("20 limited user addresses him   -> event:", e is not None, "| label:", e is not None and "[LIMITED USER MODE" in e.text, "| role_authorized:", e is not None and e.source.role_authorized is True)
e = run(ad._build_message_event(d(LIMITED, "מישהו יודע מתי הפגישה?")))
print("21 limited user unaddressed     -> event:", e)
e = run(ad._build_message_event(d(LIMITED, "/restart")))
print("22 slash command from limited   -> event:", e)
e = run(ad._build_message_event(d("100000000000003@lid", "הרמס שלום")))
print("23 unlisted member addresses him-> event:", e)
e = run(ad._build_message_event(d(BOT, "הרמס שאלה")))
print("24 collab bot is authorized too -> event:", e is not None and e.source.role_authorized is True)
e = run(ad._build_message_event(d(OWNER + "@s.whatsapp.net", "הרמס שלום")))
print("25 owner needs no flag          -> event:", e is not None and e.source.role_authorized is not True)
ad._collab_turns = {}
res = [run(ad._build_message_event(d(LIMITED, "הרמס שאלה %d" % i))) is not None for i in range(22)]
print("26 limited rate limit (20/10m)  -> allowed:", sum(res))
wctl({"limited_users": [LIMITED], "bots": [LIMITED]})
print("27 ignore list beats limited    ->", run(ad._build_message_event(d(LIMITED, "הרמס שלום"))))
wctl({"limited_users": [LIMITED]})
print("28 temp contact turn authorized ->", (lambda e: e is not None and e.source.role_authorized is True)(run(ad._build_message_event(dm))))
H = lambda tool, args=None: tl._collab_pre_tool(tool_name=tool, args=args or {}, session_id="s9")
tl._collab_pre_llm(session_id="s9", user_message="[LIMITED USER MODE: x] hi")
print("29 limited hooks: terminal blocked:", isinstance(H("terminal"), dict), "| memory blocked:", isinstance(H("mempalace_search"), dict),
      "| read_file blocked:", isinstance(H("read_file"), dict), "| web_search ok:", H("web_search") is None,
      "| history ok:", H("whatsapp_history") is None, "| group_control status ok:", H("whatsapp_group_control", {"action": "status"}) is None,
      "| group_control mute blocked:", isinstance(H("whatsapp_group_control", {"action": "mute"}), dict))
tl._collab_pre_llm(session_id="s9", user_message="[EXTERNAL CONTACT Store (+972): x] כן")
print("30 external-contact hooks       : terminal blocked:", isinstance(H("terminal"), dict), "| whatsapp_send blocked:", isinstance(H("whatsapp_send"), dict))
tl._collab_post(session_id="s9")
print("31 after the turn: unrestricted ->", H("terminal") is None)
wctl({})
# ---- whatsapp_react tool (ported from PR #128496) ----
cap = []
tl._bridge_post = lambda path, body: (cap.append((path, body)) or {"success": True})
os.environ["HERMES_HOME"] = "/tmp/hp2"
r1 = json.loads(tl._react({"emoji": "👍"}))
print("32 react to the latest person message ->", r1["success"], cap[-1][0], cap[-1][1].get("senderId") is not None and cap[-1][1].get("fromMe") is False)
mid = cap[-1][1]["messageId"]
r2 = json.loads(tl._react({"emoji": "", "message_id": mid}))
print("33 remove by message id               ->", r2["success"], repr(cap[-1][1]["emoji"]))
r3 = json.loads(tl._react({"emoji": "👍", "message_id": "no-such-id"}))
print("34 unknown message id is refused      ->", not r3["success"])
r4 = json.loads(tl._react({"emoji": "x" * 40}))
print("35 not an emoji is refused            ->", not r4["success"])

# ---- upstream PR ports (adapter side) ----
import types
base_cls = type(ad).__mro__[2]
captured = []
async def fake_receipt(self, data): captured.append(data)
orig_receipt = base_cls._send_read_receipt
base_cls._send_read_receipt = fake_receipt
dm_data = {"isGroup": False, "readReceiptKey": {"remoteJid": "972@s.whatsapp.net", "id": "X", "participant": "972@s.whatsapp.net", "fromMe": False}}
gp_data = {"isGroup": True, "readReceiptKey": {"remoteJid": "1203@g.us", "id": "Y", "participant": "100000000000001@lid", "fromMe": False}}
run(ad._send_read_receipt(dm_data)); run(ad._send_read_receipt(gp_data))
base_cls._send_read_receipt = orig_receipt
print("36 DM read receipt has no participant, group keeps it ->", "participant" not in captured[0]["readReceiptKey"] and "participant" in captured[1]["readReceiptKey"])

async def batching():
    handled = []
    async def fake_handle(ev): handled.append(ev.text)
    ad.handle_message = fake_handle
    ad._text_batch_key = lambda ev: "K"
    ad._pending_text_batches = {}; ad._pending_text_batch_tasks = {}
    ad._text_batch_delay_seconds = 0.2; ad._text_batch_split_delay_seconds = 0.2
    ad._flush_text_batch_orig = ad._flush_text_batch
    mk = lambda who, text: types.SimpleNamespace(text=text, media_urls=[], media_types=[], absorb_reply_expected=lambda ev: None, source=types.SimpleNamespace(user_id=who, user_id_alt=None))
    ad._enqueue_text_event(mk("972500000001@s.whatsapp.net", "from owner"))
    ad._enqueue_text_event(mk("972500000001@s.whatsapp.net", "owner again"))
    ad._enqueue_text_event(mk("100000000000001@lid", "from other"))
    await asyncio.sleep(0.05)
    first = list(handled)
    await asyncio.sleep(0.5)
    ad._enqueue_text_event(mk("972500000001@s.whatsapp.net", "pending text"))
    ad._enqueue_text_event(mk("972500000001@s.whatsapp.net", "/stop"))
    await asyncio.sleep(0.05)
    return first, list(handled)
first, allh = asyncio.run(batching())
print("37 batching: same author merges, a different author flushes first ->", first[0] == "from owner\n\nowner again" or "owner again" in first[0], "| other not merged into owner:", all("from other" not in h or h == "from other" for h in allh))
print("38 slash command bypasses the debounce and flushes pending ->", "/stop" in allh and "pending text" in allh)

hist = sqlite3.connect("/tmp/hp2/state/wa_group_history.db")
hist.execute("INSERT OR REPLACE INTO msgs(id,ts,chat,chat_name,sender,sender_name,body,quoted) VALUES ('QX', ?, '120363000000000001@g.us', 'G', 'x@lid', 'Dana', 'the original question', '')", (time.time(),)); hist.commit(); hist.close()
ev = types.SimpleNamespace(reply_to_text=None, reply_to_message_id=None)
ad._recover_reply_context(ev, {"quotedMessageId": "QX"})
print("39 reply context recovered from the history log ->", ev.reply_to_text == "the original question" and ev.reply_to_message_id == "QX")

fm = ad.format_message("***bold italic*** and **bold** and *italic* and `***code***`")
print("40 formatting: combined emphasis ok, code untouched ->", "*_bold italic_*" in fm and "*bold*" in fm and "_italic_" in fm and "`***code***`" in fm, repr(fm))
sp = ad._split_bubbles("one\n\ntwo\n\n```\nx\n\ny\n```\n\nthree", 4)
sp2 = ad._split_bubbles("a\n\nb\n\nc\n\nd\n\ne", 3)
print("41 bubbles split outside code, folded at the limit ->", len(sp) == 4 and "x\n\ny" in sp[2], len(sp2) == 3 and sp2[-1] == "c\n\nd\n\ne")

import subprocess
dry = subprocess.run(["python3", "/opt/data/plugins/whatsapp-plus/wa_send.py", "--dry", "120363000000000001", "hi"], capture_output=True, text=True).stdout
print("42 bare numeric group id routes to @g.us ->", "120363000000000001@g.us" in dry)
bad = json.loads(tl._poll({"to": "zz-no-such-chat", "question": "q", "options": ["only one"]}))
print("43 poll rejects bad input without sending ->", bad["success"] is False)

# ---- sensitive media guard (#51247) ----
os.environ["HERMES_HOME"] = "/opt/data"
bad = ["/opt/data/whatsapp/session/creds.json", "/opt/data/.env", "/opt/data/state/wa_group_control.json", "/home/ubuntu/.ssh/id_rsa", "/opt/data/config.yaml.bak-x"]
ok_paths = ["/tmp/photo.png", "/opt/data/cache/image_cache/a.jpg"]
print("44 sensitive paths refused ->", all(ad._sensitive_media_path(x) for x in bad), "| normal paths allowed:", not any(ad._sensitive_media_path(x) for x in ok_paths))
r = run(ad._send_media_to_bridge(G, "/opt/data/whatsapp/session/creds.json", "document"))
print("45 media send of creds refused without calling the bridge ->", r.success is False and "refusing" in str(r.error))
os.environ["HERMES_HOME"] = "/tmp/hp2"

# ---- MEDIA tag backstop (#43679) ----
async def media_tags():
    calls = []
    stock_send = type(ad).__mro__[2].send
    async def fake_send(self, chat_id, content, *a, **k):
        calls.append(content)
        from gateway.platforms.base import SendResult
        return SendResult(success=True, message_id="M1")
    type(ad).__mro__[2].send = fake_send
    try:
        await ad.send(G, "here you go\nMEDIA:/tmp/secret/report.png\nenjoy")
        r = await ad.send(G, "MEDIA:/tmp/only-tag.png")
    finally:
        type(ad).__mro__[2].send = stock_send
    return calls, r
calls, r = asyncio.run(media_tags())
print("46 MEDIA: tags never reach chat text ->", len(calls) == 1 and "MEDIA:" not in calls[0] and "here you go" in calls[0], "| tag-only message sends nothing:", r.success is True)

# ---- consecutive bot replies cap + acknowledgement rule ----
wctl({"collab_bots": [BOT], "collab_max_turns": 50})
ad._collab_turns = {}; ad._collab_consec = {}
res = [run(ad._build_message_event(d(BOT, "הרמס עדכון %d" % i))) is not None for i in range(8)]
print("47 bots cannot reply to each other more than 3 times in a row ->", res[:3] == [True] * 3 and res[3:] == [False] * 5, res)
e = run(ad._build_message_event(d("100000000000003@lid", "חחח סתם הודעה לא מתויגת")))  # an unlisted human chatting: does NOT reset
res2 = run(ad._build_message_event(d(BOT, "הרמס עוד אחד"))) is not None
e = run(ad._build_message_event(d(OWNER + "@s.whatsapp.net", "היי, ממשיכים")))  # owner speaks (unaddressed): resets
res3 = run(ad._build_message_event(d(BOT, "הרמס אחרי שעמית דיבר"))) is not None
print("48 an owner message resets the streak (unlisted humans do not) ->", res2 is False, res3 is True)
lab = ad._collab_label({"senderName": "HelperBot"})
print("49 label tells him not to answer acknowledgements ->", "acknowledgement" in lab and "[NO_REPLY]" in lab)
wctl({})

# 50. chats with outside contacts reach the owner's session once
ad._inbox_add("66800000001", "shop_a", "in", "What do you mean?")
import hermes_plugins.whatsapp_plus.tools as tl
c1 = tl._collab_pre_llm(session_id="own1", user_message="יש עדכון?")
c2 = tl._collab_pre_llm(session_id="own1", user_message="עוד משהו")
c3 = tl._collab_pre_llm(session_id="ext1", user_message="[EXTERNAL CONTACT x (+1): ...")
print("50 owner turn is told once, restricted turns get nothing ->", isinstance(c1, dict) and "What do you mean?" in c1["context"] and c2 is None and c3 is None)

# 51. limited person may message a plain number (text only); replies are routed back to their chat
LIMITED_CHAT = G
lab = ad._limited_label({"senderName": "Dana", "chatId": LIMITED_CHAT})
tl._collab_pre_llm(session_id="ori1", user_message=lab + "תשלח לחייט")
pt = lambda **a: tl._collab_pre_tool(tool_name="whatsapp_send", args=a, session_id="ori1")
print("51 limited send: number ok:", pt(to="+66800000001", message="hi") is None, "| name blocked:", pt(to="Tailor", message="hi")["action"] == "block",
      "| group blocked:", pt(to="120363@g.us", message="x")["action"] == "block", "| file blocked:", pt(to="+66800000001", file_path="/tmp/a")["action"] == "block",
      "| links blocked:", pt(to="+66800000001", message="x", allow_links=True)["action"] == "block")
hint = json.load(open("/tmp/hp2/state/wa_origin_hint.json"))
print("51b origin hint written          ->", hint["origin"] == LIMITED_CHAT)
ad._inbox_add("66800000001", "tailor", "in", "מחיר 300", LIMITED_CHAT)
ctxo = tl._collab_pre_llm(session_id="ori2", user_message=lab + "מה הוא ענה?")
ctxo2 = tl._collab_pre_llm(session_id="ori3", user_message=lab + "ועוד?")
print("51c Dana's chat is told once      ->", isinstance(ctxo, dict) and "מחיר 300" in ctxo["context"] and ctxo2 is None)
other = tl._collab_pre_llm(session_id="x9", user_message=ad._limited_label({"senderName": "Z", "chatId": "other@g.us"}) + "hi")
print("51d another chat is not told     ->", other is None)

# 52. whatsapp_history: chat list, DMs only on request, restricted turns cannot read private chats
ad._inbox_add("66800000002", "Shop B", "in", "2 pant course around 700 Thai baht")
ad._inbox_add("66800000002", "Shop B", "out", "תודה, מאשר")
j = lambda **a: json.loads(tl._history(dict({"group": "", "limit": 100}, **a)) if a.get("list_chats") or a.get("group") else tl._history(dict({"group": "Test", "limit": 100}, **a)))["result"]
print("52 groups only by default      ->", "700 Thai" not in j(hours=48))
print("52b include_dms finds the store ->", "700 Thai" in j(hours=48, include_dms=True, group="Shop B") and "תודה" in j(hours=48, include_dms=True, group="66800000002"))
lc = j(list_chats=True)
print("52c list_chats                  ->", "[1:1]" in lc and "[group]" in lc, "| year window ok:", "No matching" not in j(hours=8760, include_dms=True, search="700", group="Shop B"))
tl._collab_pre_llm(session_id="ori9", user_message=ad._limited_label({"senderName": "Dana", "chatId": G}) + "x")
bl = lambda **a: tl._collab_pre_tool(tool_name="whatsapp_history", args=a, session_id="ori9")
print("52d limited: DMs/list blocked, groups ok ->", bl(include_dms=True)["action"] == "block", bl(list_chats=True)["action"] == "block", bl(hours=5) is None)

print("53 history without chat/limit is refused ->", json.loads(tl._history({"hours": 5}))["success"] is False and json.loads(tl._history({"group": "Test"}))["success"] is False, "| list_chats needs neither:", json.loads(tl._history({"list_chats": True}))["success"])
print("53b max_chars caps the result ->", len(json.loads(tl._history({"group": "Test", "limit": 300, "hours": 8760, "max_chars": 500}))["result"]) < 800)

# 54. groups: the owner's own groups are allowed automatically, restricted until approved (or Dana is there too)
NEW = "120363999000111222@g.us"
wctl({"limited_users": ["100000000000001@lid"]})
json.dump({NEW: {"name": "Family", "owner": True, "limited": False, "size": 5}, "120363777@g.us": {"name": "Strangers", "owner": False, "limited": False, "size": 9},
           "120363555@g.us": {"name": "Friends+Dana", "owner": True, "limited": True, "size": 4}}, open("/tmp/hp2/state/wa_group_members.json", "w"))
print("54 modes: restricted/blocked/full/full(listed) ->", ad._group_mode(NEW) == "restricted", ad._group_mode("120363777@g.us") is None, ad._group_mode("120363555@g.us") == "full", ad._group_mode(G) == "full")
nd = lambda sender, body, **kw: d(sender, body, chatId=NEW, messageId="n%s" % time.time(), **kw)
e = run(ad._build_message_event(nd(OWNER + "@s.whatsapp.net", "hermes מה דעתך")))
print("54b owner in restricted group -> event:", e is not None, "| label:", e is not None and "RESTRICTED GROUP MODE" in e.text)
e = run(ad._build_message_event(nd(OWNER + "@s.whatsapp.net", "/status hermes")))
print("54c slash command dropped      ->", e is None)
e = run(ad._build_message_event(nd("100000000000001@lid", "hermes עזור")))
print("54d others cannot trigger it   ->", e is None)
tl._collab_pre_llm(session_id="rg1", user_message="[RESTRICTED GROUP MODE: x]\nhi")
rb = lambda t, **a: tl._collab_pre_tool(tool_name=t, args=a, session_id="rg1")
print("54e restricted turn: terminal blocked:", rb("terminal")["action"] == "block", "| web_search ok:", rb("web_search") is None, "| approve_group blocked:", rb("whatsapp_group_control", action="approve_group")["action"] == "block", "| pairing blocked:", rb("whatsapp_pairing", action="approve")["action"] == "block")
tl._collab_pre_llm(session_id="cb1", user_message="[BOT COLLAB MODE: x]\nhi"); wctl({"collab_tools": "full"})
print("54f full-tools bot still cannot approve ->", tl._collab_pre_tool(tool_name="whatsapp_group_control", args={"action": "approve_group"}, session_id="cb1")["action"] == "block", tl._collab_pre_tool(tool_name="whatsapp_pairing", args={"action": "approve"}, session_id="cb1")["action"] == "block")
wctl({})
cg = lambda **a: json.loads(tl._control(a))
r = cg(action="groups"); print("54g groups list ->", "Family - restricted" in r["result"] and "Strangers - blocked" in r["result"] and "full (the owner and a limited user" in r["result"])
print("54h cannot approve a group the owner is not in ->", cg(action="approve_group", group="Strangers")["success"] is False)
print("54i approve_group -> full:", cg(action="approve_group", group="Family")["success"], ad._group_mode(NEW) == "full")
e = run(ad._build_message_event(nd(OWNER + "@s.whatsapp.net", "hermes ועכשיו")))
print("54j approved group: normal turn ->", e is not None and "RESTRICTED" not in e.text)
print("54k revoke_group -> restricted:", cg(action="revoke_group", group="Family")["success"], ad._group_mode(NEW) == "restricted")
print("54l pairing tool rejects junk codes ->", json.loads(tl._pairing({"action": "approve", "code": "x y;"}))["success"] is False)

# 55. internal busy/queue notices never reach outside people (they still reach the owner)
r = run(ad.send("66800000002@s.whatsapp.net", "⚡ Interrupting current task. I'll respond to your message shortly."))
r2 = run(ad.send("120363999@g.us", "↪ Redirected current run. I'll adjust using your correction."))
print("55 notices to contacts/groups are dropped ->", r.success and r.message_id is None and r2.success and r2.message_id is None, "| owner chat recognised:", ad._is_owner_chat(OWNER + "@s.whatsapp.net"), "| contact is not:", not ad._is_owner_chat("66800000002@s.whatsapp.net"))
# 56. a name learned later fixes earlier number-only rows
ad._inbox_add("66810000001", "66810000001", "out", "שלום")
ad._inbox_add("66810000001", "Bangkok Tailor", "in", "hello")
dbn = sqlite3.connect("/tmp/hp2/state/wa_group_history.db")
print("56 contact name learned -> old rows renamed ->", dbn.execute("select count(*) from msgs where chat='66810000001@s.whatsapp.net' and chat_name='Bangkok Tailor'").fetchone()[0] == 2); dbn.close()
# 57. campaign: sends one by one, report collects replies, limits enforced
import time as _t, threading as _th
_t_sleep = _t.sleep; _t.sleep = lambda s: None
sentlog = "/tmp/hp2/state/wa_outbound.log"
def fake_run(cmd):
    to = cmd[0]; jid = ("66%s@s.whatsapp.net" % "".join(ch for ch in to if ch.isdigit())[-9:]) if any(ch.isdigit() for ch in to) else "66999999999@s.whatsapp.net"
    open(sentlog, "a").write("%d\tSENT\t%s\tMID%s\t%s\n" % (_t.time(), jid, to, cmd[1])); return json.dumps({"success": True, "result": "SENT to %s" % to})
tl._run = fake_run
cj = lambda **a: json.loads(tl._campaign(a))
bad1 = cj(action="start", message="see https://x.com", recipients=["+66811111111"]); bad2 = cj(action="start", message="hi", recipients=["+6681111%04d" % i for i in range(11)])
print("57 campaign rejects links and more than 10 recipients ->", not bad1["success"] and not bad2["success"])
st = cj(action="start", message="Can you shorten pants? Price?", recipients=["+66811111111", "+66822222222", "+66833333333"], topic="pants")
cid = st["result"].split()[1]
for _ in range(50):
    if all(r["status"] != "queued" for r in tl._camp_read()[cid]["recipients"]): break
    _t_sleep(0.1)
print("57b started, all sent one by one ->", st["success"], [r["status"] for r in tl._camp_read()[cid]["recipients"]])
ad._inbox_add("66811111111", "Shop A", "in", "100 baht, 2 days")
ad._inbox_add("66822222222", "Shop B", "in", "250 baht")
rep = cj(action="report", id=cid)["result"]
print("57c report lists replies and who is silent ->", "100 baht, 2 days" in rep and "250 baht" in rep and "no reply yet" in rep and "2 of 3 answered" in rep)
print("57d list + stop ->", cid in cj(action="list")["result"], cj(action="stop", id=cid)["success"])
_t.sleep = _t_sleep
tl._collab_pre_llm(session_id="cb2", user_message="[BOT COLLAB MODE: x]\nhi"); wctl({"collab_tools": "full"})
print("57e a bot cannot start campaigns even with full tools ->", tl._collab_pre_tool(tool_name="whatsapp_campaign", args={"action": "start"}, session_id="cb2")["action"] == "block"); wctl({})

# 58. acknowledgement / emoji-only messages never keep two bots talking
wctl({"collab_bots": [BOT], "collab_max_turns": 50}); ad._collab_turns = {}; ad._collab_consec = {}
acks = ["🤝", "👍", "💤", "נעצרתי 🤐", "תודה!", "ok", "קיבלתי 👍", "@100000000000004 סבבה"]
dropped = [run(ad._build_message_event(d(BOT, a, mentionedIds=[BOT]))) is None for a in acks]
real = [run(ad._build_message_event(d(BOT, t))) is not None for t in ("הרמס, הקוד אצלי. תבנה את הטאב", "הרמס יכול לשלוח?", "הרמס מה המחיר")]
print("58 inbound acks from a bot dropped, real messages pass ->", all(dropped), real == [True, True, True], real)
ad.__dict__.setdefault("_last_level", {})[G] = "collab"
r1 = run(ad.send(G, "💤")); r2 = run(ad.send(G, "נעצרתי 🤐"))
print("58b emoji/ack reply to a bot is suppressed ->", r1.success and r1.message_id is None and r2.success and r2.message_id is None)
print("58c ack detector: questions and real text are not acks ->", not ad._is_ack_only("מה דעתך?") and not ad._is_ack_only("הקוד אצלי, בונה עכשיו טאב") and ad._is_ack_only("👍👍"))
wctl({})
