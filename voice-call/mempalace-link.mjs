// Fast, read-only access to Hermes's MemPalace memory for the live voice: a long-lived Python helper (mempalace_server.py)
// kept warm between questions, so a recall question takes a second or two instead of a full Hermes turn.
import { spawn } from 'node:child_process';
import path from 'node:path';

export function createMemory({ here, home, python, log }) {
  let child = null, buf = '', startPromise = null, nextId = 1;
  const pending = new Map();
  const failAll = (why) => { for (const [, p] of pending) p({ ok: false, text: why }); pending.clear(); };

  function start() {
    if (startPromise) return startPromise;
    startPromise = new Promise((resolve) => {
      let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        child = spawn(python, [path.join(here, 'mempalace_server.py')], { cwd: here, env: { ...process.env, HOME: home, HERMES_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) { log('memory helper could not start:', e.message); child = null; startPromise = null; return finish(false); }
      child.stdout.on('data', (d) => {
        buf += d.toString(); let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (j.ready) { finish(true); continue; }
          const p = pending.get(j.id); if (p) { pending.delete(j.id); p(j); }
        }
      });
      child.stderr.on('data', () => {});
      child.on('error', (e) => { log('memory helper error:', e.message); });
      child.on('exit', (code) => { log('memory helper exited', code); child = null; startPromise = null; buf = ''; failAll('memory search stopped'); finish(false); });
      setTimeout(() => finish(false), 30000);
    });
    return startPromise;
  }

  /** {op:'search', query, limit} or {op:'kg', entity} -> { ok, text, ms } (never throws) */
  async function query(req, timeoutMs = 9000) {
    if (!(await start()) || !child) return { ok: false, text: 'memory search is not available right now' };
    const id = nextId++;
    return new Promise((resolve) => {
      const t = setTimeout(() => { pending.delete(id); resolve({ ok: false, text: 'memory search took too long' }); }, timeoutMs);
      pending.set(id, (r) => { clearTimeout(t); resolve(r); });
      try { child.stdin.write(JSON.stringify({ id, ...req }) + '\n'); } catch { pending.delete(id); clearTimeout(t); resolve({ ok: false, text: 'memory search is not available right now' }); }
    });
  }
  const stop = () => { try { child?.kill('SIGTERM'); } catch {} };
  return { warm: () => { void start(); }, query, stop };
}
