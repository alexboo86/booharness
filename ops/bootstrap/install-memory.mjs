#!/usr/bin/env node
// Installs the memory service and its PATH client from THIS checkout — on
// every platform the memory service runs on.
//
// Both were hand-copied until 2026-07-29, and the copies drifted the same day:
// the installed client was missing a documented flag while the repository had
// it. Nothing noticed, because nothing compared them. So installation is a
// command now, and `--check` is the sensor that says when it has gone stale.
//
//   node ops/bootstrap/install-memory.mjs           # install
//   node ops/bootstrap/install-memory.mjs --check   # verify only, exit 1 on drift
//   node ops/bootstrap/install-memory.mjs --landed-map # committed map only, master only
//
// Since the macOS cutover (2026-08) the same command owns the darwin service
// layout, so there is exactly ONE way to install and one thing to check:
//
//   client + store + daemon + routing map    byte-identical to this checkout
//                                            (`--check` on a client host does
//                                            not compare the map: no reader
//                                            there — see FILE_TARGETS)
//   launchd plist (darwin)                   GENERATED here, absolute node +
//                                            installed memoryd, KeepAlive
//   loaded launchd job (darwin)              the RUNNING definition's env and
//                                            argv must match the plist: kickstart
//                                            -k restarts the OLD definition, so
//                                            a difference needs bootout/bootstrap
//   state dir (darwin)                       0700, db/token 0600 when present
//
// The personal ops/memoryctl-mac-kit used to be a second way, and it was the
// dangerous one: its store carried SCHEMA_VERSION 4 against a live database at
// 6, it never installed the routing map (so `memoryctl lessons` answered "no
// lessons" while every check called the install fresh), and its smoke test
// created a P3 task the real service refuses. It is gone; this file is the
// canon. A static, hand-written launchd plist was the third way —
// unreadable on any machine but the one it was hand-written on — and is gone
// the same way: the plist is rendered per machine, and drift in it is caught
// by the same `--check` that catches every other artifact.
//
// The service is launched from the installed copy (a Windows Scheduled Task
// and a macOS launchd job, both named from names.prefix), so installing
// REPLACES files a running service holds open. Restart it afterwards; the
// script prints the command for the platform it is on rather than restarting
// anything itself - a memory operation never manages services, deploys, or
// agents.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync, unlinkSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseShipTo, SHIPPED_STATE } from '../backup-memory.mjs';
import { embedUrlRefusal, harnessLabel, harnessPaths, harnessTaskName, readHarnessConfig } from '../../scripts/lib/harness-config.mjs';
import { forwardLaunchdLabel, forwardSshArgs, workerPlistPath } from '../../scripts/lib/memory-forward.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let config;
try { config = readHarnessConfig({ repoRoot: REPO }); } catch (error) { refuse(error.message); }
const PREFIX = config.names.prefix;
const HOME = process.env.MEMORYCTL_HOME || os.homedir();
const SERVICE_DIR = process.env.MEMORYCTL_SERVICE_DIR
  || path.join(harnessPaths({ prefix: PREFIX, home: HOME }).shareDir, 'scripts', 'memory');
// store.mjs reads this installed data two levels above its own file.
const ROUTING_MAP = path.join(SERVICE_DIR, '..', '..', 'docs', 'agent', 'domain-routing.generated.json');
const BIN_DIR = process.env.MEMORYCTL_BIN_DIR || path.join(HOME, '.local', 'bin');
const STATE_DIR = process.env.MEMORYCTL_STATE_DIR
  || path.join(HOME, '.local', 'state', 'memoryctl');
const LAUNCHD_LABEL = process.env.MEMORYCTL_LAUNCHD_LABEL || harnessLabel({ prefix: PREFIX, name: 'memoryctl' });
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(LAUNCHD_LABEL)) {
  refuse('MEMORYCTL_LAUNCHD_LABEL must be a label containing only ASCII letters, digits, dots, underscores or hyphens, starting with a letter or digit');
}
const LAUNCHD_LABEL_FILE = path.join(STATE_DIR, 'launchd.label');
const TASK_NAME = process.env.MEMORYCTL_TASK_NAME || harnessTaskName({ prefix: PREFIX });
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(TASK_NAME)) {
  refuse('MEMORYCTL_TASK_NAME must be a name containing only ASCII letters, digits, dots, underscores or hyphens, starting with a letter or digit');
}
const TASK_NAME_FILE = path.join(STATE_DIR, 'task.name');
const FORWARD_LABEL = harnessLabel({ prefix: PREFIX, name: 'memory-forward' });
const BACKUP_LABEL = harnessLabel({ prefix: PREFIX, name: 'memory-backup' });

