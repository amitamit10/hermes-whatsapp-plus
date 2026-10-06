import { EventEmitter } from 'events';
import { createRequire } from 'module';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
process.env.HERMES_HOME = '/tmp/hx';
mkdirSync('/tmp/hx/state', { recursive: true });
const require = createRequire('/opt/data/plugins/whatsapp-plus/bridge/');
const express = require('express');
const ext = (await import('/opt/data/plugins/whatsapp-plus/bridge/bridge-ext.mjs')).default;

const digits = (j) => String(j || '').split('@')[0].split(':')[0];
const sent = [];
const presences = [];
const G = '120363000000000001@g.us';
const sock = {
  ev: new EventEmitter(),
  user: { id: '66800000099:2@s.whatsapp.net', lid: '100000000000004:2@lid' },
  sendMessage: async (jid, content, opts) => { sent.push({ jid, content, opts }); return { key: { id: 'ID' + sent.length, remoteJid: jid, fromMe: true } }; },
  onWhatsApp: async (jid) => [{ exists: jid.startsWith('972501') }],
  groupMetadata: async () => ({ subject: 'Test Group', ephemeralDuration: 0, participants: [{ id: '100000000000001@lid' }, { id: '100000000000003@lid' }] }),
  groupFetchAllParticipating: async () => ({ [G]: { subject: 'Test Group', participants: [{ id: '100000000000001@lid', name: 'Dana Example' }, { id: '123@lid', phoneNumber: '972500000001@s.whatsapp.net' }] }, '120363444@g.us': { subject: 'Other', participants: [{ id: '999@lid' }] } }),
  rejectCall: async (id, from) => { sent.push({ rejected: id, from }); },
  updateProfileStatus: async (t) => { sent.push({ about: t }); },
  sendPresenceUpdate: async (state, jid) => { presences.push({ state, jid }); },
};
const app = express(); app.use(express.json());
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const port = server.address().port;
const queue = [];
const store = new Map(); const messageStore = { get: (id) => store.get(id), remember: (m) => store.set(m.key.id, m) };
const ctx = {
  app, messageQueue: queue, messageStore, ALLOWED_USERS: new Set(['972500000001']),
  matchesAllowedUser: (id, set) => set.has(digits(id)), SESSION_DIR: '/tmp/hx',
  jidNormalizedUser: (j) => (j ? j.replace(/:\d+@/, '@') : ''), normalizeWhatsAppId: (j) => (j ? String(j).replace(':', '@') : ''),
  getMessageContent: (m) => m.message, getContextInfo: () => ({}),
  extractBridgeEvent: async ({ msg, chatId, senderId }) => ({ chatId, senderId, body: msg.message.conversation, hasMedia: false, isGroup: false, botIds: [] }),
  downloadMediaMessage: async () => null, IMAGE_CACHE_DIR: '/tmp', DOCUMENT_CACHE_DIR: '/tmp', AUDIO_CACHE_DIR: '/tmp', logger: {},
  sendWithTimeout: (jid, c, o) => sock.sendMessage(jid, c, o), getConnectionState: () => 'connected', getSock: () => sock,
};
const opts = ext.socketOptions({ messageStore });
const results = [];
const ok = (name, cond) => results.push([name, !!cond]);
ext.attach(sock, ctx);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const http = async (method, path, body) => {
  const r = await fetch('http://127.0.0.1:' + port + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
};

// socket options
ok('socketOptions has cache + previews + getMessage', typeof opts.cachedGroupMetadata === 'function' && opts.generateHighQualityLinkPreview === true && typeof opts.getMessage === 'function');
messageStore.remember({ key: { id: 'STORED' }, message: { conversation: 'real text' } });
ok('getMessage returns the stored message', (await opts.getMessage({ id: 'STORED' })).conversation === 'real text');
ok('getMessage returns nothing for unknown ids (no blank bubbles)', (await opts.getMessage({ id: 'NONE' })) === undefined);
ok('markOnlineOnConnect defaults on (read receipts)', opts.markOnlineOnConnect === true);

// guards
let e1, e2; try { await sock.sendMessage('66800000099@s.whatsapp.net', { text: 'x' }); } catch (e) { e1 = e.message; }
ok('refuses the bot itself', e1 && e1.includes("bot's own"));
try { await sock.sendMessage('100000000000004@s.whatsapp.net', { text: 'x' }); } catch (e) { e2 = e.message; }
ok('refuses the bot LID-as-phone', e2 && e2.includes("bot's own"));
let e3; try { await sock.sendMessage('972509999999@s.whatsapp.net', { text: 'x' }); } catch (e) { e3 = e.message; }
ok('refuses a number not on WhatsApp', e3 && e3.includes('not on WhatsApp'));
await sock.sendMessage('972501112222@s.whatsapp.net', { text: 'hello store' });
ok('allows a real number', sent.at(-1).jid === '972501112222@s.whatsapp.net');

// names + mentions
sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: G, participant: '100000000000001@lid', id: 'U1', fromMe: false }, pushName: 'Dana Example', message: { conversation: 'מי בא מחר?' }, messageTimestamp: 1791000000 }] });
await tick();
const ctxEv = queue.find((q) => q.contextOnly);
ok('non-owner group message becomes a contextOnly event with name', ctxEv && ctxEv.senderName === 'Dana Example' && ctxEv.body === 'מי בא מחר?');
// images of members in allowlisted groups ride along with the pending history; other groups are not downloaded
const origExtract = ctx.extractBridgeEvent; let extracted = 0;
ctx.extractBridgeEvent = async (a) => { extracted++; return { ...(await origExtract(a)), mediaUrls: ['/tmp/hx/pic.jpg'], mediaTypes: ['image/jpeg'], body: '' }; };
writeFileSync('/tmp/hx/state/wa_allowed_groups.json', JSON.stringify([G]));
queue.length = 0;
sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: G, participant: '100000000000001@lid', id: 'IMG1', fromMe: false }, pushName: 'Dana Example', message: { imageMessage: { caption: 'look' } }, messageTimestamp: 1791000001 }] });
await tick(60);
const imgEv = queue.find((q) => q.messageId === 'IMG1');
ok('allowlisted group image: contextOnly event carries the downloaded path', imgEv && imgEv.contextOnly && imgEv.mediaUrls[0] === '/tmp/hx/pic.jpg' && extracted === 1);
queue.length = 0; writeFileSync('/tmp/hx/state/wa_allowed_groups.json', JSON.stringify([]));
sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: G, participant: '100000000000001@lid', id: 'IMG2', fromMe: false }, pushName: 'Dana Example', message: { imageMessage: {} }, messageTimestamp: 1791000002 }] });
await tick(60);
ok('group not on the allowlist: image is not downloaded', extracted === 1 && queue.find((q) => q.messageId === 'IMG2')?.mediaUrls?.length === 0);
ctx.extractBridgeEvent = origExtract;
queue.length = 0; sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: G, participant: '100000000000001@lid', id: 'U1', fromMe: false }, pushName: 'Dana Example', message: { conversation: 'מי בא מחר?' }, messageTimestamp: 1791000000 }] });
await sock.sendMessage(G, { text: 'היי @Dana Example תודה' });
const gs = sent.at(-1);
ok('@Name -> real mention', gs.content.text.includes('@100000000000001') && !gs.content.text.includes('@Dana') && gs.content.mentions && gs.content.mentions.includes('100000000000001@lid'));

