// callerd: local WhatsApp voice-call daemon for Hermes. 127.0.0.1 only, every request needs the key in ./key.
//   GET  /status                      -> { state, paired, pairingCode, error, call }
//   POST /pair  { phone }             -> link this daemon as a second device of that account with a pairing code
//   POST /call  { to, mode, reason, direction, audioFile? }   -> place a call (mode live = live voice, otherwise a file/silence)
//   POST /hangup
// Incoming calls from the owner are answered with the live voice when wa_settings.json has call_mode = "answer".
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { VoipClient } from './baileys-caller/dist/index.mjs';
import { makeLive } from './live.mjs';
import { createHermesLink } from './hermes-link.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUTH = path.join(HERE, 'auth');
const KEYFILE = path.join(HERE, 'key');
const LOG = path.join(HERE, 'callerd.log');
const PORT = Number(process.env.CALLERD_PORT || 3100);
const HOME = process.env.HERMES_HOME || '/opt/data';
const SESSION_DIR = process.env.WA_SESSION_DIR || HOME + '/whatsapp/session';
mkdirSync(AUTH, { recursive: true, mode: 0o700 });
if (!existsSync(KEYFILE)) { writeFileSync(KEYFILE, randomBytes(24).toString('hex')); chmodSync(KEYFILE, 0o600); }
const KEY = readFileSync(KEYFILE, 'utf8').trim();
const log = (...a) => { const l = new Date().toISOString() + ' ' + a.join(' '); console.log(l); try { appendFileSync(LOG, l + '\n'); } catch {} };

const LIVE_ENV = path.join(HERE, 'live.env');
const TRANSCRIPTS = path.join(HERE, 'transcripts');
mkdirSync(TRANSCRIPTS, { recursive: true, mode: 0o700 });
const HERMES_API = process.env.HERMES_API_URL || 'http://127.0.0.1:8642';
const digits = (s) => String(s || '').replace(/\D/g, '');

/** Read ONLY the named variables from a KEY=VALUE file (nothing else is loaded or logged). */
const readVars = (file, names) => {
  const out = {};
  try { for (const line of readFileSync(file, 'utf8').split('\n')) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && names.includes(m[1])) out[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
  return out;
};
const liveConfig = () => readVars(LIVE_ENV, ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'LIVE_PROVIDER', 'GEMINI_LIVE_MODEL', 'GEMINI_LIVE_VOICE', 'OPENAI_REALTIME_MODEL', 'OPENAI_REALTIME_VOICE', 'OWNER_NAME', 'OWNER_NUMBER', 'INPUT_LANGUAGES', 'END_SILENCE_MS', 'ERRAND_PER_HOUR', 'ERRAND_MAX_MIN', 'ASK_MAX_MS', 'MAX_CALL_MIN', 'SILENCE_HANGUP_S', 'ASK_LIMIT_MS']);
const hermesKey = () => readVars(process.env.HERMES_ENV_FILE || HOME + '/.env', ['API_SERVER_KEY']).API_SERVER_KEY || '';
const waSettings = () => { try { return JSON.parse(readFileSync(HOME + '/state/wa_settings.json', 'utf8')); } catch { return {}; } };
/** The only number that may talk to the live voice: OWNER_NUMBER from live.env. */
const callUsers = () => { const o = digits(liveConfig().OWNER_NUMBER); return o ? [o] : []; };   // only the owner gets the live voice (it can act with the owner's full Hermes)
const lidToPhone = (jid) => {
  const j = String(jid || '');
  if (!j.endsWith('@lid')) return digits(j);
  try { return digits(JSON.parse(readFileSync(SESSION_DIR + '/lid-mapping-' + digits(j.split(':')[0]) + '_reverse.json', 'utf8'))); } catch { return digits(j); }
};