// The ONE writer is Mac launchd memoryd (2026-10-06), with no service.url.
// A Windows host is client-only via its ssh forward at http://127.0.0.1:7718.
// `--remote <url>` records that client's service URL in
// STATE_DIR/service.url — the file the client, the MCP bridge and deep-search
// read when MEMORYCTL_URL is unset — and takes the local daemon OUT of launchd,
// so a reboot cannot bring back a second writer on a stale local copy.
// `--check` honours an existing service.url without the flag.
const SERVICE_URL_FILE = path.join(STATE_DIR, 'service.url');
let cli;
try {
  cli = parseArgs({ options: {
    check: { type: 'boolean' },
    'landed-map': { type: 'boolean' },
    remote: { type: 'string' },
    'embed-url': { type: 'string', multiple: true },
    'embed-model': { type: 'string', multiple: true },
    forward: { type: 'string', multiple: true },
    'backup-to': { type: 'string', multiple: true },
  }, tokens: true });
} catch (error) {
  refuse(error.message);
}
if (cli.tokens.some((token) => token.kind === 'option' && token.inlineValue)) {
  refuse('use --flag value, not --flag=value');
}
if (cli.values['landed-map']) {
  if (cli.tokens.some((token) => token.name !== 'landed-map')) {
    refuse('--landed-map must be used alone');
  }
  try {
    await installLandedMap();
  } catch (error) {
    console.error(`install-memory: ${error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

async function installLandedMap() {
  const { scrubbedGitEnv } = await import('../../scripts/git-env.mjs');
  const branch = spawnSync('git', ['-C', REPO, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
    { encoding: 'utf8', env: scrubbedGitEnv() });
  if (branch.error) throw branch.error;
  if (branch.status === 1) return; // Detached HEAD is not a landing on master.
  if (branch.status !== 0) throw new Error(branch.stderr.trim() || 'cannot read the checkout branch');
  if (branch.stdout.trim() !== 'master') return;
  const committedMap = () => execFileSync('git',
    ['-C', REPO, 'show', 'HEAD:docs/agent/domain-routing.generated.json'],
    { env: scrubbedGitEnv() });
  const shortHash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  let wanted = committedMap();
  for (let round = 0; round < 3; round++) {
    let installed = null;
    try { installed = readFileSync(ROUTING_MAP); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (installed?.equals(wanted)) return;
    mkdirSync(path.dirname(ROUTING_MAP), { recursive: true });
    const temporary = `${ROUTING_MAP}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, wanted, { flag: 'wx' });
      renameSync(temporary, ROUTING_MAP); // A live reader sees whole old or new bytes.
    } finally {
      try { unlinkSync(temporary); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    console.log(`installed the domain routing map ${installed === null ? 'absent' : shortHash(installed)} -> ${shortHash(wanted)}`);
    const latest = committedMap();
    if (latest.equals(wanted)) return;
    wanted = latest;
  }
  throw new Error('HEAD routing map kept changing after three install rounds; run npm run install:memory');
}

function remoteArg(argv) {
  const at = argv.indexOf('--remote');
  if (at === -1) return null;
  const url = argv[at + 1];
  if (!url || !/^https?:\/\/[^/\s]+(:\d+)?\/?$/.test(url)) {
    console.error('install-memory: --remote expects http(s)://host[:port]');
    process.exit(2);
  }
  return url.replace(/\/+$/, '');
}
const REMOTE = remoteArg(process.argv)
  ?? (existsSync(SERVICE_URL_FILE) ? readFileSync(SERVICE_URL_FILE, 'utf8').trim() || null : null);
// The interpreter launchd will exec. `process.execPath` is the node that is
// running this installer — the one node:sqlite provably works in — rather than
// whatever `command -v node` would find first. Overridable so a test (or an
// operator with a strong opinion) can point it at a specific build.
const NODE_BIN = process.env.MEMORYCTL_NODE_BIN || process.execPath;

// The plist is a darwin artifact. An explicit MEMORYCTL_LAUNCHD_PLIST makes it
// a managed artifact on ANY platform — the same relocation MEMORYCTL_SERVICE_DIR
// already enjoys — which is what lets its drift checks run in CI everywhere
// instead of only on the Mac that will eventually hold it.
const PLIST_PATH = process.env.MEMORYCTL_LAUNCHD_PLIST
  ?? (process.platform === 'darwin'
    ? path.join(HOME, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
    : null);
// A remote service owns the daemon; this machine then manages no plist at all.
const MANAGES_PLIST = PLIST_PATH !== null && REMOTE === null;
const SERVICE_PORT = process.env.MEMORYCTL_PORT || '7717';
const LOCAL_OPTIONS_FILE = path.join(STATE_DIR, 'local-service.json');
// A local writer owns the cross-encoder on macOS and Windows alike. Absent is
// that writer. "off" installs no venv and tells memoryd not to rerank; a remote
// pointer owns nothing on this machine.
const RERANK_MODE = config.memory.rerank;
const RERANK_MANAGED = RERANK_MODE !== 'off' && REMOTE === null;
const RERANK_VENV = path.join(STATE_DIR, 'rerank-venv');
// A Windows venv keeps its interpreter under Scripts, not bin.
const RERANK_PYTHON = process.platform === 'win32'
  ? path.join(RERANK_VENV, 'Scripts', 'python.exe')
  : path.join(RERANK_VENV, 'bin', 'python');
const RERANK_CACHE = path.join(STATE_DIR, 'rerank-model');

function refuse(message) {
  console.error(`install-memory: ${message}`);
  process.exit(2);
}

function optionValues(flag) {
  const values = cli.values[flag.slice(2)] ?? [];
  if (values.some((value) => !value || value.startsWith('--'))) refuse(`${flag} expects a value`);
  if (flag !== '--forward' && values.length > 1) refuse(`${flag} may only appear once`);
  return values;
}

function sshDestination(value, backup = false) {
  if (backup) {
    try {
      const { host, dir } = parseShipTo(value);
      return { host, target: dir };
    } catch {
      refuse('--backup-to expects an SSH host and a safe absolute directory');
    }
  }
  const match = typeof value === 'string' && value.match(/^([a-zA-Z0-9][a-zA-Z0-9._-]*):(.+)$/);
  if (!match || /[\x00-\x1f\x7f]/.test(value)) {
    refuse('--forward expects an SSH host alias and port');
  }
  const [, host, target] = match;
  // This ASCII host becomes a filename. Include the configured label and
  // plist suffix in the NAME_MAX (255 bytes) budget, while preserving the
  // existing 200-byte SSH alias cap.
  const maxHostBytes = Math.min(200, 255 - Buffer.byteLength(`${FORWARD_LABEL}..plist`));
  if (host.length > maxHostBytes) refuse(`--forward host must be at most ${maxHostBytes} bytes`);
  if (!/^\d+$/.test(target) || Number(target) < 1 || Number(target) > 65535) {
    refuse('--forward requires a port from 1 to 65535');
  }
  return { host, target: String(Number(target)) };
}

const embedArgs = optionValues('--embed-url');
const modelArgs = optionValues('--embed-model');
const forwardArgs = optionValues('--forward');
const backupArgs = optionValues('--backup-to');
if (REMOTE !== null && (embedArgs.length || modelArgs.length || forwardArgs.length || backupArgs.length)) {
  refuse('local service options cannot be used in remote mode; remove service.url before configuring a local service');
}
let savedOptions = { embedUrl: null, forwards: [], backupTo: null };
if (existsSync(LOCAL_OPTIONS_FILE)) {
  try {
    savedOptions = JSON.parse(readFileSync(LOCAL_OPTIONS_FILE, 'utf8'));
  } catch {
    if (REMOTE === null) refuse(`cannot read local options in ${LOCAL_OPTIONS_FILE}`);
  }
  if (!savedOptions || typeof savedOptions !== 'object' || !Array.isArray(savedOptions.forwards)) {
    if (REMOTE === null) refuse(`invalid local options in ${LOCAL_OPTIONS_FILE}`);
    savedOptions = { embedUrl: null, forwards: [], backupTo: null };
  }
}
// Checkout-only consumer: daemon-side use would need installed targets.
let embedModel = null;
if (REMOTE === null) {
  const { MODELS } = await import('../../scripts/memory/embed-recipe.mjs');
  embedModel = modelArgs[0] ?? savedOptions.embedModel ?? config.memory.embed.model;
  if (typeof embedModel !== 'string' || !Object.hasOwn(MODELS, embedModel)) {
    refuse(`memory.embed.model ${JSON.stringify(embedModel)} has no measured recipe in MODELS`);
  }
}
const LOCAL_OPTIONS = {
  embedUrl: embedArgs[0] ?? savedOptions.embedUrl ?? config.memory.embed.url ?? null,
  embedModel,
  forwards: forwardArgs.length ? forwardArgs : savedOptions.forwards,
  backupTo: backupArgs[0] ?? savedOptions.backupTo ?? null,
};
if (REMOTE === null) {
  if (!/^\d+$/.test(SERVICE_PORT) || Number(SERVICE_PORT) < 1 || Number(SERVICE_PORT) > 65535) {
    refuse('MEMORYCTL_PORT requires a port from 1 to 65535');
  }
  if (LOCAL_OPTIONS.embedUrl !== null) {
    const reason = embedUrlRefusal(LOCAL_OPTIONS.embedUrl);
    if (reason) refuse(`--embed-url ${reason}`);
  }
  const hosts = new Set();
  for (const value of LOCAL_OPTIONS.forwards) {
    const { host, target } = sshDestination(value);
    if (Number(target) === Number(SERVICE_PORT)) refuse('--forward port must differ from the service port: clients must never revive a host-local daemon');
    if (hosts.has(host)) refuse(`--forward repeats SSH host ${host}; only one LaunchAgent per host is allowed`);
    hosts.add(host);
  }
  if (LOCAL_OPTIONS.backupTo !== null) sshDestination(LOCAL_OPTIONS.backupTo, true);
}

// The routing map is DATA the installed code reads, and it is installed for
// exactly that reason: store.mjs resolves it two levels above its own file, so
// the daemon reads <service dir>/../../docs/agent/domain-routing.generated.json
// and never looks at this checkout. It was left out until 2026-08-03 and the
// copy sitting there was a hand-made snapshot: a newly assigned source glob was
// routed to domain-harness, regenerated, promoted - and `memoryctl lessons`
// still answered "no lessons", while `--check` called the install current.

// source -> installed. The client keeps its extensionless name: it is on PATH
// under `memoryctl`, and renaming it would break every agent's muscle memory.
const FILE_TARGETS = [
  // store.mjs imports this at load: omitting it leaves the daemon unable to start.
  { from: 'scripts/memory/embed-recipe.mjs', to: path.join(SERVICE_DIR, 'embed-recipe.mjs'), what: 'embedding recipe' },
  // store.mjs imports this at load too: omitting it leaves the daemon unable to start.
  { from: 'scripts/memory/task-pure.mjs', to: path.join(SERVICE_DIR, 'task-pure.mjs'), what: 'task helpers' },
  { from: 'scripts/memory/search-results.mjs', to: path.join(SERVICE_DIR, 'search-results.mjs'), what: 'search presentation' },
  { from: 'scripts/memory/reranker.mjs', to: path.join(SERVICE_DIR, 'reranker.mjs'), what: 'reranker supervisor' },
  { from: 'scripts/memory/rerank-worker.py', to: path.join(SERVICE_DIR, 'rerank-worker.py'), what: 'reranker worker', writerOnly: true },
  // Publish entrypoints only after their load-time dependencies are present.
  { from: 'scripts/memory/store.mjs', to: path.join(SERVICE_DIR, 'store.mjs'), what: 'service core' },
  { from: 'scripts/memory/memoryd.mjs', to: path.join(SERVICE_DIR, 'memoryd.mjs'), what: 'service daemon' },
  { from: 'ops/backup-memory.mjs', to: path.join(SERVICE_DIR, 'backup-memory.mjs'), what: 'backup worker' },
  // writerOnly: the map's one reader is store.mjs inside memoryd, and memoryd
  // runs on the writer. A client host (service.url) reads nothing from this
  // copy and installs nothing into it, so `--check` there does not compare it.
  { from: 'docs/agent/domain-routing.generated.json', to: ROUTING_MAP, what: 'domain routing map', writerOnly: true },
  // `executable` is a property of the ARTIFACT, not of the platform: the client
  // is the one target a shell resolves and RUNS, while the others are read
  // by node and by this installer. See `record` for why bytes alone cannot
  // decide whether this one is installed.
  { from: '.claude/scripts/memoryctl-http.sh', to: path.join(BIN_DIR, 'memoryctl-http.sh'), what: 'PATH client HTTP transport' },
  { from: '.claude/scripts/memoryctl', to: path.join(BIN_DIR, 'memoryctl'), what: 'PATH client', executable: true },
];

/// Paths inside a launchd plist are POSIX on every platform that renders one —
/// a backslash path is valid XML and a dead service.
const posix = (value) => value.split(path.sep).join('/');
const xml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const unxml = (value) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/// Every EnvironmentVariables key renderLaunchdPlist can write - the one
/// list, kept beside the renderer. A loaded job still holding one of these
/// that the plist no longer defines is drift only a bootout/bootstrap clears;
/// keys launchd itself adds (OSLogRateLimit, XPC_SERVICE_NAME, ...) and the
/// inherited block are not ours and never count.
const OWNED_PLIST_ENV_KEYS = new Set([
  'MEMORYCTL_STATE_DIR',
  'MEMORYCTL_PORT',
  'MEMORYCTL_EMBED_URL',
  'MEMORYCTL_EMBED_MODEL',
  'MEMORYCTL_RERANK',
  'MEMORYCTL_RERANK_PYTHON',
  'RERANK_DEVICE',
]);

/// The one launchd unit the memory service has. Rendered, never committed:
/// a committed plist can only describe the machine it was written on, and a
/// plist for somebody else's home is how the install went unmanaged before.
function renderLaunchdPlist({ label, nodeBin, serviceDir, stateDir, port, embedUrl, embedModel, rerankPython, rerankOff, rerankDevice }) {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(posix(nodeBin))}</string>
    <string>${xml(posix(serviceDir))}/memoryd.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MEMORYCTL_STATE_DIR</key>
    <string>${xml(posix(stateDir))}</string>
    <key>MEMORYCTL_PORT</key>
    <string>${port}</string>${embedUrl === null ? '' : `
    <key>MEMORYCTL_EMBED_URL</key>
    <string>${xml(embedUrl)}</string>
    <key>MEMORYCTL_EMBED_MODEL</key>
    <string>${xml(embedModel)}</string>`}${rerankOff ? `
    <key>MEMORYCTL_RERANK</key>
    <string>off</string>` : ''}${rerankPython === null ? '' : `
    <key>MEMORYCTL_RERANK_PYTHON</key>
    <string>${xml(posix(rerankPython))}</string>`}${rerankDevice == null ? '' : `
    <key>RERANK_DEVICE</key>
    <string>${xml(rerankDevice)}</string>`}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(posix(stateDir))}/service.log</string>
  <key>StandardErrorPath</key>
  <string>${xml(posix(stateDir))}/service.err.log</string>
</dict>
</plist>
`;
  // A key written here but missing from OWNED_PLIST_ENV_KEYS would never be
  // seen as stale once a later plist drops it: refuse it at render time.
  for (const key of wantedPlistDefinition(body).environment.keys()) {
    if (!OWNED_PLIST_ENV_KEYS.has(key)) throw new Error(`renderLaunchdPlist writes ${key}, which OWNED_PLIST_ENV_KEYS does not list`);
  }
  return body;
}

function servicePlist(rerankDevice) {
  return renderLaunchdPlist({
    label: LAUNCHD_LABEL,
    nodeBin: NODE_BIN,
    serviceDir: SERVICE_DIR,
    stateDir: STATE_DIR,
    port: SERVICE_PORT,
    embedUrl: LOCAL_OPTIONS.embedUrl,
    embedModel: LOCAL_OPTIONS.embedModel,
    rerankPython: RERANK_MANAGED ? RERANK_PYTHON : null,
    rerankOff: RERANK_MODE === 'off',
    // Null until the smoke chooses. ProgramArguments do not include the device.
    rerankDevice: RERANK_MANAGED ? rerankDevice : null,
  });
}
// The byte comparison waits until the smoke has chosen the device.
let PLIST_BODY = MANAGES_PLIST ? servicePlist(null) : null;

/// What the installer wants launchd to run, taken from the plist it renders -
/// the plist is the one definition, so the comparison below can never drift
/// from what a fresh bootstrap would load.
function wantedPlistDefinition(body) {
  const argv = [];
  const environment = new Map();
  const args = body.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  for (const match of (args?.[1] ?? '').matchAll(/<string>([\s\S]*?)<\/string>/g)) argv.push(unxml(match[1]));
  const env = body.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  for (const match of (env?.[1] ?? '').matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)) {
    environment.set(unxml(match[1]), unxml(match[2]));
  }
  return { argv, environment };
}

/// `launchctl print gui/<uid>/<label>` text -> { environment, argv }, or null
/// when the shape is not what launchd prints for a loaded job. Only the two
/// blocks the plist defines are read; `inherited environment` and
/// `default environment` are different headers and never match. Recorded shape
/// (task 2875, this Mac):
///   \tenvironment = {
///   \t\tRERANK_DEVICE => mps
///   \t}
///   \targuments = {
///   \t\t/opt/homebrew/Cellar/node/26.7.0/bin/node
///   \t\t/Users/.../scripts/memory/memoryd.mjs
///   \t}
/// An unclosed or missing block is "cannot compare", never "equal".
function parseLaunchctlPrint(text) {
  const environment = new Map();
  const argv = [];
  let block = null;
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (block === null) {
      if (trimmed === 'environment = {' || trimmed === 'arguments = {') {
        block = trimmed === 'environment = {' ? 'environment' : 'arguments';
      }
      continue;
    }
    if (trimmed === '}') {
      block = null;
    } else if (block === 'environment') {
      const at = trimmed.indexOf(' => ');
      if (at === -1) return null;
      environment.set(trimmed.slice(0, at), trimmed.slice(at + 4));
    } else {
      argv.push(trimmed);
    }
  }
  return block === null && environment.size > 0 && argv.length > 0 ? { environment, argv } : null;
}

/// Wanted keys only: launchd itself adds OSLogRateLimit, XPC_SERVICE_NAME and
/// more to the loaded environment, and those are not drift. The reverse is
/// drift for the keys this installer owns: a key the plist DROPPED but the
/// loaded job still holds (task 2880's stale MEMORYCTL_EMBED_URL) survives
/// every kickstart, because kickstart reloads the definition launchd keeps.
function loadedJobDifferences(wanted, loaded) {
  const differences = [];
  if (wanted.argv.length !== loaded.argv.length
    || wanted.argv.some((arg, index) => arg !== loaded.argv[index])) {
    differences.push(`program arguments (loaded ${loaded.argv.join(' ') || 'none'})`);
  }
  for (const [key, value] of wanted.environment) {
    if (!loaded.environment.has(key)) differences.push(`${key} (missing from the loaded job)`);
    else if (loaded.environment.get(key) !== value) differences.push(`${key} (loaded ${loaded.environment.get(key)}, plist ${value})`);
  }
  for (const key of loaded.environment.keys()) {
    if (OWNED_PLIST_ENV_KEYS.has(key) && !wanted.environment.has(key)) {
      differences.push(`${key} (loaded ${loaded.environment.get(key)}, not in the plist)`);
    }
  }
  return differences;
}

function renderWorkerPlist(label, args, logName, throttleInterval = null) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>${throttleInterval === null ? '' : `
  <key>ThrottleInterval</key>
  <integer>${throttleInterval}</integer>`}
  <key>StandardOutPath</key>
  <string>${xml(posix(STATE_DIR))}/${logName}.log</string>
  <key>StandardErrorPath</key>
  <string>${xml(posix(STATE_DIR))}/${logName}.err.log</string>
</dict>
</plist>
`;
}