// queue wrapper
queue.length = 0;
ctx.messageQueue.push({ senderId: '100000000000001@lid', isGroup: true, chatId: G, body: 'hi @100000000000001 and @100000000000004', botIds: ['66800000099@s.whatsapp.net'] });
const qe = queue[0];
ok('inbound: sender name + group name', qe.senderName === 'Dana Example' && qe.chatName === 'Test Group');
ok('inbound: @id -> @Name but bot id kept', qe.body === 'hi @Dana Example and @100000000000004');
ok('inbound: device-less bot ids added', qe.botIds.includes('100000000000004@lid') && qe.botIds.includes('66800000099@s.whatsapp.net'));

// loop brake (4 sends already counted: 1 group send so far)
let blocked = 0; let brakeMsg = '';
for (let i = 0; i < 8; i++) { try { await sock.sendMessage(G, { text: 'm' + i }); } catch (e) { blocked++; brakeMsg = e.message; } }
ok('loop brake blocks after 6 sends', blocked >= 2 && brakeMsg.includes('muted'));
const ctl = JSON.parse(readFileSync('/tmp/hx/state/wa_group_control.json', 'utf8'));
ok('brake wrote a mute entry', ctl.mute && ctl.mute[G] > Date.now() / 1000);
await tick();
ok('owner got a notice', sent.some((s) => s.jid === '972500000001@s.whatsapp.net' && String(s.content?.text).includes('Loop brake')));
writeFileSync('/tmp/hx/state/wa_group_control.json', JSON.stringify({}));
await sock.sendMessage(G, { text: 'after unmute' });
ok('unmute works', sent.at(-1).content.text === 'after unmute');

