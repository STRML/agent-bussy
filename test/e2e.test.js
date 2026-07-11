import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/bus.js', import.meta.url));
let HOME;

// Every CLI invocation runs against a throwaway AGENT_BUS_HOME on a private port,
// so the real ~/.agent-bus and any running daemon are never touched.
function bus(args) {
  return pexec(process.execPath, [BIN, ...args], {
    env: { ...process.env, AGENT_BUS_HOME: HOME },
  });
}

before(() => {
  HOME = mkdtempSync(join(tmpdir(), 'agent-bus-e2e-'));
});
after(async () => {
  try {
    await bus(['daemon', 'stop']);
  } catch {
    /* ignore */
  }
  rmSync(HOME, { recursive: true, force: true });
});

test('daemon start/status/stop lifecycle + post/read round-trip through the CLI', async () => {
  const start = await bus(['daemon', 'start']);
  assert.match(start.stdout, /busd started/);

  // give the detached daemon a moment to bind
  await new Promise((r) => setTimeout(r, 400));

  const status = await bus(['daemon', 'status']);
  assert.match(status.stdout, /busd running/);

  const health = await bus(['health']);
  assert.match(health.stdout, /"ok":true/);

  const post = await bus(['post', '-t', 'issue-1', '--as', 'codex-1', 'is this thread-safe?']);
  assert.match(post.stdout, /posted #1/);

  const read = await bus(['read', '-t', 'issue-1']);
  assert.match(read.stdout, /<untrusted-bus-messages>/);
  assert.match(read.stdout, /codex-1: is this thread-safe\?/);

  const threads = await bus(['threads']);
  assert.match(threads.stdout, /issue-1\t#1\t1 msgs/);

  const stop = await bus(['daemon', 'stop']);
  assert.match(stop.stdout, /busd stopped/);
});

test('starting twice is refused by the pidfile guard', async () => {
  await bus(['daemon', 'start']);
  await new Promise((r) => setTimeout(r, 300));
  const again = await bus(['daemon', 'start']);
  assert.match(again.stdout, /already running/);
  await bus(['daemon', 'stop']);
});