const WORKER_UNITS = [];
if (MANAGES_PLIST) {
  for (const value of LOCAL_OPTIONS.forwards) {
    const { host, target } = sshDestination(value);
    const label = forwardLaunchdLabel({ prefix: PREFIX, host });
    WORKER_UNITS.push({ label, body: renderWorkerPlist(label, [
      '/usr/bin/ssh', ...forwardSshArgs({ host, target, servicePort: SERVICE_PORT }),
    ], `memory-forward.${host}`) });
  }
  if (LOCAL_OPTIONS.backupTo !== null) {
    const label = BACKUP_LABEL;
    WORKER_UNITS.push({ label, body: renderWorkerPlist(label, [
      posix(NODE_BIN), `${posix(SERVICE_DIR)}/backup-memory.mjs`, '--schedule',
      '--source', `${posix(STATE_DIR)}/memory.db`, '--staging', `${posix(STATE_DIR)}/backup-staging`,
      '--ship-to', LOCAL_OPTIONS.backupTo,
    ], 'memory-backup', 600) });
  }
}
const UNIT_DIR = PLIST_PATH === null ? null : path.dirname(PLIST_PATH);
const existingWorkers = UNIT_DIR !== null && existsSync(UNIT_DIR)
  ? readdirSync(UNIT_DIR).filter((file) => (file.startsWith(`${FORWARD_LABEL}.`)
    && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.plist$/.test(file.slice(FORWARD_LABEL.length + 1)))
    || file === `${BACKUP_LABEL}.plist`) : [];