const TOOLS = [
  { name: 'ask_hermes', behavior: process.env.ASYNC_TOOLS === '0' ? undefined : 'NON_BLOCKING', description: 'Ask Hermes (the full assistant with memory, files, web, calendar, messaging and other tools) to do something or look something up and answer. Say a short "one moment" naming what you check first. Call it once per separate topic, in the same turn, so they run in parallel. Give a complete, self-contained request.',
    parameters: { type: 'object', properties: { request: { type: 'string', description: 'What to do or find out, with all the details needed' } }, required: ['request'] } },
  { name: 'search_memory', behavior: process.env.ASYNC_TOOLS === '0' ? undefined : 'NON_BLOCKING', description: 'Search Hermes\'s long-term memory (MemPalace) for what is already known: people, projects, decisions, past conversations, preferences. Fast (a second or two). Use it FIRST for "what do you remember / what did we decide / what do you know about X / who is Y". Say a short "one moment, searching my memory" first. For live information or actions use ask_hermes instead.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to look for, as a short descriptive phrase with the names involved' } }, required: ['query'] } },
  { name: 'hang_up', description: 'End the call. Say goodbye first. Use it only when the conversation is clearly over.', parameters: { type: 'object', properties: {} } },
];

import { createMemory } from './mempalace-link.mjs';
import { createErrand, errandInstructions, errandTools, errandLanguage } from './errand.mjs';
const memory = process.env.MEMORY_SEARCH === '0' ? null : createMemory({ here: HERE, home: HOME, python: process.env.MEMPALACE_PYTHON || '/srv/media-ingest/hermes-service-home/hermes-agent-src/venv313/bin/python', log });
const errandTimes = [];
const link = createHermesLink({ here: HERE, home: HOME, hermesApi: HERMES_API, hermesKey, bridgeUrl: process.env.BRIDGE_URL || 'http://127.0.0.1:3000', log });
const { getSessionInfo, askHermes, askHermesBounded, postCallSummary, instructionsFor } = link;

const errand = createErrand({ log, home: HOME, link });
let retries = 0;
let client = null, state = 'idle', pairingCode = null, error = null, call = null, callInfo = null;
const registered = () => existsSync(path.join(AUTH, 'creds.json')) && JSON.parse(readFileSync(path.join(AUTH, 'creds.json'), 'utf8')).registered === true;

/** Connect the live voice (Gemini or OpenAI). Throws a readable error. */
async function openLive(wantProvider, reason, direction, info, override) {
  if (!override) memory?.warm();   // start the memory helper now so the first recall question is fast
  const cfg = liveConfig();
  const provider = wantProvider || cfg.LIVE_PROVIDER || (cfg.GEMINI_API_KEY ? 'gemini' : cfg.OPENAI_API_KEY ? 'openai' : '');
  const apiKey = provider === 'openai' ? cfg.OPENAI_API_KEY : cfg.GEMINI_API_KEY;
  if (!apiKey) { const e = new Error('no live voice key: put GEMINI_API_KEY (or OPENAI_API_KEY) in ' + LIVE_ENV); e.status = 412; throw e; }
  const live = makeLive(provider, { apiKey, instructions: override?.instructions ?? instructionsFor(cfg, reason, direction, info), tools: override?.tools ?? TOOLS,
    model: provider === 'openai' ? cfg.OPENAI_REALTIME_MODEL : cfg.GEMINI_LIVE_MODEL, voice: provider === 'openai' ? cfg.OPENAI_REALTIME_VOICE : cfg.GEMINI_LIVE_VOICE,
    silenceMs: Number(cfg.END_SILENCE_MS) || 300,
    inputLanguages: override ? override.inputLanguages : (cfg.INPUT_LANGUAGES ? cfg.INPUT_LANGUAGES.split(',').map((x) => x.trim()).filter(Boolean) : undefined) });
  try { await live.connect(); } catch (e) { const err = new Error('live voice failed: ' + String(e?.message || e).slice(0, 200)); err.status = 502; throw err; }
  return { live, provider };
}

