import importlib.util, json, os, sys, tempfile, threading, http.server
home = tempfile.mkdtemp(); os.environ["HERMES_HOME"] = home
os.makedirs(home + "/voice-call"); os.makedirs(home + "/state")
open(home + "/voice-call/key", "w").write("k123")
json.dump({"Joe tailor": "+66812345678"}, open(home + "/state/wa_contacts.json", "w"))
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("tools_under_test", os.path.join(here, "..", "whatsapp-plus", "tools.py")); T = importlib.util.module_from_spec(spec); spec.loader.exec_module(T)
T.__dict__["_env_value"] = lambda name: "972500000001" if name == "WHATSAPP_ALLOWED_USERS" else ""
got = []
FAIL_NEXT = False
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("content-length", 0)); got.append((self.path, self.headers.get("x-callerd-key"), json.loads(self.rfile.read(n))))
        code, out = (429, {"error": "too many errand calls"}) if FAIL_NEXT else (200, {"ok": True})
        self.send_response(code); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(json.dumps(out).encode())
    def log_message(self, *a): pass
srv = http.server.HTTPServer(("127.0.0.1", 18950), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
os.environ["CALLERD_URL"] = "http://127.0.0.1:18950"
ok = fail = 0
def check(n, c, extra=""):
    global ok, fail
    if c: ok += 1; print("PASS", n)
    else: fail += 1; print("FAIL", n, extra)
A = {"to": "Joe tailor", "purpose": "Ask whether he is free on Saturday afternoon to fit two pairs of trousers", "language": "en"}
r = json.loads(T._call_contact(dict(A)))
check("no confirmation -> preview only, no call placed", r.get("needs_confirmation") and not got and r["preview"]["number"] == "+66812345678" and "AI assistant" in r["preview"]["note"], r)
r = json.loads(T._call_contact({"to": "Joe tailor", "purpose": "hi"})); check("short purpose rejected", not r["success"])
r = json.loads(T._call_contact({"to": "nobody at all", "purpose": A["purpose"]})); check("unknown name rejected", not r["success"], r)
r = json.loads(T._call_contact({"to": "1203630000000000000@g.us", "purpose": A["purpose"], "confirmed": True})); check("group rejected", not r["success"] and not got, r)
r = json.loads(T._call_contact(dict(A, confirmed=True)))
check("confirmed -> daemon /errand called with key and brief", r["success"] and got and got[0][0] == "/errand" and got[0][1] == "k123" and got[0][2]["to"] == "66812345678" and got[0][2]["language"] == "en" and "Saturday" in got[0][2]["purpose"], r)
check("daily state written", len(json.load(open(home + "/state/wa_errand_calls.json"))["calls"]) == 1)
for i in range(3):
    r = json.loads(T._call_contact({"to": "+6681000000%d" % i, "purpose": A["purpose"], "confirmed": True}))
r = json.loads(T._call_contact({"to": "+66819999999", "purpose": A["purpose"], "confirmed": True}))
check("5th different number refused (limit 4 numbers/day)", not r["success"] and "different people" in r["error"], r)
r = json.loads(T._call_contact(dict(A, confirmed=True)))
check("same number again is allowed within the daily total", r["success"], r)
FAIL_NEXT = True
r = json.loads(T._call_contact(dict(A, confirmed=True)))
check("daemon refusal passed back", not r["success"] and "too many" in r["error"], r)
check("restricted turns are blocked from this tool", "whatsapp_call_contact" in open(os.path.join(here, "..", "whatsapp-plus", "tools.py")).read().split("def _collab_pre_tool")[1])
print(ok, "passed,", fail, "failed"); sys.exit(1 if fail else 0)
