// orch entry point.
//
//   node ops/orchestrator/src/main.ts serve [--lan-port <off|port>]  run the daemon; the flag wins over ORCH_LAN_PORT
//   node ops/orchestrator/src/main.ts status   ask the running daemon; exit 1 if none
//   node ops/orchestrator/src/main.ts check-on <host> [--repo <lead checkout>] -- <command...>
//   node ops/orchestrator/src/main.ts restart --when-idle
//                                      drain, then exit 0 so launchd KeepAlive restarts
//   node ops/orchestrator/src/main.ts stop     stop the daemon on Windows and release its lock
//   node ops/orchestrator/src/main.ts smoke    prove the provider adapters against the real CLIs
//   node ops/orchestrator/src/main.ts pause <family> --reason "<text>"|unpause <family>|paused
//   node ops/orchestrator/src/main.ts language [off|flag|enforce]  language switch; a missing file is off
//   node ops/orchestrator/src/main.ts hosts list  print the hosts.json registry as JSON
//   node ops/orchestrator/src/main.ts hosts add <name> --ssh <alias> --platform <p> --repo <path> --node <path> [--native <json>] [--replace] [--no-probe]
//                                              register a host once it answers the probe; --no-probe writes it unproved
//   node ops/orchestrator/src/main.ts hosts remove <name>  unregister a host; add and remove print the registry
//   node ops/orchestrator/src/main.ts hosts probe <name>  run the host's node over ssh and print its version or the failure reason
//   node ops/orchestrator/src/main.ts roles show [--json]  the effective matrix; each row marked file or compiled
//   node ops/orchestrator/src/main.ts roles set <role> <family> <model> [<effort>]  one cell; an unstored role copies its effective row first
//   node ops/orchestrator/src/main.ts roles unset <role> <family>  refuses to leave an empty row
//   node ops/orchestrator/src/main.ts roles reset <role>  remove the row; the last row removes the file
//   node ops/orchestrator/src/main.ts roles preset <tier> --families <a,b,...> [--dry-run] [--json]  write the whole matrix from the team presets; tier: economy, balanced, strong
//   node ops/orchestrator/src/main.ts review-plan <coder-seat>  suggest reviewer depth/focus
//   node ops/orchestrator/src/main.ts pick-stats [--since 30d] [--json]  historical outcomes
//   node ops/orchestrator/src/main.ts lesson-stats [--since 7d] [--json]  weekly lesson usage
//   node ops/orchestrator/src/main.ts role-stats [--since 7d] [--json] [--write-tiers]  family means by seat role; --write-tiers also refreshes the quality tier file
//   node ops/orchestrator/src/main.ts lesson-repeat --lesson L --duplicate-of N [--json]
//   node ops/orchestrator/src/main.ts lead-lessons --session <id>  list a lead session's delivered lessons
//   node ops/orchestrator/src/main.ts lead-lessons --session <id> --applied <lessonId>=true|false --why "<text>"  record the lead's answer
//   node ops/orchestrator/src/main.ts prune [--dry-run] [--seat <id>] [--older-than 7d]
//   node ops/orchestrator/src/main.ts prune --caches [--dry-run]   free closed seats' regenerable caches
//   node ops/orchestrator/src/main.ts prune --targets [--dry-run]  free idle lead worktrees' Cargo targets
//   node ops/orchestrator/src/main.ts sweep-host-worktrees [--host <name>] [--dry-run]
//   node ops/orchestrator/src/main.ts wait <turn> [<turn>...] [--grace-seconds n] [--timeout-minutes n] [--json]
//                                              block until the turns end; one id keeps today's digest
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { codeHash } from '../code-hash.mjs';
import { suitePassRefusal } from '../suite-pass.mjs';
import type { AddressInfo } from 'node:net';
import { addHost, checkHosts, loadConfig, readHost, readHosts, refuseExistingHost, removeHost, type RemoteHost } from './config.ts';
import { describeRoles, resetRole, setRole, unsetRole, writeRolesMatrix } from './profiles.ts';
import { buildMatrix, knownModel, teamPresets, type PresetTier } from './team-presets.ts';
import { probeHost } from './placement.ts';
import { daemonCheckout, syncHostRuntime } from './remote-repo.ts';
import { checkOn } from './check-on.ts';
import { createHttpServer, createLanBoardServer } from './http.ts';
import { formatDigest, formatWaitError } from './digest-text.ts';
import type { Digest } from './seats.ts';
import { landable } from './seats-defs.ts';
import { acquireLock, isUnreachableConnection, pidRecord, PROBE_TIMEOUT_MS, recordPort, releaseLock, releaseStoppedLock, runningInstance, waitingInstance } from './lock.ts';
import { Limits, providerError } from './limits.ts';
import { FAMILIES, type Family } from './providers/types.ts';
import { changePaused, formatPause, readPauseRecords } from './paused-families.ts';
import { LANGUAGE_MODES, languageFile, readLanguageMode, writeLanguageMode, type LanguageMode } from './shared.entry.ts';
import { createLogger } from './log.ts';
import { startConfigHealth } from './config-health.ts';
import { startLoopDelay } from './shared.entry.ts';
import { SeatManager } from './seats.ts';
import { smoke } from './smoke.ts';
import { openReadOnlyStore, openStore, provisioningStarted } from './store.ts';
import { setJevBalance } from '../../bootstrap/jev-ledger.mjs';
import { reviewPlan } from './review-plan.ts';
import { formatPickStats, readCoderRetained, readPickStats } from './pick-stats.ts';
import { formatLessonStats, readLessonStats } from './lesson-stats.ts';
import { cellKey, writeTierFile } from './role-quality.ts';
import { formatRoleStats, roleStats } from './role-stats.ts';
import { clearCaches, inspectCoder, ownedWorktree, parseOlderThan, protectedBackupPaths, pruneCoder, unknownMirrors } from './prune.ts';
import { sweepBackups, sweepStoreBackups } from './backup-sweep.ts';
import { noteCodegraphDaemonStop, repoOf } from './worktrees.ts';
import { sweepTargets } from './target-sweep.ts';
import { sweepTmp } from './tmp-sweep.ts';
import { sweepConfiguredHostWorktrees } from './host-worktree-sweep.ts';
import { sweepWorktrees } from './worktree-sweep.ts';

/** off and 0 disable the LAN board; a decimal port 1..65535 enables it. The same refusals judge --lan-port and ORCH_LAN_PORT. */
function parseLanPort(setting: string): number {
  if (setting !== 'off' && !/^(?:0|[1-9]\d*)$/.test(setting)) throw new Error(`invalid ORCH_LAN_PORT: ${setting}`);
  const lanPort = setting === 'off' ? 0 : Number(setting);
  if (lanPort > 65535) throw new Error(`invalid ORCH_LAN_PORT: ${setting}`);
  return lanPort;
}

/** --lan-port wins over ORCH_LAN_PORT. No flag keeps today's env-or-7761 read. A value never starts with --. */
function readServeLanPort(argv: string[]): number {
  let fromFlag: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--lan-port') continue;
    if (fromFlag !== undefined) throw new Error('serve: --lan-port given twice');
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('serve: --lan-port needs a value');
    fromFlag = value;
    i++;
  }
  return parseLanPort(fromFlag ?? process.env.ORCH_LAN_PORT ?? '7761');
}

