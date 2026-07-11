import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createBus } from '../src/server.js';

const TOKEN = 'a'.repeat(64);
const PORT = 47771;
let ctx;

async function listen() {
  // Generous burst so the shared per-token limiter doesn't 429 unrelated tests;
  // the dedicated rate-limit test spins its own low-burst bus below.
  ctx = createBus({ token: TOKEN, dbPath: ':memory:', config: { port: PORT, rateBurst: 1000 } });
  await new Promise((r) => ctx.server.listen(PORT, '127.0.0.1', r));
}

// undici (global fetch) forbids setting the Host header, so raw http for that case.
function rawGet(path, { host, token = TOKEN } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: PORT, path, method: 'GET', headers: { host, authorization: `Bearer ${token}` } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function call(method, path, { body, headers = {}, token = TOKEN, host = `127.0.0.1:${PORT}` } = {}) {
  const h = { host, ...headers };
  if (token !== null) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  return fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

before(listen);
after(() => new Promise((r) => ctx.server.close(r)));
// Fresh DB per test so rate-limit/idempotency state never bleeds across cases.
beforeEach(() => {
  // Also reset the AUTOINCREMENT sequence so each test's ids start at 1.
  ctx.db.exec("DELETE FROM messages; DELETE FROM idempotency; DELETE FROM sqlite_sequence WHERE name='messages';");
});

test('health requires a valid token', async () => {
  const bad = await call('GET', '/health', { token: 'wrong' });
  assert.equal(bad.status, 401);
  const ok = await call('GET', '/health');
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
});

test('missing token is rejected everywhere', async () => {
  const res = await call('GET', '/health', { token: null });
  assert.equal(res.status, 401);
});

test('bad Host header is rejected (DNS-rebinding guard)', async () => {
  assert.equal(await rawGet('/health', { host: 'evil.example.com' }), 421);
  assert.equal(await rawGet('/health', { host: `127.0.0.1:${PORT}` }), 200);
});

test('requests carrying an Origin are rejected (browser CSRF guard)', async () => {
  const res = await call('GET', '/health', { headers: { origin: 'https://evil.example.com' } });
  assert.equal(res.status, 403);
});

test('post then read round-trips', async () => {
  const p = await call('POST', '/post', { body: { thread: 't', author: 'a', body: 'hi' } });
  assert.equal(p.status, 201);
  const { id } = await p.json();
  assert.equal(id, 1);
  const r = await call('GET', '/messages?thread=t');
  const data = await r.json();
  assert.equal(data.messages.length, 1);
  assert.equal(data.messages[0].body, 'hi');
});

test('post validation: rejects missing fields and bad kind', async () => {
  assert.equal((await call('POST', '/post', { body: { author: 'a', body: 'x' } })).status, 400);
  assert.equal((await call('POST', '/post', { body: { thread: 't', body: 'x' } })).status, 400);
  assert.equal((await call('POST', '/post', { body: { thread: 't', author: 'a' } })).status, 400);
  const badKind = await call('POST', '/post', {
    body: { thread: 't', author: 'a', body: 'x', kind: 'shout' },
  });
  assert.equal(badKind.status, 400);
});

test('idempotency-key dedupes a retried post', async () => {
  const h = { 'idempotency-key': 'req-1' };
  const a = await call('POST', '/post', { body: { thread: 't', author: 'a', body: 'once' }, headers: h });
  const b = await call('POST', '/post', { body: { thread: 't', author: 'a', body: 'again' }, headers: h });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal((await a.json()).id, (await b.json()).id);
  const r = await call('GET', '/messages?thread=t');
  assert.equal((await r.json()).messages.length, 1);
});

test('rate limit returns 429 after burst, keyed on token', async () => {
  // Own bus with burst 5 (the shared suite bus uses 1000 to avoid interference).
  const RL_PORT = 47772;
  const rl = createBus({ token: TOKEN, dbPath: ':memory:', config: { port: RL_PORT, rateBurst: 5 } });
  await new Promise((r) => rl.server.listen(RL_PORT, '127.0.0.1', r));
  try {
    let last;
    for (let i = 0; i < 6; i++) {
      last = await fetch(`http://127.0.0.1:${RL_PORT}/post`, {
        method: 'POST',
        headers: { host: `127.0.0.1:${RL_PORT}`, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ thread: 't', author: 'a', body: `m${i}` }),
      });
    }
    assert.equal(last.status, 429);
    assert.equal((await last.json()).error, 'rate_limited');
  } finally {
    await new Promise((r) => rl.server.close(r));
  }
});

test('consecutive-post warning is advisory, not a block', async () => {
  const a = await call('POST', '/post', { body: { thread: 't', author: 'a', body: '1' } });
  const b = await call('POST', '/post', { body: { thread: 't', author: 'a', body: '2' } });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201); // NOT blocked
  assert.equal((await b.json()).warning, 'consecutive');
});

test('since is exclusive over HTTP', async () => {
  for (const m of ['1', '2', '3'])
    await call('POST', '/post', { body: { thread: 't', author: 'a', body: m } });
  const r = await call('GET', '/messages?thread=t&since=1');
  const ids = (await r.json()).messages.map((m) => m.id);
  assert.deepEqual(ids, [2, 3]);
});

test('limit is capped at messagesLimit and flags truncation', async () => {
  for (let i = 0; i < 4; i++)
    await call('POST', '/post', { body: { thread: 't', author: 'a', body: `m${i}` } });
  const r = await call('GET', '/messages?thread=t&limit=2');
  const data = await r.json();
  assert.equal(data.messages.length, 2);
  assert.equal(data.truncated, true);
  assert.equal(data.oldest_unread, 2);
});

test('threads lists activity', async () => {
  await call('POST', '/post', { body: { thread: 'x', author: 'a', body: '1' } });
  await call('POST', '/post', { body: { thread: 'y', author: 'a', body: '1' } });
  const r = await call('GET', '/threads');
  const threads = (await r.json()).threads;
  assert.equal(threads.length, 2);
});

test('unknown route 404s', async () => {
  assert.equal((await call('GET', '/nope')).status, 404);
});
