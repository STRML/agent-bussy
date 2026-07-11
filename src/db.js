import Database from 'better-sqlite3';

export const KINDS = ['say', 'ask', 'decision'];

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS messages (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  thread   TEXT NOT NULL,
  author   TEXT NOT NULL,
  kind     TEXT NOT NULL DEFAULT 'say' CHECK (kind IN ('say','ask','decision')),
  reply_to INTEGER REFERENCES messages(id),
  body     TEXT NOT NULL,
  meta     TEXT,
  token_id TEXT NOT NULL,
  ts       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread, id);
CREATE INDEX IF NOT EXISTS idx_messages_token_ts  ON messages(token_id, ts);

CREATE TABLE IF NOT EXISTS idempotency (
  token_id TEXT NOT NULL,
  key      TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  PRIMARY KEY (token_id, key)
);
`;

// Open (or create) the message store. ':memory:' is honored for tests.
export function openDb(path) {
  const db = new Database(path);
  db.exec(SCHEMA);
  return db;
}

// Short id for a token: the first 12 hex chars. Non-spoofable poster identity
// for rate-limiting and audit, without persisting the full secret in every row.
export function tokenId(token) {
  return token.slice(0, 12);
}

// Insert a message. Idempotent when idemKey is supplied: a repeat (tokenId, key)
// returns the original row's id instead of inserting a duplicate (spec §1).
export function insertMessage(db, { thread, author, kind, reply_to, body, meta, tokenId: tid, idemKey }) {
  const insert = db.prepare(
    `INSERT INTO messages (thread, author, kind, reply_to, body, meta, token_id)
     VALUES (@thread, @author, @kind, @reply_to, @body, @meta, @tokenId)`
  );
  const recordIdem = db.prepare(
    `INSERT INTO idempotency (token_id, key, message_id) VALUES (?, ?, ?)`
  );
  const findIdem = db.prepare(
    `SELECT message_id FROM idempotency WHERE token_id = ? AND key = ?`
  );

  const txn = db.transaction(() => {
    if (idemKey) {
      const prior = findIdem.get(tid, idemKey);
      if (prior) return { id: prior.message_id, duplicate: true };
    }
    const info = insert.run({
      thread,
      author,
      kind: kind || 'say',
      reply_to: reply_to ?? null,
      body,
      meta: meta ?? null,
      tokenId: tid,
    });
    const id = Number(info.lastInsertRowid);
    if (idemKey) recordIdem.run(tid, idemKey, id);
    return { id, duplicate: false };
  });
  return txn();
}

// Stateless read: everything in a thread after `since` (exclusive), id-ordered.
// Fetches limit+1 to detect truncation without a second COUNT query.
export function readMessages(db, { thread, since = 0, limit }) {
  const rows = db
    .prepare(
      `SELECT id, thread, author, kind, reply_to, body, meta, ts
       FROM messages WHERE thread = ? AND id > ? ORDER BY id LIMIT ?`
    )
    .all(thread, since, limit + 1);
  const truncated = rows.length > limit;
  const messages = truncated ? rows.slice(0, limit) : rows;
  return {
    messages,
    truncated,
    oldest_unread: truncated ? messages[messages.length - 1].id : null,
  };
}

// Active threads: last message id + count, most-recently-active first.
export function listThreads(db, { activeWithinMs } = {}) {
  if (activeWithinMs) {
    const cutoff = new Date(Date.now() - activeWithinMs).toISOString();
    return db
      .prepare(
        `SELECT thread, MAX(id) AS last_id, COUNT(*) AS message_count
         FROM messages GROUP BY thread HAVING MAX(ts) >= ? ORDER BY last_id DESC`
      )
      .all(cutoff);
  }
  return db
    .prepare(
      `SELECT thread, MAX(id) AS last_id, COUNT(*) AS message_count
       FROM messages GROUP BY thread ORDER BY last_id DESC`
    )
    .all();
}

// Was this token's immediately-previous post also the most-recent row in the
// thread? Soft "consecutive" signal — never blocks (spec §1, anti-loop is advisory).
export function isConsecutive(db, { thread, tokenId: tid }) {
  const last = db
    .prepare(`SELECT token_id FROM messages WHERE thread = ? ORDER BY id DESC LIMIT 1`)
    .get(thread);
  return !!last && last.token_id === tid;
}