const retiredLabels = new Set(REMOTE === null ? [] : [LAUNCHD_LABEL]);
if (REMOTE !== null) {
  // A loaded job survives deletion of its plist. Print retirement for the
  // persisted units too, even if their files have already gone missing.
  for (const value of savedOptions.forwards) {
    // Retirement must not require a usable local configuration. Recover only
    // safe labels; on-disk units are also retired by the directory inventory.
    const host = typeof value === 'string' && value.match(/^([a-zA-Z0-9][a-zA-Z0-9._-]*):/);
    if (host) retiredLabels.add(`${FORWARD_LABEL}.${host[1]}`);
  }
  if (savedOptions.backupTo != null) retiredLabels.add(BACKUP_LABEL);
}
const checkOnly = process.argv.includes('--check');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function read(file) {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

const report = [];
let drifted = 0;

/// The second thing a byte comparison cannot see: whether the copy can RUN.
///
/// A mode is not carried by content, and it does not survive every route a file
/// takes to this machine. The measured case is the Windows→macOS move: NTFS has
/// no POSIX mode, so a client that arrives through a copy, an archive or a share
/// lands 0644 — byte-identical to its source, called `current` by every later
/// `--check`, and unusable. What the operator then sees is not "the wrong mode",
/// it is `permission denied`, which reads as "memoryctl is not installed" and
/// sends the next hour to the wrong place.
///
/// So the mode is compared where it MEANS something and repaired with the same
/// copy that repairs bytes. On Windows executability is not a file mode at all
/// and asking would invent drift that cannot be fixed.
///
/// Found by an independent reviewer (codex, round `mac-migration-r1`); the CR
/// guard three lines below is the same class of defect, caught earlier.
const MODES_ARE_MEANINGFUL = process.platform !== 'win32';

function record(what, from, to, sourceBytes, installedBytes, mustBeExecutable = false, expectedMode = null) {
  let state = installedBytes === null
    ? 'absent'
    : (installedBytes.equals(sourceBytes) ? 'current' : 'stale');
  let installedMode = null;
  if (installedBytes !== null && MODES_ARE_MEANINGFUL && (mustBeExecutable || expectedMode !== null)) {
    installedMode = statSync(to).mode & 0o777;
    if (mustBeExecutable && (installedMode & 0o111) === 0) state = 'not-executable';
    // Matching bytes with a wider mode are still drift. A direct overwrite keeps
    // the old mode, so --check must not call that pair current. A byte mismatch
    // stays 'stale': that is the row the existing drift tests name.
    if (state === 'current' && expectedMode !== null && installedMode !== expectedMode) state = 'loose-mode';
  }
  if (state !== 'current') drifted += 1;
  report.push({
    what,
    from,
    to,
    was: state,
    sha256: sha256(sourceBytes),
    installed_sha256: installedBytes === null ? null : sha256(installedBytes),
    ...(mustBeExecutable && MODES_ARE_MEANINGFUL
      ? { must_be_executable: true, installed_mode: installedMode }
      : {}),
    ...(state === 'loose-mode'
      ? { problem: `private mode ${installedMode.toString(8).padStart(4, '0')}, expected ${expectedMode.toString(8).padStart(4, '0')}` }
      : {}),
  });
  return state;
}

/// The third state a byte comparison cannot see: what launchd actually LOADED.
/// kickstart -k restarts the definition launchd already holds, so a plist that
/// changed on disk while the job kept running - bootout/bootstrap never ran -
/// made every later install print a kickstart that could never deliver the new
/// environment. Measured 2026-10-23 (task 2875): the plist on disk held
/// RERANK_DEVICE=mps, the loaded job did not, and every search answered
/// "rerank unavailable: worker exit 1" until bootout/bootstrap loaded the env.
/// Asked only where the file comparison says current: a stale or absent file
/// already forces the bootout form, and only darwin has launchd. The query is
/// read-only; this installer still restarts nothing itself. Read-only probes
/// are relocatable like every other binary here, which is what keeps the tests
/// off the real loaded job.
function compareLoadedJob(plistFileState) {
  if (process.platform !== 'darwin' || plistFileState !== 'current') return;
  // The memory-local kit loads the unit itself (print/bootout/bootstrap in its
  // install.mjs); there the donor must not duplicate that reload decision.
  if (process.env.MEMORYCTL_JOB_CHECK === 'off') return;
  const job = `gui/${process.getuid()}/${LAUNCHD_LABEL}`;
  const printed = spawnSync(process.env.MEMORYCTL_LAUNCHCTL_BIN || 'launchctl', ['print', job],
    { encoding: 'utf8', timeout: 5000 });
  // Not loaded: today's behaviour - the plist file alone decides.
  if (printed.status !== 0 && /could not find service/i.test(printed.stderr ?? '')) return;
  const loaded = printed.error || printed.status !== 0 ? null : parseLaunchctlPrint(printed.stdout);
  const row = { what: 'launchd job', from: '(loaded)', to: job, was: 'not-compared' };
  if (loaded !== null) {
    const all = loadedJobDifferences(wantedPlistDefinition(PLIST_BODY), loaded);
    if (!all.length) return; // Loaded and equal: kickstart alone is honest.
    const shown = all.length > 8 ? [...all.slice(0, 8), `... (${all.length - 8} more)`] : all;
    row.was = 'stale';
    row.problem = `loaded job differs from ${path.basename(PLIST_PATH)}: ${shown.join('; ')}`;
    drifted += 1;
    report.push(row);
    return;
  }
  // Unreadable is STATED, never guessed equal - and no sha256: this is not a
  // file the updater could reinstall, and a hash here would arm a reinstall
  // that can never clear it (the not-compared rule, task 2291).
  row.reason = printed.error?.timedOut
    ? 'launchctl print timed out: the loaded job was not compared, and kickstart -k alone may keep the OLD definition'
    : printed.error
      ? `launchctl print failed: ${printed.error.message} - the loaded job was not compared, and kickstart -k alone may keep the OLD definition`
      : printed.status !== 0
        ? `launchctl print exited ${printed.status}: ${(printed.stderr ?? '').trim().slice(0, 200)} - the loaded job was not compared, and kickstart -k alone may keep the OLD definition`
        : 'launchctl print output had no parsable environment/arguments blocks: the loaded job was not compared, and kickstart -k alone may keep the OLD definition';
  report.push(row);
  console.error(`install-memory: ${row.reason}`);
}

for (const target of FILE_TARGETS) {
  const source = path.join(REPO, target.from);
  const sourceBytes = read(source);
  if (!sourceBytes) {
    console.error(`install-memory: missing source ${target.from} in ${REPO}`);
    process.exit(1);
  }
  // CR in a source is the one drift a byte comparison BLESSES: the installed
  // copy comes out byte-identical and every later --check calls the pair
  // current, while on macOS the client dies as "bad interpreter: bash^M" and
  // the failure reads as "memoryctl is not installed". Refuse at the gate
  // every Mac copy flows through. (The Windows .cmd shim is generated CRLF by
  // design and is not a FILE_TARGET.)
  const sourceCrAt = sourceBytes.indexOf(0x0d);
  if (sourceCrAt !== -1) {
    console.error(`install-memory: refusing ${target.from}: CR byte at offset ${sourceCrAt} — on macOS this installs as 'bad interpreter: bash^M'; fix the SOURCE to LF (gitattributes already demands it)`);
    process.exit(1);
  }
  const installedBytes = read(target.to);
  // The one target a client host has no reader for. Comparing it there was a
  // gate on nothing: nothing on a client reads or installs the map, so every
  // map change in the repo turned `--check` red for a file nobody opens. Named
  // as not-compared rather than dropped — a check that quietly skips a target
  // is indistinguishable from one that never ran. The writer still compares
  // it (a stale map there is a real routing failure, task 2164), and install
  // mode still copies it everywhere a promotion to writer could ever need it.
  // The row carries no sha256, like the permission rows: only sha256-carrying
  // rows are byte state, and the daily updater
  // (ops/update-tools.mjs reinstallMemoryctlIfRepoAhead) reinstalls on exactly
  // those — a hash here armed a reinstall on every updater run that could
  // never converge, because the next check still answers not-compared
  // (task 2291 correction, reviewer-grok-1fc2b2.1).
  if (checkOnly && REMOTE !== null && target.writerOnly) {
    report.push({
      what: target.what,
      from: target.from,
      to: target.to,
      was: 'not-compared',
      reason: 'no reader on a client host: this artifact is read by memoryd on the writer only',
    });
    continue;
  }
  if (checkOnly && installedBytes !== null && installedBytes.includes(0x0d)) {
    drifted += 1;
    report.push({
      what: target.what,
      from: target.from,
      to: target.to,
      was: 'stale',
      problem: 'installed copy carries CR bytes — on macOS it fails as "bad interpreter: bash^M"; reinstall from a CR-free checkout',
    });
  }
  const state = record(target.what, target.from, target.to, sourceBytes, installedBytes, target.executable);
  if (state !== 'current' && !checkOnly) {
    mkdirSync(path.dirname(target.to), { recursive: true });
    copyFileSync(source, target.to);
    // Written unconditionally on the repair path rather than only for the
    // `not-executable` state: `copyFileSync` onto a fresh path takes the
    // source's mode, and the SOURCE is a git checkout, which carries one
    // executable bit and no more. An install that has just written the file is
    // the only moment this is knowable and free.
    if (target.executable && MODES_ARE_MEANINGFUL) chmodSync(target.to, 0o755);
  }
}

// The plist drift a byte comparison cannot see: an interpreter that no longer
// exists. launchd reports that as a job that "failed to exec" in system.log
// and KeepAlive restart-loops it forever - a service that is installed,
// current, and permanently down. Refuse it by name instead.
function plistProgramArguments(body) {
  const array = body.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!array) return [];
  return [...array[1].matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
}

if (MANAGES_PLIST) {
  const installed = read(PLIST_PATH);
  if (!checkOnly) {
    // The daemon creates the token and the transfer installer brings the
    // database; the DIRECTORY is this installer's to guarantee, before either
    // of them writes into it.
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      chmodSync(STATE_DIR, 0o700);
    }
  }

  // Resolved ProgramArguments: the bytes match the canon, now does the canon
  // point at something that exists? (An absent plist already has its drift row;
  // there is nothing to resolve.)
  const liveBody = (checkOnly ? installed?.toString('utf8') : PLIST_BODY);
  if (liveBody !== undefined) {
    const argv = plistProgramArguments(liveBody);
    const [interpreter, daemon] = argv;
    if (!interpreter || !path.isAbsolute(interpreter)) {
      if (checkOnly) {
        drifted += 1;
        report.push({ what: 'launchd plist ProgramArguments', was: 'stale', to: PLIST_PATH,
          problem: `no absolute interpreter in ${JSON.stringify(argv)}` });
      }
    } else if (!existsSync(interpreter)) {
      drifted += 1;
      report.push({ what: 'launchd plist ProgramArguments', was: 'stale', to: PLIST_PATH,
        problem: `interpreter ${interpreter} does not exist - launchd would fail to exec and KeepAlive would restart-loop it` });
    }
    if (daemon && daemon !== `${posix(SERVICE_DIR)}/memoryd.mjs`) {
      if (checkOnly) {
        drifted += 1;
        report.push({ what: 'launchd plist ProgramArguments', was: 'stale', to: PLIST_PATH,
          problem: `daemon argument ${daemon} is not the installed ${posix(SERVICE_DIR)}/memoryd.mjs` });
      }
    }
  }

  // Permissions: the state dir holds the token; the database holds everything.
  // These rows are computed and reported whatever ELSE drifted - a permission
  // finding never waits for artifact agreement - and they must SAY
  // "permissions" with the exact chmod notation (0700/0600): the cutover test
  // greps for those words, and so does a human reading a red check. The first
  // wording ("mode 644, expected 600") named neither, so the one case pinning
  // this check could not pass on any POSIX platform - it was written under
  // win32, where the case is skipped and the wording never ran once.
  if (checkOnly) {
    if (!existsSync(STATE_DIR)) {
      drifted += 1;
      report.push({ what: 'memory state dir', was: 'absent', to: STATE_DIR, problem: 'missing' });
    } else if (process.platform !== 'win32') {
      const mode = statSync(STATE_DIR).mode & 0o777;
      if (mode !== 0o700) {
        drifted += 1;
        report.push({ what: 'memory state dir', was: 'stale', to: STATE_DIR,
          problem: `permissions: mode ${mode.toString(8).padStart(4, '0')}, expected 0700` });
      }
      for (const secret of ['memory.db', 'memory.token']) {
        const file = path.join(STATE_DIR, secret);
        if (existsSync(file)) {
          const fileMode = statSync(file).mode & 0o777;
          if (fileMode !== 0o600) {
            drifted += 1;
            report.push({ what: `memory state file ${secret}`, was: 'stale', to: file,
              problem: `permissions: mode ${fileMode.toString(8).padStart(4, '0')}, expected 0600` });
          }
        }
      }
    }
  }
}

