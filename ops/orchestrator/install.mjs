#!/usr/bin/env node
// Install orch as a per-user background service. Idempotent.
//
//   node ops/orchestrator/install.mjs              install (or refresh) and start
//   node ops/orchestrator/install.mjs --dry        print what would be written; touch nothing
//   node ops/orchestrator/install.mjs --uninstall  stop and remove
//
// macOS: a LaunchAgent (RunAtLoad, KeepAlive), stdout/stderr in the state dir.
// Windows: a Task Scheduler task at logon, run through `conhost --headless` so
// no console window appears, restarted on failure.
//
// Test and installer seams: --home, --platform, --repo, --node, --user, --json,
// --no-activate (write the files, never call launchctl/schtasks). The harness
// installer passes --no-activate whenever it runs against a fixture HOME or a
// foreign --platform, because launchctl and schtasks act on the REAL session
// whatever HOME says.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalSearchDirs, resolveOnPath } from '../bootstrap/resolve-runtime-path.mjs';
import { currentUserSid, renderTaskXml as renderScheduledTaskXml, queryTask, endTask, createTask, runTask, deleteTask } from '../bootstrap/win-task.mjs';
import { harnessLabel, readHarnessConfig } from '../../scripts/lib/harness-config.mjs';
import { codeHash } from './code-hash.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The service names come from names.prefix of this checkout's harness config
// (ops/bootstrap/harness.config.json): read at FIRST USE, never at module load,
// so an import that only wants `freshness` (scripts/test-orch-core.mjs) reads
// no config and a test fixture without one still loads. A bad config throws;
// a failed read is not cached. An explicit prefix skips the config entirely.
// The config is cached whole so renderPlist reads orch.lanPort from the same
// read that resolved the prefix.
let cachedConfig;
function checkoutConfig() {
  return cachedConfig ??= readHarnessConfig({ repoRoot: path.resolve(HERE, '..', '..') });
}
function serviceNames(prefix) {
  const value = prefix ?? checkoutConfig().names.prefix;
  return { prefix: value, label: harnessLabel({ prefix: value, name: 'orch' }), taskName: `${value}-orch` };
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * launchd starts an agent with PATH=/usr/bin:/bin:/usr/sbin:/sbin, where no
 * provider CLI lives: from phase 2 the daemon spawns `pi`, `codex`, `claude`,
 * and the first seat created by a lead failed with "'pi' is not on PATH"
 * (2026-09-22). The daemon gets the harness's own search list instead.
 */
export function daemonPath(searchDirs) {
  return [...new Set([...searchDirs, '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
}

export function renderPlist({ node, entry, workdir, stateDir, pathValue, prefix }) {
  const { label } = serviceNames(prefix);
  // An explicit prefix needs no config file (memory #16177); the LAN port is a
  // config key, so it rides the same read and is absent when the prefix is explicit.
  const lanPort = prefix === undefined ? checkoutConfig().orch?.lanPort : undefined;
  const lanEnv = lanPort === undefined ? '' : `    <key>ORCH_LAN_PORT</key>\n    <string>${xmlEscape(String(lanPort))}</string>\n`;
  const args = [node, entry, 'serve'].map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(workdir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(pathValue)}</string>
${lanEnv}  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.posix.join(stateDir, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.posix.join(stateDir, 'launchd.err.log'))}</string>
</dict>
</plist>
`;
}

/** Windows cmd-line quoting for one argument (no trailing-backslash traps in our paths). */
function winQuote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

export function renderTaskXml({ node, entry, workdir, user, prefix }) {
  const { prefix: resolved, taskName } = serviceNames(prefix);
  // Same gate as renderPlist: the key is written only when it is present and the
  // prefix comes from the config. The flag is bare, like --headless; the value is
  // winQuote'd, then xmlEscape turns those quotes into &quot; in the Arguments element.
  const lanPort = prefix === undefined ? checkoutConfig().orch?.lanPort : undefined;
  const command = ['--headless', winQuote(node), winQuote(entry), 'serve'];
  if (lanPort !== undefined) command.push('--lan-port', winQuote(String(lanPort)));
  const args = command.join(' ');
  return renderScheduledTaskXml({
    taskName, command: '%SystemRoot%\\System32\\conhost.exe', args, workdir, user,
    description: `${resolved} orch daemon (ops/orchestrator), loopback 127.0.0.1:7760`,
  });
}

function parseArgs(argv) {
  const flags = new Set();
  const opts = {};
  const known = new Set(['dry', 'uninstall', 'json', 'no-activate', 'home', 'platform', 'repo', 'node', 'user']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const key = arg.replace(/^--/, '');
    // Unknown flags are refused: the harness installer taught us that a silently
    // ignored `--help` is a full install (memory #9101).
    if (!arg.startsWith('--') || !known.has(key)) throw new Error(`unknown argument '${arg}'`);
    if (['home', 'platform', 'repo', 'node', 'user'].includes(key)) {
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      opts[key] = argv[i + 1];
      i += 1;
    } else {
      flags.add(key);
    }
  }
  return { flags, opts };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false });
  return { status: result.status, out: `${result.stdout || ''}${result.stderr || ''}`.trim(), error: result.error };
}

/** The running daemon's /health (port from its pid file), or null when that daemon does not answer. */
function daemonHealth(nodePath, stateDir) {
  let record;
  try {
    record = JSON.parse(readFileSync(path.join(stateDir, 'orch.pid'), 'utf8'));
  } catch {
    return null;
  }
  const { pid, port } = record;
  if (!Number.isInteger(port)) return null;
  const probe = run(nodePath, ['-e', `fetch('http://127.0.0.1:${port}/health',{signal:AbortSignal.timeout(2000)}).then(r=>r.text()).then(t=>process.stdout.write(t),()=>process.exit(1))`]);
  let health;
  try {
    health = probe.status === 0 ? JSON.parse(probe.out) : null;
  } catch {
    return null;
  }
  // Only the daemon the pid file names counts (lock.ts applies the same rule): a
  // foreign process on a reused port must never be taken for orch, or killed.
  return health && health.pid === pid ? health : null;
}

/**
 * An installed daemon whose code fingerprint differs from the disk runs stale
 * code: the service definition did not change, so nothing reloaded it. Restart
 * it when idle; a busy one is left alone (restarting interrupts its turns).
 * A daemon from before /health carried `code` reports none and counts as stale.
 */
export function freshness(report, { nodePath, stateDir, workdir, dry, restart }) {
  const health = daemonHealth(nodePath, stateDir);
  if (!health) return 'already_installed';
  const want = codeHash(workdir);
  if (health.code === want) return 'already_installed';
  report.staleCode = { running: health.code ?? null, disk: want, pid: health.pid, busy: health.busy ?? null };
  if (health.busy > 0) {
    report.hint = `orch pid ${health.pid} runs stale code but has ${health.busy} queued/running turn(s); re-run the installer when it is idle`;
    return 'stale_busy';
  }
  if (dry) return 'would_restart';
  restart(health.pid);
  return 'restarted';
}

/** The dependency names the daemon's workdir must prove installed. The SDK
 * marker stays the floor; every dependency ops/orchestrator/package.json
 * declares adds its own node_modules/<name>/package.json marker, so an install
 * that predates a new dependency (task 3105: undici) is refused here with the
 * npm ci remedy instead of the daemon dying on ERR_MODULE_NOT_FOUND at serve. */
function orchDependencyNames(workdir, p) {
  const names = ['@modelcontextprotocol/sdk'];
  try {
    const declared = JSON.parse(readFileSync(p.join(workdir, 'package.json'), 'utf8')).dependencies;
    for (const name of Object.keys(declared ?? {})) if (!names.includes(name)) names.push(name);
  } catch { /* no or malformed package.json: the SDK marker alone decides */ }
  return names;
}

/** Plan and (unless dry) apply. Returns a report of every action. */
export function installOrchestrator({ home, platform, repo, node, user, dry, uninstall, activate, prefix }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const stateDir = p.join(home, '.local', 'state', 'orch');
  const workdir = p.join(repo, 'ops', 'orchestrator');
  const entry = p.join(workdir, 'src', 'main.ts');
  const actions = [];
  const report = { platform, dry, uninstall, activate, stateDir, entry, actions };

  if (platform !== 'darwin' && platform !== 'win32') throw new Error(`orch install supports darwin and win32, not ${platform}`);
  const { label, taskName } = serviceNames(prefix);

  if (!uninstall) {
    const nodePath = node || resolveOnPath('node', canonicalSearchDirs({ home, platform }), { platform });
    if (!nodePath) throw new Error('node is not on the canonical search path; pass --node <absolute path>');
    report.node = nodePath;
    if (!dry && orchDependencyNames(workdir, p)
      .some((name) => !existsSync(p.join(workdir, 'node_modules', ...name.split('/'), 'package.json')))) {
      throw new Error(`orch dependencies are missing: run npm ci --omit=dev --prefix ${workdir}`);
    }
    if (!dry && activate) {
      const probe = run(nodePath, ['-p', 'process.features.typescript']);
      if (probe.status !== 0 || (probe.out !== 'strip' && probe.out !== 'transform')) {
        throw new Error(`${nodePath} cannot run TypeScript directly (process.features.typescript=${probe.out}); orch needs Node >= 24`);
      }
    }
  }

  if (platform === 'darwin') {
    const plistPath = p.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    report.plistPath = plistPath;
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const domain = `gui/${uid}`;
    if (uninstall) {
      actions.push(`launchctl bootout ${domain}/${label}`);
      actions.push(`remove ${plistPath}`);
      if (!dry) {
        if (activate) {
          // 3 = "No such process": not loaded, nothing to stop.
          const out = run('launchctl', ['bootout', `${domain}/${label}`]);
          if (out.status !== 0 && out.status !== 3) throw new Error(`launchctl bootout failed (exit ${out.status}): ${out.out}`);
        }
        rmSync(plistPath, { force: true });
      }
      report.state = dry ? 'would_remove' : 'removed';
      return report;
    }
    const content = renderPlist({ node: report.node, entry, workdir, stateDir, pathValue: daemonPath(canonicalSearchDirs({ home, platform })), prefix });
    report.content = content;
    const same = existsSync(plistPath) && readFileSync(plistPath, 'utf8') === content;
    const loaded = activate && process.platform === 'darwin' && run('launchctl', ['print', `${domain}/${label}`]).status === 0;
    if (same && (loaded || !activate)) {
      report.state = !loaded ? 'already_installed' : freshness(report, {
        nodePath: report.node, stateDir, workdir, dry,
        // kickstart -k sends SIGTERM (a clean stop) and starts the job again.
        restart: () => {
          actions.push(`launchctl kickstart -k ${domain}/${label}`);
          const kick = run('launchctl', ['kickstart', '-k', `${domain}/${label}`]);
          if (kick.status !== 0) throw new Error(`launchctl kickstart failed (exit ${kick.status}): ${kick.out}`);
        },
      });
      return report;
    }
    actions.push(`mkdir ${stateDir}`, `write ${plistPath}`);
    if (activate) actions.push(`launchctl bootout ${domain}/${label} (if loaded)`, `launchctl bootstrap ${domain} ${plistPath}`);
    if (!dry) {
      mkdirSync(stateDir, { recursive: true });
      mkdirSync(p.dirname(plistPath), { recursive: true });
      writeFileSync(plistPath, content, 'utf8');
      if (activate) {
        run('launchctl', ['bootout', `${domain}/${label}`]);
        // bootout returns before the old instance is gone; bootstrapping into
        // that window fails with "5: Input/output error" and leaves NO service
        // (2026-09-22). Wait for the label to disappear, then bootstrap.
        const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
        for (let waited = 0; waited < 10_000 && run('launchctl', ['print', `${domain}/${label}`]).status === 0; waited += 250) pause(250);
        if (run('launchctl', ['print', `${domain}/${label}`]).status === 0) throw new Error(`${domain}/${label} is still loaded 10 s after bootout`);
        let boot = run('launchctl', ['bootstrap', domain, plistPath]);
        if (boot.status === 5) {
          pause(1000);
          boot = run('launchctl', ['bootstrap', domain, plistPath]);
        }
        if (boot.status !== 0) throw new Error(`launchctl bootstrap failed (exit ${boot.status}): ${boot.out}`);
      }
    }
    report.state = dry ? 'would_install' : same ? 'reloaded' : 'installed';
    return report;
  }

  // win32
  const xmlPath = p.join(stateDir, 'orch-task.xml');
  report.xmlPath = xmlPath;
  if (uninstall) {
    actions.push(`schtasks /End /TN ${taskName}`, `schtasks /Delete /TN ${taskName} /F`, `remove ${xmlPath}`);
    if (!dry) {
      if (activate) {
        endTask({ taskName });
        deleteTask({ taskName });
      }
      rmSync(xmlPath, { force: true });
    }
    report.state = dry ? 'would_remove' : 'removed';
    return report;
  }
  // On a real Windows host the principal is the current user's SID: over ssh
  // USERDOMAIN reads WORKGROUP, and schtasks cannot map WORKGROUP\<user>.
  const account = user || (process.platform === 'win32' ? currentUserSid({ systemRoot: process.env.SystemRoot }) : os.userInfo().username);
  const content = renderTaskXml({ node: report.node, entry, workdir, user: account, prefix });
  report.content = content;
  // Task Scheduler reads task XML as UTF-16; the declaration says so, and the
  // file carries the BOM that makes it true.
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]);
  const same = existsSync(xmlPath) && readFileSync(xmlPath).equals(bytes);
  const registered = activate && process.platform === 'win32' && queryTask({ taskName }).status === 0;
  if (same && (registered || !activate)) {
    report.state = !registered ? 'already_installed' : freshness(report, {
      nodePath: report.node, stateDir, workdir, dry,
      // schtasks /End leaves node running (seen 2026-09-22): kill the pid, then start the task.
      // debt: untested live on Windows; Mac-first order (memory #10491), task 1427.
      restart: (pid) => {
        actions.push(`taskkill /F /PID ${pid}`, `schtasks /Run /TN ${taskName}`);
        const kill = run('taskkill', ['/F', '/PID', String(pid)]);
        if (kill.status !== 0) throw new Error(`taskkill failed (exit ${kill.status}): ${kill.out}`);
        const start = runTask({ taskName });
        if (start.status !== 0) throw new Error(`schtasks /Run failed (exit ${start.status}): ${start.out}`);
      },
    });
    return report;
  }
  actions.push(`mkdir ${stateDir}`, `write ${xmlPath}`);
  if (activate) actions.push(`schtasks /Create /TN ${taskName} /XML ${xmlPath} /F`, `schtasks /Run /TN ${taskName}`);
  if (!dry) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(xmlPath, bytes);
    if (activate) {
      endTask({ taskName });
      const create = createTask({ taskName, xmlPath });
      if (create.status !== 0) throw new Error(`schtasks /Create failed (exit ${create.status}): ${create.out}`);
      const start = runTask({ taskName });
      if (start.status !== 0) throw new Error(`schtasks /Run failed (exit ${start.status}): ${start.out}`);
    }
  }
  report.state = dry ? 'would_install' : same ? 'reloaded' : 'installed';
  return report;
}

function main() {
  const { flags, opts } = parseArgs(process.argv.slice(2));
  const platform = opts.platform || process.platform;
  // Resolved with the TARGET platform's rules: a --platform win32 dry run on a
  // Mac must not turn C:\Users\op into <cwd>/C:\Users\op.
  const resolve = platform === 'win32' ? path.win32.resolve : path.posix.resolve;
  const report = installOrchestrator({
    home: opts.home ? resolve(opts.home) : os.homedir(),
    platform,
    repo: opts.repo ? resolve(opts.repo) : path.resolve(HERE, '..', '..'),
    node: opts.node || null,
    user: opts.user || null,
    dry: flags.has('dry'),
    uninstall: flags.has('uninstall'),
    // launchctl/schtasks act on the real session; a foreign platform has neither.
    activate: !flags.has('no-activate') && platform === process.platform,
  });
  if (flags.has('json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const verb = report.dry ? 'would do' : 'did';
  process.stdout.write(`orch ${report.uninstall ? 'uninstall' : 'install'} (${platform}): ${report.state}\n`);
  for (const action of report.actions) process.stdout.write(`  ${verb}: ${action}\n`);
  if (report.dry && report.content) process.stdout.write(`--- ${report.plistPath || report.xmlPath}\n${report.content}`);
}

/** Realpaths on both sides: ESM resolves symlinks in import.meta.url but argv
 *  keeps the path as typed, so through a linked directory (/tmp on macOS) a
 *  URL comparison is false and the script silently does nothing. */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`orch install: ${error.message}\n`);
    process.exit(1);
  }
}
