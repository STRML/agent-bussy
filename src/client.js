import { randomUUID } from 'node:crypto';
import { config } from './config.js';

// Thin HTTP client for the bus. All requests carry the token + a correct Host.
export function makeClient({ token, cfg = config(), timeoutMs } = {}) {
  const base = `http://${cfg.host}:${cfg.port}`;
  const host = `${cfg.host}:${cfg.port}`;

  async function req(method, path, { body, headers = {} } = {}) {
    const controller = new AbortController();
    const t = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetch(base + path, {
        method,
        signal: controller.signal,
        headers: {
          host,
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      return { status: res.status, json };
    } finally {
      if (t) clearTimeout(t);
    }
  }

  return {
    post: ({ thread, author, kind, body, reply_to, meta }) =>
      req('POST', '/post', {
        body: { thread, author, kind, body, reply_to, meta },
        headers: { 'idempotency-key': randomUUID() },
      }),
    messages: ({ thread, since = 0, limit }) => {
      const q = new URLSearchParams({ thread, since: String(since) });
      if (limit) q.set('limit', String(limit));
      return req('GET', `/messages?${q}`);
    },
    threads: ({ activeWithin } = {}) => {
      const q = activeWithin ? `?active_within=${activeWithin}` : '';
      return req('GET', `/threads${q}`);
    },
    health: () => req('GET', '/health'),
  };
}
