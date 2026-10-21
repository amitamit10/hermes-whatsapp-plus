// whatsapp-plus bridge extension.
//
// Loaded by the stock Hermes WhatsApp bridge through two tiny hooks that the plugin inserts when it generates bridge.js
// (see platform_plus.py). Nothing here edits Hermes' bridge code: the extension wraps `sock.sendMessage`, adds its own Baileys
// listeners and Express routes, and wraps `messageQueue.push` so inbound events get display names.
//
// Shared state lives in $HERMES_HOME/state (wa_*.json) and is also read/written by the Python plugin and its tools.
import { readFileSync, writeFileSync, renameSync, appendFileSync, statSync, mkdirSync } from 'fs';

const STATE = (process.env.HERMES_HOME || '/opt/data') + '/state';
const readJson = (name, d) => { try { return JSON.parse(readFileSync(STATE + '/' + name, 'utf8')); } catch (e) { return d; } };
const writeJson = (name, o) => {
  try { writeFileSync(STATE + '/' + name + '.tmp', JSON.stringify(o, null, 1)); renameSync(STATE + '/' + name + '.tmp', STATE + '/' + name); }
  catch (e) { console.error('whatsapp-plus: could not write', name, e.message); }
};
const digits = (j) => String(j || '').split('@')[0].split(':')[0];
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nowSec = () => Math.floor(Date.now() / 1000);
// A rejected non-Error (string, plain object) would otherwise serialize as { error: undefined } and lose the reason.
const errMsg = (e) => {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e) ?? String(e); } catch (x) { return String(e); }
};

let setCache = { t: 0, v: {} };
const settings = () => {
  if (Date.now() - setCache.t > 3000) setCache = { t: Date.now(), v: readJson('wa_settings.json', {}) };
  return setCache.v;
};
let tempCache = { t: 0, set: new Set() };
const tempContacts = () => {
  if (Date.now() - tempCache.t > 5000) {
    const set = new Set();
    const now = Date.now() / 1000;
    for (const [k, v] of Object.entries(readJson('wa_temp_contacts.json', {}))) {
      const exp = (v && typeof v === 'object') ? v.exp : v;
      if (Number(exp) > now) set.add(k);
    }
    tempCache = { t: Date.now(), set };
  }
  return tempCache.set;
};

// ---- ported from upstream PRs (reviewed, re-written for this plugin) -------------------------------------------------------
// #95934/#107816: WhatsApp re-delivers un-acked messages with the SAME id (every ~10 min, or after a reconnect); forwarding each
// copy makes the agent answer the same message again and again. Remember forwarded ids, persisted so a restart cannot re-trigger it.
const SEEN_FILE = 'wa_seen_ids.json';
const seenIds = new Map(Object.entries(readJson(SEEN_FILE, {})));
let seenDirty = 0;
function alreadySeen(id) {
  if (!id) return false;
  if (seenIds.has(id)) return true;
  seenIds.set(id, Date.now());
  while (seenIds.size > 2000) seenIds.delete(seenIds.keys().next().value);
  if (++seenDirty >= 10) { seenDirty = 0; writeJson(SEEN_FILE, Object.fromEntries(seenIds)); }
  return false;
}
setInterval(() => { if (seenDirty) { seenDirty = 0; writeJson(SEEN_FILE, Object.fromEntries(seenIds)); } }, 30000).unref?.();

// bounded JSONL appender (rotates past maxBytes)
function appendJsonl(name, obj, maxBytes = 2 * 1024 * 1024) {
  try {
    const f = STATE + '/' + name;
    mkdirSync(STATE, { recursive: true });
    try { if (statSync(f).size > maxBytes) renameSync(f, f + '.1'); } catch (e) { /* not there yet */ }
    appendFileSync(f, JSON.stringify(obj) + '\n');
  } catch (e) { /* best effort */ }
}

// #55612: a LID that has a recorded phone mapping is sent to the visible phone chat instead
function lidToPhoneJid(jid, sessionDir) {
  if (!String(jid).endsWith('@lid')) return jid;
  try {
    const v = JSON.parse(readFileSync(sessionDir + '/lid-mapping-' + digits(jid) + '_reverse.json', 'utf8'));
    const phone = String(v || '').replace(/\D/g, '');
    if (phone) return phone + '@s.whatsapp.net';
  } catch (e) { /* unmapped: keep the LID */ }
  return jid;
}

// #45644: shared contact cards -> readable text for the agent
function summarizeContacts(content) {
  const cards = [];
  if (content?.contactMessage) cards.push(content.contactMessage);
  for (const c of content?.contactsArrayMessage?.contacts || []) cards.push(c);
  const lines = [];
  for (const c of cards) {
    const v = String(c.vcard || '');
    const name = c.displayName || (v.match(/^FN:(.*)$/m) || [])[1] || 'contact';
    const nums = [...v.matchAll(/^(?:item\d+\.)?TEL[^:]*:(.*)$/gm)].map((m) => m[1].trim());
    const waid = [...v.matchAll(/waid=(\d+)/g)].map((m) => '+' + m[1]);
    lines.push(String(name).trim() + ': ' + ([...new Set([...waid, ...nums])].join(', ') || 'no number'));
  }
  return lines.length ? '[Shared contact' + (lines.length > 1 ? 's' : '') + ']\n' + lines.join('\n') : '';
}

