// Exercises the real api/chat.js handler (pickQuery + pickHistory + askPolicyRag
// + response shaping) with a 2-turn conversation, using mock req/res.
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });
const handler = (await import('../api/chat.js')).default;

function mockRes() {
  return {
    _status: 200, _json: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; return this; },
    end() { return this; },
  };
}
async function call(messages) {
  const req = { method: 'POST', headers: { 'content-type': 'application/json' }, body: { messages } };
  const res = mockRes();
  await handler(req, res);
  return res;
}

const clip = (s, n = 280) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// Turn 1
const r1 = await call([{ role: 'user', content: 'Mi az a wallbox?' }]);
console.log(`Turn 1  HTTP ${r1._status}`);
console.log(`  reply: ${clip(r1._json?.reply)}`);
console.log(`  sources: ${r1._json?.sources?.length ?? 0}`);

// Turn 2 — follow-up that depends on turn 1 ("ez" = wallbox)
const r2 = await call([
  { role: 'user', content: 'Mi az a wallbox?' },
  { role: 'assistant', content: r1._json?.reply || '' },
  { role: 'user', content: 'És ez mennyibe kerül körülbelül?' },
]);
console.log(`\nTurn 2 (follow-up)  HTTP ${r2._status}`);
console.log(`  reply: ${clip(r2._json?.reply)}`);
console.log(`  sources: ${r2._json?.sources?.length ?? 0}`);
