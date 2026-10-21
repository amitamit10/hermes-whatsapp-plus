// Live voice back-ends for the WhatsApp call daemon: Gemini Live and OpenAI Realtime behind one interface.
//   const s = new GeminiLive({ apiKey, model, instructions, tools });  await s.connect();
//   s.sendAudio(float32 16 kHz mono)      s.sendText('...')      s.sendToolResult(id, name, result)      s.close()
//   events: 'audio' (Float32 16 kHz mono, ready for the call), 'interrupted', 'transcript' (role, text), 'toolCall' (calls[]),
//           'turnComplete', 'closed' (reason), 'error'
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

// ---------------------------------------------------------------- audio helpers
export const f32ToPcm16 = (f32) => {
  const out = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    out.writeInt16LE(v < 0 ? Math.round(v * 32768) : Math.round(v * 32767), i * 2);
  }
  return out;
};
export const pcm16ToF32 = (buf) => {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
};
/** Streaming linear resampler (keeps its position between chunks so there are no clicks at chunk borders). */
export class Resampler {
  constructor(fromRate, toRate) { this.step = fromRate / toRate; this.pos = 0; }
  process(input) {
    if (!input.length) return new Float32Array(0);
    const out = [];
    while (this.pos < input.length) {
      const i = Math.floor(this.pos), frac = this.pos - i;
      const a = input[i];
      const b = i + 1 < input.length ? input[i + 1] : a; // the next sample arrives with the next chunk
      out.push(a + (b - a) * frac);
      this.pos += this.step;
    }
    this.pos -= input.length;
    return Float32Array.from(out);
  }
}

class LiveBase extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts; this.ws = null; this.ready = false; this.closed = false;
    this.fromModel = null; // Resampler(model output rate -> 16000)
  }
  _open(url, wsOpts = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, wsOpts);
      this.ws = ws;
      const t = setTimeout(() => { reject(new Error('live: connect timeout')); try { ws.terminate(); } catch {} }, this.opts.connectTimeoutMs || 15000);
      this._resolveReady = () => { clearTimeout(t); this.ready = true; resolve(); };
      ws.on('error', (e) => { clearTimeout(t); if (ws !== this.ws) return; if (!this.ready) reject(e); else this.emit('error', e); });
      ws.on('close', (code, reason) => { clearTimeout(t); if (ws !== this.ws) return; if (!this.ready) reject(new Error('live: closed before ready (' + code + ' ' + String(reason || '').slice(0, 160) + ')')); this._socketClosed('ws ' + code); });
      ws.on('open', () => this._onOpen());
      ws.on('message', (data) => { try { this._onMessage(JSON.parse(data.toString())); } catch (e) { this.emit('error', e); } });
    });
  }
  _socketClosed(reason) { this._closed(reason); }
  _closed(reason) { if (this.closed) return; this.closed = true; this.ready = false; this.emit('closed', reason); }
  _send(obj) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }
  close() { if (this.closed) return; this.closed = true; this.ready = false; clearTimeout(this.goAwayTimer); try { this.ws?.close(); } catch {} this.emit('closed', 'local'); }
}

