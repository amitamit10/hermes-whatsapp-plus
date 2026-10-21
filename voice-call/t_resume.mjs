import { WebSocketServer } from 'ws';
import { GeminiLive } from './live.mjs';
const wss = new WebSocketServer({ port: 18931 });
const setups = []; let conns = 0;
wss.on('connection', (ws) => {
  const n = ++conns;
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.setup) {
      setups.push(m.setup);
      ws.send(JSON.stringify({ setupComplete: {} }));
      if (n === 1) {
        setTimeout(() => ws.send(JSON.stringify({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } })), 50);
        setTimeout(() => ws.send(JSON.stringify({ goAway: { timeLeft: '8s' } })), 150);
        setTimeout(() => ws.send(JSON.stringify({ serverContent: { turnComplete: true } })), 300);
      }
    }
  });
});
let ok = 0, fail = 0; const check = (n, c) => { (c ? ok++ : fail++); console.log(c ? 'PASS' : 'FAIL', n); };
const live = new GeminiLive({ apiKey: 'x', model: 'm', endpoint: 'ws://127.0.0.1:18931', instructions: 'hi' });
let resumed = 0, closed = null; live.on('resumed', () => resumed++); live.on('closed', (r) => (closed = r));
await live.connect();
await new Promise((r) => setTimeout(r, 1200));
check('reconnected after goAway + turn end', conns === 2 && resumed === 1);
check('first setup has empty resumption', JSON.stringify(setups[0]?.sessionResumption) === '{}');
check('second setup carries the handle', setups[1]?.sessionResumption?.handle === 'h1');
check('sliding window compression on', !!setups[0]?.contextWindowCompression?.slidingWindow);
check('not closed', closed === null && live.ready);
// unexpected socket drop with a handle -> resumes again
wss.clients.forEach((c) => c.terminate());
await new Promise((r) => setTimeout(r, 1000));
check('resumed after a dropped socket', conns === 3 && closed === null && live.ready);
live.close(); await new Promise((r) => setTimeout(r, 100));
check('local close reported', closed === 'local');
console.log(ok + ' passed, ' + fail + ' failed'); wss.close(); process.exit(fail ? 1 : 0);
