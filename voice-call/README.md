# Hermes WhatsApp voice calls (experimental)

A small daemon (`callerd`) that gives Hermes a **live voice on WhatsApp calls**: you call the bot's number and it answers, or it calls
you back (or the agent calls you with the `whatsapp_call_me` tool). The voice is Gemini Live (speech to speech, Hebrew works);
whenever it needs a real action it calls `ask_hermes`, which runs a turn inside **your own WhatsApp chat session**, so the call and
the chat share one conversation, and a summary is posted to the chat afterwards.

> **Unofficial and fragile.** It uses a patched copy of [baileys-caller](https://github.com/SheIITear/baileys-caller) (MIT; WhatsApp
> Web's VoIP engine in WASM) as a *second linked device* on the bot's number. WhatsApp can change this at any time and automated use
> may violate its terms. Use a number you can afford to lose, never your personal one.

## How it fits together

```
phone --WhatsApp call--> bot number --> callerd (linked device "callerd")
                                            |  16 kHz audio both ways
                                            v
                                       Gemini Live  --ask_hermes--> Hermes API server (/v1/chat/completions, same session id)
```

- `callerd.mjs` - HTTP API on 127.0.0.1:3100 (`/status`, `/pair`, `/call`, `/hangup`; header `x-callerd-key`), call lifecycle,
  transcripts with smoothness metrics, owner-only answering.
- `live.mjs` - Gemini Live (and an OpenAI Realtime back-end, only tested against a fake server) behind one interface. Gemini sessions
  are resumed transparently when the ~10 minute connection limit (`goAway`) hits or the socket drops.
- `hermes-link.mjs` - talks to the Hermes API server, builds the voice persona (SOUL.md, your chat style, profile, recent chat),
  bounded `ask_hermes` (late answers are spoken, or posted to the chat if you hung up), post-call summary.
- `wa_session_info.py` - read-only helper that finds the owner's session, recent messages, model and persona files.
- `patched-baileys-caller/` - the changed files of baileys-caller (see below). The WASM assets come from the upstream package.
- `hermes-voice-call.service` - systemd unit (localhost only, runs as the hermes user).

## Settings

`call_mode` in `state/wa_settings.json`: `answer` (the bot picks up when you call; falls back to calling you back if that fails) or
`callback` (the bridge declines and calls you back). Voice settings are in `live.env` (see `live.env.example`, chmod 600).

## What had to be patched in baileys-caller (why this is not just `npm i`)

1. WhatsApp version via `fetchLatestBaileysVersion`, the standard Ubuntu/Chrome device name (custom names break pairing codes), and
   pairing-code login.
2. Live audio in and out (`pushAudio`, barge-in `clearAudio`).
3. **Incoming calls** (the library was outbound only). The engine needs the call presented in the right ID form:
   - LID accounts: give the engine the caller as `<lid>:0@lid` in both the offer's `call-creator` and the peer id. This makes it run
     the call as a LID call (`is_lid: 1`); other forms give "mismatched peer id and creator id", an Accept NACK (error 439) or
     "unknown ssrc" (silent call).
   - Feed later stanzas (transport, receipts, acks) with the same peer form, and route outgoing replies to the real peer.
   - The engine event `2` fires right after an offer and is not a hang-up while the call is still ringing.
4. Clearing the active call when it ends, so the next call can start.

## Setup sketch

1. Install Node 20+, copy this folder to `/opt/data/voice-call`, put the upstream `baileys-caller` package in
   `./baileys-caller` (with its `assets/`), overlay `patched-baileys-caller/dist/*`, `npm install ws@8` and Baileys.
2. Create `live.env` and a random `key` file (the HTTP API key), install the systemd unit.
3. Pair the daemon as a linked device of the bot number: stop the service, delete `auth/`, start it, `POST /pair` with the number,
   enter the pairing code in WhatsApp > Linked devices. (A half-finished `auth/` breaks the next pairing, so always wipe it.)
4. Set `call_mode` and call the bot.

`t_resume.mjs` tests the Gemini session resume against a fake server (`node t_resume.mjs`).