// ---------------------------------------------------------------- Gemini Live
export class GeminiLive extends LiveBase {
  constructor(opts) { super(opts); this.fromModel = new Resampler(24000, 16000); this.resumeHandle = null; this.reconnecting = false; this.goAwayTimer = null; this.pendingTurnover = false; }
  static async pickModel(apiKey, preferred) {
    if (preferred) return preferred;
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + encodeURIComponent(apiKey));
    if (!r.ok) throw new Error('gemini: model list failed (' + r.status + ')');
    const live = ((await r.json()).models || []).filter((m) => (m.supportedGenerationMethods || []).includes('bidiGenerateContent'));
    if (!live.length) throw new Error('gemini: this key has no Live-capable models');
    const best = live.find((m) => /native-audio/.test(m.name)) || live.find((m) => /live/.test(m.name)) || live[0];
    return best.name.replace(/^models\//, '');
  }
  async connect() {
    const model = await GeminiLive.pickModel(this.opts.apiKey, this.opts.model);
    this.model = model;
    this.url = this.opts.endpoint || 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=' + encodeURIComponent(this.opts.apiKey);
    await this._open(this.url);
  }
  // Connections last about ten minutes (goAway). Reconnect with the latest resumption handle so the conversation carries on.
  _socketClosed(reason) { if (this.resumeHandle && !this.closed) this._turnover('socket ' + reason); else this._closed(reason); }
  async _turnover(why) {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true; this.pendingTurnover = false; clearTimeout(this.goAwayTimer);
    const old = this.ws; this.ready = false;
    for (let i = 0; i < 3 && !this.closed; i++) {
      try { await this._open(this.url); this.reconnecting = false; try { old?.close(); } catch {} this.emit('resumed', why); return; }
      catch (e) { this.emit('error', new Error('live: resume attempt ' + (i + 1) + ' failed: ' + (e?.message || e))); await new Promise((r) => setTimeout(r, 400 * (i + 1))); }
    }
    this.reconnecting = false; try { old?.close(); } catch {} this._closed('could not resume');
  }
  _onOpen() {
    const gen = { responseModalities: ['AUDIO'] };
    if (this.opts.voice) gen.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.opts.voice } } };
    this._send({ setup: {
      model: 'models/' + this.model,
      generationConfig: gen,
      systemInstruction: { parts: [{ text: this.opts.instructions || '' }] },
      tools: this.opts.tools?.length ? [{ functionDeclarations: this.opts.tools }] : undefined,
      realtimeInputConfig: {
        automaticActivityDetection: { startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH', endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH', prefixPaddingMs: 100, silenceDurationMs: this.opts.silenceMs || 600 },
        activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
      },
      inputAudioTranscription: this.opts.inputLanguages ? { languageCodes: this.opts.inputLanguages } : {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
    } });
  }
  _onMessage(m) {
    if (m.setupComplete !== undefined) return this._resolveReady();
    const sc = m.serverContent;
    if (sc) {
      for (const p of sc.modelTurn?.parts || []) {
        const d = p.inlineData;
        if (d?.data && /audio\/pcm/.test(d.mimeType || 'audio/pcm')) {
          const rate = Number((/rate=(\d+)/.exec(d.mimeType || '') || [])[1] || 24000);
          if (!this._rate || this._rate !== rate) { this._rate = rate; this.fromModel = new Resampler(rate, 16000); }
          this.emit('audio', this.fromModel.process(pcm16ToF32(Buffer.from(d.data, 'base64'))));
        }
      }
      if (sc.interrupted) { this.fromModel = new Resampler(this._rate || 24000, 16000); this.emit('interrupted'); }
      if (sc.inputTranscription?.text) this.emit('transcript', 'user', sc.inputTranscription.text);
      if (sc.outputTranscription?.text) this.emit('transcript', 'assistant', sc.outputTranscription.text);
      if (sc.turnComplete) { this.emit('turnComplete'); if (this.pendingTurnover) this._turnover('goAway'); }
    }
    const up = m.sessionResumptionUpdate;
    if (up?.resumable && up.newHandle) this.resumeHandle = up.newHandle;
    if (m.toolCall?.functionCalls?.length) this.emit('toolCall', m.toolCall.functionCalls.map((c) => ({ id: c.id, name: c.name, args: c.args || {} })));
    if (m.goAway) {
      this.emit('closing', m.goAway.timeLeft);
      if (this.resumeHandle) { // let the current answer finish, but never wait past the time the server gave us
        this.pendingTurnover = true; clearTimeout(this.goAwayTimer);
        const left = parseFloat(String(m.goAway.timeLeft || '5').replace('s', '')) || 5;
        this.goAwayTimer = setTimeout(() => this._turnover('goAway'), Math.max(500, (left - 3) * 1000));
      }
    }
  }
  sendAudio(f32) { this._send({ realtimeInput: { audio: { data: f32ToPcm16(f32).toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }); }
  sendText(text) { this._send({ realtimeInput: { text } }); }
  sendToolResult(id, name, result, scheduling) { this._send({ toolResponse: { functionResponses: [{ id, name, response: { result }, ...(scheduling ? { scheduling } : {}) }] } }); }
}

// ---------------------------------------------------------------- OpenAI Realtime
export class OpenAIRealtime extends LiveBase {
  constructor(opts) { super(opts); this.fromModel = new Resampler(24000, 16000); this.toModel = new Resampler(16000, 24000); this.args = new Map(); }
  async connect() {
    const model = this.opts.model || 'gpt-realtime';
    this.model = model;
    const url = this.opts.endpoint || 'wss://api.openai.com/v1/realtime?model=' + encodeURIComponent(model);
    await this._open(url, { headers: { Authorization: 'Bearer ' + this.opts.apiKey } });
  }
  _onOpen() { /* the session is configured when the server says session.created */ }
  _configure() {
    this._send({ type: 'session.update', session: {
      type: 'realtime',
      instructions: this.opts.instructions || '',
      output_modalities: ['audio'],
      audio: {
        input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'gpt-4o-mini-transcribe' },
                 turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 200, silence_duration_ms: this.opts.silenceMs || 500, create_response: true, interrupt_response: true } },
        output: { format: { type: 'audio/pcm', rate: 24000 }, ...(this.opts.voice ? { voice: this.opts.voice } : {}) },
      },
      tools: (this.opts.tools || []).map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })),
      tool_choice: 'auto',
    } });
  }
  _onMessage(m) {
    switch (m.type) {
      case 'session.created': this._configure(); break;
      case 'session.updated': if (!this.ready) this._resolveReady(); break;
      case 'response.output_audio.delta': case 'response.audio.delta':
        this.emit('audio', this.fromModel.process(pcm16ToF32(Buffer.from(m.delta, 'base64')))); break;
      case 'input_audio_buffer.speech_started': this.fromModel = new Resampler(24000, 16000); this.emit('interrupted'); break;
      case 'conversation.item.input_audio_transcription.completed': if (m.transcript) this.emit('transcript', 'user', m.transcript); break;
      case 'response.output_audio_transcript.done': case 'response.audio_transcript.done': if (m.transcript) this.emit('transcript', 'assistant', m.transcript); break;
      case 'response.done': {
        const calls = (m.response?.output || []).filter((o) => o.type === 'function_call').map((o) => { let a = {}; try { a = JSON.parse(o.arguments || '{}'); } catch {} return { id: o.call_id, name: o.name, args: a }; });
        if (calls.length) this.emit('toolCall', calls);
        this.emit('turnComplete');
        break;
      }
      case 'error': this.emit('error', new Error(m.error?.message || 'openai realtime error')); break;
      default: break;
    }
  }
  sendAudio(f32) { this._send({ type: 'input_audio_buffer.append', audio: f32ToPcm16(this.toModel.process(f32)).toString('base64') }); }
  sendText(text) {
    this._send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    this._send({ type: 'response.create' });
  }
  sendToolResult(id, name, result, _scheduling) {
    this._send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: id, output: typeof result === 'string' ? result : JSON.stringify(result) } });
    this._send({ type: 'response.create' });
  }
}

export const makeLive = (provider, opts) => (provider === 'openai' ? new OpenAIRealtime(opts) : new GeminiLive(opts));
