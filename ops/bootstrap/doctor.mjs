#!/usr/bin/env node
// Installation proofs. The owning tools decide what is a fault; the doctor
// itself changes nothing unless --fix runs a repair marked safe below.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_FAMILIES, readHarnessConfig } from '../../scripts/lib/harness-config.mjs';
import { checkLogin } from '../../scripts/lib/family-logins.mjs';
import { isMain } from '../../scripts/lib/is-main.mjs';
import { memoryInstallerFor } from '../../scripts/lib/memory-installer.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const line = (value) => String(value).replace(/[\r\n]+/g, ' ').trim();
const notChecked = (id, reason) => ({ id, state: 'not checked', reason: line(reason), detail: line(reason) });
const ok = (id, detail) => ({ id, state: 'ok', detail: line(detail) });

// A fault's repair as data. `print` is the line a human runs; `argv` is the
// same command as data for `--fix`, never a shell string; `safe` says whether
// the doctor may run it itself. Every mark was read off the command's code:
// - `install-harness.mjs --only <step>` runs one installer step under the
//   install lock: it writes only the home files that step owns, asks no
//   question and reads secrets without prompting; a second run leaves the
//   same bytes. Safe today for the `skills` step only:
//   - the `mcp` step honours `install.userEntries` (the one place the installer
//     reads it, install-harness.mjs:667): under an absent key or `replace` it
//     drops the user's own MCP servers (reviewer-codex-2f58bd.1 measured
//     ['personal'] -> ['managed']), so its repair is safe only when the config
//     says `keep`; otherwise --fix leaves the row its next command and says why.
//   - the `hooks` step is NEVER safe: stripPromptHooks
//     (install-harness.mjs:966) removes every hook command matching
//     `-prompt-guard.mjs` / `prompt-hook` with no proof the harness owns it,
//     under `keep` too (task 2396 changes that sweep; the doctor waits for it).
// - `install-memory.mjs` refreshes the memory service's own artifacts only,
//   asks nothing, needs no secret and converges to "Nothing to do"; it prints
//   the restart command, it never starts the daemon.
// - `ops/orchestrator/install.mjs` is "Install orch as a per-user background
//   service. Idempotent.": its own service files, then the daemon's start.
// - a service-manager start (`launchctl kickstart`, `Start-ScheduledTask`) is
//   the start of an installed daemon, named from the installer's own state.
// Never safe: a login, a secret, `roles reset`, a config change, an ssh
// repair, a taken port.
const safeFix = (print, argv) => ({ print, argv, safe: true });
const neverSafe = (print, argv, why) => ({ print, safe: false, ...(argv ? { argv } : {}), ...(why ? { why: line(why) } : {}) });
const installerStep = (step) => safeFix(`node ops/bootstrap/install-harness.mjs --only ${step}`,
  [process.execPath, 'ops/bootstrap/install-harness.mjs', '--only', step]);
// The one installer step of this file's repairs that reads install.userEntries
// (install-harness.mjs:667): safe only once the config proves `keep`.
const keepUserEntries = () => {
  try { return readHarnessConfig({ repoRoot: repo }).install?.userEntries === 'keep'; } catch { return false; }
};
const mcpStep = () => {
  const print = 'node ops/bootstrap/install-harness.mjs --only mcp';
  const argv = [process.execPath, 'ops/bootstrap/install-harness.mjs', '--only', 'mcp'];
  return keepUserEntries() ? safeFix(print, argv)
    : neverSafe(print, argv, 'the installer would replace the user\u0027s own entries; set install.userEntries to keep first');
};
// Never safe, under keep too: stripPromptHooks of install-harness.mjs removes
// `codegraph prompt-hook`, an entry that the code-index tool wrote, not the
// harness (scripts/test-install-harness-safety.mjs pins the removal). Task
// 2396 gave the other sweeps of the hooks step an ownership proof.
const hooksStep = () => neverSafe('node ops/bootstrap/install-harness.mjs --only hooks',
  [process.execPath, 'ops/bootstrap/install-harness.mjs', '--only', 'hooks']);
// A kit's wrapper owns its writer label and service tasks.
const memoryInstaller = memoryInstallerFor(repo);
const memoryInstall = () => safeFix(`node ${memoryInstaller}`,
  [process.execPath, memoryInstaller]);
