#!/usr/bin/env python3
"""Nightly backup of the whatsapp-plus plugin, its state files and config.yaml (not .env, not the WhatsApp session credentials).
Keeps the last 14 archives in /opt/data/backups. Silent when it works; prints a line (-> Telegram) when it fails."""
import glob, os, sys, tarfile, time

HOME = os.environ.get("HERMES_HOME", "/opt/data")
OUT = HOME + "/backups"
KEEP = 14
try:
    os.makedirs(OUT, mode=0o700, exist_ok=True)
    name = "%s/whatsapp-plus-%s.tgz" % (OUT, time.strftime("%Y%m%d"))
    skip = ("/state/wa_seen_ids.json", "/.tmp")
    def keep(ti):
        return None if any(s in ti.name for s in skip) or ti.name.endswith(".tmp") else ti
    with tarfile.open(name + ".part", "w:gz") as tf:
        for rel in ("plugins/whatsapp-plus", "state", "config.yaml"):
            p = os.path.join(HOME, rel)
            if os.path.exists(p):
                tf.add(p, arcname=rel, filter=keep)
    os.chmod(name + ".part", 0o600)
    os.replace(name + ".part", name)
    for old in sorted(glob.glob(OUT + "/whatsapp-plus-*.tgz"))[:-KEEP]:
        os.remove(old)
    if os.path.getsize(name) < 1000:
        print("whatsapp-plus backup looks empty: %s" % name)
except Exception as exc:
    print("whatsapp-plus backup FAILED: %s" % exc)
    sys.exit(1)
