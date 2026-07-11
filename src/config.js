import { randomBytes, timingSafeEqual } from 'node:crypto';
import { openSync, closeSync, writeSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// All magic numbers live here (spec §5). Override the home dir via AGENT_BUSSY_HOME
// (used by tests so they never touch the real ~/.agent-bussy).
export const DEFAULTS = {
  port: 4787,
  host: '127.0.0.1',
  bodyCap: 64 * 1024, // 64 KB
  metaCap: 8 * 1024, //  8 KB
  authorCap: 128,
  threadCap: 128,
  rateWindowMs: 2000, // 1 post / 2s / token ...
  rateBurst: 5, // ... with a burst of 5
  messagesLimit: 50,
  hookTimeoutMs: 1500,
};

export function busHome() {
  return process.env.AGENT_BUSSY_HOME || join(homedir(), '.agent-bussy');
}

// Create the home dir (0700) if missing. Returns the path.
export function ensureHome() {
  const home = busHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

// Read the token, creating it atomically (O_EXCL + 0600) from a CSPRNG on first
// run. No write-then-chmod race (spec §5, Pentester m2). 256 bits of entropy.
export function ensureToken() {
  ensureHome();
  const path = join(busHome(), 'token');
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const token = randomBytes(32).toString('hex');
  // 'wx' == O_CREAT | O_EXCL | O_WRONLY. Fails if another process won the race.
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeSync(fd, token);
  } catch (err) {
    if (err.code === 'EEXIST') return readFileSync(path, 'utf8').trim();
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return token;
}

// Constant-time token comparison. Length-mismatch is not constant-time against
// the correct length, but the token is fixed-width hex so that leaks nothing.
export function tokenMatches(expected, got) {
  if (typeof got !== 'string' || got.length !== expected.length) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function config() {
  return { ...DEFAULTS, home: busHome() };
}