const orchInstall = () => safeFix('node ops/orchestrator/install.mjs',
  [process.execPath, 'ops/orchestrator/install.mjs']);
const userEntriesKeep = () => neverSafe(
  `node ops/bootstrap/harness-config.mjs set install.userEntries '"keep"'`,
  [process.execPath, 'ops/bootstrap/harness-config.mjs', 'set', 'install.userEntries', '"keep"']);

const fault = (id, detail, repair, nextStep) => ({
  id, state: 'fault', detail: line(detail),
  ...(repair
    ? { nextCommand: repair.print, fix: { safe: repair.safe, ...(repair.argv ? { argv: repair.argv } : {}), ...(repair.why ? { why: repair.why } : {}) } }
    : { nextStep: line(nextStep) }),
});

// check-skills-drift appends a human summary after its JSON document.
function readJson(stdout) {
  const text = stdout.trim();
  try { return JSON.parse(text); } catch {
    const end = text.lastIndexOf('\n}');
    if (end !== -1) return JSON.parse(text.slice(0, end + 2));
    throw new Error('tool returned no readable JSON');
  }
}

// Decision 17877: the kit installs only the Claude Code CLI. Codex, grok,
// kimi and opencode run inside the pinned Pi, so their native CLIs are absent
// from a fresh install ON PURPOSE. A skip line of the two text tools below
// that names one of those absent vendor CLIs is therefore not applicable:
// neither a hole in the proof nor a fault. A vendor CLI the user installed
// gets no such line (its checks simply run), so it stays fully checked.
const piVendorClis = ['codex', 'grok', 'kimi', 'opencode'];
const absentVendorSkip = (entry) => piVendorClis.some((vendor) =>
  new RegExp(`^skip: ${vendor} (?:mcp list |doctor )?— no ${vendor} on this machine$`).test(entry)
  || new RegExp(`^skip: ${vendor} — .+ does not exist on this machine$`).test(entry));
// The proof an ok row owes: one green line of the tool for the runtime the
// kit installs. Claude Code's homes are `~/.claude` and the GLM worker/lead
// homes that run the same CLI through the shared adapter. The doctor checks
// no Pi of its own today; a Pi proof would join here the day it does.
const claudeCodeProof = (entry) => entry.startsWith('ok: ')
  && (/^ok: claude — /.test(entry) || /\.claude([/\\.]|$)|\.glm-(?:worker|lead)-config/.test(entry));

// These owners publish text, not JSON. Interpret only their completion and
// skip/failure markers, never the delivery rules that produced them.
// Their own probes run up to 60 s each; the budget stays above the tool's.
function textCheck(id, file, label, repair) {
  return {
    id, file, args: [], text: true, timeoutMs: 90_000,
    repair,
    result(stdout, status, stderr) {
      const failures = stderr.split('\n').filter((entry) => entry.startsWith('FAIL:'));
      if (status !== 0 && failures.length) return fault(this.id, failures.join('; '), this.repair);
      if (status !== 0) return null;
      const summary = stdout.match(new RegExp(`^${label}: (\\d+) checks green.*$`, 'm'));
      if (!summary) return null;
      const skipped = stdout.split('\n').filter((entry) => entry.startsWith('skip:'));
      // Decision 17877: absent vendor CLIs are not applicable (above); every
      // other skip — an unreadable file, a retired parser, a secret-gated
      // server, the kit's own runtime skipped — keeps the row unproved.
      const open = skipped.filter((entry) => !absentVendorSkip(entry));
      if (open.length) return notChecked(this.id, [summary[0], ...open].join('; '));
      if (Number(summary[1]) === 0) return notChecked(this.id, summary[0]);
      const claude = stdout.split('\n').find(claudeCodeProof);
      if (!claude) {
        return notChecked(this.id, `${summary[0]}; the tool's green lines prove no check of Claude Code, the one runtime the kit installs`);
      }
      return ok(this.id, `${claude.slice('ok: '.length)}; ${summary[0]}${
        skipped.length ? `; ${skipped.length} absent vendor CLI${skipped.length === 1 ? '' : 's'} not applicable` : ''}`);
    },
  };
}

