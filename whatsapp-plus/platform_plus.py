"""Registers the WhatsApp platform with the Plus adapter and generates the extended bridge: the stock platform entry is re-registered (registry: last writer wins)
with an adapter factory that returns the subclass. Everything else about the entry (config hooks, setup, standalone sender,
limits...) is copied from the stock entry, so Hermes keeps treating WhatsApp exactly like the native platform."""
import dataclasses
import hashlib
import logging
import os
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

HERE = Path(__file__).resolve().parent
BRIDGE_DIR = HERE / "bridge"
_BRIDGE_CORE = ("bridge.js", "bridge_helpers.js", "allowlist.js", "owner_message_gate.js", "outbound_ids.js")


A0 = "  sock = makeWASocket({\n"
A1 = "    },\n  });\n\n  sock.ev.on('creds.update', () => { saveCreds(); lidToPhone = buildLidMap(); });\n"
LOAD = (
    "  const waPlus = await (async () => {\n"
    "    try { return (await import(new URL('./bridge-ext.mjs', import.meta.url).href)).default; }\n"
    "    catch (e) { console.error('whatsapp-plus bridge extension not loaded:', e.message); return null; }\n"
    "  })();\n"
)
A1_NEW = (
    "    },\n"
    "    ...(waPlus ? waPlus.socketOptions({ messageStore }) : {}),\n"
    "  });\n\n"
    "  try {\n"
    "    if (waPlus) waPlus.attach(sock, { app, messageQueue, messageStore, sendWithTimeout, ALLOWED_USERS, matchesAllowedUser, SESSION_DIR,\n"
    "      jidNormalizedUser, normalizeWhatsAppId, getMessageContent, extractBridgeEvent, downloadMediaMessage,\n"
    "      getContextInfo: (c) => { if (!c || typeof c !== 'object') return {}; for (const v of Object.values(c)) { if (v && typeof v === 'object' && v.contextInfo) return v.contextInfo; } return {}; },\n"
    "      IMAGE_CACHE_DIR, DOCUMENT_CACHE_DIR, AUDIO_CACHE_DIR, logger, getConnectionState: () => connectionState, getSock: () => sock });\n"
    "  } catch (e) { console.error('whatsapp-plus attach failed:', e.message); }\n\n"
    "  sock.ev.on('creds.update', () => { saveCreds(); lidToPhone = buildLidMap(); });\n"
)


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()[:12]


def _alert(msg: str) -> None:
    try:
        logger.warning(msg)
        state = Path(os.environ.get("HERMES_HOME", "/opt/data")) / "state" / "whatsapp_plus_alert.txt"
        state.parent.mkdir(parents=True, exist_ok=True)
        if not state.exists() or state.read_text() != msg:
            state.write_text(msg)
    except Exception:
        pass


def ensure_bridge(stock_dir: Path) -> bool:
    """Build plugin/bridge/bridge.js = the CURRENT stock bridge + two small hook insertions that load bridge-ext.mjs (all the
    features). Other bridge files are symlinks to the stock ones, so a Hermes update flows in on the next start. If the hook
    spots are not found (upstream refactored them) the stock bridge is used as-is and an alert is raised. Returns True if hooked."""
    stock_js = (stock_dir / "bridge.js").read_text()
    ext = BRIDGE_DIR / "bridge-ext.mjs"
    hooked = stock_js.count(A0) == 1 and stock_js.count(A1) == 1 and ext.exists()
    if hooked:
        out = stock_js.replace(A0, LOAD + A0, 1).replace(A1, A1_NEW, 1)
        out += "\n// whatsapp-plus: generated from the stock bridge (sha %s) + bridge-ext.mjs (sha %s) - do not edit\n" % (_sha(stock_js.encode()), _sha(ext.read_bytes()))
    else:
        out = stock_js + "\n// whatsapp-plus: hook points not found - plain copy of the stock bridge\n"
        _alert("whatsapp-plus: the hook points in Hermes' stock WhatsApp bridge changed, so the plugin is running the STOCK bridge without its extras "
               "(names, tags, reactions, loop brake, receipts, history extras). Ask Claude to update the two hooks in platform_plus.py.")
    BRIDGE_DIR.mkdir(parents=True, exist_ok=True)
    target = BRIDGE_DIR / "bridge.js"
    if not target.exists() or target.read_text() != out:
        tmp = BRIDGE_DIR / ".bridge.js.tmp"
        tmp.write_text(out)
        os.replace(tmp, target)
    keep = {"bridge.js", "bridge-ext.mjs"}
    for p in stock_dir.iterdir():
        n = p.name
        if n in keep or n.startswith(".") or ".test." in n or ".bak" in n:
            continue
        if not (n.endswith((".js", ".mjs")) or n in ("package.json", "package-lock.json", "node_modules")):
            continue
        link = BRIDGE_DIR / n
        if link.is_symlink() and os.readlink(link) == str(p):
            continue
        if link.is_dir() and not link.is_symlink():
            continue  # a real directory (e.g. node_modules installed by hand or by the launcher): leave it alone
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(p)
    if hooked:
        try:
            (Path(os.environ.get("HERMES_HOME", "/opt/data")) / "state" / "whatsapp_plus_alert.txt").unlink()
        except OSError:
            pass
    return hooked


def _stock_registration():
    """The stock WhatsApp platform's own register() arguments, captured WITHOUT asking the platform registry.

    In current Hermes the stock platform is a lazily loaded plugin: a registry lookup from inside our own load
    (a deadline worker that the discovery lock is waiting on) blocks on that lazy loader until the load deadline
    kills this plugin. Running the stock register() against a recording context gives the same arguments."""
    import importlib
    stock_module = importlib.import_module("plugins.platforms.whatsapp.adapter")
    captured = {}

    class _Recorder:
        def register_platform(self, **kw):
            captured.update(kw)

        def __getattr__(self, _name):
            return lambda *a, **k: None

    stock_module.register(_Recorder())
    return stock_module, captured


def register_platform_plus(ctx) -> None:
    try:
        stock_module, kw = _stock_registration()
    except Exception as exc:
        logger.warning("whatsapp-plus: could not read the stock WhatsApp registration (%s); leaving WhatsApp alone", exc)
        return
    kw.pop("adapter_factory", None)
    from .adapter_plus import build_plus_class
    plus_cls = build_plus_class(stock_module.WhatsAppAdapter)

    def factory(config):
        return plus_cls(config)

    ctx.register_platform(adapter_factory=factory, **kw)
    try:  # the paired session holds full account access: owner-only (#80137)
        home = Path(os.environ.get("HERMES_HOME", "/opt/data"))
        for target, mode in ((home / "whatsapp" / "session", 0o700), (home / "whatsapp" / "bridge.log", 0o600)):
            if target.exists():
                target.chmod(mode)
    except Exception as exc:
        logger.debug("whatsapp-plus: could not tighten permissions: %s", exc)
    try:
        stock_dir = Path(stock_module.__file__).resolve().parents[3] / "scripts" / "whatsapp-bridge"
        ensure_bridge(stock_dir)
    except Exception as exc:  # never break WhatsApp because of the extras
        logger.error("whatsapp-plus: could not build the extended bridge (%s)", exc)
    logger.info("whatsapp-plus: WhatsApp platform now uses %s (bridge: %s)", plus_cls.__name__, BRIDGE_DIR / "bridge.js")