// Both resolved names are one file the PATH client reads with no checkout.
// One writer: a private temp in the same directory, then rename. A direct
// write truncates the live file, and the client refuses an empty name.
function writePrivateFile(file, bytes) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    if (MODES_ARE_MEANINGFUL) chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function installResolvedName(what, from, file, value) {
  const wanted = Buffer.from(`${value}\n`);
  const state = record(what, from, file, wanted, read(file), false, 0o600);
  if (checkOnly) return;
  if (state !== 'current') writePrivateFile(file, wanted);
  else if (MODES_ARE_MEANINGFUL) chmodSync(file, 0o600);
}

installResolvedName('daemon launchd label', '(resolved label)', LAUNCHD_LABEL_FILE, LAUNCHD_LABEL);
installResolvedName('windows task name', '(resolved task name)', TASK_NAME_FILE, TASK_NAME);

if (REMOTE === null) {
  const wanted = Buffer.from(`${JSON.stringify(LOCAL_OPTIONS, null, 2)}\n`);
  const state = record('local service options', '(local options)', LOCAL_OPTIONS_FILE, wanted, read(LOCAL_OPTIONS_FILE));
  if (!checkOnly && state !== 'current') {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    if (savedOptions.backupTo !== LOCAL_OPTIONS.backupTo) {
      // A verified ship to the old destination cannot establish the new one's health.
      rmSync(path.join(STATE_DIR, 'backup-staging', SHIPPED_STATE), { force: true });
    }
    writeFileSync(LOCAL_OPTIONS_FILE, wanted, { mode: 0o600 });
  }
}
if (WORKER_UNITS.some((unit) => unit.label === BACKUP_LABEL)) {
  const staging = path.join(STATE_DIR, 'backup-staging');
  if (checkOnly) {
    const present = existsSync(staging);
    const info = present ? statSync(staging) : null;
    const problem = !present ? 'missing' : !info.isDirectory() ? 'not a directory'
      : MODES_ARE_MEANINGFUL && (info.mode & 0o777) !== 0o700 ? 'permissions: expected 0700' : null;
    if (problem) {
      drifted += 1;
      report.push({ what: 'backup staging dir', was: present ? 'stale' : 'absent', to: staging, problem });
    }
  } else {
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    if (MODES_ARE_MEANINGFUL) chmodSync(staging, 0o700);
  }
}
for (const unit of WORKER_UNITS) {
  const file = workerPlistPath(PLIST_PATH, unit.label);
  const state = record(`launchd ${unit.label}`, '(generated)', file, Buffer.from(unit.body), read(file));
  if (!checkOnly && state !== 'current') {
    mkdirSync(UNIT_DIR, { recursive: true });
    writeFileSync(file, unit.body, { mode: 0o644 });
  }
}
for (const name of existingWorkers) {
  const label = name.slice(0, -'.plist'.length);
  if (WORKER_UNITS.some((unit) => unit.label === label)) continue;
  const file = path.join(UNIT_DIR, name);
  drifted += 1;
  retiredLabels.add(label);
  report.push({ what: `launchd ${label}`, was: checkOnly ? 'stale' : 'removed', to: file,
    problem: REMOTE !== null ? 'local unit retired: the service is remote' : 'unit absent from persisted local options' });
  if (!checkOnly) unlinkSync(file);
}