// true: a listener holds the port; false: nothing listens; null: no proof.
// A connect that is closed at once changes nothing on either side.
function portHeld(host, port) {
  return new Promise((done) => {
    const socket = connect({ host, port: Number(port), timeout: 1000 });
    const end = (held) => { socket.destroy(); done(held); };
    socket.once('connect', () => end(true));
    socket.once('timeout', () => end(null));
    socket.once('error', (error) => end(error.code === 'ECONNREFUSED' ? false : null));
  });
}

const freePort = (service, port) => `Free port ${port}: a process that is not ${service} holds it (find it: ${
  process.platform === 'win32' ? `netstat -ano | findstr :${port}` : `lsof -nP -iTCP:${port} -sTCP:LISTEN`})`;

// The names the memory client itself revives the service by (.claude/scripts/memoryctl).
function memoryStart(stateDir) {
  const installed = (file) => {
    try {
      const name = readFileSync(join(stateDir, file), 'utf8').trim();
      return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) ? name : null;
    } catch { return null; }
  };
  const install = memoryInstall();
  if (process.platform === 'darwin') {
    const label = installed('launchd.label');
    return [label ? safeFix(`launchctl kickstart -k gui/$(id -u)/${label}`,
      ['launchctl', 'kickstart', '-k', `gui/${process.getuid()}/${label}`]) : install];
  }
  if (process.platform === 'win32') {
    const task = installed('task.name');
    return [task ? safeFix(`powershell.exe -NoProfile -NonInteractive -Command "Start-ScheduledTask -TaskName '${task}'"`,
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `Start-ScheduledTask -TaskName '${task}'`]) : install];
  }
  return [undefined, `No service manager is configured for ${process.platform}: start memoryd by hand; ${install} prints its command`];
}

// The proof is of the address the memory client itself uses: MEMORYCTL_URL,
// else service.url, else its loopback default. A service installed on another
// port (MEMORYCTL_PORT of install-memory.mjs) is not followed by the client,
// so it is not followed here.
async function memoryService(id) {
  let health;
  try {
    const { serviceUrl } = await import('../../scripts/memory/service-client.mjs');
    health = new URL('/health', serviceUrl());
  } catch (error) {
    return notChecked(id, `cannot read the memory client's address: ${error.message}`);
  }
  const { origin, hostname } = health;
  const port = health.port || (health.protocol === 'https:' ? 443 : 80);
  const stateDir = process.env.MEMORYCTL_STATE_DIR || join(process.env.HOME || homedir(), '.local/state/memoryctl');
  // service.url makes this host a client: its service runs on another host.
  // So does an address that is not loopback, whichever source named it.
  const client = existsSync(join(stateDir, 'service.url'));
  const away = !(hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname));
  let response;
  try {
    response = await fetch(health, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  } catch (error) {
    const cause = error.cause?.code || error.name;
    const held = await portHeld(hostname, port);
    if (held === null) return notChecked(id, `${origin} gave no health answer (${cause}) and its port gave no proof`);
    if (client || away) {
      const why = away ? `${origin} is not this machine` : 'service.url points this host at a remote service';
      if (held) {
        return fault(id, `memory service does not answer at ${origin} (${cause}); ${why}`, undefined,
          `The route at ${origin} is open but the service behind it gave no answer: start the memory service on its writer host`);
      }
      return away
        ? fault(id, `the route to the memory service at ${origin} is closed (${cause}); ${why}`, undefined,
          `Restore the route to ${origin}, or start the memory service on that machine; start no memory service on this host`)
        : fault(id, `memory service does not answer at ${origin} (${cause}); ${why}`, undefined,
          `Restore the route to ${origin} (the ssh forward from the writer host); start no memory service on this host`);
    }
    if (held) {
      return fault(id, `a process holds ${origin} but gave no memory health answer (${cause})`, undefined,
        freePort('the memory service', port));
    }
    return fault(id, `memory service is stopped: nothing listens at ${origin}`, ...memoryStart(stateDir));
  }
  const answer = await response.json().catch(() => null);
  if (answer?.service === 'memoryctl') {
    return answer.ok === true ? ok(id, `memory service answers at ${origin}`)
      : notChecked(id, `${origin} answered its health route without ok: true`);
  }
  return fault(id, `${origin} answered HTTP ${response.status}, but not as the memory service: another process holds its port`,
    undefined, freePort('the memory service', port));
}

