import { hostname } from 'node:os';
import { ensureToken, config } from './config.js';
import { makeClient } from './client.js';
import { startDaemon, stopDaemon, statusDaemon } from './daemon.js';
import { fence, renderMessages } from './render.js';

const USAGE = `bus — the paddock radio

  bus post   -t THREAD [--as NAME] [--kind say|ask|decision] [--reply N] "message"
  bus read   -t THREAD [--since N] [--limit N] [--raw]
  bus threads [--active 2h]
  bus tail   [--interval 2] [--raw]
  bus daemon start|stop|status
  bus health

Identity for --as defaults to $AGENT_BUSSY_IDENTITY, then "cli-<host>".
`;

// Minimal flag parser: --flag value, -t value, and a trailing positional.
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-t') flags.thread = argv[++i];
    else if (a === '--as') flags.as = argv[++i];
    else if (a === '--kind') flags.kind = argv[++i];
    else if (a === '--reply') flags.reply = Number(argv[++i]);
    else if (a === '--since') flags.since = Number(argv[++i]);
    else if (a === '--limit') flags.limit = Number(argv[++i]);
    else if (a === '--active') flags.active = argv[++i];
    else if (a === '--interval') flags.interval = Number(argv[++i]);
    else if (a === '--raw') flags.raw = true;
    else positional.push(a);
  }
  return { flags, positional };
}

function identity(flags) {
  return flags.as || process.env.AGENT_BUSSY_IDENTITY || `cli-${hostname().split('.')[0]}`;
}

function client() {
  return makeClient({ token: ensureToken(), cfg: config() });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run(argv, { out = console.log, err = console.error } = {}) {
  const [cmd, ...rest] = argv;
  const { flags, positional } = parseArgs(rest);

  switch (cmd) {
    case 'daemon': {
      const sub = positional[0];
      if (sub === 'start') {
        const r = startDaemon();
        out(r.started ? `bussy started (pid ${r.pid})` : `bussy already running (pid ${r.pid})`);
      } else if (sub === 'stop') {
        const r = stopDaemon();
        out(r.stopped ? `bussy stopped (pid ${r.pid})` : 'bussy not running');
      } else if (sub === 'status') {
        const r = statusDaemon();
        out(r.running ? `bussy running (pid ${r.pid})` : 'bussy not running');
      } else {
        err('usage: bus daemon start|stop|status');
        return 2;
      }
      return 0;
    }

    case 'health': {
      try {
        const { status, json } = await client().health();
        out(JSON.stringify(json));
        return status === 200 ? 0 : 1;
      } catch (e) {
        err(`bus unreachable: ${e.message}`);
        return 1;
      }
    }

    case 'post': {
      if (!flags.thread) return usageErr(err, 'post needs -t THREAD');
      const body = positional.join(' ');
      if (!body) return usageErr(err, 'post needs a message');
      const { status, json } = await client().post({
        thread: flags.thread,
        author: identity(flags),
        kind: flags.kind,
        body,
        reply_to: flags.reply,
      });
      if (status >= 400) {
        err(`post rejected (${status}): ${json.error}${json.reason ? ' — ' + json.reason : ''}`);
        return 1;
      }
      out(`posted #${json.id}${json.warning ? ` [${json.warning}]` : ''}`);
      return 0;
    }

    case 'read': {
      if (!flags.thread) return usageErr(err, 'read needs -t THREAD');
      const { status, json } = await client().messages({
        thread: flags.thread,
        since: flags.since || 0,
        limit: flags.limit,
      });
      if (status >= 400) {
        err(`read failed (${status}): ${json.error}`);
        return 1;
      }
      out(flags.raw ? JSON.stringify(json.messages) : renderMessages(json.messages, { fenced: true }));
      if (json.truncated) err(`… truncated; more after #${json.oldest_unread} (pass --since ${json.oldest_unread})`);
      return 0;
    }

    case 'threads': {
      const { status, json } = await client().threads({ activeWithin: flags.active });
      if (status >= 400) return 1;
      for (const t of json.threads) out(`${t.thread}\t#${t.last_id}\t${t.message_count} msgs`);
      return 0;
    }

    case 'tail': {
      const c = client();
      const intervalMs = (flags.interval || 2) * 1000;
      const seen = new Map(); // thread -> last id
      out('# tailing — Ctrl-C to stop');
      for (;;) {
        const { json } = await c.threads({});
        for (const t of json.threads.reverse()) {
          const since = seen.get(t.thread) ?? Math.max(0, t.last_id - 1);
          const r = await c.messages({ thread: t.thread, since });
          if (r.json.messages?.length) {
            out(renderMessages(r.json.messages, { fenced: flags.raw ? false : true, thread: t.thread }));
            seen.set(t.thread, r.json.messages[r.json.messages.length - 1].id);
          } else if (!seen.has(t.thread)) {
            seen.set(t.thread, t.last_id);
          }
        }
        await sleep(intervalMs);
      }
    }

    default:
      err(USAGE);
      return cmd ? 2 : 0;
  }
}

function usageErr(err, msg) {
  err(`error: ${msg}`);
  return 2;
}

// Re-export so the fence rule is discoverable from the CLI module too.
export { fence };