/** Everything that happens during a call: audio both ways, tools, transcript, clean-up. */
function wireCall(active, n, { live, provider, mode, direction, reason, info }) {
  let frames = 0, energy = 0, connected = false;
  const transcript = [];                                   // { t (ms since the call started), tag, text }
  const M = { respDelays: [], interruptions: 0, stalls: 0, askHermes: 0, askMs: [] };   // "was it smooth?" numbers
  let lastUserAt = 0, lastAudioAt = 0, turnStart = 0, hangupWanted = 0, asking = 0, askingSince = 0;
  callInfo = { to: n, status: active._incoming ? 'ringing' : 'calling', mode: mode || 'file', provider, dir: direction === 'in' ? 'in' : 'out', startedAt: Date.now(), frames: 0, heardRms: 0, reason: null, turns: 0 };
  const since = () => Date.now() - callInfo.startedAt;
  const plain = () => transcript.map((e) => e.tag + e.text);
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  const metrics = () => ({ responses: M.respDelays.length, avgResponseMs: avg(M.respDelays), maxResponseMs: M.respDelays.length ? Math.max(...M.respDelays) : null,
    interruptions: M.interruptions, audioStalls: M.stalls, askHermes: M.askHermes, avgAskHermesMs: avg(M.askMs), frames });
  const finish = (why) => {
    if (callInfo.status === 'ended') return;
    callInfo.status = 'ended'; callInfo.reason = why; callInfo.endedAt = Date.now(); live?.close();
    const m = metrics(); callInfo.metrics = m;
    if (live) { try {
      const stamp = new Date(callInfo.startedAt).toISOString().replace(/[:.]/g, '-');
      const lines = transcript.map((e) => '[+' + (e.t / 1000).toFixed(1) + 's] ' + e.tag + e.text);
      lines.push('', '--- how smooth was it ---', 'duration ' + Math.round((Date.now() - callInfo.startedAt) / 1000) + 's | ' + (m.responses || 0) + ' answers, average delay before he started speaking: ' + (m.avgResponseMs ?? '-') + ' ms (slowest ' + (m.maxResponseMs ?? '-') + ' ms)',
        'interruptions: ' + m.interruptions + ' | audio stalls (choppy moments): ' + m.audioStalls + ' | asked Hermes ' + m.askHermes + 'x (avg ' + (m.avgAskHermesMs ?? '-') + ' ms) | received audio frames: ' + m.frames);
      writeFileSync(path.join(TRANSCRIPTS, stamp + '_' + n.slice(-4) + '.txt'), lines.join('\n') + '\n', { mode: 0o600 });
      mkdirSync(HOME + '/state', { recursive: true });
      appendFileSync(HOME + '/state/wa_call_log.jsonl', JSON.stringify({ ts: Date.now(), to: n, dir: callInfo.dir, provider, seconds: Math.round((Date.now() - callInfo.startedAt) / 1000), reason: why, turns: transcript.length, metrics: m, said: plain().slice(-6) }) + '\n', { mode: 0o600 });
    } catch (e) { log('transcript save failed:', e.message); } }
    log('ended:', why, live ? JSON.stringify(m) : ''); if (call === active) call = null;
    if (live) void postCallSummary(info, plain(), (Date.now() - callInfo.startedAt) / 1000, n);
  };
  active.on('ringing', () => { callInfo.status = 'ringing'; log('ringing'); });
  active.on('connected', () => {
    callInfo.status = 'connected'; connected = true; log('connected (' + (active._incoming ? 'answered' : 'call answered') + ')');
    live?.sendText(direction === 'in' ? 'The call just connected: he called you and you answered. Say a short hello now (in Hebrew) and ask what he needs.'
      : 'The call just connected and he answered. Say a short hello now (in Hebrew) and ' + (direction === 'out' ? 'tell him why you are calling.' : 'ask what he needs.'));
  });
  active.on('audio', (pcm) => {
    frames++; let e = 0; for (let i = 0; i < pcm.length; i++) e += pcm[i] * pcm[i]; energy = Math.max(energy, Math.sqrt(e / pcm.length));
    callInfo.frames = frames; callInfo.heardRms = Number(energy.toFixed(4));
    if (live && connected) live.sendAudio(pcm);
  });
  active.on('ended', (why) => finish(why));
  if (live) {
    live.on('audio', (f32) => {
      const now = Date.now();
      if (now - lastAudioAt > 1200) {                      // a new spoken answer starts
        turnStart = now; if (lastUserAt && lastUserAt > lastAudioAt) M.respDelays.push(now - lastUserAt);
      } else if (active.queuedMs < 30) M.stalls++;         // the next piece arrived after the last one had already played out
      lastAudioAt = now; active.pushAudio(f32);
    });
    live.on('interrupted', () => { M.interruptions++; active.clearAudio(); });
    live.on('transcript', (role, text) => {
      if (role === 'user') { lastUserAt = Date.now(); hangupWanted = 0; }   // he spoke after the goodbye: stay on the line
      const tag = role === 'user' ? 'HE: ' : 'HERMES: '; const last = transcript[transcript.length - 1];
      if (last && last.tag === tag) last.text += text; else transcript.push({ t: since(), tag, text });
      callInfo.turns = transcript.length;
    });
    live.on('toolCall', async (calls) => {
      const ASYNC = process.env.ASYNC_TOOLS !== '0' && callInfo?.provider === 'gemini';   // non-blocking: the voice keeps talking while Hermes works, and several lookups run at the same time
      for (const c of calls) {
        if (c.name === 'hang_up') { live.sendToolResult(c.id, c.name, 'ok'); hangupWanted = Date.now(); continue; }
        if (c.name === 'search_memory') {
          const q = String(c.args?.query || ''); log('search_memory:', q.slice(0, 60));
          const run = async () => { const t1 = Date.now(); const r = memory ? await memory.query({ op: 'search', query: q, limit: 4 }) : { ok: false, text: 'memory search is off; use ask_hermes' };
            transcript.push({ t: since(), tag: '', text: '(searched memory: ' + q.slice(0, 80) + ' -> ' + (Date.now() - t1) + ' ms)' });
            live.sendToolResult(c.id, c.name, r.ok ? r.text : r.text + '. Use ask_hermes instead.', ASYNC ? 'WHEN_IDLE' : undefined); };
          if (ASYNC) void run(); else await run();
          continue;
        }
        if (c.name === 'ask_hermes') {
          const req = String(c.args?.request || ''); log('ask_hermes:', req.slice(0, 80)); const t1 = Date.now(); asking++; askingSince = t1;
          const note = (how) => { M.askHermes++; M.askMs.push(Date.now() - t1); asking = Math.max(0, asking - 1); askingSince = Date.now(); transcript.push({ t: since(), tag: '', text: '(asked Hermes: ' + req.slice(0, 120) + ' -> ' + how + (Date.now() - t1) + ' ms)' }); };
          if (ASYNC) {
            void (async () => {
              const text = await askHermes(req, info, 'none', Number(liveConfig().ASK_MAX_MS) || 90000);
              note('answered in ');
              if (call === active && callInfo?.status === 'connected' && live) live.sendToolResult(c.id, c.name, text, 'WHEN_IDLE');   // spoken as soon as he is not mid-sentence
              else void link.postToChat(n, '\u{1F4DE} \u05ea\u05e9\u05d5\u05d1\u05d4 \u05dc\u05de\u05d4 \u05e9\u05d1\u05d9\u05e7\u05e9\u05ea \u05d1\u05e9\u05d9\u05d7\u05d4:\n' + text);
            })();
            continue;
          }
          const r = await askHermesBounded(req, info, n, Number(liveConfig().ASK_LIMIT_MS) || 7000,
            (answer) => { if (call === active && callInfo?.status === 'connected' && live) { live.sendText('Hermes finished checking. Tell him the answer now, short and natural, in Hebrew: ' + String(answer).slice(0, 1500)); transcript.push({ t: since(), tag: "", text: '(late answer from Hermes spoken)' }); return true; } return false; });
          note(r.late ? 'continued in the background after ' : 'answered in '); live.sendToolResult(c.id, c.name, r.text); continue;
        }
        live.sendToolResult(c.id, c.name, 'unknown tool');
      }
    });
    live.on('error', (e) => log('live error:', e?.message || e));
    live.on('resumed', (why) => log('live session resumed after', why));
    // Ending: hang up only once the goodbye has finished playing (and a short quiet window passed); a long silence or the length cap also ends it
    const cfgNow = liveConfig(); const MAX_MS = (Number(cfgNow.MAX_CALL_MIN) || 30) * 60000, SILENCE_MS = (Number(cfgNow.SILENCE_HANGUP_S) || 150) * 1000;
    const watch = setInterval(() => {
      if (call !== active || callInfo?.status === 'ended') { clearInterval(watch); return; }
      const now = Date.now();
      if (hangupWanted && active.queuedMs < 30 && now - lastAudioAt > 1200 && now - hangupWanted > 1500) { log('hanging up after the goodbye'); clearInterval(watch); active.end(); setTimeout(() => active._forceEnd('goodbye'), 1500); return; }
      if (hangupWanted && now - hangupWanted > 15000) { clearInterval(watch); active.end(); setTimeout(() => active._forceEnd('goodbye'), 1500); return; }
      if (callInfo?.status === 'connected' && now - callInfo.startedAt > MAX_MS) { log('call length cap reached'); clearInterval(watch); active.end(); setTimeout(() => active._forceEnd('max_length'), 1500); return; }
      const quietSince = Math.max(lastUserAt || 0, lastAudioAt || 0, askingSince || 0, callInfo?.startedAt || 0);
      if (callInfo?.status === 'connected' && !asking && now - quietSince > SILENCE_MS) { log('hanging up after a long silence'); clearInterval(watch); active.end(); setTimeout(() => active._forceEnd('silence'), 1500); }
    }, 500);
    live.on('closed', (why) => { if (why !== 'local' && call === active) { log('live session closed:', why); active.end(); setTimeout(() => active._forceEnd('live_closed'), 1500); } });
  }
}

