# hermes-whatsapp-plus

A native plugin for [Hermes Agent](https://github.com/NousResearch/hermes-agent) that makes its WhatsApp platform much better in
**group chats** and adds a set of `whatsapp_*` agent tools. It is a plugin, not a fork: it subclasses the stock WhatsApp adapter,
re-registers the platform through the plugin API, and generates its bridge from the *current* stock bridge plus two small hook
insertions (so Hermes updates flow in on the next start). If the hook anchors ever change upstream, it falls back to the stock
bridge and raises an alert instead of breaking.

Developed against Hermes `0.21.1` and kept compatible with `main` as of October 2026 (the stock WhatsApp platform is a lazily loaded plugin there, so this plugin reads its registration without querying the registry) (Baileys 7.0.0-rc13 bridge), running natively under systemd. Use at your own risk -
this automates a personal WhatsApp account, which WhatsApp can restrict if abused. The built-in limits exist for that reason.

## Highlights

- **OpenClaw-style group history**: every group message is stored; when the agent is addressed it sees only what it has not seen yet
  (once, with markers, a member roster, images, voice-note transcripts), so `@bot what do you think?` works. Searchable for a year.
- **Trust tiers**: owner (full), *limited* people (chat + read-only tools; may ask the bot to message a phone number), *collab bots*
  (another AI assistant, rate-limited with a consecutive-reply cap), temporary contacts (people the bot messaged, 48 h), strangers (ignored
  or DM-paired). Enforced by native hooks (`pre_tool_call`) and the adapter-verified `role_authorized` flag.
- **Group access**: groups the owner is in are allowed automatically but *restricted* (chat-only) until approved from a private chat,
  or the owner and a limited user are both members.
- **Loop protection** for bot-to-bot chats: loop brake, auto-mute, `[NO_REPLY]` silence, bot pause.
- **Outside contacts**: replies are marked untrusted and forwarded to the owner; the owner's session is told about them once.
- **Tools** (`whatsapp_*`): send, contacts, history, group_control, status, delete, backfill, settings, react, groups, poll, pairing,
  campaign (ask the same thing to up to 10 shops and compare replies).
- Bridge extras: @mentions by name, reactions while working, read receipts, calls (decline or call back; with the optional `voice-call/` daemon the bot answers and talks), link previews, LID->phone mapping,
  de-duplication, voice-note fixes, history sync hooks, send/status/delete/profile routes.
- Safety: sensitive files are never sent, links need confirmation, 30 sends/hour and 10 new numbers/day, random gaps in campaigns.

## Voice calls (experimental)

The `whatsapp_call_me` tool and an optional daemon in [`voice-call/`](voice-call/) let the bot answer your WhatsApp calls (or call you) with
a live Gemini voice that shares your chat session. See [`voice-call/README.md`](voice-call/README.md).

## Install

1. Hermes with WhatsApp working (`hermes whatsapp`, paired session).
2. Copy `whatsapp-plus/` to `$HERMES_HOME/plugins/whatsapp-plus/` (the folder must contain `bridge/bridge-ext.mjs`).
3. In `config.yaml`:
   ```yaml
   plugins:
     enabled: [whatsapp-platform, whatsapp-plus]
   platforms:
     whatsapp:
       extra:
         bridge_script: /path/to/HERMES_HOME/plugins/whatsapp-plus/bridge/bridge.js   # generated at startup
   ```
4. Restart the gateway. Check `curl 127.0.0.1:3000/health` -> `connected`.
5. Optional: `scripts/whatsapp_plus_backup.py` as a no-agent cron job for nightly backups.

State lives in `$HERMES_HOME/state/` (`wa_group_history.db`, `wa_group_control.json`, `wa_settings.json`, ...).
Trust lists (`limited_users`, `collab_bots`, `bots`, `approved_groups`) are in `wa_group_control.json`; the owner is whoever is in
`WHATSAPP_ALLOWED_USERS`.

## Tests

`tests/t_plus.py` (adapter/tools; run inside the Hermes venv with the plugin installed) and `tests/t_ext.mjs` (bridge extension with a
fake Baileys socket; `node tests/t_ext.mjs`). Run the Python tests with `PYTHONPATH=<hermes source dir>`. Identifiers in the tests are synthetic; both paths and the group id in the Hermes config
must match what the tests expect (see the top of each file).

## Notes

- Defaults assume the Israeli number format in `wa_send.py` (`0501234567` -> `972...`) and `TZ` for history times.
- Not affiliated with Nous Research or WhatsApp.

License: MIT.