async function serve(lanPort: number): Promise<void> {
  // Task 3105: before anything else, pin outbound fetch to HTTP/1.1. A wedged
  // native h2 send loop ignores the AbortController; no later code may fetch h2.
  // Imported dynamically so only the daemon needs undici installed: every other
  // main.ts command (status, wait, check-on, review-plan) runs without it.
  (await import('./outbound-http1.ts')).forceOutboundHttp1();
  const config = loadConfig();
  mkdirSync(config.stateDir, { recursive: true });
  // The lock comes BEFORE the store: two overlapping starts must not both open
  // (and migrate) the database, and the port cannot be the lock because each
  // start may ask for a different one.
  const lock = await acquireLock(config.pidFile);
  if (lock.ok === false) {
    const { pid, port, reason } = lock.holder;
    process.stderr.write(
      `orch is already running (${pid > 0 ? `pid ${pid}` : 'lock being written'}, ${port === null ? 'still starting' : `port ${port}`}, ${reason}); ` +
        `refusing a second instance (lock ${config.pidFile})\n`,
    );
    process.exit(2);
  }
  const log = createLogger(config.logFile);
  const code = codeHash(fileURLToPath(new URL('..', import.meta.url)));
  const configHealth = startConfigHealth({ code, log });
  let store;
  try {
    store = openStore(config.dbFile);
  } catch (error) {
    releaseLock(config.pidFile);
    throw error;
  }
  const loop = startLoopDelay(log);
  // Only running providers died with the process. Every queued turn still has its
  // persisted start args and must be rescheduled, whether or not a drain was armed.
  const resumeDrain = store.draining();
  const recovered = store.interruptOrphans();
  if (recovered.turns || recovered.seats) log('warn', 'daemon.recovered', recovered);
  const limits = new Limits(config.usage ? { lastGoodFile: config.lastGoodFile, doneUsage: store.doneUsage } : { off: 'usage reading is off (ORCH_USAGE=off)' });
  limits.refresh();
  // A turn that failed on its quota is the only load signal some plans give (qwen, memory #10496).
  let exitDrain = (): void => {};
  // Resolved once, before any seat can be created: a later create must not follow a
  // lead worktree's HEAD. A failure is logged and leaves remote creates refused; it
  // does not block startup or local seats (task 1784).
  let daemonRuntime: { repo: string; sha: string } | undefined;
  try {
    daemonRuntime = await daemonCheckout(fileURLToPath(new URL('..', import.meta.url)));
  } catch (error) {
    log('warn', 'daemon.host_runtime_refused', { message: (error as Error).message });
  }
  const seats = new SeatManager(store, { stateDir: config.stateDir, log, ...(daemonRuntime ? { daemonRuntime } : {}), onDrainIdle: () => exitDrain(), onTurnEnd: (seat, end) => {
    if (end.status === 'done') limits.noteSuccess(seat.family as Family);
    else {
      // Only the provider's own words are evidence of quota, outage or credentials (task 1519 review).
      const error = providerError(end);
      if (error) limits.noteError(seat.family as Family, error);
    }
  } });
  await seats.recover();
  seats.resumeProvisioning();
  // A crash before scheduling leaves the rows queued for the next start. If a
  // drain was armed, clear its crash guard only after the work is scheduled.
  seats.resumeQueued();
  if (resumeDrain) store.setDrain(false);
  // Every remote seat runs remote-exec and the build gate from the host's runtime
  // checkout (its hosts.json repo): move each to the commit resolved above.
  // A refusal (uncommitted tracked changes) or failure is logged and surfaced in
  // orch_status; it never blocks startup or unrelated local seats (task 1784).
  if (daemonRuntime) {
    const { repo, sha } = daemonRuntime;
    void Promise.all(Object.keys(readHosts(config.stateDir)).map(async (name) => {
      try {
        const result = await syncHostRuntime(name, repo, { sha, log });
        if (result.moved) log('info', 'daemon.host_runtime_moved', { host: name, from: result.from, to: result.to });
      } catch (error) {
        log('warn', 'daemon.host_runtime_refused', { host: name, message: (error as Error).message });
      }
    }));
  }
  // Close 24 h idle disposable seats/proven coders, then prune landed closed
  // local checkouts and final remote mirrors. Unknowns retain their checkout.
  let targetCheckout: string | undefined;
  try {
    targetCheckout = (await repoOf(fileURLToPath(new URL('..', import.meta.url)))).main;
  } catch (error) {
    log('warn', 'daemon.target_sweep', { skipped: [{ reason: `checkout unavailable: ${(error as Error).message}` }], removed: [], bytesBefore: 0 });
  }
  let sweeping = false;
  const sweep = setInterval(() => {
    loop.mark('timer daemon.sweep');
    if (sweeping) return;
    sweeping = true;
    void seats.pruneLanded()
      .catch((error) => log('warn', 'daemon.sweep_failed', { message: (error as Error).message }))
      .then(async () => {
        try {
          await sweepConfiguredHostWorktrees({ stateDir: config.stateDir, daily: true,
            seats: () => store.listSeats(),
            log: event => log(event.action === 'error' ? 'warn' : 'info', 'daemon.host_worktree_sweep', event) });
        } catch (error) {
          log('warn', 'daemon.host_worktree_sweep', { skipped: [{ reason: (error as Error).message }] });
        }
        if (!targetCheckout) return;
        try {
          const result = await sweepTargets({ checkout: targetCheckout, stateDir: config.stateDir, daily: true });
          if (result) log('info', 'daemon.target_sweep', result);
        } catch (error) {
          log('warn', 'daemon.target_sweep', { skipped: [{ reason: (error as Error).message }], removed: [], bytesBefore: 0 });
        }
        try {
          // Task 2861 slice D: idle .claude/worktrees checkouts and their caches;
          // same daily stamp/lease gate inside the sweep, same main checkout.
          const result = await sweepWorktrees({ checkout: targetCheckout, stateDir: config.stateDir, daily: true });
          if (result) log('info', 'daemon.worktree_sweep', result);
        } catch (error) {
          log('warn', 'daemon.worktree_sweep', { skipped: [{ reason: (error as Error).message }], removed: [], bytesBefore: 0 });
        }
        try {
          const result = await sweepTmp({ stateDir: config.stateDir, daily: true,
            openSeatIds: () => new Set(store.listSeats({ notStatus: 'closed' }).map((seat) => seat.id)) });
          if (result) log('info', 'daemon.tmp_sweep', result);
        } catch (error) {
          log('warn', 'daemon.tmp_sweep', { skipped: [{ reason: (error as Error).message }], removed: [], bytesBefore: 0 });
        }
        try {
          // Task 2861 slice S5 (operator decision #19671): worktree backups keep
          // 14 days; a file named by a removal still in progress always stays.
          const result = await sweepStoreBackups(store, { stateDir: config.stateDir, daily: true });
          if (result) log('info', 'daemon.backup_sweep', result);
        } catch (error) {
          log('warn', 'daemon.backup_sweep', { skipped: [{ reason: (error as Error).message }], removed: [], bytesBefore: 0 });
        }
      })
      .finally(() => { sweeping = false; });
  }, 10 * 60_000);
  sweep.unref();
  const startedAt = Date.now();
  let port = config.port;
  const runtime = { store, seats, log, loop, startedAt, stateDir: config.stateDir, port: () => port, code, limits, configHealth };
  const server = createHttpServer(runtime);
  const lanServer = lanPort === 0 ? null : createLanBoardServer(runtime);
  lanServer?.on('error', (error: NodeJS.ErrnoException) => {
    log('error', 'daemon.lan_listen_failed', { port: lanPort, message: error.message });
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    const message = error.code === 'EADDRINUSE'
      ? `port ${config.host}:${config.port} is already in use; is another orch running?`
      : error.message;
    log('error', 'daemon.listen_failed', { message });
    process.stderr.write(`orch: ${message}\n`);
    loop.stop();
    store.close();
    releaseLock(config.pidFile);
    process.exit(2);
  });
  server.listen(config.port, config.host, () => {
    port = (server.address() as AddressInfo).port;
    recordPort(config.pidFile, port);
    store.appendEvent('daemon.started', { pid: process.pid, port });
    log('info', 'daemon.started', { port, schema: store.schemaVersion(), stateDir: config.stateDir });
    process.stdout.write(`${JSON.stringify({ event: 'listening', host: config.host, port, pid: process.pid })}\n`);
    lanServer?.listen(lanPort, '0.0.0.0', () => {
      log('info', 'daemon.lan_listening', { address: lanServer.address(), routes: ['GET /', 'GET /api/dashboard', 'GET /api/chat'] });
    });
  });

  let drainingExit = false;
  exitDrain = () => {
    if (drainingExit) return;
    if (store.runningTurns() > 0 || store.listSeats('provisioning').some(provisioningStarted)) {
      seats.rearmDrain();
      return;
    }
    drainingExit = true;
    void stopDrain();
  };
  // KeepAlive is unconditional (install.mjs), so exit 0 is what launchd restarts.
  // Queued turns stay queued; the flag was set by beginDrain and the next start clears it.
  const stopDrain = async () => {
    // Let the /restart response flush before the socket closes.
    await new Promise((resolve) => setImmediate(resolve));
    if (store.runningTurns() > 0 || store.listSeats('provisioning').some(provisioningStarted)) {
      drainingExit = false;
      seats.rearmDrain();
      return;
    }
    log('info', 'daemon.draining_exit', { pid: process.pid });
    clearInterval(sweep);
    configHealth.stop();
    loop.stop();
    server.close();
    server.closeAllConnections();
    if (lanServer?.listening) {
      lanServer.close();
      lanServer.closeAllConnections();
    }
    await Promise.race([seats.shutdown(), new Promise((resolve) => setTimeout(resolve, 8000))]);
    store.appendEvent('daemon.stopped', { pid: process.pid, signal: 'drain' });
    store.close();
    releaseLock(config.pidFile);
    process.exit(0);
  };

  const stop = async (signal: string) => {
    log('info', 'daemon.stopping', { signal });
    clearInterval(sweep);
    configHealth.stop();
    loop.stop();
    server.close();
    server.closeAllConnections();
    if (lanServer?.listening) {
      lanServer.close();
      lanServer.closeAllConnections();
    }
    // Longer than an adapter's own 5 s kill timer, so no provider outlives the daemon.
    await Promise.race([seats.shutdown(), new Promise((resolve) => setTimeout(resolve, 8000))]);
    // Turns still running when the providers were closed did not finish: say so.
    store.interruptOrphans();
    store.appendEvent('daemon.stopped', { pid: process.pid, signal });
    store.close();
    releaseLock(config.pidFile);
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

/** Arm or cancel a drain; an uncancelled drain exits 0 for launchd to restart. */
async function restart(argv: string[]): Promise<number> {
  const usage = () => {
    process.stderr.write('usage: node ops/orchestrator/src/main.ts restart --when-idle [--as <handle> --session <id> --note "<what changes for a lead>"] [--no-suite "<reason>"] | --cancel\n');
    return 64;
  };
  if (!['--when-idle', '--cancel'].includes(argv[0]!) || (argv[0] === '--cancel' && argv.length !== 1)) return usage();
  const notice: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!['--as', '--session', '--note', '--no-suite'].includes(flag) || value === undefined || value.startsWith('--') || flag.slice(2) in notice) return usage();
    notice[flag.slice(2)] = value;
  }
  const { 'no-suite': noSuite, ...post } = notice;
  if (noSuite !== undefined && !noSuite.trim()) return usage();
  if (Object.keys(post).length && !['as', 'session', 'note'].every((key) => key in post)) return usage();
  const config = loadConfig();
  const holder = await runningInstance(config.pidFile);
  if (!holder || holder.port === null) {
    process.stderr.write('restart: orch daemon is not running\n');
    return 1;
  }
  if (holder.health === null) {
    process.stderr.write('restart: orch daemon is busy; health did not answer\n');
    return 1;
  }
  if (argv[0] !== '--cancel') {
    // The daemon comes back on the checkout that it loads, not on the one that
    // runs this CLI: the whole non-live suite must have passed on its suite
    // inputs (operator #16333). An older daemon names no checkout. A cancel
    // restarts nothing.
    const repo = typeof holder.health.checkout === 'string' && holder.health.checkout
      ? holder.health.checkout : fileURLToPath(new URL('../../..', import.meta.url));
    if (noSuite !== undefined) {
      createLogger(config.logFile)('warn', 'restart.no_suite', { reason: noSuite, repo });
      process.stderr.write(`restart: whole orch suite not required (--no-suite): ${noSuite}\n`);
    } else {
      let refusal: string | null;
      try {
        refusal = suitePassRefusal(repo, config.stateDir);
      } catch (error) {
        refusal = `could not hash the suite inputs of ${repo} (${(error as Error).message})`;
      }
      if (refusal) {
        process.stderr.write(`restart: refused, ${refusal}\n`);
        return 1;
      }
    }
  }
  const response = await fetch(`http://${config.host}:${holder.port}/restart`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(argv[0] === '--cancel' ? { cancel: true } : { whenIdle: true, ...post }), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    process.stderr.write(`restart: daemon returned ${response.status}: ${await response.text()}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(await response.json())}\n`);
  return 0;
}

async function stopWindows(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('stop is only for Windows; use SIGTERM on macOS');
  const file = loadConfig().pidFile;
  const record = pidRecord(file);
  const holder = await runningInstance(file);
  if (!record || !holder || record.pid !== holder.pid) throw new Error('orch is not running');
  if (holder.health === null) throw new Error('orch daemon is busy; health did not answer');
  process.kill(holder.pid, 'SIGTERM'); // Windows terminates the process; no JS signal handler runs.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(holder.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      releaseStoppedLock(file, record.pid, record.startedAt);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`orch pid ${holder.pid} did not stop`);
}

async function status(): Promise<void> {
  const config = loadConfig();
  const record = pidRecord(config.pidFile);
  const holder = await runningInstance(config.pidFile);
  if (!holder) {
    process.stdout.write(`${JSON.stringify({ running: false, stateDir: config.stateDir, stalePid: record?.pid ?? null })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({
    ...holder.health, running: true, pid: holder.pid, port: holder.port, stateDir: config.stateDir,
    ...(holder.health === null ? { healthUnanswered: true } : {}),
  })}\n`);
}
/** How long `wait` rides out a daemon that is down or unreachable before it reports it (task 1859). */
const DOWN_GRACE_MS = 5 * 60_000;

const WAIT_USAGE = 'usage: node ops/orchestrator/src/main.ts wait <turn> [<turn>...] [--grace-seconds n] [--timeout-minutes n] [--json]\n';
const WAIT_USAGE_SHORT = 'usage: wait <turn> [<turn>...] [--grace-seconds n] [--timeout-minutes n] [--json]\n';
/** How long a multi-id wait keeps collecting after the first end. Zero is allowed; the deadline still wins. */
const BATCH_GRACE_SECONDS = 180;
const TERMINAL_WAIT = new Set(['done', 'error', 'cancelled', 'interrupted']);
type WaitArgs = { turns: string[]; minutes: number; graceSeconds: number; json: boolean };
type EndedWait = { kind: 'digest'; digest: Digest } | { kind: 'error'; error: string };

function parseWaitArgs(argv: string[]): WaitArgs | { error: string } {
  const first = argv[0];
  if (!first || !/^[A-Za-z0-9._-]+$/.test(first)) return { error: WAIT_USAGE };
  const turns = [first];
  let minutes = 240;
  let graceSeconds = BATCH_GRACE_SECONDS;
  let json = false;
  let sawGrace = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') {
      if (json) return { error: WAIT_USAGE_SHORT };
      json = true;
    } else if (arg === '--timeout-minutes' && i + 1 < argv.length) minutes = Number(argv[++i]);
    else if (arg === '--grace-seconds' && i + 1 < argv.length) {
      if (sawGrace) return { error: WAIT_USAGE_SHORT };
      sawGrace = true;
      graceSeconds = Number(argv[++i]);
    } else if (!first.startsWith('-') && !arg.startsWith('-') && /^[A-Za-z0-9._-]+$/.test(arg)) {
      if (turns.includes(arg)) return { error: WAIT_USAGE_SHORT };
      turns.push(arg);
    } else return { error: WAIT_USAGE_SHORT };
  }
  if (!(minutes > 0)) return { error: '--timeout-minutes needs a positive number\n' };
  if (!Number.isFinite(graceSeconds) || graceSeconds < 0) return { error: '--grace-seconds needs a non-negative number\n' };
  return { turns, minutes, graceSeconds, json };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function waitAgain(ids: string[]): string {
  const main = fileURLToPath(import.meta.url);
  return `still running: ${ids.join(' ')}; wait again: node "${main}" wait ${ids.join(' ')}`;
}

/**
 * Block until the named turns end and print their digests. One id keeps today's
 * bytes and exit code. Two or more are waited at once: after the first end,
 * keep collecting for the grace (default 180s, never past the deadline) or until
 * every turn has ended. Exit 0 when every ended turn is done, 1 when one ended
 * otherwise or orch stayed unreachable past DOWN_GRACE_MS, 3 on timeout with no
 * ended turn.
 */
async function wait(argv: string[]): Promise<number> {
  const parsed = parseWaitArgs(argv);
  if ('error' in parsed) {
    process.stderr.write(parsed.error);
    return 64;
  }
  if (parsed.turns.length === 1) return waitOne(parsed.turns[0]!, parsed.minutes, parsed.json);
  return waitMany(parsed.turns, parsed.minutes, parsed.graceSeconds, parsed.json);
}

async function waitOne(turn: string, minutes: number, json: boolean): Promise<number> {
  const config = loadConfig();
  const deadline = Date.now() + minutes * 60_000;
  const writeError = (error: string) => process.stdout.write(`${json ? JSON.stringify({ turn, error }) : formatWaitError(turn, error)}\n`);
  let retryMs = 250;
  const retry = async () => {
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryMs, Math.max(0, deadline - Date.now()))));
    retryMs = Math.min(retryMs * 2, 2000);
  };
  // A restart (drain or launchd) takes the daemon down for seconds and keeps
  // queued and drained turns (task 1859): keep waiting through a short outage,
  // report it only once it outlasts the grace or the deadline.
  let downSince: number | null = null;
  const stillDown = async (): Promise<boolean> => {
    downSince ??= Date.now();
    if (Date.now() - downSince >= DOWN_GRACE_MS || Date.now() >= deadline) return false;
    await retry();
    return true;
  };
  for (;;) {
    const holder = await waitingInstance(config.pidFile, Math.max(1, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now())));
    if (!holder) {
      if (await stillDown()) continue;
      writeError('orch is not running');
      return 1;
    }
    const remaining = deadline - Date.now();
    if (holder.port === null) {
      if (remaining <= 0) {
        writeError(`waited: gave up after ${minutes} min`);
        return 3;
      }
      await retry();
      continue;
    }
    const finalCheck = remaining <= 0;
    let digest: Digest;
    try {
      // Even at the deadline, ask once with wait=0: the turn may have ended.
      const response = await fetch(`http://${config.host}:${holder.port}/turns/${turn}?wait=${Math.min(55_000, Math.max(0, remaining))}`, { signal: AbortSignal.timeout(70_000) });
      digest = await response.json() as Digest;
      downSince = null;
      if (!response.ok) {
        writeError(digest.error ?? `HTTP ${response.status}`);
        return 1;
      }
    } catch (error) {
      if (isUnreachableConnection(error)) {
        if (await stillDown()) continue;
        writeError('orch is not running');
        return 1;
      }
      if (finalCheck) {
        writeError(`waited: gave up after ${minutes} min`);
        return 3;
      }
      // A busy daemon or a restart may drop the connection; recheck the lock.
      await retry();
      continue;
    }
    if (['done', 'error', 'cancelled', 'interrupted'].includes(digest.status)) {
      process.stdout.write(`${json ? JSON.stringify(digest, null, 1) : formatDigest(digest)}\n`);
      return digest.status === 'done' ? 0 : 1;
    }
    if (Date.now() >= deadline && finalCheck) {
      process.stdout.write(`${json ? JSON.stringify({ ...digest, waited: `gave up after ${minutes} min; the turn is still ${digest.status}` }) : `${formatDigest(digest)}\nwaited: gave up after ${minutes} min; the turn is still ${digest.status}`}\n`);
      return 3;
    }
  }
}

