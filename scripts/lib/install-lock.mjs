import { closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
function inspect(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile()) throw new Error(`Refusing non-file installer lock: ${file}`);
    const bytes = readFileSync(file, 'utf8');
    let record;
    try { record = JSON.parse(bytes); } catch { /* Malformed records are recoverable. */ }
    const pid = record?.pid;
    let live = false;
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); live = true; }
      catch (error) { if (error.code !== 'ESRCH') live = true; }
    }
    return { stat, bytes, pid, live };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Scope is the HOME being written, not a config-derived name or checkout.
export function acquireInstallLock(ctx) {
  if ((ctx.only === 'skills' && ctx.skipSkills) || (ctx.only === 'code-intel' && ctx.skipCodeIntel)) return () => {};
  const file = path.join(ctx.home, '.harness-install.lock');
  const refuse = (holder) => {
    throw new Error(`Installer lock held by live pid ${holder.pid}: ${file}. If that pid is not an installer, remove this file by hand.`);
  };
  let tookOver = false;
  const removeOwned = (target, owned) => {
    const current = inspect(target);
    if (current && sameFile(owned, current.stat)) unlinkSync(target);
  };
  const publish = (target) => {
    // Interrupted runs may leave temporary or reaper files. They do not change
    // the main lock's ownership; reaper claims recover by pid, and no sweep is needed.
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() })}\n`);
      const stat = fstatSync(fd);
      closeSync(fd);
      fd = undefined;
      try { linkSync(temp, target); return stat; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally {
      if (fd !== undefined) closeSync(fd);
      unlinkSync(temp);
    }
    return null;
  };
  const acquire = (target, depth = 0) => {
    if (depth > 8) throw new Error(`Too many interrupted installer lock takeovers: ${file}`);
    for (;;) {
      const holder = inspect(target);
      if (holder?.live) refuse(holder);
      if (holder) {
        // A transient claim keyed to the stale generation serializes reapers.
        // A stat check alone has an unlink race: a second reaper can remove
        // the first reaper's newly published live lock. Claims use the same
        // recovery protocol if their owner was interrupted.
        const key = createHash('sha256').update(`${target}:${holder.stat.dev}:${holder.stat.ino}:${holder.bytes}`).digest('hex');
        const claim = `${file}.reap-${key}`;
        const claimOwned = acquire(claim, depth + 1);
        try {
          const current = inspect(target);
          if (!current || !sameFile(holder.stat, current.stat) || holder.bytes !== current.bytes) continue;
          if (current.live) refuse(current);
          try { unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (target === file) tookOver = true;
          const owned = publish(target);
          if (owned) return owned;
        } finally { removeOwned(claim, claimOwned); }
      } else {
        const owned = publish(target);
        if (owned) return owned;
      }
    }
  };
  const holder = inspect(file);
  if (holder?.live) refuse(holder);
  // The lock sits in HOME itself, so it needs no directory of its own: a step
  // that refuses after the lock is taken leaves HOME as it found it.
  mkdirSync(ctx.home, { recursive: true });
  // Publish a complete record exclusively: another process never observes
  // an empty JSON file between exclusive creation and the record write.
  const owned = acquire(file);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    removeOwned(file, owned);
  };
  process.once('exit', release);
  // Do not replace default signal actions: synchronous steps cannot dispatch
  // JS handlers. A killed run leaves its lock for dead-pid takeover.
  if (tookOver) process.stderr.write(`Taking over stale installer lock: ${file}\n`);
  return release;
}
