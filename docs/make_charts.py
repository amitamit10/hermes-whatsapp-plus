#!/usr/bin/env python3
"""Regenerate the SVG charts in this folder from call_metrics.json (no dependencies)."""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
D = json.load(open(os.path.join(HERE, "call_metrics.json")))
FG, MUTED, GRID, A, B, C = "#1f2328", "#656d76", "#d0d7de", "#0969da", "#bf8700", "#1a7f37"

def svg(w, h, body, title):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d" role="img" aria-label="%s" '
            'font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">'
            '<rect x="0.5" y="0.5" width="%d" height="%d" rx="8" fill="#ffffff" stroke="%s"/>'
            '<text x="24" y="34" font-size="16" font-weight="600" fill="%s">%s</text>%s</svg>' % (w, h, w, h, title, w - 1, h - 1, GRID, FG, title, body))

def lookups():
    items = D["lookups"]["items"]; w, h = 760, 70 + 56 * len(items) + 120
    x0, x1 = 170, 720; mx = max(i["started_s"] + i["ms"] / 1000 for i in items); scale = (x1 - x0) / (mx * 1.05)
    b = '<text x="24" y="54" font-size="12" fill="%s">%s (seconds after the questions were asked)</text>' % (MUTED, D["lookups"]["call"])
    for t in range(0, int(mx) + 6, 10):
        x = x0 + t * scale
        if x > x1: break
        b += '<line x1="%.1f" y1="70" x2="%.1f" y2="%d" stroke="%s"/><text x="%.1f" y="%d" font-size="11" text-anchor="middle" fill="%s">%ds</text>' % (x, x, 70 + 56 * len(items), GRID, x, 70 + 56 * len(items) + 16, MUTED, t)
    for n, i in enumerate(items):
        y = 84 + n * 56; ww = i["ms"] / 1000 * scale
        b += '<text x="24" y="%d" font-size="13" fill="%s">%s</text><rect x="%.1f" y="%d" width="%.1f" height="24" rx="4" fill="%s"/><text x="%.1f" y="%d" font-size="12" fill="#fff" text-anchor="end">%.1f s</text>' % (y + 17, FG, i["what"], x0 + i["started_s"] * scale, y, ww, A, x0 + i["started_s"] * scale + ww - 8, y + 16, i["ms"] / 1000)
    par = max(i["ms"] for i in items) / 1000; seq = sum(i["ms"] for i in items) / 1000
    yb = 70 + 56 * len(items) + 44
    b += '<text x="24" y="%d" font-size="13" fill="%s">All three ran at the same time: <tspan font-weight="600" fill="%s">%.0f s</tspan> instead of about <tspan font-weight="600" fill="%s">%.0f s</tspan> one after the other.</text>' % (yb, FG, C, par, B, seq)
    b += '<text x="24" y="%d" font-size="11" fill="%s">One real call, n = 3 lookups. Each lookup is a full Hermes turn with tools, so the time is Hermes working, not the voice.</text>' % (yb + 22, MUTED)
    return svg(w, h, b, "Parallel lookups on a call"), "lookup-parallel.svg"

def delay():
    rows = D["response_delay"]; w, h = 760, 120 + 70 * len(rows)
    x0, x1 = 170, 700; mx = max(r["slowest_ms"] for r in rows) * 1.15; sc = (x1 - x0) / mx
    b = '<text x="24" y="54" font-size="12" fill="%s">Time from the end of his sentence until the voice starts speaking (milliseconds)</text>' % MUTED
    for n, r in enumerate(rows):
        y = 80 + n * 70
        b += '<text x="24" y="%d" font-size="13" fill="%s">%s</text>' % (y + 18, FG, r["call"])
        b += '<rect x="%d" y="%d" width="%.1f" height="18" rx="3" fill="%s"/><text x="%.1f" y="%d" font-size="12" fill="%s">average %d ms (n=%d)</text>' % (x0, y, r["avg_ms"] * sc, A, x0 + r["avg_ms"] * sc + 8, y + 13, FG, r["avg_ms"], r["answers"])
        b += '<rect x="%d" y="%d" width="%.1f" height="18" rx="3" fill="%s"/><text x="%.1f" y="%d" font-size="12" fill="%s">slowest %d ms</text>' % (x0, y + 24, r["slowest_ms"] * sc, B, x0 + r["slowest_ms"] * sc + 8, y + 37, FG, r["slowest_ms"])
    b += '<text x="24" y="%d" font-size="11" fill="%s">Two real calls, very few spoken answers each: treat as a sanity check, not a benchmark.</text>' % (h - 18, MUTED)
    return svg(w, h, b, "How fast the voice answers"), "voice-response-delay.svg"

def attempts():
    A_ = D["answer_attempts"]; st = A_["stages"]; at = A_["attempts"]; w, h = 760, 392
    x0, y0, gw, gh = 190, 70, 540, 230; dx = gw / (len(at) - 1); dy = gh / (len(st) - 1)
    b = '<text x="24" y="54" font-size="12" fill="%s">Furthest stage reached by each test call while making Hermes answer incoming calls</text>' % MUTED
    for k, s in enumerate(st):
        y = y0 + gh - k * dy
        b += '<line x1="%d" y1="%.1f" x2="%d" y2="%.1f" stroke="%s"/><text x="%d" y="%.1f" font-size="12" text-anchor="end" fill="%s">%s</text>' % (x0, y, x0 + gw, y, GRID, x0 - 10, y + 4, FG, s)
    pts = [(x0 + n * dx, y0 + gh - a["stage"] * dy) for n, a in enumerate(at)]
    b += '<polyline points="%s" fill="none" stroke="%s" stroke-width="2.5"/>' % (" ".join("%.1f,%.1f" % p for p in pts), A)
    for n, ((x, y), a) in enumerate(zip(pts, at)):
        col = C if n == len(at) - 1 else A
        b += '<circle cx="%.1f" cy="%.1f" r="6" fill="%s"/><text x="%.1f" y="%d" font-size="12" text-anchor="middle" fill="%s">%s</text>' % (x, y, col, x, y0 + gh + 22, MUTED, a["label"])
    b += '<text x="%d" y="%d" font-size="12" text-anchor="middle" fill="%s">test call number</text>' % (x0 + gw / 2, y0 + gh + 46, MUTED)
    b += '<text x="24" y="%d" font-size="11" fill="%s">Read from the daemon logs of the real test calls. Causes are listed in voice-call/README.md (LID vs phone-number IDs).</text>' % (h - 14, MUTED)
    return svg(w, h, b, "Getting Hermes to answer: 8 real test calls"), "answering-attempts.svg"

for fn in (lookups, delay, attempts):
    content, name = fn()
    open(os.path.join(HERE, name), "w", encoding="utf-8").write(content)
    print("wrote", name)
