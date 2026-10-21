# Tool-side checks for whatsapp_call_contact against a fake call daemon. The real code/limit logic of the daemon is tested in voice-call/t_errand.mjs.
import importlib.util, json, os, sys, tempfile, threading, http.server
home = tempfile.mkdtemp(); os.environ["HERMES_HOME"] = home
os.makedirs(home + "/voice-call"); os.makedirs(home + "/state")
open(home + "/voice-call/key", "w").write("k123")
json.dump({"Joe tailor": "+66812345678"}, open(home + "/state/wa_contacts.json", "w"))
here = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(here, "tools.py") if os.path.exists(os.path.join(here, "tools.py")) else os.path.join(here, "..", "whatsapp-plus", "tools.py")
spec = importlib.util.spec_from_file_location("tools_under_test", src); T = importlib.util.module_from_spec(spec); spec.loader.exec_module(T)
T.__dict__["_env_value"] = lambda name: "972500000001" if name == "WHATSAPP_ALLOWED_USERS" else ""
lock = threading.Lock(); previews = []; errands = []; codes = {}; FAIL_NEXT = [False]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("content-length", 0)); b = json.loads(self.rfile.read(n)); code, out = 200, {"ok": True}
        with lock:
            k = json.dumps([b["to"], b["purpose"], b.get("may_share", ""), b.get("language", "")])
            if self.headers.get("x-callerd-key") != "k123": code, out = 401, {"error": "bad key"}
            elif self.path == "/errand/preview": previews.append(b); codes[k] = "908172"
            elif self.path == "/errand":
                if FAIL_NEXT[0]: code, out = 429, {"error": "too many errand calls"}
                elif codes.get(k) != b.get("code"): code, out = 403, {"error": "that code is not right"}
                else: del codes[k]; errands.append(b)
        self.send_response(code); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(json.dumps(out).encode())
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 18950), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
os.environ["CALLERD_URL"] = "http://127.0.0.1:18950"
ok = fail = 0
def check(n, c, extra=""):
    global ok, fail
    if c: ok += 1; print("PASS", n)
    else: fail += 1; print("FAIL", n, extra)
A = {"to": "Joe tailor", "purpose": "Ask whether he is free on Saturday afternoon to fit two pairs of trousers", "may_share": "two pairs, shortened", "language": "en"}
def count_calls(): return len(json.load(open(home + "/state/wa_errand_calls.json")).get("calls", [])) if os.path.exists(home + "/state/wa_errand_calls.json") else 0

r = json.loads(T._call_contact(dict(A)))
check("preview goes to the daemon (which sends the owner the code), nothing dialled", r.get("needs_confirmation") and len(previews) == 1 and not errands and previews[0]["to"] == "66812345678" and "may_share" in previews[0], r)
check("the code is not in the tool result, and no code file exists on disk", "908172" not in json.dumps(r) and not any("pending" in f for f in os.listdir(home + "/state")), (r, os.listdir(home + "/state")))
r = json.loads(T._call_contact(dict(A, confirmed=True)))
check("confirmed=true without a code is not enough (new preview, no call)", r.get("needs_confirmation") and not errands and len(previews) == 2, r)
r = json.loads(T._call_contact(dict(A, confirmed=True, confirm_code="000000")))
check("wrong code refused, no call, slot not consumed", not r["success"] and "not right" in r["error"] and not errands and count_calls() == 0, r)
r = json.loads(T._call_contact(dict(A, confirmed=True, confirm_code="908172", purpose=A["purpose"] + " and bring the invoice")))
check("code does not work for a different task", not r["success"] and not errands, r)
check("short purpose rejected", not json.loads(T._call_contact({"to": "Joe tailor", "purpose": "hi"}))["success"])
check("unknown name rejected", not json.loads(T._call_contact({"to": "nobody at all", "purpose": A["purpose"]}))["success"])
r = json.loads(T._call_contact({"to": "1203630000000000000@g.us", "purpose": A["purpose"], "confirmed": True, "confirm_code": "908172"})); check("group rejected", not r["success"] and not errands, r)
r = json.loads(T._call_contact(dict(A, confirmed=True, confirm_code="908172")))
check("right code -> /errand called with key, brief and code", r["success"] and len(errands) == 1 and errands[0]["code"] == "908172" and errands[0]["to"] == "66812345678", r)
check("slot recorded", count_calls() == 1)
r = json.loads(T._call_contact(dict(A, confirmed=True, confirm_code="908172")))
check("code is single use (daemon refuses the repeat) and the slot is released", not r["success"] and len(errands) == 1 and count_calls() == 1, r)

def confirmed_call(to):
    p = dict(A, to=to); json.loads(T._call_contact(dict(p))); return json.loads(T._call_contact(dict(p, confirmed=True, confirm_code="908172")))
for i in range(3): confirmed_call("+6681000000%d" % i)
r = confirmed_call("+66819999999")
check("5th different number refused (limit 4 numbers/day)", not r["success"] and "different people" in r["error"], r)
check("same number again is allowed within the daily total", confirmed_call("Joe tailor")["success"])
FAIL_NEXT[0] = True; before = count_calls(); r = confirmed_call("Joe tailor"); FAIL_NEXT[0] = False
check("daemon refusal passed back and the reserved slot is released", not r["success"] and "too many" in r["error"] and count_calls() == before, (before, count_calls(), r))

json.dump({"day": T.time.strftime("%Y-%m-%d"), "calls": []}, open(home + "/state/wa_errand_calls.json", "w")); n0 = len(errands); res = []
p = dict(A, to="+66855555555"); json.loads(T._call_contact(dict(p)))
ths = [threading.Thread(target=lambda: res.append(json.loads(T._call_contact(dict(p, confirmed=True, confirm_code="908172"))))) for _ in range(6)]
[t.start() for t in ths]; [t.join() for t in ths]
check("6 simultaneous confirmations -> exactly one call placed and one slot kept", sum(1 for x in res if x["success"]) == 1 and len(errands) - n0 == 1 and count_calls() == 1, (res, count_calls()))
json.dump({"day": T.time.strftime("%Y-%m-%d"), "calls": []}, open(home + "/state/wa_errand_calls.json", "w")); n0 = len(errands); res = []
def one(i):
    q = dict(A, to="+6686000000%d" % (i % 2)); json.loads(T._call_contact(dict(q))); res.append(json.loads(T._call_contact(dict(q, confirmed=True, confirm_code="908172"))))
ths = [threading.Thread(target=one, args=(i,)) for i in range(12)]
[t.start() for t in ths]; [t.join() for t in ths]
check("12 simultaneous requests never exceed the daily total (6)", len(errands) - n0 <= T.ERRAND_PER_DAY and count_calls() <= T.ERRAND_PER_DAY, (len(errands) - n0, count_calls()))
check("restricted turns are blocked from this tool", "whatsapp_call_contact" in open(src).read().split("def _collab_pre_tool")[1])
print(ok, "passed,", fail, "failed"); sys.exit(1 if fail else 0)
