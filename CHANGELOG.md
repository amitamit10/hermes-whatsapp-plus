# Changelog

## Unreleased
### Added
- Voice calls: `whatsapp_call_me` tool, `call_mode` setting (`answer` / `callback`), and the `voice-call/` daemon (live Gemini voice,
  shared chat session, `ask_hermes`, post-call summary, transcripts with smoothness metrics).
- Gemini Live session resumption (calls survive the ~10 minute connection limit).
- Goodbye-aware hang-up, silence hang-up and call length cap.
- `wait_reply` on `whatsapp_send`; contact replies are wrapped as untrusted and given to the next turn as inbox context.
- Link-preview dependency is reinstalled automatically if missing.

### Fixed
- Answering incoming calls on LID accounts (engine ID form, Accept NACK 439, silent audio, early "remote end" event).
- Phone-number matching compares digits, so the country code is optional.

## 2.0.0 - initial public release