/** An incoming call: answer it with the live voice if it is the owner and call_mode is "answer"; otherwise leave it alone. */
async function handleIncoming(incoming, meta) {
  const from = lidToPhone(meta.from);
  const mode = waSettings().call_mode === 'answer' ? 'answer' : 'callback';
  log('incoming call from', from.slice(0, 3) + '…' + from.slice(-2), '| mode', mode);
  const ours = callUsers().some((u) => u === from);
  if (mode !== 'answer' || !ours || call) { incoming._forceEnd('ignored'); return; }   // not ours to answer: only forget it here (the bridge declines or calls back)
  call = incoming;
  let opened = null;
  const info = await getSessionInfo(from);
  try { opened = await openLive(null, '', 'in', info); }
  catch (e) { log('cannot answer, live voice unavailable:', e.message); call = null; incoming._forceEnd('ignored'); return; }
  wireCall(incoming, from, { live: opened.live, provider: opened.provider, mode: 'live', direction: 'in', reason: '', info });
  const t0 = Date.now();
  while (incoming.state !== 3 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100)); // wait for the engine to know it is ringing
  setTimeout(() => { if (call === incoming && callInfo?.status !== 'connected') { log('answer did not connect in time; releasing the call so the call-back fallback can run'); try { incoming.reject(); } catch { incoming._forceEnd('answer_timeout'); } } }, 8000);
  try { incoming.answer(); log('answer sent after', Date.now() - t0, 'ms; engine state', incoming.state); }
  catch (e) { log('answer failed:', e?.message || e); incoming._forceEnd('answer_failed'); }
}