function textOf(m) {
  if (!m) return '';
  const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message
    || m.documentWithCaptionMessage?.message || m.editedMessage?.message || m;
  return inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || inner.videoMessage?.caption
    || inner.documentMessage?.caption || '';
}
const hasMedia = (m) => !!(m && (m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage || m.stickerMessage));

// ---- shared module state (survives reconnects) ----------------------------------------------------------------------------
const names = new Map();        // digits -> display name
const metaCache = new Map();    // group jid -> { t, m }
const sentIndex = new Map();    // message id -> chat jid (our own sent messages)
const sentLast = new Map();     // chat jid -> last message id we sent there
const status = new Map();       // message id -> { status, t }
const ephemeral = new Map();    // DM jid -> disappearing-messages timer (seconds)
const groupSends = new Map();   // group jid -> recent send timestamps (loop brake)
const existsCache = new Map();  // jid -> { t, ok } (onWhatsApp lookups)
const called = new Map();       // caller -> last time we texted them about calls
const recentReactions = new Map(); // reaction signature -> last logged time
let current = null;             // { sock, ctx } of the live connection
let routesDone = false;
let pushWrapped = false;

function learnName(msg) {
  const pn = msg.pushName;
  if (!pn || msg.key?.fromMe) return;
  for (const j of [msg.key.participant, msg.key.participantAlt, msg.key.remoteJidAlt]) if (j) names.set(digits(j), pn);
  if (!String(msg.key.remoteJid).endsWith('@g.us')) names.set(digits(msg.key.remoteJid), pn);
}

function setStatus(id, st) {
  if (!id) return;
  const order = { sent: 1, delivered: 2, read: 3, played: 3 };
  const cur = status.get(id);
  if (!cur || (order[st] || 0) >= (order[cur.status] || 0)) status.set(id, { status: st, t: nowSec() });
  while (status.size > 2000) status.delete(status.keys().next().value);
}

async function groupMeta(chatId) {
  const c = metaCache.get(chatId);
  if (c && Date.now() - c.t < 600000) return c.m;
  const m = await current.sock.groupMetadata(chatId);
  metaCache.set(chatId, { t: Date.now(), m });
  for (const p of m.participants || []) {
    const nm = p.name || p.notify;
    if (!nm) continue;
    for (const j of [p.id, p.lid, p.phoneNumber]) if (j && !names.has(digits(j))) names.set(digits(j), nm);
  }
  return m;
}

// ---- outbound guards ------------------------------------------------------------------------------------------------------
async function guardTarget(sock, jid) {
  const d = digits(jid);
  const own = [sock.user?.id, sock.user?.lid].filter(Boolean).map(digits);
  if (own.includes(d)) return "refusing to send to the bot's own number/ID (a group member's LID is not a phone number - ask the user for their real number)";
  if (String(jid).endsWith('@g.us')) {
    const now = Date.now() / 1000;
    const c = readJson('wa_group_control.json', {});
    const until = Number((c.mute || {})[jid] || 0);
    if (until > now) return 'this group is muted for ' + Math.ceil((until - now) / 60) + ' more minutes (mute / loop protection) - do not send to it; tell the user if needed';
    const arr = (groupSends.get(jid) || []).filter((t) => now - t < 120);
    if (arr.length >= 6) {
      c.mute = Object.assign({}, c.mute, { [jid]: now + 600 });
      c.last_auto_mute = { chat: jid, at: now };
      writeJson('wa_group_control.json', c);
      groupSends.set(jid, []);
      try {
        const owner = [...current.ctx.ALLOWED_USERS][0];
        if (owner && owner !== '*') current.origSend(owner + '@s.whatsapp.net', { text: 'Loop brake: Hermes sent 6 messages to a group within 2 minutes, so it is muted there for 10 minutes. Ask me to unmute when ready.' }, {}).catch(() => {});
      } catch (e) { /* best effort */ }
      return 'loop brake: 6 messages to this group within 2 minutes - muted for 10 minutes';
    }
    arr.push(now);
    groupSends.set(jid, arr);
    return null;
  }
  if (String(jid).endsWith('@s.whatsapp.net')) {
    const c = existsCache.get(jid);
    if (c && Date.now() - c.t < 3600000) return c.ok ? null : 'that number is not on WhatsApp';
    try {
      const r = await sock.onWhatsApp(jid);
      const ok = !!(r && r[0] && r[0].exists);
      existsCache.set(jid, { t: Date.now(), ok });
      if (!ok) return 'that number is not on WhatsApp';
    } catch (e) { /* lookup failed: do not block */ }
  }
  return null;
}