// `status` does not print the port of a stopped daemon; orch's own config does.
async function orchStopped(check) {
  const stopped = fault(check.id, 'orch daemon is not running', check.repair);
  let held = null;
  let config;
  try {
    config = (await import('../orchestrator/src/config.ts')).loadConfig();
    held = await portHeld(config.host, config.port);
  } catch { /* An unreadable config leaves the port unproved, below. */ }
  if (held) {
    return fault(check.id, `orch daemon is not running and another process holds its port ${config.port}`, undefined,
      freePort('the orch daemon', config.port));
  }
  return held === false ? stopped : { ...stopped, detail: `${stopped.detail}; its port was not probed` };
}

// `status` saw a live pid whose port accepted and gave no health answer. Only
// the pid of the listener tells a busy daemon from a different process.
function orchUnanswered(check, data) {
  const silent = 'orch process is alive but its loopback health probe did not answer';
  if (!Number.isInteger(data.pid) || !Number.isInteger(data.port)) return notChecked(check.id, silent);
  const unknown = notChecked(check.id, `${silent}; the holder of port ${data.port} was not identified`);
  if (process.platform === 'win32') return unknown;
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${data.port}`, '-sTCP:LISTEN', '-t'],
    { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
  const holders = (lsof.stdout || '').split('\n').filter(Boolean).map(Number);
  if (lsof.error || !holders.length) return unknown;
  if (holders.includes(data.pid)) return notChecked(check.id, `${silent}; it holds port ${data.port} itself`);
  return fault(check.id, `orch pid ${data.pid} is alive but pid ${holders.join(', ')} holds its port ${data.port}`, undefined,
    freePort('the orch daemon', data.port));
}

function loginRows() {
  let families;
  try {
    families = readHarnessConfig({ repoRoot: repo }).families?.enabled ?? HARNESS_FAMILIES;
  } catch (error) {
    return [notChecked('logins', `cannot select enabled families: ${error.message}`)];
  }
  const home = homedir();
  return families.map((family) => {
    const id = `logins/${family}`;
    try {
      const proof = checkLogin(family, { home, orchStateDir: join(home, '.local', 'state', 'orch') });
      if (proof.state === 'ok') return ok(id, proof.detail);
      if (proof.state === 'missing' || proof.state === 'expired') {
        // The launcher resolves the pinned Pi (or Claude Code/key prompt).
        // Never suggest a global Pi or a vendor CLI for a Pi family.
        return fault(id, proof.detail, neverSafe(`node ops/bootstrap/harness-login.mjs ${family}`,
          [process.execPath, 'ops/bootstrap/harness-login.mjs', family]));
      }
      return notChecked(id, proof.detail || 'no readable login proof');
    } catch (error) {
      return notChecked(id, error.message);
    }
  });
}

function userEntries(id) {
  let config;
  let kit = false;
  try {
    config = readHarnessConfig({ repoRoot: repo });
    try {
      const manifest = JSON.parse(readFileSync(join(repo, 'KIT-MANIFEST.json'), 'utf8'));
      if (manifest?.kit !== 'harness-kit') return notChecked(id, 'KIT-MANIFEST.json is not a readable harness-kit marker');
      kit = true;
    } catch (error) {
      if (error.code !== 'ENOENT') return notChecked(id, `cannot read KIT-MANIFEST.json: ${error.message}`);
    }
  } catch (error) {
    return notChecked(id, `cannot read install.userEntries: ${error.message}`);
  }
  // The installers keep entries only for an explicit "keep"; absence replaces.
  const policy = config.install?.userEntries ?? 'replace';
  const detail = `install.userEntries=${policy}${config.install?.userEntries ? '' : ' (installer default)'}`;
  return kit && policy === 'replace'
    ? fault(id, `${detail} in a public kit: a second install would remove the user's own MCP servers and permission rules`,
      userEntriesKeep())
    : ok(id, `${detail}; ${kit ? 'public kit keeps user entries' : 'no kit marker (donor repository)'}`);
}

const orchFile = 'ops/orchestrator/src/main.ts';
const hostRepair = (name) => `Repair SSH access and the configured Node command on host ${name}; recheck with node ${orchFile} hosts probe ${name}`;
const rolesRepair = 'Run node ops/orchestrator/src/main.ts roles reset <role>, or edit roles.json in the orch state directory';

