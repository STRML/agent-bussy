import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, insertMessage, readMessages, listThreads, isConsecutive, tokenId } from '../src/db.js';

function freshDb() {
  return openDb(':memory:');
}

function post(db, over = {}) {
  return insertMessage(db, {
    thread: 't1',
    author: 'claude-aaaa',
    kind: 'say',
    body: 'hello',
    tokenId: 'tok-abc',
    ...over,
  });
}

test('insert returns a monotonic id', () => {
  const db = freshDb();
  const a = post(db);
  const b = post(db);
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);
  assert.equal(b.duplicate, false);
});

test('kind CHECK constraint rejects unknown kinds', () => {
  const db = freshDb();
  assert.throws(() => post(db, { kind: 'bogus' }), /CHECK constraint/);
});

test('idempotency: same (token, key) returns original id, no duplicate row', () => {
  const db = freshDb();
  const first = post(db, { idemKey: 'k1', body: 'once' });
  const retry = post(db, { idemKey: 'k1', body: 'DIFFERENT body ignored' });
  assert.equal(retry.id, first.id);
  assert.equal(retry.duplicate, true);
  const all = readMessages(db, { thread: 't1', limit: 50 });
  assert.equal(all.messages.length, 1);
  assert.equal(all.messages[0].body, 'once');
});

test('idempotency is scoped per token: same key, different token = distinct rows', () => {
  const db = freshDb();
  const a = post(db, { idemKey: 'k1', tokenId: 'tok-abc' });
  const b = post(db, { idemKey: 'k1', tokenId: 'tok-xyz' });
  assert.notEqual(a.id, b.id);
});

test('readMessages: since is exclusive (id > since)', () => {
  const db = freshDb();
  post(db); // id 1
  post(db); // id 2
  post(db); // id 3
  const r = readMessages(db, { thread: 't1', since: 1, limit: 50 });
  assert.deepEqual(r.messages.map((m) => m.id), [2, 3]);
});

test('readMessages: empty thread and first-message boundary', () => {
  const db = freshDb();
  assert.deepEqual(readMessages(db, { thread: 'empty', since: 0, limit: 50 }).messages, []);
  post(db); // id 1
  const r = readMessages(db, { thread: 't1', since: 0, limit: 50 });
  assert.deepEqual(r.messages.map((m) => m.id), [1]);
});

test('readMessages: truncation flags oldest_unread at the limit boundary', () => {
  const db = freshDb();
  for (let i = 0; i < 5; i++) post(db, { body: `m${i}` });
  const r = readMessages(db, { thread: 't1', since: 0, limit: 3 });
  assert.equal(r.messages.length, 3);
  assert.equal(r.truncated, true);
  assert.equal(r.oldest_unread, 3); // last id in the returned page
  // exactly-at-limit does NOT truncate
  const exact = readMessages(db, { thread: 't1', since: 0, limit: 5 });
  assert.equal(exact.truncated, false);
  assert.equal(exact.oldest_unread, null);
});

test('listThreads: most-recently-active first', () => {
  const db = freshDb();
  post(db, { thread: 'a' });
  post(db, { thread: 'b' });
  post(db, { thread: 'a' });
  const threads = listThreads(db);
  assert.equal(threads[0].thread, 'a'); // highest last_id
  assert.equal(threads.find((t) => t.thread === 'a').message_count, 2);
});

test('isConsecutive: true only when same token holds the last row', () => {
  const db = freshDb();
  post(db, { tokenId: 'tok-abc' });
  assert.equal(isConsecutive(db, { thread: 't1', tokenId: 'tok-abc' }), true);
  post(db, { tokenId: 'tok-xyz' });
  assert.equal(isConsecutive(db, { thread: 't1', tokenId: 'tok-abc' }), false);
  assert.equal(isConsecutive(db, { thread: 'never', tokenId: 'tok-abc' }), false);
});

test('reply_to persists', () => {
  const db = freshDb();
  const a = post(db);
  post(db, { reply_to: a.id, body: 're' });
  const r = readMessages(db, { thread: 't1', since: 0, limit: 50 });
  assert.equal(r.messages[1].reply_to, a.id);
});

test('tokenId truncates to 12 chars', () => {
  assert.equal(tokenId('0123456789abcdef0000'), '0123456789ab');
});