// routes
const idLast = 'ID' + (sent.length);
sock.ev.emit('message-receipt.update', [{ key: { id: idLast, fromMe: true }, receipt: { readTimestamp: 1 } }]);
ok('status route shows read', (await http('GET', '/status/' + idLast)).json.status === 'read');
ok('status unknown id', (await http('GET', '/status/NOPE')).json.status === 'unknown');
const del = await http('POST', '/delete', { chatId: G });
ok('delete retracts the last message', del.json.success && sent.at(-1).content.delete && sent.at(-1).content.delete.fromMe === true);
ok('delete unknown -> 404', (await http('POST', '/delete', { messageId: 'NOPE' })).status === 404);
ok('react route', (await http('POST', '/react', { chatId: G, key: { id: 'X' }, emoji: '👀' })).json.success && sent.at(-1).content.react.text === '👀');
ok('backfill validates', (await http('POST', '/backfill', {})).status === 400);
ok('about route', (await http('POST', '/profile-status', { text: 'hello' })).json.success);

// temp contacts + strangers
queue.length = 0;
writeFileSync('/tmp/hx/state/wa_temp_contacts.json', JSON.stringify({ '972501112222': { exp: Date.now() / 1000 + 3600, sent: 'x' } }));
sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '972501112222@s.whatsapp.net', id: 'D1', fromMe: false }, message: { conversation: 'כן פתוח' } }] });
sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '972509999999@s.whatsapp.net', id: 'D2', fromMe: false }, message: { conversation: 'spam' } }] });
sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '972500000001@s.whatsapp.net', id: 'D3', fromMe: false }, message: { conversation: 'owner dm' } }] });
await tick(60);
ok('temp-contact DM pushed, stranger and owner left to the bridge', queue.length === 1 && queue[0].body === 'כן פתוח');

// notes: reaction + calls
queue.length = 0;
store.set('T1', { key: { id: 'T1' }, message: { conversation: 'original text' } });
sock.ev.emit('messages.reaction', [{ reaction: { text: '👍', key: { participant: '100000000000001@lid', fromMe: false } }, key: { id: 'T1', remoteJid: G } }]);
await tick(60);
ok('reaction note', queue.some((q) => q.historyOnly && q.body.includes('reacted 👍') && q.body.includes('original text')));
sock.ev.emit('messages.reaction', [{ reaction: { text: '✅', key: { fromMe: true } }, key: { id: 'T1', remoteJid: G } }]);
await tick(30);
ok('own reactions are not logged', queue.filter((q) => q.body && q.body.includes('✅')).length === 0);
const before = sent.length;
sock.ev.emit('call', [{ id: 'C1', from: '972501112222@s.whatsapp.net', status: 'offer' }]);
await tick(60);
sock.ev.emit('call', [{ id: 'C2', from: '972501112222@s.whatsapp.net', status: 'offer' }]);
await tick(60);
const callMsgs = sent.slice(before);
ok('calls rejected, one polite text only', callMsgs.filter((s) => s.rejected).length === 2 && callMsgs.filter((s) => s.content?.text?.includes("can't take calls")).length === 1);