// The kit's marker (ops/harness-kit ships KIT-MANIFEST.json; a donor tree has
// none). A row whose meaning differs between the two reads it; an unreadable
// marker is not a kit, so the row keeps the donor's meaning.
const kitInstall = () => {
  try {
    return JSON.parse(readFileSync(join(repo, 'KIT-MANIFEST.json'), 'utf8'))?.kit === 'harness-kit';
  } catch {
    return false;
  }
};

// Peekaboo, the macOS capture tool a lead or a seat uses when a picture is necessary.
export async function peekabooRow({ platform = process.platform, run: probeRun } = {}) {
  const id = 'peekaboo';
  if (platform !== 'darwin') return notChecked(id, 'Peekaboo runs on macOS only');
  try {
    const { peekabooVerdict } = await import('../orchestrator/src/shared.entry.ts');
    const peek = await peekabooVerdict(probeRun);
    if (peek.ok) return ok(id, 'OK');
    // Task 2414: in a kit, Peekaboo is optional (ops/harness-kit/INSTALL.md
    // lists it as optional and installs no Homebrew, decision 17877), so the
    // verdict's own brew fix names a route a kit user does not have. The row
    // reports the state and the guide's route instead of faulting a fresh install.
    if (kitInstall()) {
      return ok(id,
        'optional in this kit: Peekaboo is not ready; only a screen capture on macOS needs it — ops/harness-kit/INSTALL.md names what it needs (Peekaboo plus the Screen Recording and Accessibility rights the user grants); the kit installs no capture tool');
    }
    return fault(id, peek.fix, undefined, peek.fix);
  } catch (error) {
    const reason = `the check failed to run: ${error?.message || error}`;
    return fault(id, reason, undefined, 'Retry the Peekaboo check after resolving the error above');
  }
}