async function startClient(pairingPhone) {
  if (client) return;
  state = pairingPhone ? 'pairing' : 'connecting'; error = null;
  client = new VoipClient({ authDir: AUTH, pairingPhone,
    onPairingCode: (code, err) => { if (err) { error = 'pairing: ' + err.message; log('pairing error', err.message); } else { pairingCode = code; log('PAIRING CODE issued'); } },
    onIncomingCall: (c, info) => { void handleIncoming(c, info); } });
  try { await client.connect(); state = 'ready'; pairingCode = null; retries = 0; log('connected, ready'); }
  catch (e) {
    error = String(e?.message || e); state = 'idle'; log('connect failed:', error); try { client.disconnect(); } catch {} client = null;
    if (registered() && !pairingPhone) { const wait = Math.min(60000, 15000 * (++retries)); log('retrying the WhatsApp connection in', wait / 1000, 's'); setTimeout(() => { void startClient(null); }, wait); }
  }
}

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });

const server = http.createServer(async (req, res) => {
  if (req.headers['x-callerd-key'] !== KEY) return json(res, 401, { error: 'bad key' });
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/status') return json(res, 200, { state, paired: registered(), pairingCode, error, call: callInfo });
    if (req.method === 'POST' && url.pathname === '/pair') {
      const { phone } = await body(req);
      if (!/^\d{8,15}$/.test(digits(phone))) return json(res, 400, { error: 'phone: digits with country code' });
      if (registered()) return json(res, 409, { error: 'already linked' });
      pairingCode = null; error = null;
      void startClient(String(phone));
      for (let i = 0; i < 40 && !pairingCode && !error; i++) await new Promise((r) => setTimeout(r, 500));
      return json(res, pairingCode ? 200 : 500, { pairingCode, error });
    }
    if (req.method === 'POST' && url.pathname === '/errand') {
      // Hermes phones a third party for the owner. Locked down: the voice gets only the brief (no memory, no Hermes tools); the call is recorded.
      const b = await body(req);
      if (state !== 'ready' || !client) return json(res, 409, { error: 'not ready: ' + state });
      if (call) return json(res, 409, { error: 'a call is already active' });
      const n = digits(b.to), purpose = String(b.purpose || '').trim();
      if (n.length < 8 || n.length > 15) return json(res, 400, { error: 'to: digits with country code' });
      if (purpose.length < 8) return json(res, 400, { error: 'purpose: say what the call is for' });
      const cfg = liveConfig(), owner = digits(cfg.OWNER_NUMBER);
      const perHour = Number(cfg.ERRAND_PER_HOUR) || 4, now = Date.now();
      while (errandTimes.length && now - errandTimes[0] > 3600000) errandTimes.shift();
      if (errandTimes.length >= perHour) return json(res, 429, { error: 'too many errand calls in the last hour (limit ' + perHour + ')' });
      const lang = errandLanguage(b.language);
      const brief = { name: String(b.name || '').slice(0, 60), purpose, mayShare: String(b.may_share || '').slice(0, 500), language: b.language, ownerName: cfg.OWNER_NAME || 'the owner' };
      let opened = null;
      try { opened = await openLive(null, '', 'out', null, { instructions: errandInstructions(brief), tools: errandTools(), inputLanguages: lang ? [lang.code] : undefined }); }
      catch (e) { log('errand: live connect failed:', e.message); return json(res, e.status || 502, { error: e.message }); }
      const ownerInfo = await getSessionInfo(owner);   // only used to report back into the owner's chat session
      const maxMin = Number(cfg.ERRAND_MAX_MIN) || 6;
      try { call = await client.call(n, { audioSource: 'live', durationMs: (maxMin + 2) * 60000 }); }
      catch (e) { opened.live.close(); log('errand: call failed:', e.message); return json(res, 502, { error: String(e.message || e).slice(0, 160) }); }
      errandTimes.push(now);
      const active = call;
      errand.wire(active, n, brief, opened, { setInfo: (i) => { callInfo = i; }, onEnd: () => { if (call === active) call = null; }, info: ownerInfo, owner, maxMs: maxMin * 60000 });
      log('errand started to', n.slice(0, 3) + '\u2026' + n.slice(-2));
      return json(res, 200, { ok: true, status: 'calling' });
    }
    if (req.method === 'POST' && url.pathname === '/call') {
      const { to, audioFile, durationMs, mode, reason, direction, provider: wantProvider } = await body(req);
      if (state !== 'ready' || !client) return json(res, 409, { error: 'not ready: ' + state });
      if (call) return json(res, 409, { error: 'a call is already active' });
      const n = digits(to);
      if (n.length < 8) return json(res, 400, { error: 'to: digits with country code' });
      const dir = direction || (reason ? 'out' : 'back');   // out: Hermes calls for a reason; back: he called first and Hermes calls back
      let opened = null, info = null;
      if (mode === 'live' && !callUsers().includes(n)) return json(res, 403, { error: 'the live voice (with the owner\'s memory and tools) is only for the owner number' });
      if (mode === 'live') { info = await getSessionInfo(n); try { opened = await openLive(wantProvider, reason, dir, info); } catch (e) { log('live connect failed:', e.message); return json(res, e.status || 502, { error: e.message }); } }
      try { call = await client.call(n, { audioSource: opened ? 'live' : (audioFile || 'silence'), durationMs: Number(durationMs) || (opened ? 600000 : 120000) }); }
      catch (e) { opened?.live.close(); call = null; log('call failed:', e?.message || e); return json(res, 502, { error: String(e?.message || e) }); }
      wireCall(call, n, { live: opened?.live, provider: opened?.provider, mode: mode || 'file', direction: dir, reason, info });
      return json(res, 200, { ok: true, mode: callInfo.mode, provider: opened?.provider });
    }
    if (req.method === 'POST' && url.pathname === '/hangup') { call?.end(); return json(res, 200, { ok: true }); }
    return json(res, 404, { error: 'not found' });
  } catch (e) { log('request failed:', e?.message || e); call = null; return json(res, 500, { error: String(e?.message || e) }); }
});
server.listen(PORT, '127.0.0.1', () => { log('callerd listening on 127.0.0.1:' + PORT); if (registered()) void startClient(null); });
process.on('SIGTERM', () => { try { call?.end(); } catch {} memory?.stop(); setTimeout(() => { try { client?.disconnect(); } catch {} process.exit(0); }, 2000); });   // give the call a moment to save its transcript
