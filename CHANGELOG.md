# Changelog

## Unreleased
### Added
- Errand calls: `whatsapp_call_contact` (preview, then confirmed call) makes Hermes phone a third party for the owner with a locked-down, disclosed, recorded voice, then sends the result, transcript and recording to the chat.
- MemPalace support on calls: a `search_memory` voice tool backed by a read-only MemPalace helper (about 2 s per recall question), used before falling back to `ask_hermes`.
- Non-blocking, parallel `ask_hermes` on calls: several things in one sentence run at the same time and each answer is spoken the moment it is ready (Gemini `NON_BLOCKING` tools); a second concurrent request uses its own side session so the two do not overwrite the chat session.
- Voice calls: `whatsapp_call_me` tool, `call_mode` setting (`answer` / `callback`), and the `voice-call/` daemon (live Gemini voice,
  shared chat session, `ask_hermes`, post-call summary, transcripts with smoothness metrics).
- Gemini Live session resumption (calls survive the ~10 minute connection limit).
- Goodbye-aware hang-up, silence hang-up and call length cap.
- `wait_reply` on `whatsapp_send`; contact replies are wrapped as untrusted and given to the next turn as inbox context.
- Link-preview dependency is reinstalled automatically if missing.

- Errand-call guardrails: a chat message the moment a call starts, refusal of emergency / premium / toll-free numbers and of the bot's own number, a 5-minute cooldown per number, and a warning in the report if the AI + recording disclosure was not detected in the transcript.
- `ERRAND_CODE=off` option: the owner's clear yes after the preview replaces the one-time code (the preview of exactly that call is still required first).

### Changed
- Errand voice introduces itself once and does not repeat the disclosure after a language switch; the report summary retries and falls back to a lighter Gemini model on 503.

### Fixed
- Incoming calls: `user_pn` is removed from every call message so the engine no longer adds a duplicate participant when WhatsApp sends `group_update` (this caused "reconnecting" and `INIT_MEDIA_STREAM_FAILED`). Group *offers* are still refused by the engine (status 70008); joining a group call is not solved.
- Hanging up from our side now ends the call properly (the library never announced the end, which left calls stuck as "connected").
- The live voice answers the owner number only; untrusted-reply markers can no longer be faked with brackets; the call log file is private (0600).
- Answering incoming calls on LID accounts (engine ID form, Accept NACK 439, silent audio, early "remote end" event).
- Phone-number matching compares digits, so the country code is optional.

## 2.0.0 - initial public release