const checks = [
  {
    id: 'config',
    run() {
      try {
        readHarnessConfig({ repoRoot: repo });
        return ok(this.id, 'ops/bootstrap/harness.config.json accepted');
      } catch (error) {
        return fault(this.id, error.message, undefined,
          `Edit ops/bootstrap/harness.config.json: ${error.message}`);
      }
    },
  },
  // --check scores one reranker pair on mps and, after a Metal failure, again
  // on cpu, each bounded at 180 s (install-memory.mjs smokeOn); in a VM it took
  // 17.54 s against the 15 s default (task 2414). The budget stays above the tool's.
  {
    id: 'memory install', file: memoryInstaller, args: ['--check'], timeoutMs: 400_000,
    repair: memoryInstall(),
    result(data, status, stderr) {
      const refusal = this.diagnostic('', status, stderr);
      if (refusal) return refusal;
      if (typeof data.ok !== 'boolean' || data.mode !== 'check' || !Array.isArray(data.targets)) return null;
      return data.ok && status === 0 ? ok(this.id, 'installed memory artifacts are current')
        : fault(this.id, `installed memory artifacts need repair; see node ${this.file} --check`, this.repair);
    },
    // The kit wrapper can refuse before the donor emits JSON (ownership), or
    // after it (task/launcher drift). Any nonzero wrapper exit is a fault,
    // including an unexpected crash without the wrapper's diagnostic prefix.
    diagnostic(stdout, status, stderr) {
      if (status === 0 || this.file !== 'ops/memory-local/install.mjs') return null;
      const failures = stderr.split('\n').filter((entry) => entry.startsWith('memory-local:'));
      return fault(this.id, failures.length ? failures.join('; ')
        : `node ${this.file} --check exited ${status}${stderr || stdout ? `: ${stderr || stdout}` : ''}`, this.repair);
    },
  },
  {
    id: 'skills', file: 'scripts/check-skills-drift.mjs', args: ['--json'],
    repair: installerStep('skills'), // installer --only usage, checker repair guidance
    result(data, status, stderr) {
      if (!Array.isArray(data.report) || !Array.isArray(data.retired)) return null;
      if (status !== 0 && data.retired.length && data.report.every((row) => row.absent || row.bad === 0)) {
        const locations = data.retired.map((hit) => `${hit.skill}/${hit.file}:${hit.line}`).join(', ');
        // The checker has already classified the faults; use its RETIRED guidance.
        const guidance = stderr.split('\n  RETIRED\n')[1];
        return fault(this.id, `RETIRED: ${locations}`, undefined,
          guidance || 'name a document the set still carries, or drop the sentence');
      }
      if (status !== 0) return fault(this.id, 'skill delivery needs repair; see node scripts/check-skills-drift.mjs --json', this.repair);
      if (data.report.every((row) => row.absent)) return notChecked(this.id, 'no runtime skill directories installed');
      return ok(this.id, 'every promised skill is linked, nothing shadows it');
    },
    diagnostic(stdout) {
      return stdout.startsWith('check-skills-drift: FAIL') ? fault(this.id, stdout, this.repair) : null;
    },
  },
  {
    id: 'orch daemon', file: 'ops/orchestrator/src/main.ts', args: ['status'],
    repair: orchInstall(), // ops/orchestrator/README.md service install
    result(data, status) {
      if (typeof data.running !== 'boolean') return null;
      if (!data.running) return orchStopped(this);
      if (data.healthUnanswered) return orchUnanswered(this, data);
      if (status !== 0) return notChecked(this.id, `status exited ${status}`);
      return ok(this.id, `orch answers on loopback port ${data.port}`);
    },
  },
  { id: 'memory service', run() { return memoryService(this.id); } },
  textCheck('hooks', 'scripts/check-hook-topology.mjs', 'hook-topology', hooksStep()),
  textCheck('mcp', 'scripts/check-mcp-delivery.mjs', 'mcp-delivery', mcpStep()),
  {
    id: 'hosts', file: orchFile, args: ['hosts', 'list'],
    result(data, status) {
      if (status !== 0 || !data || typeof data !== 'object' || Array.isArray(data)
        || Object.values(data).some((host) => !host || typeof host !== 'object' || Array.isArray(host))) return null;
      const names = Object.keys(data);
      if (!names.length) return ok(this.id, 'no remote hosts are registered');
      return names.map((name) => run({
        id: `hosts/${name}`, file: orchFile, args: ['hosts', 'probe', name],
        result(proof, exit) {
          if (proof.host !== name || typeof proof.ok !== 'boolean') return null;
          if (proof.ok && exit === 0 && typeof proof.version === 'string' && proof.version) {
            return ok(this.id, `${name}: ${proof.version}`);
          }
          if (!proof.ok && exit !== 0 && typeof proof.reason === 'string' && proof.reason) {
            return fault(this.id, `${proof.reason}${proof.error ? `: ${proof.error}` : ''}`, undefined, hostRepair(name));
          }
          return null;
        },
        diagnostic(stdout, exit, stderr) {
          return exit !== 0 && stderr.startsWith('hosts:')
            ? fault(this.id, stderr, undefined, hostRepair(name)) : null;
        },
      }));
    },
    diagnostic(stdout, status, stderr) {
      return status !== 0 && stderr.startsWith('hosts:')
        ? fault(this.id, stderr, undefined, 'Edit hosts.json in the orch state directory, then run node ops/orchestrator/src/main.ts hosts list')
        : null;
    },
  },
  {
    id: 'role matrix', file: orchFile, args: ['roles', 'show', '--json'],
    result(data, status) {
      if (status !== 0 || !data || typeof data !== 'object' || Array.isArray(data)) return null;
      const roles = Object.values(data);
      if (!roles.length || roles.some((role) => !role || !['file', 'compiled'].includes(role.mark)
        || !role.cells || typeof role.cells !== 'object' || Array.isArray(role.cells))) return null;
      return ok(this.id, roles.every((role) => role.mark === 'compiled')
        ? 'no roles.json overrides; compiled matrix is in use'
        : 'roles.json accepted by the loader');
    },
    diagnostic(stdout, status, stderr) {
      return status !== 0 && stderr.startsWith('roles:') ? fault(this.id, stderr, undefined, rolesRepair) : null;
    },
  },
  { id: 'user entries', run() { return userEntries(this.id); } },
  { id: 'peekaboo', run() { return peekabooRow(); } },
];