async function waitMany(turns: string[], minutes: number, graceSeconds: number, json: boolean): Promise<number> {
  const config = loadConfig();
  const deadline = Date.now() + minutes * 60_000;
  const ended = new Map<string, EndedWait>();
  let collectUntil = deadline;
  let sawEnd = false;
  let downSince: number | null = null;
  let retryMs = 250;
  let unreachable = false;
  let windowAbort = new AbortController();
  let windowTimer: ReturnType<typeof setTimeout> | undefined;
  // setTimeout past 2^31-1 ms overflows to 1 ms and aborts the window at once.
  const MAX_TIMER_MS = 2_147_483_647;
  const armWindow = (at: number) => {
    clearTimeout(windowTimer);
    const left = at - Date.now();
    if (left <= 0) return;
    const controller = windowAbort;
    windowTimer = setTimeout(() => {
      if (controller !== windowAbort) return;
      if (Date.now() >= at) controller.abort();
      else armWindow(at);
    }, Math.min(left, MAX_TIMER_MS));
  };
  armWindow(deadline);

  const shrinkWindow = (at: number) => {
    collectUntil = at;
    const previous = windowAbort;
    windowAbort = new AbortController();
    armWindow(at);
    previous.abort();
  };
  const note = (id: string, value: EndedWait) => {
    if (ended.has(id)) return;
    ended.set(id, value);
    if (!sawEnd) {
      sawEnd = true;
      shrinkWindow(Math.min(Date.now() + graceSeconds * 1000, deadline));
    }
  };
  const markUnreachable = () => {
    if (unreachable) return;
    unreachable = true;
    windowAbort.abort();
  };
  const stillDown = async (): Promise<boolean> => {
    downSince ??= Date.now();
    if (Date.now() - downSince >= DOWN_GRACE_MS || Date.now() >= deadline) return false;
    const wait = Math.min(retryMs, Math.max(0, deadline - Date.now()));
    retryMs = Math.min(retryMs * 2, 2000);
    // The collect window may already be closed. That abort must not skip this pause;
    // the deadline still caps it.
    await new Promise((resolve) => setTimeout(resolve, wait));
    return !unreachable && Date.now() < deadline;
  };

  const poll = async (id: string): Promise<void> => {
    let settled = false;
    while (!ended.has(id) && !unreachable && !settled) {
      const finalCheck = Date.now() >= collectUntil;
      const holder = await waitingInstance(config.pidFile, Math.max(1, Math.min(PROBE_TIMEOUT_MS, Math.max(1, deadline - Date.now()))));
      if (ended.has(id) || unreachable) return;
      if (!holder) {
        if (await stillDown()) continue;
        markUnreachable();
        return;
      }
      if (holder.port === null) {
        if (finalCheck) { settled = true; return; }
        await delay(Math.min(retryMs, Math.max(0, collectUntil - Date.now())), windowAbort.signal);
        retryMs = Math.min(retryMs * 2, 2000);
        continue;
      }
      const waitMs = Math.min(55_000, Math.max(0, collectUntil - Date.now()));
      const signals = [AbortSignal.timeout(finalCheck ? 5_000 : 70_000)];
      if (!finalCheck) signals.push(windowAbort.signal);
      try {
        const response = await fetch(`http://${config.host}:${holder.port}/turns/${id}?wait=${waitMs}`, { signal: AbortSignal.any(signals) });
        const body = await response.json() as Digest & { error?: string };
        downSince = null;
        if (!response.ok) {
          note(id, { kind: 'error', error: body.error ?? `HTTP ${response.status}` });
          return;
        }
        if (TERMINAL_WAIT.has(body.status)) {
          note(id, { kind: 'digest', digest: body });
          return;
        }
        if (finalCheck || Date.now() >= collectUntil) { settled = true; return; }
      } catch (error) {
        if (ended.has(id) || unreachable) return;
        if (isUnreachableConnection(error)) {
          if (await stillDown()) continue;
          markUnreachable();
          return;
        }
        if (finalCheck) { settled = true; return; }
        if (Date.now() >= collectUntil) continue;
        await delay(Math.min(250, Math.max(0, collectUntil - Date.now())), windowAbort.signal);
      }
    }
  };

  try {
    await Promise.all(turns.map((id) => poll(id)));
  } finally {
    clearTimeout(windowTimer);
  }
  if (unreachable) {
    for (const id of turns) if (!ended.has(id)) ended.set(id, { kind: 'error', error: 'orch is not running' });
  }
  const running = turns.filter((id) => !ended.has(id));
  const ordered = turns.filter((id) => ended.has(id));
  if (!unreachable && ended.size === 0) {
    process.stdout.write(`${json ? JSON.stringify({ turns: [], running }, null, 1) : waitAgain(running)}\n`);
    return 3;
  }
  if (json) {
    const payload = ordered.map((id) => {
      const value = ended.get(id)!;
      return value.kind === 'digest' ? value.digest : { turn: id, error: value.error };
    });
    process.stdout.write(`${JSON.stringify({ turns: payload, running }, null, 1)}\n`);
  } else {
    const blocks = ordered.map((id) => {
      const value = ended.get(id)!;
      return value.kind === 'digest' ? formatDigest(value.digest) : formatWaitError(id, value.error);
    });
    const body = blocks.join('\n\n');
    process.stdout.write(running.length ? `${body}\n${waitAgain(running)}\n` : `${body}\n`);
  }
  if (unreachable) return 1;
  const failed = ordered.some((id) => {
    const value = ended.get(id)!;
    return value.kind === 'error' || value.digest.status !== 'done';
  });
  return failed ? 1 : 0;
}