// "@Name" of a group member -> "@<id>" + a real WhatsApp mention
async function tagMentions(jid, content) {
  if (!content.text.includes('@')) return;
  const meta = await groupMeta(jid);
  let text = content.text;
  const cands = [];
  for (const p of meta.participants || []) {
    const nm = names.get(digits(p.id)) || names.get(digits(p.lid)) || names.get(digits(p.phoneNumber));
    if (nm) cands.push([nm, digits(p.id)]);
  }
  cands.sort((a, b) => b[0].length - a[0].length);
  for (const [nm, d] of cands) text = text.replace(new RegExp('@' + esc(nm), 'g'), '@' + d);
  const nums = [...new Set((text.match(/@(\d{6,16})/g) || []).map((m) => m.slice(1)))];
  if (nums.length) {
    const jids = new Set();
    for (const p of meta.participants || []) {
      for (const j of [p.id, p.lid, p.phoneNumber, p.jid]) if (j && nums.includes(digits(j))) jids.add(j);
    }
    if (jids.size) content.mentions = [...jids];
  }
  content.text = text;
}

function wrapSend(sock, ctx) {
  const orig = sock.sendMessage.bind(sock);
  current.origSend = orig;
  sock.sendMessage = async (jid, content, options) => {
    options = options || {};
    jid = lidToPhoneJid(jid, ctx.SESSION_DIR);
    // text-like documents keep a usable type instead of application/octet-stream (#114408)
    if (content?.document && (!content.mimetype || content.mimetype === 'application/octet-stream') && content.fileName) {
      const ext = String(content.fileName).split('.').pop().toLowerCase();
      const mt = { html: 'text/html', htm: 'text/html', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', json: 'application/json', xml: 'application/xml' }[ext];
      if (mt) content.mimetype = mt;
    }
    const control = !!(content && (content.react || content.delete));
    if (!control) {
      const err = await guardTarget(sock, jid);
      if (err) throw new Error(err);
      try {
        if (String(jid).endsWith('@g.us') && content && typeof content.text === 'string') await tagMentions(jid, content);
        const exp = String(jid).endsWith('@g.us') ? ((await groupMeta(jid))?.ephemeralDuration || 0) : (ephemeral.get(jid) || 0);
        if (exp) options.ephemeralExpiration = exp;
      } catch (e) { console.error('whatsapp-plus send prep:', e.message); }
    }
    const sent = await orig(jid, content, options);
    if (!control) { try { Promise.resolve(sock.sendPresenceUpdate('paused', jid)).catch(() => {}); } catch (e) { /* ignore */ } } // clear the typing indicator (#46343)
    try {
      if (sent?.key?.id) {
        sentIndex.set(sent.key.id, sent.key.remoteJid);
        sentLast.set(sent.key.remoteJid, sent.key.id);
        while (sentIndex.size > 1000) sentIndex.delete(sentIndex.keys().next().value);
      }
    } catch (e) { /* ignore */ }
    return sent;
  };
}

// ---- inbound: names, bot ids, @mentions in the body ------------------------------------------------------------------------
function wrapQueue(ctx) {
  if (pushWrapped) return;
  pushWrapped = true;
  const q = ctx.messageQueue;
  const origPush = q.push.bind(q);
  q.push = (...events) => {
    events = events.filter((ev) => {
      try { return ev.historyOnly || ev.contextOnly || !alreadySeen(ev.messageId); } catch (e) { return true; }
    });
    for (const ev of events) {
      try {
        const sock = current.sock;
        // modern voice notes arrive as plain opus audio without the ptt flag, so speech-to-text never ran on them (#102385)
        if (ev.mediaType === 'audio' && !ev.fileName && /ogg|opus/i.test(ev.mime || '')) {
          ev.mediaType = 'ptt';
          if (ev.body === '[audio received]') ev.body = '[ptt received]';
        }
        // a reply whose quoted payload was not delivered: recover the text from the message store, keep the reply id (#76075)
        if (ev.quotedMessageId && !ev.quotedText) {
          const t = textOf(ctx.messageStore.get(ev.quotedMessageId)?.message);
          if (t) ev.quotedText = t.slice(0, 500);
          ev.hasQuotedMessage = true;
        }
        const nm = names.get(digits(ev.senderId));
        if (nm) ev.senderName = nm;
        const gm = ev.isGroup ? metaCache.get(ev.chatId)?.m : null;
        if (gm?.subject) ev.chatName = gm.subject;
        const extra = [ctx.jidNormalizedUser(sock.user?.id || ''), ctx.jidNormalizedUser(sock.user?.lid || '')].filter(Boolean);
        ev.botIds = [...new Set([...(ev.botIds || []), ...extra])];
        if (ev.body && !ev.historyOnly) {
          const own = [sock.user?.id, sock.user?.lid].filter(Boolean).map(digits);
          ev.body = ev.body.replace(/@(\d{6,16})/g, (m, d) => (own.includes(d) || !names.has(d)) ? m : '@' + names.get(d));
        }
      } catch (e) { /* never block an event */ }
    }
    return events.length ? origPush(...events) : q.length;
  };
}

async function historyNote(chatId, senderId, note) {
  try {
    if (!chatId || !String(chatId).endsWith('@g.us')) return;
    const m = await groupMeta(chatId).catch(() => null);
    current.ctx.messageQueue.push({
      historyOnly: true, isGroup: true, chatId, chatName: m?.subject || '', senderId: senderId || '',
      senderName: names.get(digits(senderId)) || digits(senderId), body: note,
      messageId: 'note-' + chatId + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      timestamp: nowSec(), hasMedia: false, mentionedIds: [], botIds: [], fromOwner: false,
    });
  } catch (e) { /* best effort */ }
}

// ---- HTTP routes (registered once; they use whichever socket is current) ----------------------------------------------------
function addRoutes(app) {
  if (routesDone) return;
  routesDone = true;
  app.disable('x-powered-by'); // do not advertise Express (#96994)
  const live = (res) => {
    if (!current?.sock || current.ctx.getConnectionState() !== 'connected') { res.status(503).json({ error: 'Not connected' }); return null; }
    return current;
  };
  app.get('/groups', async (req, res) => {
    const c = live(res); if (!c) return;
    try {
      let list = [...metaCache.entries()].filter(([, v]) => Date.now() - v.t < 600000).map(([id, v]) => ({ id, name: v.m.subject || '', participants: (v.m.participants || []).length }));
      if (!list.length) {
        const all = await c.sock.groupFetchAllParticipating();
        list = Object.values(all || {}).map((g) => ({ id: g.id, name: g.subject || '', participants: (g.participants || []).length }));
      }
      res.json(list);
    } catch (err) { res.status(500).json({ error: errMsg(err) }); }
  });
  app.get('/status/:id', (req, res) => {
    const s = status.get(req.params.id);
    res.json({ id: req.params.id, status: s ? s.status : 'unknown', at: s ? s.t : null });
  });
  app.post('/react', async (req, res) => {
    const c = live(res); if (!c) return;
    const { chatId, key, messageId, senderId, fromMe, emoji } = req.body || {};
    if (!chatId || emoji === undefined || emoji === null || (!key && !messageId)) {
      return res.status(400).json({ error: 'chatId, emoji and either key or messageId are required (emoji "" removes our reaction)' });
    }
    let rkey = key;
    if (!rkey) {
      // Build the target key like Baileys needs it: ownership (fromMe) and, in groups, the author. Prefer the cached original.
      const cached = c.ctx.messageStore.get(messageId);
      if (cached?.key) {
        if (cached.key.remoteJid !== chatId && cached.key.remoteJidAlt !== chatId && digits(cached.key.remoteJid) !== digits(chatId)) {
          return res.status(400).json({ error: 'Reaction target belongs to another chat' });
        }
        rkey = { ...cached.key };
      } else {
        rkey = { remoteJid: chatId, id: messageId, fromMe: fromMe === true || fromMe === 'true' };
        if (String(chatId).endsWith('@g.us')) {
          if (!senderId) return res.status(400).json({ error: 'group reaction needs senderId (the author of that message) when the message is not in the bridge cache' });
          rkey.participant = senderId;
        }
      }
    }
    if (!rkey.id) return res.status(400).json({ error: 'message id missing' });
    try { await c.ctx.sendWithTimeout(chatId, { react: { text: String(emoji), key: rkey } }, {}); res.json({ success: true }); }
    catch (err) { res.json({ success: false, error: errMsg(err) }); }
  });
  app.post('/delete', async (req, res) => {
    const c = live(res); if (!c) return;
    const { messageId, chatId } = req.body || {};
    const chat = chatId || sentIndex.get(messageId);
    const id = messageId || sentLast.get(chatId);
    if (!chat || !id) return res.status(404).json({ error: 'no such sent message known (only messages sent since the last bridge restart can be deleted)' });
    try { await c.ctx.sendWithTimeout(chat, { delete: { remoteJid: chat, fromMe: true, id } }, {}); res.json({ success: true, chatId: chat, messageId: id }); }
    catch (err) { res.json({ success: false, error: errMsg(err) }); }
  });
  app.post('/backfill', async (req, res) => {
    const c = live(res); if (!c) return;
    const { chatId, messageId, participant, ts, count, fromMe } = req.body || {};
    if (!chatId || !messageId || !ts) return res.status(400).json({ error: 'chatId, messageId and ts are required' });
    try {
      const id = await c.sock.fetchMessageHistory(Math.min(Number(count) || 50, 50), { remoteJid: chatId, id: messageId, fromMe: !!fromMe, participant: participant || undefined }, Number(ts) * 1000);
      res.json({ success: true, requested: id });
    } catch (err) { res.json({ success: false, error: errMsg(err) }); }
  });
  app.post('/profile-status', async (req, res) => {
    const c = live(res); if (!c) return;
    const text = String((req.body || {}).text || '').trim();
    if (!text || text.length > 139) return res.status(400).json({ error: 'text required (max 139 chars)' });
    try { await c.sock.updateProfileStatus(text); res.json({ success: true }); } catch (err) { res.json({ success: false, error: errMsg(err) }); }
  });
  app.post('/profile-name', async (req, res) => {
    const c = live(res); if (!c) return;
    const name = String((req.body || {}).name || '').trim();
    if (!name || name.length > 25) return res.status(400).json({ error: 'name required (max 25 chars)' });
    try { await c.sock.updateProfileName(name); res.json({ success: true }); } catch (err) { res.json({ success: false, error: errMsg(err) }); }
  });
  app.post('/profile-picture', async (req, res) => {
    const c = live(res); if (!c) return;
    const fp = String((req.body || {}).path || '');
    let buf = null;
    try { if (/\.(jpe?g|png)$/i.test(fp)) buf = readFileSync(fp); } catch (e) { /* handled below */ }
    if (!buf) return res.status(400).json({ error: 'path must be an existing .jpg/.jpeg/.png file' });
    try { await c.sock.updateProfilePicture(c.ctx.jidNormalizedUser(c.sock.user.id), buf); res.json({ success: true }); }
    catch (err) { res.json({ success: false, error: errMsg(err) }); }
  });
}

export default {
  // extra makeWASocket options (spread last, so they win over the stock ones)
  socketOptions({ messageStore }) {
    return {
      cachedGroupMetadata: async (jid) => metaCache.get(jid)?.m,
      generateHighQualityLinkPreview: true, // needs the npm package link-preview-js; harmless without it
      // Read receipts only work on a socket that is marked online (#99834): follow the `mark_online` setting (default on).
      markOnlineOnConnect: settings().mark_online !== false,
      // On a retry request resend the real stored message; unknown ids resolve to nothing.
      getMessage: async (key) => {
        try { const m = messageStore.get(key?.id); if (m?.message) return m.message; } catch (e) { /* fall through */ }
        return undefined; // never fabricate an empty payload: retries would turn it into blank bubbles (#63649)
      },
    };
  },

  attach(sock, ctx) {
    current = { sock, ctx, origSend: null };
    wrapSend(sock, ctx);
    wrapQueue(ctx);
    addRoutes(ctx.app);

    // our listeners are registered before the bridge's own, so they see every message first
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      for (const msg of messages || []) {
        try {
          if (!msg.message) continue;
          learnName(msg);
          const chatId = msg.key.remoteJid;
          if (!chatId || String(chatId).endsWith('@broadcast') || String(chatId).endsWith('@newsletter')) continue;
          const isGroup = chatId.endsWith('@g.us');
          if (!isGroup) {
            const ci = ctx.getContextInfo(ctx.getMessageContent(msg));
            if (ci && ci.expiration !== undefined) ephemeral.set(chatId, Number(ci.expiration) || 0);
          }
          if (msg.key.fromMe) continue;
          const senderId = msg.key.participant || chatId;
          const owner = ctx.matchesAllowedUser(senderId, ctx.ALLOWED_USERS, ctx.SESSION_DIR);
          if (owner) {
            // the stock bridge handles allowed senders, but it drops shared contact cards as empty messages (#45644)
            const content = ctx.getMessageContent(msg);
            if (content?.contactMessage || content?.contactsArrayMessage) {
              const botIds = [...new Set([ctx.normalizeWhatsAppId(sock.user?.id), ctx.normalizeWhatsAppId(sock.user?.lid)].filter(Boolean))];
              const ev = await ctx.extractBridgeEvent({
                msg, chatId, senderId, senderNumber: senderId.replace(/@.*/, ''), botIds, isGroup,
                downloadMedia: async () => null, cacheDirs: { image: ctx.IMAGE_CACHE_DIR, document: ctx.DOCUMENT_CACHE_DIR, audio: ctx.AUDIO_CACHE_DIR },
              });
              ev.body = summarizeContacts(content) || ev.body;
              ev.fromOwner = false;
              if (ev.body) { ctx.messageStore.remember(msg); ctx.messageQueue.push(ev); }
            }
            continue;
          }
          if (isGroup) {
            const ctl = readJson('wa_group_control.json', {});
            const isCollab = ((ctl.collab_bots || []).map(digits).includes(digits(senderId)) && !(Number(ctl.bots_paused || 0) > Date.now() / 1000))
              || (ctl.limited_users || []).map(digits).includes(digits(senderId)); // trusted bots and people with partial access
            const dl = async (m) => ctx.downloadMediaMessage(m, 'buffer', {}, { logger: ctx.logger, reuploadRequest: sock.updateMediaMessage });
            if (isCollab) {
              // a trusted bot: pass a real event so the adapter can decide (mention check, chat-only turn, loop brake)
              const botIds = [...new Set([ctx.normalizeWhatsAppId(sock.user?.id), ctx.normalizeWhatsAppId(sock.user?.lid)].filter(Boolean))];
              const ev = await ctx.extractBridgeEvent({
                msg, chatId, senderId, senderNumber: senderId.replace(/@.*/, ''), botIds, isGroup: true,
                downloadMedia: dl, cacheDirs: { image: ctx.IMAGE_CACHE_DIR, document: ctx.DOCUMENT_CACHE_DIR, audio: ctx.AUDIO_CACHE_DIR },
              });
              ev.fromOwner = false; ev.collabBot = true;
              if (!ev.body) continue;
              ctx.messageStore.remember(msg);
              ctx.messageQueue.push(ev);
              continue;
            }
            // the stock bridge drops non-owner group messages; keep them as context + history (they never trigger Hermes)
            const text = textOf(msg.message) || (hasMedia(msg.message) ? '[media]' : '');
            if (!text) continue;
            ctx.messageStore.remember(msg);
            let mediaUrls = [], mediaTypes = [];
            try { // images of group members stay with the pending history so Hermes can see them when it is addressed (allowlisted groups only)
              const allowed = readJson('wa_allowed_groups.json', []);
              if (msg.message?.imageMessage && Array.isArray(allowed) && allowed.includes(chatId)) {
                const ev = await ctx.extractBridgeEvent({
                  msg, chatId, senderId, senderNumber: senderId.replace(/@.*/, ''), botIds: [], isGroup: true, downloadMedia: dl,
                  cacheDirs: { image: ctx.IMAGE_CACHE_DIR, document: ctx.DOCUMENT_CACHE_DIR, audio: ctx.AUDIO_CACHE_DIR },
                });
                mediaUrls = ev.mediaUrls || []; mediaTypes = ev.mediaTypes || [];
              }
            } catch (e) { console.error('whatsapp-plus context image:', e.message); }
            ctx.messageQueue.push({
              mediaUrls, mediaTypes, contextOnly: true, isGroup: true, chatId, chatName: '', senderId, senderName: names.get(digits(senderId)) || digits(senderId), body: text,
              messageId: msg.key.id, timestamp: Number(msg.messageTimestamp?.low ?? msg.messageTimestamp) || nowSec(), hasMedia: hasMedia(msg.message),
              mentionedIds: [], botIds: [], fromOwner: false,
            });
          } else if (ctx.matchesAllowedUser(senderId, tempContacts(), ctx.SESSION_DIR)) {
            // a person Hermes messaged recently (48h window): let their reply through like a normal DM
            const botIds = [...new Set([ctx.normalizeWhatsAppId(sock.user?.id), ctx.normalizeWhatsAppId(sock.user?.lid)].filter(Boolean))];
            const ev = await ctx.extractBridgeEvent({
              msg, chatId, senderId, senderNumber: senderId.replace(/@.*/, ''), botIds, isGroup: false,
              downloadMedia: async (m) => ctx.downloadMediaMessage(m, 'buffer', {}, { logger: ctx.logger, reuploadRequest: sock.updateMediaMessage }),
              cacheDirs: { image: ctx.IMAGE_CACHE_DIR, document: ctx.DOCUMENT_CACHE_DIR, audio: ctx.AUDIO_CACHE_DIR },
            });
            ev.fromOwner = false;
            if (!ev.body && !ev.hasMedia) continue;
            ctx.messageStore.remember(msg);
            ctx.messageQueue.push(ev);
          }
        } catch (e) { console.error('whatsapp-plus upsert:', e.message); }
      }
    });

    sock.ev.on('messages.update', (updates) => {
      try {
        for (const u of updates || []) {
          const k = u.key;
          if (!k) continue;
          if (k.fromMe) {
            const st = u.update?.status;
            const name = st === 4 ? 'read' : st === 5 ? 'played' : st === 3 ? 'delivered' : st === 2 ? 'sent' : null;
            if (name) setStatus(k.id, name);
            continue;
          }
          if (!String(k.remoteJid).endsWith('@g.us')) continue;
          const m = u.update?.message;
          const edited = m?.editedMessage?.message || m?.protocolMessage?.editedMessage;
          if (edited) {
            historyNote(k.remoteJid, k.participant, '[edited a message to: "' + (textOf(edited) || '...').slice(0, 300) + '"]');
          } else if (m?.protocolMessage?.type === 0 || u.update?.messageStubType === 1) {
            const orig = textOf(ctx.messageStore.get(k.id)?.message);
            historyNote(k.remoteJid, k.participant, '[deleted a message' + (orig ? ': "' + orig.slice(0, 200) + '"' : '') + ']');
          }
        }
      } catch (e) { /* ignore */ }
    });
    sock.ev.on('message-receipt.update', (updates) => {
      try {
        for (const u of updates || []) {
          if (!u?.key?.fromMe) continue;
          if (u.receipt?.readTimestamp) setStatus(u.key.id, 'read');
          else if (u.receipt?.receiptTimestamp) setStatus(u.key.id, 'delivered');
        }
      } catch (e) { /* ignore */ }
    });
    sock.ev.on('messages.reaction', (items) => {
      try {
        for (const it of items || []) {
          const r = it.reaction;
          if (!r || !r.text || r.key?.fromMe) continue;
          const reactor = r.key?.participant || r.key?.remoteJid;
          const bots = (readJson('wa_group_control.json', {}).bots || []).map(digits);
          if (bots.includes(digits(reactor))) continue; // other bots react constantly (status emojis): not worth logging
          const sig = digits(reactor) + '|' + r.text + '|' + it.key?.id;
          if (Date.now() - (recentReactions.get(sig) || 0) < 60000) continue;
          recentReactions.set(sig, Date.now());
          if (recentReactions.size > 500) recentReactions.delete(recentReactions.keys().next().value);
          const orig = textOf(ctx.messageStore.get(it.key?.id)?.message);
          historyNote(it.key?.remoteJid, r.key?.participant || r.key?.remoteJid, '[reacted ' + r.text + ' to: "' + (orig || 'an earlier message').slice(0, 120) + '"]');
        }
      } catch (e) { /* ignore */ }
    });
    sock.ev.on('messaging-history.set', ({ messages }) => {
      try {
        let n = 0;
        for (const m of messages || []) {
          const chat = m.key?.remoteJid;
          if (!chat || !chat.endsWith('@g.us') || !m.message) continue;
          learnName(m);
          const text = textOf(m.message) || (hasMedia(m.message) ? '[media]' : '');
          if (!text) continue;
          const who = m.key.fromMe ? 'hermes' : (m.key.participant || m.participant || '');
          ctx.messageQueue.push({
            historyOnly: true, isGroup: true, chatId: chat, chatName: '', senderId: who,
            senderName: m.key.fromMe ? 'Hermes' : (names.get(digits(who)) || m.pushName || digits(who)), body: text,
            messageId: m.key.id, timestamp: Number(m.messageTimestamp?.low ?? m.messageTimestamp) || 0, hasMedia: false,
            mentionedIds: [], botIds: [], fromOwner: false,
          });
          n++;
        }
        if (n) console.log('whatsapp-plus history sync: queued ' + n + ' group messages');
      } catch (e) { console.error('whatsapp-plus history set:', e.message); }
    });
    let refreshTimer = null;
    const refreshMembers = () => {  // debounced: someone joined/left or we were added to a group
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async () => { try { publishMembers(ctx, await sock.groupFetchAllParticipating()); } catch (e) { /* ignore */ } }, 3000);
    };
    sock.ev.on('groups.update', (ups) => { try { for (const u of ups || []) metaCache.delete(u.id); refreshMembers(); } catch (e) { /* ignore */ } });
    sock.ev.on('group-participants.update', (u) => { try { metaCache.delete(u?.id); refreshMembers(); } catch (e) { /* ignore */ } });
    sock.ev.on('groups.upsert', () => { try { refreshMembers(); } catch (e) { /* ignore */ } });
    setInterval(refreshMembers, 10 * 60 * 1000).unref?.();
    const CALL_NOTE = "[\u{1F4DE} The owner just called you on WhatsApp (missed: calls cannot be answered here). Call him back now: use the whatsapp_call_me tool with a short, friendly spoken greeting in his language (for example: 'Hi, I saw your call - what do you need?'). Then continue by voice: when he answers with a voice note, answer with another voice note via whatsapp_call_me.]";
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const HOME = process.env.HERMES_HOME || '/opt/data';
    // ask the local call daemon (callerd) to call the owner back with a live voice; false -> use the voice-note fallback
    const liveCallback = async (number) => {
      try {
        const key = readFileSync(HOME + '/voice-call/key', 'utf8').trim();
        const r = await fetch((process.env.CALLERD_URL || 'http://127.0.0.1:3100') + '/call', {
          method: 'POST', headers: { 'x-callerd-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({ to: number, mode: 'live', direction: 'back' }), signal: AbortSignal.timeout(25000),
        });
        return r.ok;
      } catch (e) { console.error('whatsapp-plus live call-back not possible:', e.message); return false; }
    };
    const calledBack = new Map();   // caller -> last time we turned a call into a message (a ringing call fires several events)
    const callUsers = () => {
      const set = (settings().call_users || []).map(digits).filter(Boolean);
      if (set.length) return set;
      const first = [...ctx.ALLOWED_USERS][0];
      return first ? [digits(first)] : [];
    };
    // ring the owner back (live voice if the call daemon can, else a message that makes Hermes send a voice note)
    const callBack = async (c, callerJid) => {
      if (Date.now() - (calledBack.get(callerJid) || 0) < Number(process.env.WA_CALL_THROTTLE_MS || 45000)) return;
      calledBack.set(callerJid, Date.now());
      await sleep(2500);                        // let the declined call settle before ringing back
      if (await liveCallback(digits(callerJid))) return;
      ctx.messageQueue.push({
        messageId: 'call-' + c.id, chatId: callerJid, isGroup: false, senderId: callerJid, senderNumber: digits(callerJid),
        senderName: names.get(digits(callerJid)) || digits(callerJid), body: CALL_NOTE, fromOwner: true, isCall: true,
        timestamp: nowSec(), mentionedIds: [], botIds: [], hasMedia: false,
      });
    };
    // is the call daemon (our second linked device) currently on a call it answered?
    const daemonAnswered = async () => {
      try {
        const key = readFileSync(HOME + '/voice-call/key', 'utf8').trim();
        const r = await fetch((process.env.CALLERD_URL || 'http://127.0.0.1:3100') + '/status', { headers: { 'x-callerd-key': key }, signal: AbortSignal.timeout(5000) });
        const st = await r.json();
        return !!(st.call && st.call.dir === 'in' && st.call.status === 'connected');
      } catch (e) { return false; }
    };
    sock.ev.on('call', async (calls) => {
      try {
        for (const c of calls || []) {
          if (c.status !== 'offer') continue;
          const callerJid = lidToPhoneJid(c.chatId && String(c.chatId).endsWith('@s.whatsapp.net') ? c.chatId : c.from, ctx.SESSION_DIR);
          const users = callUsers();
          const isUser = users.includes(digits(callerJid)) || users.includes(digits(c.from));
          if (isUser && settings().call_mode === 'answer') {
            // call_mode=answer: do NOT decline - the call daemon answers with the live voice. If it has not picked up in time, decline and ring back.
            void (async () => {
              await sleep(Number(process.env.WA_ANSWER_WAIT_MS || 10000));
              if (await daemonAnswered()) return;
              try { await sock.rejectCall(c.id, c.from); } catch (e) { /* already ended */ }
              await callBack(c, callerJid);
            })();
            continue;
          }
          await sock.rejectCall(c.id, c.from);
          if (isUser) { await callBack(c, callerJid); continue; }   // the owner: Hermes calls back
          const cr = settings().call_reply;
          if (cr === 'off') continue;
          if (Date.now() - (called.get(c.from) || 0) > 12 * 3600 * 1000) {
            called.set(c.from, Date.now());
            orig_text_send(sock, c.from, cr || "I'm Hermes, an automated assistant, so I can't take calls. Please send a text message instead.");
          }
        }
      } catch (e) { console.error('whatsapp-plus call handler:', e.message); }
    });
    // warm the group cache (subjects + member names) once connected
    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'open' || connection === 'close') {
        // structured connection log for debugging flapping (#64068)
        appendJsonl('wa_bridge_events.jsonl', { ts: new Date().toISOString(), event: connection, reason: lastDisconnect?.error?.output?.statusCode ?? null });
      }
      if (connection !== 'open') return;
      try {
        const all = await sock.groupFetchAllParticipating();
        for (const [jid, m] of Object.entries(all || {})) {
          metaCache.set(jid, { t: Date.now(), m });
          for (const p of m.participants || []) {
            const nm = p.name || p.notify;
            if (!nm) continue;
            for (const j of [p.id, p.lid, p.phoneNumber]) if (j && !names.has(digits(j))) names.set(digits(j), nm);
          }
        }
        publishMembers(ctx, all);
        console.log('whatsapp-plus: cached ' + Object.keys(all || {}).length + ' groups');
      } catch (e) { console.error('whatsapp-plus group warm-up:', e.message); }
    });
  },
};

// who is in which group (owner / limited users), so the adapter can allow groups the owner is in
function publishMembers(ctx, all) {
  try {
    const ctl = readJson('wa_group_control.json', {});
    const limited = new Set((ctl.limited_users || []).map(digits));
    const out = {};
    for (const [jid, m] of Object.entries(all || {})) {
      let owner = false, lim = false;
      for (const p of m.participants || []) {
        for (const j of [p.id, p.lid, p.phoneNumber]) {
          if (!j) continue;
          if (!owner && ctx.matchesAllowedUser(j, ctx.ALLOWED_USERS, ctx.SESSION_DIR)) owner = true;
          if (limited.has(digits(j))) lim = true;
        }
      }
      out[jid] = { name: m.subject || '', owner, limited: lim, size: (m.participants || []).length, ts: Date.now() / 1000 };
    }
    writeJson('wa_group_members.json', out);
  } catch (e) { console.error('whatsapp-plus members:', e.message); }
}

function orig_text_send(sock, jid, text) {
  current.origSend(jid, { text }, {}).catch(() => {});
}