if (REMOTE !== null) {
  if (existsSync(LOCAL_OPTIONS_FILE)) {
    drifted += 1;
    report.push({ what: 'local service options', was: checkOnly ? 'stale' : 'removed', to: LOCAL_OPTIONS_FILE,
      problem: 'local options retired: the service is remote' });
    if (!checkOnly) unlinkSync(LOCAL_OPTIONS_FILE);
  }
  // service.url is the client's pointer (a Windows host's ssh forward). Compared by content
  // like every other artifact; a stale URL is a client talking to nothing.
  const wanted = Buffer.from(`${REMOTE}\n`);
  const installed = read(SERVICE_URL_FILE);
  const state = record('remote service url', '(--remote)', SERVICE_URL_FILE, wanted, installed);
  if (!checkOnly) {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(STATE_DIR, 0o700);
    if (state !== 'current') writeFileSync(SERVICE_URL_FILE, wanted);
  }
  // A local plist next to a remote pointer is the second writer waiting for the
  // next login. Remove it here; the running job is unloaded by the operator's
  // bootout (printed below) because launchctl is a per-session action.
  if (PLIST_PATH !== null && existsSync(PLIST_PATH)) {
    drifted += 1;
    if (!checkOnly) {
      unlinkSync(PLIST_PATH);
      report.push({ what: 'launchd plist', was: 'removed', to: PLIST_PATH, problem: 'local daemon retired: the service is remote' });
    } else {
      report.push({ what: 'launchd plist', was: 'stale', to: PLIST_PATH, problem: 'present while service.url points at a remote daemon — run install-memory --remote to retire it' });
    }
  }
}

