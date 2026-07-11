import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHome, busHome } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function pidPath() {
  return join(busHome(), 'bussy.pid');
}

// Is a process with this pid alive? signal 0 tests existence without killing.
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not ours — still "alive"
  }
}

// Returns the running daemon's pid, or null. Cleans up a stale pidfile.
export function daemonPid() {
  const p = pidPath();
  if (!existsSync(p)) return null;
  const pid = Number(readFileSync(p, 'utf8').trim());
  if (Number.isInteger(pid) && alive(pid)) return pid;
  try {
    unlinkSync(p);
  } catch {
    /* already gone */
  }
  return null;
}

// Start bussy detached. Refuses if one is already running (pidfile guard).
export function startDaemon() {
  ensureHome();
  const existing = daemonPid();
  if (existing) return { started: false, pid: existing, reason: 'already_running' };

  const logPath = join(busHome(), 'bussy.log');
  const out = openSync(logPath, 'a');
  const child = spawn(process.execPath, [join(__dirname, 'bussy-entry.js')], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  writeFileSync(pidPath(), String(child.pid), { mode: 0o600 });
  child.unref();
  return { started: true, pid: child.pid, log: logPath };
}

export function stopDaemon() {
  const pid = daemonPid();
  if (!pid) return { stopped: false, reason: 'not_running' };
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* race: died between check and kill */
  }
  try {
    unlinkSync(pidPath());
  } catch {
    /* already gone */
  }
  return { stopped: true, pid };
}

export function statusDaemon() {
  const pid = daemonPid();
  return pid ? { running: true, pid } : { running: false };
}