writeFileSync('/tmp/hx/state/wa_group_control.json', JSON.stringify({ bots: ['100000000000002@lid'] }));
queue.length = 0;
sock.ev.emit('messages.reaction', [{ reaction: { text: '⚡', key: { participant: '100000000000002@lid', fromMe: false } }, key: { id: 'T1', remoteJid: G } }]);
sock.ev.emit('messages.reaction', [{ reaction: { text: '🔥', key: { participant: '100000000000001@lid', fromMe: false } }, key: { id: 'T1', remoteJid: G } }]);
sock.ev.emit('messages.reaction', [{ reaction: { text: '🔥', key: { participant: '100000000000001@lid', fromMe: false } }, key: { id: 'T1', remoteJid: G } }]);
await tick(80);
ok('bot reactions skipped, human reaction logged once', queue.filter((q) => q.body && q.body.includes('⚡')).length === 0 && queue.filter((q) => q.body && q.body.includes('🔥')).length === 1);
// collab bot: real event while active, contextOnly while paused
queue.length = 0;
writeFileSync('/tmp/hx/state/wa_group_control.json', JSON.stringify({ collab_bots: ['100000000000002@lid'] }));
const botMsg = (id, text) => ({ type: 'notify', messages: [{ key: { remoteJid: G, participant: '100000000000002@lid', id, fromMe: false }, pushName: 'HelperBot', message: { conversation: text } }] });
sock.ev.emit('messages.upsert', botMsg('B1', 'הרמס @100000000000004 שאלה'));
await tick(60);
ok('collab bot message becomes a normal event flagged collabBot', queue.length === 1 && queue[0].collabBot === true && !queue[0].contextOnly && queue[0].body.includes('שאלה'));
queue.length = 0;
writeFileSync('/tmp/hx/state/wa_group_control.json', JSON.stringify({ collab_bots: ['100000000000002@lid'], bots_paused: Date.now() / 1000 + 600 }));
sock.ev.emit('messages.upsert', botMsg('B2', 'עוד שאלה'));
await tick(60);
ok('paused: the same bot is context only', queue.length === 1 && queue[0].contextOnly === true && !queue[0].collabBot);
// react by message id (ported from PR #128496)
store.set('CACHED1', { key: { id: 'CACHED1', remoteJid: G, participant: '100000000000001@lid', fromMe: false }, message: { conversation: 'x' } });
let rr = await http('POST', '/react', { chatId: G, messageId: 'CACHED1', emoji: '👍' });
ok('react by cached message id uses the original key', rr.json.success && sent.at(-1).content.react.key.participant === '100000000000001@lid' && sent.at(-1).content.react.key.fromMe === false);
ok('react with empty emoji removes', (await http('POST', '/react', { chatId: G, messageId: 'CACHED1', emoji: '' })).json.success && sent.at(-1).content.react.text === '');
ok('react: other chat is refused', (await http('POST', '/react', { chatId: '120363999999@g.us', messageId: 'CACHED1', emoji: '👍' })).status === 400);
ok('react: uncached group message needs senderId', (await http('POST', '/react', { chatId: G, messageId: 'UNKNOWN9', emoji: '👍' })).status === 400);
rr = await http('POST', '/react', { chatId: G, messageId: 'UNKNOWN9', emoji: '🔥', senderId: '100000000000003@lid' });
ok('react: uncached with senderId builds the key', rr.json.success && sent.at(-1).content.react.key.participant === '100000000000003@lid');
// ---- upstream PR ports ----
queue.length = 0;
const evA = () => ({ messageId: 'DUP1', senderId: '972500000001@s.whatsapp.net', isGroup: false, chatId: '972500000001@s.whatsapp.net', body: 'hi', botIds: [] });
ctx.messageQueue.push(evA()); ctx.messageQueue.push(evA());
ok('re-delivered inbound message is forwarded once (#95934)', queue.filter((q) => q.messageId === 'DUP1').length === 1);
ctx.messageQueue.push({ contextOnly: true, messageId: 'DUP2', isGroup: true, chatId: G, senderId: 'x@lid', body: 'a', botIds: [] });
ctx.messageQueue.push({ contextOnly: true, messageId: 'DUP2', isGroup: true, chatId: G, senderId: 'x@lid', body: 'a', botIds: [] });
ok('context-only events are not deduped', queue.filter((q) => q.messageId === 'DUP2').length === 2);
ctx.messageQueue.push({ messageId: 'V1', senderId: 'a@lid', isGroup: false, chatId: 'a@lid', mediaType: 'audio', mime: 'audio/ogg; codecs=opus', fileName: '', body: '[audio received]', botIds: [] });
ctx.messageQueue.push({ messageId: 'V2', senderId: 'a@lid', isGroup: false, chatId: 'a@lid', mediaType: 'audio', mime: 'audio/ogg; codecs=opus', fileName: 'song.ogg', body: '[audio received]', botIds: [] });
const v1 = queue.find((q) => q.messageId === 'V1'), v2 = queue.find((q) => q.messageId === 'V2');
ok('unflagged opus audio becomes a voice note (#102385)', v1.mediaType === 'ptt' && v1.body === '[ptt received]');
ok('a named audio file stays audio', v2.mediaType === 'audio');
store.set('QM1', { key: { id: 'QM1' }, message: { conversation: 'the original text' } });
ctx.messageQueue.push({ messageId: 'R1', senderId: 'a@lid', isGroup: false, chatId: 'a@lid', body: 'yes', quotedMessageId: 'QM1', quotedText: '', hasQuotedMessage: false, botIds: [] });
const r1 = queue.find((q) => q.messageId === 'R1');
ok('reply text recovered from the store (#76075)', r1.quotedText === 'the original text' && r1.hasQuotedMessage === true);
writeFileSync('/tmp/hx/lid-mapping-111222_reverse.json', JSON.stringify('972501112222'));
await sock.sendMessage('111222@lid', { text: 'hello via lid' });
ok('LID target is mapped to the phone chat (#55612)', sent.at(-1).jid === '972501112222@s.whatsapp.net');
sent.length = 0;
await sock.sendMessage('972501112222@s.whatsapp.net', { text: 'typing test' });
await tick(30);
ok('typing indicator cleared after a send (#46343)', presences.some((p) => p.state === 'paused' && p.jid === '972501112222@s.whatsapp.net'));
const gr = await fetch('http://127.0.0.1:' + port + '/groups');
const grj = await gr.json();
ok('/groups lists the bot groups (#124173)', Array.isArray(grj) && grj.some((g) => g.id === G && g.name === 'Test Group'));
ok('Express banner is hidden (#96994)', gr.headers.get('x-powered-by') === null);
queue.length = 0;
sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '972500000001@s.whatsapp.net', id: 'CARD1', fromMe: false }, pushName: 'Owner',
  message: { contactMessage: { displayName: 'Dan Plumber', vcard: 'BEGIN:VCARD\nFN:Dan Plumber\nTEL;type=CELL;waid=972501234567:+972 50-123-4567\nEND:VCARD' } } }] });