// The client is an extensionless bash script, and on Windows that makes it
// invisible to every runtime that dispatches through cmd or PowerShell rather
// than through Git Bash: `memoryctl hot` resolves only when PATHEXT matches, and
// nothing matches a file with no extension. Measured 2026-08-11 after the home
// directory was rebuilt - grok could not call memory from PATH at all while the
// script sat right there in ~/.local/bin. The shim is what puts it back on PATH
// for those runtimes; Git Bash keeps preferring the extensionless script.
const SHIM = path.join(BIN_DIR, 'memoryctl.cmd');
// Git Bash by name, never by PATH order: on Windows the first `bash.exe` on PATH
// is System32's WSL launcher, and it answers a memoryctl call with
// `execvpe(/bin/bash) failed` instead of running anything. Measured 2026-08-11.
const SHIM_BODY = [
  '@echo off',
  'setlocal',
  'set "SCRIPT=%~dp0memoryctl"',
  'set "BASH=%ProgramFiles%\\Git\\bin\\bash.exe"',
  'if not exist "%BASH%" set "BASH=%ProgramW6432%\\Git\\bin\\bash.exe"',
  'if not exist "%BASH%" set "BASH=%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe"',
  'if not exist "%BASH%" (',
  '  echo memoryctl: Git Bash not found - install Git for Windows or set BASH in %~f0 1>&2',
  '  exit /b 1',
  ')',
  '"%BASH%" "%SCRIPT%" %*',
  '',
].join('\r\n');

if (process.platform === 'win32') {
  const installedShim = read(SHIM);
  const shimState = installedShim === null
    ? 'absent'
    : (installedShim.toString() === SHIM_BODY ? 'current' : 'stale');
  if (shimState !== 'current') {
    drifted += 1;
    if (!checkOnly) {
      mkdirSync(BIN_DIR, { recursive: true });
      writeFileSync(SHIM, SHIM_BODY);
    }
  }
  report.push({
    what: 'PATH client shim (cmd/PowerShell runtimes)',
    from: '(generated)',
    to: SHIM,
    was: shimState,
    sha256: sha256(Buffer.from(SHIM_BODY)),
    installed_sha256: installedShim === null ? null : sha256(installedShim),
  });
}

