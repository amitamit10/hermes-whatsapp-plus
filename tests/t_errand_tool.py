import importlib.util, json, os, re, sys, tempfile, threading, http.server
home = tempfile.mkdtemp(); os.environ["HERMES_HOME"] = home
os.makedirs(home + "/voice-call"); os.makedirs(home + "/state")
open(home + "/voice-call/key", "w").write("k123")
json.dump({"Joe tailor": "+66812345678"}, open(home + "/state/wa_contacts.json", "w"))
here = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(here, "tools.py") if os.path.exists(os.path.join(here, "tools.py")) else os.path.join(here, "..", "whatsapp-plus", "tools.py")
spec = importlib.util.spec_from_file_location("tools_under_test", src); T = importlib.util.module_from_spec(spec); spec.loader.exec_module(T)
OWNER = "972500000001"
T.__dict__["_env_value"] = lambda name: OWNER if name == "WHATSAPP_ALLOWED_USERS" else ""
sent = []
T.__dict__["_bridge_post"] = lambda path, body: (sent.append((path, body)) or {"success": True})
got = []; FAIL_NEXT = [False]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("content-length", 0)); got.append((self.path, self.headers.get("x-callerd-key"), json.loads(self.rfile.read(n))))
        code, out = (429, {"error": "too many errand calls"}) if FAIL_NEXT[0] else (200, {"ok": True})
        self.send_response(code); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(json.dumps(out).encode())
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 18950), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
os.environ["CALLERD_URL"] = "http://127.0.0.1:18950"
ok = fail = 0
def check(n, c, extra=""):
    global ok, fail
    if c: ok += 1; print("PASS", n)
    else: fail += 1; print("FAIL", n, extra)
def last_code():
    m = re.search(r"(\d{4})\s*$", sent[-1][1]["message"]); return m.group(1) if m else None
A = {"to": "Joe tailor", "purpose": "Ask whether he is free on Saturday afternoon to fit two pairs of trousers", "language": "en"}

r = json.loads(T._call_contact(dict(A)))
code = last_code()
check("preview: nothing dialled, code sent to the OWNER's private chat only", r.get("needs_confirmation") and not got and sent[-1][0] == "/send" and sent[-1][1]["chatId"] == OWNER + "@s.whatsapp.net" and code, (r, sent))
check("the code is never shown to the model", code not in json.dumps(r))
r = json.loads(T._call_contact(dict(A, confirmed=True)))
check("confirmed=true without a code is not enough (new preview, no call)", r.get("needs_confirmation") and not got, r)
code = last_code()
r = json.loads(T._call_contact(dict(A, confirmed=True, confirm_code="0000" if code != "0000" else "1111")))
check("wrong code refused, no call", not r["success"] and "not right" in r["error"] and not got, r)
r = json.loads(T._call_contact(dict(A, confirmed=True, confirm_code=code, purpose=A["purpose"] + " and bring the invoice")))
check("code does not work for a different task", not r["success"] and not got, r)
r = json.loads(T._call_contact({"to": "Joe tailor", "purpose": "hi"})); check("short purpose rejected", not r["success"])
r = json.loads(T._call_contact({"to": "nobody at all", "purpose": A["purpose"]})); check("unknown name rejected", not r["success"], r)
r = json.loads(T._call_contact({"to": "1203630000000000000@g.us", "purpose": A["purpose"], "confirmed": True, "confirm_code": "1234"})); check("group rejected", not r["success"] and not got, r)
r = json.loads(T._call_contact(dict(A, confirmed=True, confirm_code=code)))
check("right code -> daemon /errand called with key and brief", r["success"] and got and got[0][0] == "/errand" and got[0][1] == "k123" and got[0][2]["to"] == "66812345678" and got[0][2]["language"] == "en" and "Saturday" in got[0][2]["purpose"], r)
r = json.loads(T._call_contact(dict(A, confirmed=True, confirm_code=code)))
check("the code is single use", not r["success"] and len(got) == 1, r)
# three wrong codes lock the preview
json.loads(T._call_contact(dict(A))); good = last_code()
for _ in range(3): json.loads(T._call_contact(dict(A, confirmed=True, confirm_code="0001" if good != "0001" else "0002")))
r = json.loads(T._call_contact(dict(A, confirmed=True, confirm_code=good)))
check("after 3 wrong codes even the right one is refused", not r["success"], r)

def confirmed_call(to, purpose=None):
    p = dict(A, to=to, purpose=purpose or A["purpose"])
    json.loads(T._call_contact(dict(p))); return json.loads(T._call_contact(dict(p, confirmed=True, confirm_code=last_code())))
for i in range(3): confirmed_call("+6681000000%d" % i)
r = confirmed_call("+66819999999")
check("5th different number refused (limit 4 numbers/day)", not r["success"] and "different people" in r["error"], r)
r = confirmed_call("Joe tailor")
check("same number again is allowed within the daily total", r["success"], r)
FAIL_NEXT[0] = True
before = len(json.load(open(home + "/state/wa_errand_calls.json"))["calls"])
r = confirmed_call("Joe tailor")
after = len(json.load(open(home + "/state/wa_errand_calls.json"))["calls"]); check("daemon refusal passed back and the reserved slot is released", not r["success"] and "too many" in r["error"] and after == before, (before, after, r))
FAIL_NEXT[0] = False

# concurrency: two simultaneous confirmations with the same valid code -> exactly one call
json.dump({"day": T.time.strftime("%Y-%m-%d"), "calls": []}, open(home + "/state/wa_errand_calls.json", "w"))
p = dict(A, to="+66855555555"); json.loads(T._call_contact(dict(p))); c = last_code(); n0 = len(got); res = []
ths = [threading.Thread(target=lambda: res.append(json.loads(T._call_contact(dict(p, confirmed=True, confirm_code=c))))) for _ in range(6)]
[t.start() for t in ths]; [t.join() for t in ths]
check("6 simultaneous confirmations -> exactly one call placed", sum(1 for x in res if x["success"]) == 1 and len(got) - n0 == 1, res)
# daily total under concurrency
json.dump({"day": T.time.strftime("%Y-%m-%d"), "calls": []}, open(home + "/state/wa_errand_calls.json", "w")); n0 = len(got); res = []
def one(i):
    q = dict(A, to="+6686000000%d" % (i % 2)); json.loads(T._call_contact(dict(q))); cc = last_code()
    res.append(json.loads(T._call_contact(dict(q, confirmed=True, confirm_code=cc))))
ths = [threading.Thread(target=one, args=(i,)) for i in range(12)]
[t.start() for t in ths]; [t.join() for t in ths]
check("12 simultaneous requests never exceed the daily total (6)", len(got) - n0 <= T.ERRAND_PER_DAY, len(got) - n0)
check("restricted turns are blocked from this tool", "whatsapp_call_contact" in open(src).read().split("def _collab_pre_tool")[1])
print(ok, "passed,", fail, "failed"); sys.exit(1 if fail else 0)