const command = process.argv[2];
if (command === 'serve') {
  let lanPort: number;
  try {
    lanPort = readServeLanPort(process.argv.slice(3));
  } catch (error) {
    // One line always: a value may carry a line break (lesson 16461).
    process.stderr.write(`${(error as Error).message.replaceAll(/[\r\n]+/g, ' ')}\n`);
    process.exit(1);
  }
  await serve(lanPort);
}
else if (command === 'restart') process.exit(await restart(process.argv.slice(3)));
else if (command === 'status') await status();
else if (command === 'stop') {
  try { await stopWindows(); }
  catch (error) { process.stderr.write(`stop: ${(error as Error).message}\n`); process.exitCode = 1; }
}
else if (command === 'check-on') process.exitCode = await checkOn(process.argv.slice(3));
else if (command === 'smoke') process.exit(await smoke(process.argv.slice(3)));
else if (command === 'pause' || command === 'unpause' || command === 'paused') {
  const args = process.argv.slice(3);
  const reason = args[2]?.trim();
  if (command === 'paused' ? args.length !== 0 : command === 'pause'
    ? args.length !== 3 || !FAMILIES.includes(args[0] as Family) || args[1] !== '--reason' || !reason || reason.length > 200
    : args.length !== 1 || !FAMILIES.includes(args[0] as Family)) {
    process.stderr.write(command === 'pause' && reason && reason.length > 200
      ? 'pause reason must be at most 200 characters after trim\n'
      : 'usage: node ops/orchestrator/src/main.ts pause <family> --reason "<text>"|unpause <family>|paused\n');
    process.exitCode = 64;
  } else {
    const stateDir = loadConfig().stateDir;
    if (command !== 'paused') changePaused(stateDir, args[0] as Family, command === 'pause', args[2]);
    process.stdout.write(`${JSON.stringify(readPauseRecords(stateDir).map((pause) => formatPause(pause)))}\n`);
  }
}
else if (command === 'language') {
  const args = process.argv.slice(3);
  const asked = args[0];
  if (args.length > 1 || (asked !== undefined && !(LANGUAGE_MODES as readonly string[]).includes(asked))) {
    process.stderr.write('usage: node ops/orchestrator/src/main.ts language [off|flag|enforce]\n');
    process.exit(2);
  }
  const stateDir = loadConfig().stateDir;
  if (asked !== undefined) writeLanguageMode(stateDir, asked as LanguageMode);
  const read = readLanguageMode(stateDir);
  process.stdout.write(`${JSON.stringify({ mode: read.mode, file: languageFile(stateDir), ...(read.fault ? { fault: read.fault } : {}) })}\n`);
}
else if (command === 'hosts') {
  const args = process.argv.slice(3);
  const HOSTS_USAGE = 'usage: node ops/orchestrator/src/main.ts hosts list|hosts add <name> --ssh <alias> --platform <p> --repo <path> --node <path> [--native <json>] [--replace]|hosts remove <name>|hosts probe <name> (hosts add also takes --no-probe: write with no probe)';
  // add and remove print the registry as written; the writer stays the one validator of entries.
  const printHosts = (hosts: Record<string, RemoteHost>) => process.stdout.write(`${JSON.stringify(hosts)}\n`);
  try {
    if (args[0] === 'list' && args.length === 1) printHosts(readHosts(loadConfig().stateDir));
    else if (args[0] === 'remove' && args.length === 2) printHosts(removeHost(args[1]!, loadConfig().stateDir));
    else if (args[0] === 'probe' && args.length === 2) {
      const probe = await probeHost(readHost(args[1]!, loadConfig().stateDir));
      process.stdout.write(`${JSON.stringify({ host: args[1], ...probe })}\n`);
      if (probe.ok === false) process.exitCode = 1;
    }
    else if (args[0] === 'add') {
      const name = args[1];
      if (name === undefined || name.startsWith('--')) throw new Error(HOSTS_USAGE);
      const flags = new Map<string, string>();
      let replace = false;
      let noProbe = false;
      for (let i = 2; i < args.length; i++) {
        const flag = args[i]!;
        if (flag === '--no-probe') {
          if (noProbe) throw new Error(HOSTS_USAGE);
          noProbe = true;
          continue;
        }
        if (flag === '--replace') {
          if (replace) throw new Error(HOSTS_USAGE);
          replace = true;
          continue;
        }
        if (!['--ssh', '--platform', '--repo', '--node', '--native'].includes(flag) || flags.has(flag)) throw new Error(HOSTS_USAGE);
        // A value never starts with '--': that is the next flag, so this one has no value.
        if (args[i + 1] === undefined || args[i + 1]!.startsWith('--')) throw new Error(`hosts add: ${flag} needs a value`);
        flags.set(flag, args[++i]!);
      }
      const missing = ['--ssh', '--platform', '--repo', '--node'].find((flag) => !flags.has(flag));
      if (missing) throw new Error(`hosts add: missing required flag ${missing}`);
      let native: RemoteHost['native'] | undefined;
      if (flags.has('--native')) {
        try { native = JSON.parse(flags.get('--native')!) as RemoteHost['native']; }
        catch (error) { throw new Error(`hosts add: --native must be a JSON object: ${(error as Error).message}`); }
      }
      const host: RemoteHost = {
        ssh: flags.get('--ssh')!, platform: flags.get('--platform')! as NodeJS.Platform,
        repo: flags.get('--repo')!, node: flags.get('--node')!, ...(native !== undefined ? { native } : {}),
      };
      const stateDir = loadConfig().stateDir;
      let proof = `'${name}' is written with no probe: the host is not proved (hosts probe ${name} proves it)`;
      if (!noProbe) {
        // The entry's rules come before ssh sees its alias and node path; the writer applies them again to the bytes.
        const file = `${stateDir}/hosts.json`;
        checkHosts({ [name]: host }, file);
        // A name that exists is refused before ssh starts: a failed probe must not hide that reason.
        if (!replace) refuseExistingHost(name, readHosts(stateDir), file);
        const probe = await probeHost(host);
        if (probe.ok === false) throw new Error(`hosts add: probe of '${name}' failed, nothing written: ${probe.reason}: ${probe.error}`);
        proof = `'${name}' answers with node ${probe.version}`;
      }
      printHosts(addHost(name, host, { replace, stateDir }));
      process.stderr.write(`hosts add: ${proof}\n`);
    } else throw new Error(HOSTS_USAGE);
  } catch (error) {
    // One line always: the writer's message or a caller's argument may carry a line break.
    process.stderr.write(`hosts: ${(error as Error).message.replaceAll(/[\r\n]+/g, ' ')}\n`);
    process.exitCode = 1;
  }
}
else if (command === 'roles') {
  const args = process.argv.slice(3);
  const ROLES_USAGE = 'usage: node ops/orchestrator/src/main.ts roles show [--json]|roles set <role> <family> <model> [<effort>]|roles unset <role> <family>|roles reset <role>|roles preset <tier> --families <a,b,...> [--dry-run] [--json]';
  // A value that starts with -- is a mistaken flag, not a model or an effort (lesson 16461).
  const notFlag = (verb: string, values: string[]) => {
    if (values.some((value) => value.startsWith('--'))) throw new Error(`${verb}: a value must not start with --`);
  };
  try {
    if (args[0] === 'show' && (args.length === 1 || (args.length === 2 && args[1] === '--json'))) {
      const rows = describeRoles();
      if (args.length === 2) {
        const body: Record<string, unknown> = {};
        for (const row of rows) body[row.role] = { mark: row.mark, cells: row.cells };
        process.stdout.write(`${JSON.stringify(body)}\n`);
      } else {
        const lines: string[] = [];
        for (const row of rows) {
          lines.push(`${row.role} ${row.mark}`);
          const cells = Object.entries(row.cells);
          if (cells.length === 0) lines.push('  no family');
          for (const [family, cell] of cells) lines.push(`  ${family} ${cell.model}${cell.effort ? ` ${cell.effort}` : ''}`);
        }
        process.stdout.write(`${lines.join('\n')}\n`);
      }
    } else if (args[0] === 'set' && (args.length === 4 || args.length === 5)) {
      notFlag('set', args.slice(1));
      // A model outside the preset catalogue is a warning, not a refusal (task 2275 slice M2b): the
      // write still happens. The warning is best-effort — a presets file that cannot be read must not
      // block a set; `roles preset` owns refusing that file.
      try {
        if ((FAMILIES as readonly string[]).includes(args[2]!) && !knownModel(args[2]! as Family, args[3]!)) {
          process.stderr.write(`roles: warning: model '${args[3]}' is not one the team presets run on ${args[2]}\n`);
        }
      } catch { /* the warning alone is dropped when it cannot be computed */ }
      process.stdout.write(`${JSON.stringify(setRole(args[1]!, args[2]!, args[3]!, args[4]))}\n`);
    } else if (args[0] === 'preset') {
      // Task 2275 slice M2b: the whole roles.json from the team presets for the families the user
      // has. Every check runs before the writer, and the writer's own refusals (a loader fault, a
      // busy lock) throw before its rename, so a refusal writes nothing. Exit 2, not 1, so a
      // script can tell a refused preset from a refused cell edit.
      const PRESET_USAGE = 'usage: node ops/orchestrator/src/main.ts roles preset <tier> --families <family,...> [--dry-run] [--json]  tier: economy, balanced, strong';
      try {
        const rest = args.slice(1);
        const tier = rest[0];
        if (tier === undefined || tier.startsWith('--')) throw new Error(PRESET_USAGE);
        let families: string | undefined;
        let dryRun = false;
        let json = false;
        for (let i = 1; i < rest.length; i++) {
          // A value that starts with -- is a mistaken flag, not a family list (lesson 16461).
          if (rest[i] === '--families' && families === undefined && rest[i + 1] !== undefined && !rest[i + 1]!.startsWith('--')) families = rest[++i];
          else if (rest[i] === '--dry-run' && !dryRun) dryRun = true;
          else if (rest[i] === '--json' && !json) json = true;
          else throw new Error(PRESET_USAGE);
        }
        if (families === undefined) throw new Error(PRESET_USAGE);
        const presets = teamPresets();
        if (!Object.hasOwn(presets, tier)) throw new Error(`unknown tier '${tier}'; expected one of ${Object.keys(presets).join(', ')}`);
        if (families === '') throw new Error('--families is an empty list; name at least one family, e.g. --families glm,kimi');
        const names = families.split(',');
        for (const name of names) {
          if (!(FAMILIES as readonly string[]).includes(name)) throw new Error(`unknown family '${name}'; expected one of ${FAMILIES.join(', ')}`);
        }
        const built = buildMatrix(names as Family[], presets[tier as PresetTier]);
        if (!dryRun) writeRolesMatrix(built.matrix);
        if (json) process.stdout.write(`${JSON.stringify(built)}\n`);
        else {
          const lines: string[] = [];
          for (const [role, row] of Object.entries(built.matrix)) {
            lines.push(`${role} file`);
            const cells = Object.entries(row);
            if (cells.length === 0) lines.push('  no family');
            for (const [family, cell] of cells) lines.push(`  ${family} ${cell.model}${cell.effort ? ` ${cell.effort}` : ''}`);
          }
          for (const role of built.missing) lines.push(`no family serves ${role}`);
          process.stdout.write(`${lines.join('\n')}\n`);
        }
      } catch (error) {
        process.stderr.write(`roles: ${(error as Error).message.replaceAll(/[\r\n]+/g, ' ')}\n`);
        process.exitCode = 2;
      }
    } else if (args[0] === 'unset' && args.length === 3) {
      notFlag('unset', args.slice(1));
      process.stdout.write(`${JSON.stringify(unsetRole(args[1]!, args[2]!))}\n`);
    } else if (args[0] === 'reset' && args.length === 2) {
      notFlag('reset', args.slice(1));
      process.stdout.write(`${JSON.stringify(resetRole(args[1]!))}\n`);
    } else throw new Error(ROLES_USAGE);
  } catch (error) {
    process.stderr.write(`roles: ${(error as Error).message.replaceAll(/[\r\n]+/g, ' ')}\n`);
    process.exitCode = 1;
  }
}
else if (command === 'wait') process.exit(await wait(process.argv.slice(3)));
else if (command === 'prune') {
  const args = process.argv.slice(3);
  let dryRun = false;
  let caches = false;
  let targets = false;
  let onlySeat: string | undefined;
  let olderThanMs: number | undefined;
  try {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--dry-run' && !dryRun) dryRun = true;
      else if (args[i] === '--targets' && !targets && !caches && onlySeat === undefined && olderThanMs === undefined) targets = true;
      else if (args[i] === '--caches' && !caches && !targets && onlySeat === undefined && olderThanMs === undefined) caches = true;
      else if (args[i] === '--older-than' && olderThanMs === undefined && !caches && !targets && args[i + 1]) olderThanMs = parseOlderThan(args[++i]);
      else if (args[i] === '--seat' && !caches && !targets && onlySeat === undefined && args[i + 1]) onlySeat = args[++i];
      else throw new Error('usage: prune [--dry-run] [--seat <id>] [--older-than 24h|7d] | prune --caches|--targets [--dry-run]');
    }
    if (onlySeat && !dryRun) throw new Error('--seat requires --dry-run');
    const config = loadConfig();
    if (!targets && !existsSync(config.dbFile)) throw new Error(`orch store does not exist: ${config.dbFile}`);
    if (targets) {
      const checkout = (await repoOf(fileURLToPath(new URL('..', import.meta.url)))).main;
      const result = await sweepTargets({ checkout, stateDir: config.stateDir, dryRun });
      process.stdout.write(`${JSON.stringify({ event: 'daemon.target_sweep', ...(result ?? { skipped: [{ reason: 'target sweep already running' }] }) })}\n`);
    } else if (caches) {
      // Caches of CLOSED seats only, which the daemon no longer runs in: no lock needed.
      const store = openStore(config.dbFile);
      try {
        for (const seat of store.listSeats('closed')) {
          const worktree = ownedWorktree(config.stateDir, seat);
          if (!worktree) continue;
          try {
            const cleanup = await clearCaches(worktree, { dryRun });
            if (cleanup.codegraphDaemon) noteCodegraphDaemonStop(cleanup.codegraphDaemon, seat.id, worktree, store);
            process.stdout.write(`${JSON.stringify({ seat: seat.id, worktree, dryRun, ...cleanup })}\n`);
          } catch (error) {
            process.stdout.write(`${JSON.stringify({ seat: seat.id, worktree, dryRun, error: (error as Error).message })}\n`);
            process.exitCode = 1;
          }
        }
      } finally { store.close(); }
    } else {
      // The daemon may be creating or closing seats: destructive CLI pruning
      // holds its single-instance lock, or refuses while serve owns it.
      const lock = dryRun ? null : await acquireLock(config.pidFile);
      if (lock && !lock.ok) throw new Error('orch is running; stop it before destructive prune');
      try {
        const store = openStore(config.dbFile);
        try {
          const candidates = store.listSeats().filter((seat) => landable(seat.role) && (!onlySeat || seat.id === onlySeat));
          if (onlySeat && !candidates.length) throw new Error(`no coder seat '${onlySeat}'`);
          for (const seat of candidates) {
            try {
              const result = dryRun ? await inspectCoder(config.stateDir, seat, olderThanMs)
                : await pruneCoder(store, config.stateDir, seat.id, olderThanMs);
              process.stdout.write(`${JSON.stringify(result)}\n`);
            } catch (error) {
              process.stdout.write(`${JSON.stringify({ seat: seat.id, remove: false, reason: `inspection failed: ${(error as Error).message}`, lost: [] })}\n`);
              process.exitCode = 1;
            }
          }
          if (!onlySeat) for (const entry of unknownMirrors(config.stateDir, store.listSeats())) process.stdout.write(`${JSON.stringify(entry)}\n`);
        } finally { store.close(); }
      } finally { if (lock?.ok) releaseLock(config.pidFile); }
    }
  } catch (error) { process.stderr.write(`prune: ${(error as Error).message}\n`); process.exitCode = 1; }
}
else if (command === 'sweep-host-worktrees') {
  let host: string | undefined;
  let dryRun = false;
  try {
    const args = process.argv.slice(3);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--dry-run' && !dryRun) dryRun = true;
      else if (args[i] === '--host' && host === undefined && args[i + 1] && !args[i + 1].startsWith('--')) host = args[++i];
      else throw new Error('usage: sweep-host-worktrees [--host <name>] [--dry-run]');
    }
    const config = loadConfig();
    if (!existsSync(config.dbFile)) throw new Error(`orch store does not exist: ${config.dbFile}`);
    // Only hosts.json entries are swept; the daemon host is not in that registry.
    const store = openStore(config.dbFile);
    try {
      const events = await sweepConfiguredHostWorktrees({
        host, stateDir: config.stateDir, dryRun, seats: () => store.listSeats(),
        log: event => process.stdout.write(`${JSON.stringify(event)}\n`),
      });
      if (events === null) process.stdout.write(`${JSON.stringify({ action: 'skip', reason: 'host worktree sweep already running' })}\n`);
      else if (events.some(event => event.action === 'error')) process.exitCode = 1;
    } finally { store.close(); }
  } catch (error) {
    process.stderr.write(`sweep-host-worktrees: ${(error as Error).message.replace(/[\r\n]+/g, ' ')}\n`);
    process.exitCode = 1;
  }
}
else if (command === 'tmp-sweep') {
  const args = process.argv.slice(3);
  let dryRun = false;
  try {
    for (const arg of args) {
      if (arg === '--dry-run' && !dryRun) dryRun = true;
      else throw new Error('usage: tmp-sweep [--dry-run]');
    }
    const config = loadConfig();
    let db: ReturnType<typeof openReadOnlyStore> | undefined;
    try { db = openReadOnlyStore(config.dbFile); }
    catch { /* An unreadable seat set must keep every spill, not stop other tmp cleanup. */ }
    try {
      const openSeatIds = db ? () => new Set((db.prepare("SELECT id FROM seats WHERE status != 'closed'").all() as { id: string }[]).map((row) => row.id)) : undefined;
      const result = await sweepTmp({ stateDir: config.stateDir, dryRun, openSeatIds });
      process.stdout.write(`${JSON.stringify({ event: 'daemon.tmp_sweep', ...(result ?? { skipped: [{ reason: 'tmp sweep already running' }] }) })}\n`);
    } finally { db?.close(); }
  } catch (error) { process.stderr.write(`tmp-sweep: ${(error as Error).message}\n`); process.exitCode = 1; }
}
else if (command === 'backup-sweep') {
  const args = process.argv.slice(3);
  let dryRun = false;
  try {
    for (const arg of args) {
      if (arg === '--dry-run' && !dryRun) dryRun = true;
      else throw new Error('usage: backup-sweep [--dry-run]');
    }
    const config = loadConfig();
    // A removal in progress must keep its backup even from a manual run: the
    // marker set comes from the store, read-only.
    let protectedPaths: () => string[] = () => [];
    if (existsSync(config.dbFile)) {
      const db = openReadOnlyStore(config.dbFile);
      try {
        const rows = db.prepare("SELECT data FROM seats WHERE json_type(data, '$.autoPruned') = 'object'").all() as { data: string }[];
        const seats = rows.map((row) => ({ data: JSON.parse(row.data) }));
        protectedPaths = () => [...protectedBackupPaths(seats)];
      } finally { db.close(); }
    }
    const result = await sweepBackups({ stateDir: config.stateDir, dryRun, protectedPaths });
    process.stdout.write(`${JSON.stringify({ event: 'daemon.backup_sweep', ...(result ?? { skipped: [{ reason: 'backup sweep already running' }] }) })}\n`);
  } catch (error) { process.stderr.write(`backup-sweep: ${(error as Error).message}\n`); process.exitCode = 1; }
}
else if (command === 'pick-stats') {
  const args = process.argv.slice(3);
  let since: string | undefined;
  let json = false;
  try {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--json' && !json) json = true;
      else if (args[i] === '--since' && since === undefined && args[i + 1]) {
        const value = args[++i];
        if (!/^[1-9]\d*d$/.test(value)) throw new Error('--since needs a positive number of days, e.g. 30d');
        const ms = Number(value.slice(0, -1)) * 86_400_000;
        if (!Number.isSafeInteger(ms)) throw new Error('--since is too large');
        since = new Date(Date.now() - ms).toISOString();
      } else throw new Error('usage: pick-stats [--since 30d] [--json]');
    }
    const { dbFile } = loadConfig();
    const result = readPickStats(dbFile, since);
    const coderRetained = await readCoderRetained(dbFile);
    process.stdout.write(`${json ? JSON.stringify({ ...result, coderRetained }) : formatPickStats(result, coderRetained)}\n`);
  } catch (error) { process.stderr.write(`pick-stats: ${(error as Error).message}\n`); process.exitCode = 1; }
}
else if (command === 'lesson-stats') {
  const args = process.argv.slice(3);
  try {
    let days = 7;
    let seenSince = false;
    let json = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--json' && !json) json = true;
      else if (args[i] === '--since' && !seenSince && args[i + 1]) {
        const value = args[++i];
        if (!/^[1-9]\d*d$/.test(value)) throw new Error('--since needs a positive number of days, e.g. 7d');
        days = Number(value.slice(0, -1));
        if (!Number.isSafeInteger(days * 86_400_000)) throw new Error('--since is too large');
        seenSince = true;
      } else throw new Error('usage: lesson-stats [--since 7d] [--json]');
    }
    const until = new Date();
    const since = new Date(until.getTime() - days * 86_400_000).toISOString();
    const result = await readLessonStats(loadConfig().dbFile, since, until.toISOString());
    process.stdout.write(`${json ? JSON.stringify(result) : formatLessonStats(result)}\n`);
  } catch (error) { process.stderr.write(`lesson-stats: ${(error as Error).message}\n`); process.exitCode = 1; }
}
else if (command === 'role-stats') {
  const args = process.argv.slice(3);
  try {
    let days = 7;
    let seenSince = false;
    let json = false;
    let writeTiers = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--json' && !json) json = true;
      else if (args[i] === '--write-tiers' && !writeTiers) writeTiers = true;
      else if (args[i] === '--since' && !seenSince && args[i + 1]) {
        const value = args[++i];
        if (!/^[1-9]\d*d$/.test(value)) throw new Error('--since needs a positive number of days, e.g. 7d');
        days = Number(value.slice(0, -1));
        if (!Number.isSafeInteger(days * 86_400_000)) throw new Error('--since is too large');
        seenSince = true;
      } else throw new Error('usage: role-stats [--since 7d] [--json] [--write-tiers]');
    }
    const until = new Date();
    const since = new Date(until.getTime() - days * 86_400_000).toISOString();
    const config = loadConfig();
    const db = openReadOnlyStore(config.dbFile);
    try {
      const result = roleStats(db, since, until.toISOString());
      if (!writeTiers) process.stdout.write(`${json ? JSON.stringify(result, null, 2) : formatRoleStats(result)}\n`);
      else {
        const tiers = writeTierFile(config.stateDir, result, until);
        const number = (value: number | null) => value === null ? '—' : value.toFixed(3);
        if (json) process.stdout.write(`${JSON.stringify({ ...result, tiers: { file: tiers.file, cells: tiers.cells.length,
          manual: Object.keys(tiers.manual).length, entered: tiers.entered.map(cellKey), left: tiers.left.map(cellKey) } }, null, 2)}\n`);
        else {
          const lines = [formatRoleStats(result), `role-quality: ${tiers.cells.length} cells to ${tiers.file} (${Object.keys(tiers.manual).length} manual kept)`];
          for (const cell of tiers.entered) lines.push(`role-quality: ${cellKey(cell)} entered WEAK (mean ${number(cell.mean)}, failShare ${(cell.failShare * 100).toFixed(1)}%, p25 ${number(cell.p25)}, median ${number(cell.median)})`);
          for (const cell of tiers.left) lines.push(`role-quality: ${cellKey(cell)} left WEAK`);
          if (!tiers.entered.length && !tiers.left.length) lines.push('role-quality: no cell entered or left WEAK');
          process.stdout.write(`${lines.join('\n')}\n`);
        }
      }
    } finally { db.close(); }
  } catch (error) { process.stderr.write(`role-stats: ${(error as Error).message}\n`); process.exitCode = 1; }
}
else if (command === 'lesson-repeat') {
  const args = process.argv.slice(3);
  let lesson: string | undefined;
  let duplicateOf: string | undefined;
  let json = false;
  const validId = (value: string | undefined) => value !== undefined && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
  try {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--json' && !json) json = true;
      else if (args[i] === '--lesson' && lesson === undefined && args[i + 1]) lesson = args[++i];
      else if (args[i] === '--duplicate-of' && duplicateOf === undefined && args[i + 1]) duplicateOf = args[++i];
      else throw new Error('usage: lesson-repeat --lesson <L> --duplicate-of <N> [--json]');
    }
    if (!validId(lesson) || !validId(duplicateOf)) throw new Error('usage: lesson-repeat --lesson <L> --duplicate-of <N> [--json]');
    if (lesson === duplicateOf) throw new Error(`lesson #${lesson} cannot duplicate itself`);
    const config = loadConfig();
    const holder = await runningInstance(config.pidFile);
    if (!holder) throw new Error('orch daemon is not running');
    if (holder.health === null) throw new Error('orch daemon is busy; health did not answer');
    const response = await fetch(`http://${config.host}:${holder.port}/lesson-repeat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lesson, duplicateOf }), signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`daemon returned ${response.status}: ${await response.text()}`);
    const result = await response.json() as { provenance: boolean; recorded: boolean; task: { state: string; id: number | null } | null };
    process.stdout.write(`${json ? JSON.stringify(result) : !result.provenance ? `no orch provenance for #${lesson}` : `repeat ${result.recorded ? 'recorded' : 'not recorded'} for #${lesson} duplicate of #${duplicateOf}; task ${result.task ? `${result.task.id === null ? 'unknown id' : `#${result.task.id}`} (${result.task.state})` : 'none'}`}\n`);
  } catch (error) { process.stderr.write(`lesson-repeat: ${(error as Error).message}\n`); process.exitCode = 1; }
}
else if (command === 'lead-lessons') {
  const args = process.argv.slice(3);
  const usage = 'usage: lead-lessons --session <id> [--applied <lessonId>=true|false --why "<text>"]';
  try {
    let session: string | undefined;
    let applied: { id: string; value: boolean } | undefined;
    let why: string | undefined;
    // A value that starts with -- is a misplaced flag, never a value (task 2275 slice H1b).
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--session' && session === undefined && args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) session = args[++i];
      else if (args[i] === '--why' && why === undefined && args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) why = args[++i];
      else if (args[i] === '--applied' && applied === undefined && args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) {
        const answer = /^([1-9]\d{0,17})=(true|false)$/.exec(args[++i]!);
        if (!answer) throw new Error('--applied needs <lessonId>=true|false');
        applied = { id: answer[1]!, value: answer[2] === 'true' };
      } else throw new Error(usage);
    }
    if (!session || (applied !== undefined) !== (why !== undefined)) throw new Error(usage);
    const store = openStore(loadConfig().dbFile);
    try {
      if (applied === undefined) {
        const rows = store.leadLessonDeliveries(session);
        if (!rows.length) process.stdout.write(`no lessons recorded for session '${session}'\n`);
        for (const row of rows) {
          const answer = row.applied === null ? 'unreported' : row.applied ? 'applied' : 'not applied';
          process.stdout.write(`#${row.lesson_id} ${row.mode} ${row.file} at ${row.delivered_at} — ${answer}${row.why ? `: ${row.why}` : ''}\n`);
        }
      } else {
        const text = (why ?? '').trim();
        if (!text || text.length > 400) throw new Error('--why must be 1..400 characters after trim');
        if (!store.recordLeadLessonApplied(session, applied.id, applied.value, text)) {
          const row = store.leadLessonDeliveries(session).find((r) => r.lesson_id === applied!.id);
          throw new Error(row ? `lesson #${applied.id} was delivered ${row.mode} only; only a full delivery is answered` : `no lesson #${applied.id} recorded for session '${session}'`);
        }
        process.stdout.write(`lesson #${applied.id} ${applied.value ? 'applied' : 'not applied'} for session '${session}'\n`);
      }
    } finally { store.close(); }
  } catch (error) { process.stderr.write(`lead-lessons: ${(error as Error).message}\n`); process.exitCode = 1; }
}
else if (command === 'review-plan') {
  if (process.argv.length !== 4) {
    process.stderr.write('usage: node ops/orchestrator/src/main.ts review-plan <coder-seat>\n');
    process.exitCode = 64;
  } else {
    const store = openStore(loadConfig().dbFile);
    try {
      const plan = await reviewPlan(store, { seat: process.argv[3] });
      // Multi-theme output exposes each independently scoped reviewer set; legacy output stays compact.
      process.stdout.write(`${JSON.stringify(plan, null, plan.themes ? 2 : undefined)}\n`);
    }
    catch (error) { process.stderr.write(`review-plan: ${(error as Error).message}\n`); process.exitCode = 1; }
    finally { store.close(); }
  }
}
else if (command === 'jev-balance') {
  const amount = process.argv[3];
  if (process.argv.length !== 4 || !/^(?:\d+)(?:\.\d+)?$/.test(amount)) {
    process.stderr.write('usage: node ops/orchestrator/src/main.ts jev-balance <non-negative usd>\n');
    process.exitCode = 64;
  } else {
    const saved = await setJevBalance(Number(amount));
    process.stdout.write(`${JSON.stringify(saved)}\n`);
  }
}
else {
  process.stderr.write('usage: node ops/orchestrator/src/main.ts serve [--lan-port <off|port>]|restart --when-idle [--as <handle> --session <id> --note "<text>"]|restart --cancel|status|check-on <host> [--repo <lead checkout>] -- <command...>|stop|pick-stats [--since 30d] [--json]|lesson-stats [--since 7d] [--json]|role-stats [--since 7d] [--json] [--write-tiers]|lesson-repeat --lesson L --duplicate-of N [--json]|lead-lessons --session <id> [--applied <lessonId>=true|false --why "<text>"]|prune [--dry-run] [--seat <id>] [--older-than 7d]|prune --caches [--dry-run]|prune --targets [--dry-run]|pause <family> --reason "<text>"|unpause <family>|paused|language [off|flag|enforce]|hosts list|hosts add <name> --ssh <alias> --platform <p> --repo <path> --node <path> [--native <json>] [--replace]|hosts remove <name>|hosts probe <name> (hosts add also takes --no-probe: write with no probe)|roles show [--json]|roles set <role> <family> <model> [<effort>]|roles unset <role> <family>|roles reset <role>|roles preset <tier> --families <a,b,...> [--dry-run] [--json]|jev-balance <usd>|wait <turn> [<turn>...] [--grace-seconds n] [--timeout-minutes n] [--json]|smoke [--family f,..] [--harness native|pi] [--model m] [--effort e] [--timeout ms] [--cwd dir]\n');
  process.exit(64);
}