// This is part of the same install/check as the code and plist. A health-only
// probe cannot detect a missing snapshot, dependency drift, or a broken venv.
function pythonBelow310(python) {
  const shown = process.env.MEMORYCTL_PYTHON_BIN || 'python3';
  const result = spawnSync(python, ['-c', 'import sys; print("%d.%d" % (sys.version_info[0], sys.version_info[1]))'], {
    encoding: 'utf8', timeout: 30_000,
  });
  const match = result.status === 0 ? /^(\d+)\.(\d+)$/.exec(result.stdout.trim()) : null;
  if (result.error || result.status !== 0 || !match) {
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    return `cannot read the version of ${shown}: ${detail}; set MEMORYCTL_PYTHON_BIN to Python 3.10 or newer`;
  }
  if (Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 10)) {
    return `Python ${match[1]}.${match[2]} from ${shown} is below 3.10; set MEMORYCTL_PYTHON_BIN to Python 3.10 or newer before creating the rerank venv`;
  }
  return null;
}
let rerankDevice = process.platform === 'darwin' ? null : 'cpu';
if (RERANK_MANAGED) {
  if (!checkOnly && !existsSync(path.join(RERANK_VENV, 'pyvenv.cfg'))) {
    // Windows has no platform python3 to fall back to: the interpreter is the
    // operator's explicit choice (INSTALL.md 4.2 installs it with winget).
    if (process.platform === 'win32' && !process.env.MEMORYCTL_PYTHON_BIN) {
      refuse('MEMORYCTL_PYTHON_BIN is required on Windows: point it at Python 3.10 or newer (winget install --id Python.Python.3.12)');
    }
    const refusal = pythonBelow310(process.env.MEMORYCTL_PYTHON_BIN || 'python3');
    if (refusal) refuse(refusal);
  }
  const worker = path.join(SERVICE_DIR, 'rerank-worker.py');
  const recipe = { from: 'scripts/memory/rerank-worker.py (runtime recipe)',
    sha256: sha256(read(path.join(REPO, 'scripts/memory/rerank-worker.py'))) };
  const env = { ...process.env, HF_HOME: RERANK_CACHE, HF_HUB_OFFLINE: checkOnly ? '1' : '0',
    HF_HUB_DISABLE_TELEMETRY: '1', PYTHONDONTWRITEBYTECODE: '1' };
  const runPython = (python, args, input = '', timeout = 60_000, extraEnv = {}) => {
    const result = spawnSync(python, args, {
      env: { ...env, ...extraEnv }, input, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      const detail = [result.stderr, result.stdout].map((text) => text?.trim()).filter(Boolean).join('\n').slice(-600);
      throw new Error(result.error?.message || detail || `Python exited ${result.status}`);
    }
    return result.stdout;
  };
  const smokeInput = `${JSON.stringify({ id: 1, query: 'memory service', docs: ['memoryctl stores durable memory'] })}\n`;
  const smokeOn = (device) => {
    const output = runPython(RERANK_PYTHON, [worker], smokeInput, 180_000, { RERANK_DEVICE: device });
    const lines = output.trim().split('\n').map((line) => JSON.parse(line));
    if (lines.length !== 2 || lines[0].ready !== true || lines[0].device !== device
      || lines[1].id !== 1 || !Array.isArray(lines[1].scores)
      || lines[1].scores.length !== 1 || !Number.isFinite(lines[1].scores[0])) {
      throw new Error('reranker one-pair smoke returned invalid readiness or scores');
    }
    return lines;
  };
  // The Parallels Metal error names a pipeline state, not always the word MPS.
  const mpsOrMetal = (message) => /mps|metal|pipeline state object|deferred-static-alloca/i.test(message);
  try {
    if (!checkOnly) {
      mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
      if (!existsSync(path.join(RERANK_VENV, 'pyvenv.cfg'))) {
        runPython(process.env.MEMORYCTL_PYTHON_BIN || 'python3', ['-m', 'venv', RERANK_VENV]);
      }
      // Real Python on Windows prints CRLF; the pin gate below still rejects
      // any control character other than that line ending.
      const requirements = runPython(RERANK_PYTHON, [worker, '--requirements']).trim().split(/\r?\n/);
      if (!requirements.length || requirements.some(value => !/^[a-z_]+==\d+\.\d+\.\d+$/.test(value))) {
        throw new Error('invalid pinned reranker requirements');
      }
      // PyPI ships no win_arm64 torch wheel; the pytorch CPU index carries the
      // same pin as 2.14.1+cpu, and the worker's version gate accepts that tag.
      const pipInstall = ['-m', 'pip', 'install', '--disable-pip-version-check'];
      if (process.platform === 'win32' && process.arch === 'arm64') {
        runPython(RERANK_PYTHON, [...pipInstall, '--index-url', 'https://download.pytorch.org/whl/cpu',
          ...requirements.filter(value => value.startsWith('torch=='))], '', 10 * 60_000);
        runPython(RERANK_PYTHON, [...pipInstall,
          ...requirements.filter(value => !value.startsWith('torch=='))], '', 10 * 60_000);
      } else {
        runPython(RERANK_PYTHON, [...pipInstall, ...requirements], '', 10 * 60_000);
      }
      // Download only fills the cache. Scoring is what broken MPS cannot do,
      // so the download must not require a working Metal device.
      runPython(RERANK_PYTHON, [worker, '--download'], '', 20 * 60_000, { RERANK_DEVICE: 'cpu' });
    }
    if (!existsSync(path.join(RERANK_VENV, 'pyvenv.cfg')) || !existsSync(RERANK_PYTHON)) {
      throw new Error('reranker venv missing');
    }
    if (!existsSync(RERANK_CACHE)) throw new Error('pinned reranker model cache missing');
    let lines;
    let mpsError = null;
    if (process.platform === 'darwin') {
      try {
        lines = smokeOn('mps');
        rerankDevice = 'mps';
      } catch (error) {
        if (!mpsOrMetal(error.message)) throw error;
        mpsError = error.message;
        lines = smokeOn('cpu');
        rerankDevice = 'cpu';
      }
    } else {
      lines = smokeOn('cpu');
      rerankDevice = 'cpu';
    }
    report.push({ ...recipe, what: 'reranker runtime', to: RERANK_VENV, was: 'current', smoke: 'one pair ok',
      device: rerankDevice, ...(mpsError ? { mpsError } : {}),
      model: lines[0].model, revision: lines[0].revision });
  } catch (error) {
    drifted += 1;
    report.push({ ...recipe, what: 'reranker runtime', to: RERANK_VENV, was: 'stale', problem: error.message });
    if (!checkOnly) {
      // An existing pyvenv.cfg skips venv creation, so a broken venv needs removing first.
      console.error(`install-memory: reranker runtime: ${error.message}\n`
        + `install-memory: if ${RERANK_VENV} is broken (for example after a Python upgrade), remove it and run the install again`);
      process.exit(1);
    }
  }
}

if (MANAGES_PLIST) {
  if (RERANK_MANAGED && rerankDevice === null) {
    const installedDevice = read(PLIST_PATH)?.toString('utf8')
      .match(/<key>RERANK_DEVICE<\/key>\s*<string>(mps|cpu)<\/string>/);
    rerankDevice = installedDevice?.[1] ?? 'mps';
  }
  PLIST_BODY = servicePlist(RERANK_MANAGED ? rerankDevice : null);
  const plistFileState = record('launchd plist', '(generated)', PLIST_PATH, Buffer.from(PLIST_BODY), read(PLIST_PATH));
  compareLoadedJob(plistFileState);
}
const changed = report.filter((row) => row.was !== 'current' && row.was !== 'not-compared');
// The loaded launchd job (darwin) can differ from a byte-identical plist file,
// and an unreadable one cannot be cleared by reinstalling: both rows are
// 'launchd job', and only the stale row counts as change - a not-compared row
// says what is unknown, it does not claim work.
const plistChanged = changed.some(row => row.what === 'launchd plist' || row.what === 'launchd job');
const jobUnreadable = report.some((row) => row.what === 'launchd job' && row.was === 'not-compared');
// Never advertise an interpreter until preparation and real content smoke pass.
if (MANAGES_PLIST && !checkOnly && plistChanged) {
  mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  writeFileSync(PLIST_PATH, PLIST_BODY);
  chmodSync(PLIST_PATH, 0o644);
}

if (checkOnly) {
  console.log(JSON.stringify({ ok: drifted === 0, mode: 'check', targets: report }, null, 2));
  if (drifted) {
    const loosePermissions = report.some((row) => row.problem?.startsWith('permissions:'));
    console.error(`\ninstall-memory: ${drifted} problem(s) in the installed memory service (see report above).`);
    console.error('Fix stale artifacts: node ops/bootstrap/install-memory.mjs   (then restart the memory service)');
    const jobRow = report.find((row) => row.what === 'launchd job' && row.was === 'stale');
    if (jobRow) {
      console.error(`Fix the loaded job: ${jobRow.problem}`);
      console.error(`  launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}; launchctl bootstrap gui/$(id -u) '${PLIST_PATH}' (kickstart -k alone keeps the OLD definition)`);
    }
    if (loosePermissions) {
      // A reinstall chmods the DIR, but the database and the token arrive from
      // the daemon and the transfer installer - reinstalling fixes neither.
      console.error(`Fix permissions: chmod 700 ${STATE_DIR} && chmod 600 ${path.join(STATE_DIR, 'memory.db')} ${path.join(STATE_DIR, 'memory.token')}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

console.log(JSON.stringify({ ok: true, mode: 'install', installed: changed.length, targets: report }, null, 2));
if (changed.length || jobUnreadable) {
  // The daemon keeps its own copy of the code in memory; a fresh schema or a
  // fixed route does nothing until it is restarted. The command is the one the
  // PLATFORM's service manager understands - a Windows-only line on a Mac was
  // the installer's quietest lie.
  if (REMOTE !== null) {
    console.log(`\nInstalled. Clients now read ${SERVICE_URL_FILE} -> ${REMOTE}`);
    if (process.platform === 'win32') {
      console.log(`  retire the local daemon: Stop-ScheduledTask -TaskName ${TASK_NAME}; Disable-ScheduledTask -TaskName ${TASK_NAME}`);
    }
    console.log(`  then verify: memoryctl status   (and curl -s ${REMOTE}/health)`);
  } else if (process.platform === 'darwin') {
    // kickstart -k restarts a LOADED service in one step - with the definition
    // launchd already holds. The old three-line
    // sequence ran bootstrap right after bootout, which answered
    // "Bootstrap failed: 5: Input/output error" and left every agent without
    // memory until a retry (2026-09-11). bootout/bootstrap is only for a
    // changed plist or an unreadable loaded job, and then with the wait it needs.
    console.log('\nInstalled. The running service still holds the OLD code - restart it:');
    if (plistChanged || jobUnreadable) {
      const quotedPlist = `'${PLIST_PATH.replace(/'/g, "'\\''")}'`;
      console.log(`  launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}; (attempt=0; until launchctl bootstrap gui/$(id -u) ${quotedPlist} 2>/dev/null; do attempt=$((attempt + 1)); if [ "$attempt" -ge 60 ]; then echo "memoryctl: bootstrap failed after 60 attempts" >&2; exit 1; fi; sleep 1; done)`);
    } else {
      console.log(`  launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`);
    }
    console.log('  then verify: curl -s http://127.0.0.1:7717/health');
  } else if (process.platform === 'win32') {
    console.log('\nInstalled. The running service still holds the OLD code - restart it:');
    console.log(`  Windows: Stop-ScheduledTask -TaskName ${TASK_NAME}; Start-ScheduledTask -TaskName ${TASK_NAME}`);
    console.log('  then verify: curl -s http://127.0.0.1:7717/health');
  } else {
    console.log('\nInstalled. No service manager is configured for this platform:');
    console.log(`  restart memoryd manually: ${NODE_BIN} ${path.join(SERVICE_DIR, 'memoryd.mjs')}`);
  }
} else {
  console.log('\nNothing to do: every installed file already matches this checkout.');
}

for (const label of retiredLabels) {
  console.log(`  retire the local unit if it is still loaded: launchctl bootout gui/$(id -u)/${label}`);
}

if (!existsSync(path.join(BIN_DIR, 'memoryctl'))) {
  console.error(`\nWARNING: ${BIN_DIR} holds no memoryctl after install — check that it is on PATH.`);
}
