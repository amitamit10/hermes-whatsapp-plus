# Changelog

## Unreleased
### Added
- Non-blocking, parallel `ask_hermes` on calls: several things in one sentence run at the same time and each answer is spoken the moment it is ready (Gemini `NON_BLOCKING` tools); a second concurrent request uses its own side session so the two do not overwrite the chat session.
- Voice calls: `whatsapp_call_me` tool, `call_mode` setting (`answer` / `callback`), and the `voice-call/` daemon (live Gemini voice,
  shared chat session, `ask_hermes`, post-call summary, transcripts with smoothness metrics).
- Gemini Live session resumption (calls survive the ~10 minute connection limit).
- Goodbye-aware hang-up, silence hang-up and call length cap.
- `wait_reply` on `whatsapp_send`; contact replies are wrapped as untrusted and given to the next turn as inbox context.
- Link-preview dependency is reinstalled automatically if missing.

### Fixed
- Hanging up from our side now ends the call properly (the library never announced the end, which left calls stuck as "connected").
- The live voice answers the owner number only; untrusted-reply markers can no longer be faked with brackets; the call log file is private (0600).
- Answering incoming calls on LID accounts (engine ID form, Accept NACK 439, silent audio, early "remote end" event).
- Phone-number matching compares digits, so the country code is optional.

## 2.0.0 - initial public release