// A row, or a promise of one when the check probes the network. A check's own
// budget outranks the doctor's.
export function run(check, budgetMs = 15_000) {
  // A check that throws or rejects is one unproved row, never the end of the run.
  const unproved = (error) => notChecked(check.id, `the check itself failed: ${error?.message || error}`);
  const guarded = (row) => (typeof row?.then === 'function' ? Promise.resolve(row).catch(unproved) : row);
  if (check.run) {
    try { return guarded(check.run()); } catch (error) { return unproved(error); }
  }
  const timeoutMs = check.timeoutMs ?? budgetMs;
  const child = spawnSync(process.execPath, [resolve(repo, check.file), ...check.args], {
    cwd: repo, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
  });
  if (child.error || child.signal || child.status === null) {
    return notChecked(check.id, child.error?.message || `tool stopped by ${child.signal}`);
  }
  try {
    const row = check.result(check.text ? child.stdout : readJson(child.stdout), child.status, child.stderr);
    if (row) return guarded(row);
  } catch { /* A skipped or failed-to-start tool is not a successful proof. */ }
  const diagnostic = check.diagnostic?.(child.stdout.trim(), child.status, child.stderr.trim());
  return diagnostic || notChecked(check.id, child.stderr || child.stdout || `tool exited ${child.status} without a result`);
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const fix = args.includes('--fix');
  const dryRun = args.includes('--dry-run');
  const allowed = fix ? ['--fix', '--dry-run', '--json'] : ['--json'];
  const wellFormed = new Set(args).size === args.length
    && args.every((arg) => allowed.includes(arg)) && !(dryRun && !fix);
  if (!wellFormed) {
    console.error('usage: node ops/bootstrap/doctor.mjs [--json] | [--fix [--dry-run] [--json]]');
    process.exitCode = 2;
  } else {
    const collect = async () => {
      const rows = [];
      for (const check of checks) rows.push(...[await run(check)].flat());
      rows.push(...loginRows());
      return rows;
    };
    let rows = await collect();
    const fixes = [];
    if (fix) {
      // The safe repairs in the order of the checks, each distinct command
      // once. A command runs only on its own safe mark and argv data: a login,
      // a secret, roles reset, a config change, an ssh repair or a taken port
      // never carries a safe mark.
      const seen = new Set();
      const planned = [];
      for (const row of rows) {
        if (row.state !== 'fault' || row.fix?.safe !== true || !row.fix.argv || !row.nextCommand) continue;
        const key = row.fix.argv.join('\u0000');
        if (seen.has(key)) continue;
        seen.add(key);
        planned.push(row);
      }
      let ran = false;
      for (const row of planned) {
        const entry = { command: row.nextCommand, state: 'planned', detail: '' };
        if (json) fixes.push(entry);
        else console.log(`fix: ${row.nextCommand}`);
        if (dryRun) continue;
        ran = true;
        // The repair child's stdout and stderr stay captured (encoding, not
        // stdio: 'inherit'), so a noisy repair never breaks the single JSON
        // document that --fix --json prints.
        const child = spawnSync(row.fix.argv[0], row.fix.argv.slice(1), {
          cwd: repo, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
        });
        if (child.error) {
          if (json) { entry.state = 'failed'; entry.detail = child.error.message; }
          else console.log(`fix failed: ${child.error.message}`);
        } else if (child.status !== 0) {
          const reason = child.status === null ? `stopped by ${child.signal}` : `exit ${child.status}`;
          if (json) { entry.state = 'failed'; entry.detail = reason; }
          else console.log(`fix failed: ${reason}`);
        } else if (json) {
          entry.state = 'ran';
        }
      }
      // A repair the doctor refuses to run keeps its next command and says why,
      // in one line, so the human keeps the instruction.
      for (const row of rows) {
        if (row.state === 'fault' && row.fix?.safe === false && row.fix.why && row.nextCommand) {
          if (json) fixes.push({ command: row.nextCommand, state: 'refused', detail: row.fix.why });
          else console.log(`fix refused: ${row.nextCommand} — ${row.fix.why}`);
        }
      }
      // Only a run that repaired something owes a second proof; a failed
      // repair is reported above and keeps its fault row.
      if (ran && !dryRun) rows = await collect();
    }
    if (json) console.log(JSON.stringify(fix ? { fixes, rows } : rows, null, 2));
    else {
      for (const row of rows) {
        const next = row.nextCommand || row.nextStep;
        console.log(`${row.id}: ${row.state} — ${row.detail}${next ? `; next: ${next}` : ''}`);
      }
      const first = rows.find((row) => row.state === 'fault');
      if (first) console.log(first.nextCommand ? `Next command: ${first.nextCommand}` : `Next step: ${first.nextStep}`);
    }
    process.exitCode = rows.some((row) => row.state === 'fault') ? 1 : 0;
  }
}
