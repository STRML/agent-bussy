import { createServer } from 'node:http';
import { DEFAULTS, tokenMatches } from './config.js';
import {
  openDb,
  insertMessage,
  readMessages,
  listThreads,
  isConsecutive,
  tokenId,
  KINDS,
} from './db.js';

// A sliding-window rate limiter keyed on token_id (spec §1 — NEVER on the
// spoofable author). Allows `burst` posts, then 1 per `windowMs`.
function makeRateLimiter({ windowMs, burst }) {
  const hits = new Map(); // tokenId -> number[] of timestamps
  return function allow(tid, now = Date.now()) {
    const arr = (hits.get(tid) || []).filter((t) => now - t < windowMs);
    if (arr.length >= burst) {
      hits.set(tid, arr);
      return false;
    }
    arr.push(now);
    hits.set(tid, arr);
    return true;
  };
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

// Read a request body with a hard byte cap. Rejects (destroys) oversize streams
// rather than buffering them — a noisy peer can't exhaust memory (spec §1).
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) {
        reject(Object.assign(new Error('body too large'), { code: 'E_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Host header must be loopback on our port (spec §1 — kills DNS-rebinding).
function hostAllowed(req, cfg) {
  const host = (req.headers.host || '').toLowerCase();
  return host === `127.0.0.1:${cfg.port}` || host === `localhost:${cfg.port}`;
}

export function createBus({ token, dbPath = ':memory:', config = {} } = {}) {
  if (!token) throw new Error('createBus requires a token');
  const cfg = { ...DEFAULTS, ...config };
  const db = openDb(dbPath);
  const allow = makeRateLimiter({ windowMs: cfg.rateWindowMs, burst: cfg.rateBurst });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${cfg.port}`);

      // --- Request hardening: applied to EVERY path, health included ---
      if (!hostAllowed(req, cfg)) return send(res, 421, { error: 'bad_host' });
      // No browser is a legitimate client — reject anything carrying an Origin.
      if (req.headers.origin) return send(res, 403, { error: 'cross_origin' });
      const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!tokenMatches(token, auth)) return send(res, 401, { error: 'unauthorized' });

      const tid = tokenId(token);

      if (req.method === 'GET' && url.pathname === '/health') {
        let db_ok = true;
        try {
          db.prepare('SELECT 1').get();
        } catch {
          db_ok = false;
        }
        return send(res, 200, { ok: true, db_ok, uptime: process.uptime() });
      }

      if (req.method === 'GET' && url.pathname === '/messages') {
        const thread = url.searchParams.get('thread');
        if (!thread) return send(res, 400, { error: 'missing_thread' });
        const since = Number(url.searchParams.get('since') || 0);
        let limit = Number(url.searchParams.get('limit') || cfg.messagesLimit);
        if (!Number.isInteger(since) || since < 0) return send(res, 400, { error: 'bad_since' });
        if (!Number.isInteger(limit) || limit < 1) limit = cfg.messagesLimit;
        limit = Math.min(limit, cfg.messagesLimit);
        return send(res, 200, readMessages(db, { thread, since, limit }));
      }

      if (req.method === 'GET' && url.pathname === '/threads') {
        const within = url.searchParams.get('active_within');
        const activeWithinMs = within ? parseWindow(within) : undefined;
        return send(res, 200, { threads: listThreads(db, { activeWithinMs }) });
      }

      if (req.method === 'POST' && url.pathname === '/post') {
        if (!allow(tid)) return send(res, 429, { error: 'rate_limited', reason: 'slow down' });
        let raw;
        try {
          raw = await readBody(req, cfg.bodyCap);
        } catch (e) {
          if (e.code === 'E_TOO_LARGE') return send(res, 413, { error: 'body_too_large' });
          throw e;
        }
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: 'bad_json' });
        }
        const bad = validatePost(payload, cfg);
        if (bad) return send(res, 400, { error: bad });

        const meta = payload.meta === undefined ? null : JSON.stringify(payload.meta);
        if (meta && Buffer.byteLength(meta) > cfg.metaCap)
          return send(res, 400, { error: 'meta_too_large' });

        const idemKey = req.headers['idempotency-key'] || null;
        const consecutive = isConsecutive(db, { thread: payload.thread, tokenId: tid });
        const result = insertMessage(db, {
          thread: payload.thread,
          author: payload.author,
          kind: payload.kind || 'say',
          reply_to: payload.reply_to ?? null,
          body: payload.body,
          meta,
          tokenId: tid,
          idemKey,
        });
        return send(res, result.duplicate ? 200 : 201, {
          id: result.id,
          duplicate: result.duplicate,
          ...(consecutive ? { warning: 'consecutive' } : {}),
        });
      }

      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      send(res, 500, { error: 'internal', reason: String(err.message || err) });
    }
  });

  return { server, db, config: cfg };
}

function parseWindow(s) {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]];
}

// Returns an error string if the post is invalid, else null.
function validatePost(p, cfg) {
  if (!p || typeof p !== 'object') return 'bad_payload';
  if (typeof p.thread !== 'string' || !p.thread || p.thread.length > cfg.threadCap)
    return 'bad_thread';
  if (typeof p.author !== 'string' || !p.author || p.author.length > cfg.authorCap)
    return 'bad_author';
  if (typeof p.body !== 'string' || !p.body) return 'bad_body';
  if (p.kind !== undefined && !KINDS.includes(p.kind)) return 'bad_kind';
  if (p.reply_to !== undefined && p.reply_to !== null && !Number.isInteger(p.reply_to))
    return 'bad_reply_to';
  return null;
}