await tick(80);
ok('shared contact card reaches the agent as text (#45644)', queue.length === 1 && queue[0].body.includes('Dan Plumber') && queue[0].body.includes('+972501234567'));
await sock.sendMessage('972501112222@s.whatsapp.net', { document: Buffer.from('x'), fileName: 'report.csv', mimetype: 'application/octet-stream' });
ok('text documents keep their type (#114408)', sent.at(-1).content.mimetype === 'text/csv');
// group membership is published for the adapter (owner present? limited user present?)
writeFileSync('/tmp/hx/state/wa_group_control.json', JSON.stringify({ limited_users: ['100000000000001@lid'] }));
sock.ev.emit('connection.update', { connection: 'open' });
await tick(120);
const mem = JSON.parse(readFileSync('/tmp/hx/state/wa_group_members.json', 'utf8'));
ok('group members published: owner + limited detected, other group has neither', mem[G]?.owner === true && mem[G]?.limited === true && mem['120363444@g.us']?.owner === false && mem['120363444@g.us']?.limited === false);
for (const [n, c] of results) console.log((c ? 'PASS' : 'FAIL') + '  ' + n);
console.log(results.every((r) => r[1]) ? 'RESULT: ALL PASSED' : 'RESULT: SOME FAILED');
server.close(); process.exit(0);
