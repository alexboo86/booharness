#!/usr/bin/env node
/**
 * Task 3536 slice B: the Pi client update job. Run on the target machine FROM ITS CHECKOUT
 * (remote-repo.ts `runCheckCommand`) or directly on the daemon's machine:
 *
 *   node ops/orchestrator/pi-client-job.mjs update <version>
 *   node ops/orchestrator/pi-client-job.mjs rollback
 *
 * Both modes take one machine lock (`.pi-client.lock`: pid + start) beside the runtime; a
 * dead pid's lock is reclaimed and the machine's dead `versions/.staging-*` trees are removed
 * while the lock is held. Update stages `versions/.staging-<version>` (the repo package.json
 * with that exact version and the repo's overrides), runs `npm install --ignore-scripts`,
 * renames to `versions/<version>` after install passes, smokes that tree step by step, then
 * switches `current.json` (temp + rename, carrying `previous`) and re-reads through
 * `resolvePiInstall`; a mismatch restores the old record. Any failure removes the staged
 * tree and leaves `current.json` untouched, naming the failed step in the summary line.
 * Rollback puts `previous` back into `current.json` (temp + rename), then verifies version
 * and one turn; a failed verification restores the pre-rollback record. Older trees are
 * never deleted automatically (deliberate debt — see the task 3536 report).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  piArgs, piExpectedTools, piRuntimeLayout, piVersionedLayout, resolvePiInstall,
  readLocalPiInstall, piPinVersion, comparePiVersions, PI_ENV, piChildEnv, ORCH_SEAT_COMMAND, piRouteFor, qwenKey, mimoRouteKey,
  piSecretValues, piCredentialValues, redactPiSecrets, resolveCommand,
} from './src/providers/index.ts';
import { stateDirFor } from './src/config.ts';
import { localCodexEdit } from './src/codex-edit.ts';
import { localHashlineEdit } from './src/hashline-edit.ts';

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const LEAD_CHILD = fileURLToPath(new URL('./src/providers/pi-lead-child.mjs', import.meta.url));
const ROOT = process.cwd();
const RUNTIME = path.join(ROOT, 'ops', 'pi-runtime');
const VERSIONS = path.join(RUNTIME, 'versions');
const CURRENT = path.join(RUNTIME, 'current.json');
const LOCK = path.join(RUNTIME, '.pi-client.lock');
// One smoke bound for every spawn/wait. Overridable so the fixture tests run fast; production keeps the 180 s default.
const SMOKE_MS = Number(process.env.PI_CLIENT_SMOKE_MS ?? 180_000);
const PLATFORM = process.platform;

class StepError extends Error {
  constructor(step, message) { super(message); this.step = step; }
}

const report = { ok: false, mode: null, version: null, failedStep: null, error: null };
function step(name, detail) {
  process.stdout.write(`pi-client: step ${name}: ${detail}\n`);
}
// Task 3536 slice B review: child stderr can echo a credential this machine carries, and the
// summary line leaves the job. Every PI_UNSET-named value of this environment, the userinfo of
// its admitted registry/proxy URLs, plus the selected smoke route's key, is [redacted] before
// child text enters an error (scrubBearer rule). CREDENTIALS (task 3536 B correction 3) is the
// key/token subset: only a credential may fragment-mask — a path or configuration value
// (PI_CODING_AGENT_DIR) keeps its fragments readable so a real error stays diagnosable.
let SECRETS = piSecretValues();
let CREDENTIALS = piCredentialValues();
const redact = (text) => redactPiSecrets(text, SECRETS);
function fail(stepName, message) {
  return new StepError(stepName, redact(message));
}

// ---- machine lock ---------------------------------------------------------------------------

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function acquireLock() {
  fs.mkdirSync(RUNTIME, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(LOCK, 'wx');
      fs.writeSync(fd, `${JSON.stringify({ pid: process.pid, start: new Date().toISOString() })}\n`);
      fs.closeSync(fd);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let held = null;
      try { held = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { /* malformed = dead */ }
      if (held && alive(held.pid)) {
        throw fail('lock', `machine lock ${LOCK} is held by live pid ${held.pid} (start ${held.start})`);
      }
      // A dead pid's lock is reclaimed.
      fs.rmSync(LOCK, { force: true });
    }
  }
  throw fail('lock', `could not take the machine lock ${LOCK}`);
}

// ---- subprocess helpers ---------------------------------------------------------------------

// Task 3536 slice B correction: a seat inherits the daemon environment minus PI_UNSET names
// (pi.ts:719), but a smoke or install child is not a seat — it must never carry credentials
// the daemon happens to hold (a planted OPENAI_API_KEY reached the fake-Pi child). Children
// see only the shared piChildEnv allowlist (pi.ts: PI_CHILD_ENV) plus PI_ENV plus the
// caller's extra: the selected route's key and nothing else. `install` additionally admits
// PI_INSTALL_ENV (registry/proxy/TLS configuration for npm behind a private registry or a
// custom CA — never an authToken, which no admitted name spells).
function seatEnv(extra = {}, install = false) {
  return { ...PI_ENV, ...piChildEnv(process.env, extra, install) };
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    // win32: Node refuses to spawn a .cmd shim without a shell (spawn EINVAL); the shared
    // resolver unwraps the shim instead of re-quoting its arguments.
    const resolved = resolveCommand(command, options.env ?? process.env);
    const child = spawn(resolved.file, [...resolved.args, ...args], { cwd: options.cwd ?? ROOT, env: options.env ?? seatEnv(), windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? SMOKE_MS);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: -1, out, err: `${err}${error.message}` }); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out, err }); });
  });
}

/** One Pi RPC session against a candidate runtime (docs rpc.md: JSONL commands over stdio). */
// Task 3536 slice B correction: redact BEFORE slicing. A keep-last-N slice that lands inside a
// credential would otherwise leave its raw suffix beyond what redactPiSecrets can match.
function withTail(errState, message) {
  return `${message}${errState.tail ? `: ${redact(errState.tail).slice(-300)}` : ''}`;
}

// Task 3536 slice B correction 2 (CWE-532): a secret can straddle stderr chunks — the first
// half can be trimmed away before the second completes it. Redact the whole retained buffer,
// and also mask any unmatched head or tail fragment (≥ 8 chars, the same floor
// piSecretValues uses) of a known CREDENTIAL, so no trim boundary can leave a raw partial that
// later passes cannot match. High-entropy keys make an 8-char false positive negligible.
// Credentials only (task 3536 B correction 3): fragment-masking a configuration value
// (PI_CODING_AGENT_DIR) rewrote an unrelated path into 'Error loading [redacted]pi/...';
// whole-value redaction above still covers configuration values.
const SECRET_FRAGMENT = 8;
function redactTail(buffer) {
  let text = redact(buffer);
  for (const secret of CREDENTIALS) {
    for (let k = secret.length - SECRET_FRAGMENT; k >= SECRET_FRAGMENT; k--) {
      const head = secret.slice(0, k);
      if (text.includes(head)) text = text.split(head).join('[redacted]');
      const tail = secret.slice(secret.length - k);
      if (text.includes(tail)) text = text.split(tail).join('[redacted]');
    }
  }
  return text;
}

function lineScanner(onLine) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      onLine(record);
    }
  };
}

function dispatchLine(record, events, pending, waiters) {
  events.push(record);
  if (record.type === 'response' && record.id && pending.has(record.id)) {
    const resolve = pending.get(record.id);
    pending.delete(record.id);
    resolve(record.data);
  }
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].pred(record)) { const [w] = waiters.splice(i, 1); w.resolve(record); }
  }
}

function makeCmd(child, pending, errState) {
  let next = 1;
  return (type, fields = {}) => new Promise((resolve, reject) => {
    const id = `smoke-${next++}`;
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(withTail(errState, `pi did not answer ${type} in ${SMOKE_MS} ms`)));
    }, SMOKE_MS);
    child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
  });
}

function makeWait(events, waiters, errState) {
  return (pred, what) => {
    // Scan history first: the event can arrive before this waiter registers.
    for (const record of events) if (pred(record)) return Promise.resolve(record);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) { waiters.splice(i, 1); reject(new Error(withTail(errState, `timed out waiting for ${what}`))); }
      }, SMOKE_MS);
    });
  };
}

function makeClose(child, isExited) {
  return () => new Promise((resolve) => {
    if (isExited()) return resolve();
    child.once('exit', resolve);
    child.stdin.end();
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => clearTimeout(timer));
  });
}

function rpc(bin, args, env) {
  const childEnv = seatEnv(env);
  const resolved = resolveCommand(bin, childEnv);
  const child = spawn(resolved.file, [...resolved.args, ...args], { cwd: ROOT, env: childEnv, windowsHide: true });
  // Lesson #12515: a dead child's stdin write/end must not crash the job (EPIPE).
  child.stdin.on('error', () => {});
  const events = [];
  const pending = new Map();
  const waiters = [];
  const errState = { tail: '' };
  let exited = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', lineScanner((record) => dispatchLine(record, events, pending, waiters)));
  child.stderr.setEncoding('utf8');
  // The accumulating tail is itself sliced (last 2000 chars): redactTail on entry, so a
  // chunk boundary or the window edge can never cut a credential into a raw fragment.
  child.stderr.on('data', (c) => { errState.tail = redactTail(errState.tail + c).slice(-2000); });
  child.once('exit', () => { exited = true; });
  return { child, cmd: makeCmd(child, pending, errState), wait: makeWait(events, waiters, errState), close: makeClose(child, () => exited), events, exited: () => exited };
}

// ---- smoke loadout --------------------------------------------------------------------------

const SMOKE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pi-client-smoke-'));
const SMOKE_EXT = path.join(SMOKE_DIR, 'smoke-tools.mjs');
const SMOKE_MCP_SERVER = path.join(SMOKE_DIR, 'smoke-mcp-server.mjs');
const SMOKE_MCP_CONFIG = path.join(SMOKE_DIR, 'smoke-mcp.json');
// The smoke-only extension (lesson #13172: session_start, not before_agent_start): it reports
// the tools the candidate runtime ACTIVATED, so the job can compare them to piExpectedTools.
fs.writeFileSync(SMOKE_EXT, `import fs from 'node:fs';
export default function (pi) {
  pi.on('session_start', () => {
    const out = process.env.PI_SMOKE_TOOLS;
    if (out) fs.writeFileSync(out, JSON.stringify(pi.getActiveTools()));
  });
}
`);
// One tiny stdio MCP server for the single `mcp` proxy call.
fs.writeFileSync(SMOKE_MCP_SERVER, `let seq = 0;
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, at).replace(/\\r$/, '');
    buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    if (request.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'smoke', version: '0.0.0' } });
    else if (request.method === 'tools/list') reply({ tools: [{ name: 'smoke_ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] });
    else if (request.method === 'tools/call') reply({ content: [{ type: 'text', text: 'pong' }] });
    else if (request.id !== undefined) reply({});
  }
});
`);
fs.writeFileSync(SMOKE_MCP_CONFIG, JSON.stringify({
  mcpServers: { smoke: { type: 'stdio', command: process.execPath, args: [SMOKE_MCP_SERVER] } },
}));

/**
 * The smoke's route order, cheapest first (task 3536): opencode runs glm-5.3-flash — the
 * cheapest model QUOTA_RATES measures — then glm, qwen and mimo. A route is "keyed" when its
 * credentials resolve on this machine without throwing; claude/codex/grok/kimi are login
 * routes with no machine-checkable key and are not smoke routes (claude also bills a Max
 * plan as extra usage, memory #11848). None keyed: the smoke refuses.
 */
const SMOKE_ROUTE_ORDER = ['opencode', 'glm', 'qwen', 'mimo'];

function keyedRoute() {
  for (const family of SMOKE_ROUTE_ORDER) {
    try {
      const route = piRouteFor(family);
      // qwen's Pi route keeps its key in Pi's own auth.json, and the smoke passes it
      // explicitly: qwenKey() is OPENAI_API_KEY, the name the child's stack reads. mimo's
      // credential also lives in auth.json but rides no child env — `secrets` (not `env`)
      // carries it to redaction (slice B correction 2: a file-based key too).
      const env = family === 'qwen' ? qwenKey() : route.env ? route.env() : {};
      const secrets = family === 'mimo' ? mimoRouteKey() : env;
      if (family !== 'mimo' && Object.keys(env).length === 0) continue;
      const provider = typeof route.provider === 'string' ? route.provider : route.provider();
      return { family, route, env, provider, secrets };
    } catch { continue; }
  }
  return null;
}

function needKeyed() {
  const keyed = keyedRoute();
  if (!keyed) throw fail('smoke:turn', `no keyed route on this machine (${SMOKE_ROUTE_ORDER.join(', ')}): the smoke needs one real keyed route`);
  // The selected route's key reaches the children by design; if a child echoes it, redaction
  // knows it — including a file-based credential no child env ever carried.
  SECRETS = piSecretValues(process.env, keyed.secrets);
  CREDENTIALS = piCredentialValues(process.env, keyed.secrets);
  return keyed;
}

const fullSpec = (keyed) => ({ family: keyed.family, cwd: ROOT, model: keyed.route.defaultModel, access: 'full', env: {} });

async function turnOn(bin, keyed, message, expectMcp = false) {
  const session = rpc(bin, piArgs(keyed.route, fullSpec(keyed), null, SMOKE_EXT, expectMcp ? SMOKE_MCP_CONFIG : undefined), keyed.env);
  try {
    await session.cmd('get_state');
    await session.cmd('prompt', { message });
    const settled = session.wait((r) => r.type === 'agent_settled', 'agent_settled');
    if (expectMcp) {
      await session.wait((r) => r.type === 'tool_execution_end' && r.toolName === 'mcp' && r.isError !== true, 'one successful mcp tool_execution_end');
    }
    await settled;
    const usage = session.events.filter((r) => r.type === 'message_end' && r.message?.role === 'assistant')
      .map((r) => r.message?.usage).find((u) => u && typeof u.input === 'number');
    return usage ?? null;
  } finally {
    await session.close();
  }
}

async function toolsEqual(bin, keyed, spec, model, tag) {
  const out = path.join(SMOKE_DIR, `tools-${tag}-${process.pid}.json`);
  fs.rmSync(out, { force: true });
  const session = rpc(bin, piArgs(keyed.route, spec, null, SMOKE_EXT), { ...keyed.env, PI_SMOKE_TOOLS: out });
  try {
    await session.cmd('get_state');
    const deadline = Date.now() + SMOKE_MS;
    while (!fs.existsSync(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (!fs.existsSync(out)) throw fail(`smoke:${tag}`, 'the smoke-only extension never reported getActiveTools');
    const active = JSON.parse(fs.readFileSync(out, 'utf8'));
    const expected = piExpectedTools(spec, model);
    const a = [...active].sort().join(','), b = [...expected].sort().join(',');
    if (a !== b) throw fail(`smoke:${tag}`, `active tools [${a}] differ from piExpectedTools [${b}]`);
    return `${expected.length} tools match piExpectedTools`;
  } finally {
    await session.close();
  }
}

// ---- smoke suite ----------------------------------------------------------------------------

async function smokeVersion({ bin, version }) {
  const r = await run(bin, ['--version']);
  if (r.code !== 0 || !r.out.includes(version)) {
    throw fail('smoke:version', `--version printed ${JSON.stringify(redact((r.out || r.err).trim()).slice(0, 160))}, expected ${version}`);
  }
  return `--version reports ${version}`;
}

async function smokeTurn({ bin, keyed }) {
  const usage = await turnOn(bin, keyed, 'Reply with exactly the single word: ok');
  if (!usage) throw fail('smoke:turn', 'the turn reported no usage fields');
  return 'one real RPC turn completed with usage fields present';
}

function smokeToolsRead({ bin, keyed }) {
  return toolsEqual(bin, keyed,
    { family: keyed.family, cwd: ROOT, model: keyed.route.defaultModel, access: 'read-only', env: {} },
    keyed.route.defaultModel, 'tools-read-only');
}

async function smokeMcp({ bin, keyed }) {
  await turnOn(bin, keyed, 'Call the smoke_ping tool on the smoke server once through the mcp tool now, then reply done.', true);
  return 'one mcp proxy call completed';
}

function awaitLeadStartup(child, errState) {
  const seen = new Set();
  let buffer = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(fail('smoke:lead', withTail(errState, `pi-lead-child did not verify startup in ${SMOKE_MS} ms`))); }, SMOKE_MS);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, '');
        buffer = buffer.slice(at + 1);
        try {
          const record = JSON.parse(line);
          if (record.type === 'response' && record.success === true && ['lead-state', 'lead-commands'].includes(record.id)) seen.add(record.id);
        } catch { continue; }
        if (seen.size === 2) { clearTimeout(timer); child.stdin.end(); resolve(); }
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(fail('smoke:lead', withTail(errState, `pi-lead-child exited ${code} before verifying startup (shape drift)`)));
    });
  });
}

function awaitLeadExit(child) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(-1); }, 5000);
    child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });
}

async function smokeLead({ bin, keyed }) {
  const args = piArgs(keyed.route, fullSpec(keyed), null);
  const resolved = resolveCommand(bin);
  const child = spawn(process.execPath, [LEAD_CHILD, resolved.file, ...resolved.args, ...args], {
    cwd: ROOT,
    env: seatEnv({ ...keyed.env, ORCH_PI_LEAD_PROVIDER: keyed.provider, ORCH_PI_LEAD_EXTENSION_COMMAND: ORCH_SEAT_COMMAND }),
    windowsHide: true,
  });
  const errState = { tail: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { errState.tail = redactTail(errState.tail + c).slice(-2000); });
  await awaitLeadStartup(child, errState);
  const code = await awaitLeadExit(child);
  if (code !== 0 && code !== null) throw fail('smoke:lead', `pi-lead-child exited ${code}`);
  return 'lead spawn through pi-lead-child passed startup verification';
}

async function smokeToolsFull({ bin, keyed }) {
  const stateDir = process.env.ORCH_STATE_DIR || stateDirFor(os.homedir());
  const codexEdit = await localCodexEdit(stateDir);
  const hashlineEdit = await localHashlineEdit(stateDir);
  const model = codexEdit.models[0];
  return toolsEqual(bin, { ...keyed, route: piRouteFor('codex'), env: {} },
    { family: 'codex', cwd: ROOT, model, access: 'full', env: {}, codexEdit, hashlineEdit }, model, 'tools-full');
}

async function oldSessionFile(keyed) {
  const pin = piPinVersion(ROOT);
  const old = resolvePiInstall({ machine: 'local', pin, repo: ROOT, platform: PLATFORM, facts: readLocalPiInstall(ROOT, PLATFORM) });
  const before = rpc(old.command, piArgs(keyed.route, fullSpec(keyed), null, SMOKE_EXT), keyed.env);
  let sessionFile;
  try {
    const state = await before.cmd('get_state');
    sessionFile = state?.sessionFile;
  } finally { await before.close(); }
  if (typeof sessionFile !== 'string' || !sessionFile) throw fail('smoke:resume', `the old runtime ${old.command} reported no sessionFile to resume`);
  return sessionFile;
}

async function smokeResume({ bin, keyed }) {
  const sessionFile = await oldSessionFile(keyed);
  const after = rpc(bin, piArgs(keyed.route, fullSpec(keyed), sessionFile, SMOKE_EXT), keyed.env);
  try {
    const state = await after.cmd('get_state');
    if (state?.sessionFile !== sessionFile) throw fail('smoke:resume', `--session ${sessionFile} did not resume the old-version session`);
    await after.cmd('prompt', { message: 'Reply with exactly: ok' });
    await after.wait((r) => r.type === 'agent_settled', 'agent_settled after resume');
  } finally { await after.close(); }
  return `old-version session ${path.basename(sessionFile)} resumed`;
}

async function smokeCompact({ bin, keyed }) {
  const session = rpc(bin, piArgs(keyed.route, fullSpec(keyed), null, SMOKE_EXT), keyed.env);
  try {
    const state = await session.cmd('get_state');
    if (state?.isStreaming !== false) throw fail('smoke:compact', 'compaction runs only while Pi is idle (lesson #13104)');
    await session.cmd('compact');
    return 'one compaction completed while idle';
  } finally { await session.close(); }
}

async function smokeSteer({ bin, keyed }) {
  const session = rpc(bin, piArgs(keyed.route, fullSpec(keyed), null, SMOKE_EXT), keyed.env);
  try {
    await session.cmd('get_state');
    const run = session.cmd('prompt', { message: 'Count from 1 to 20, one number per line.' });
    const steer = session.cmd('steer', { message: 'Prefer odd numbers first.' });
    await steer;
    await run;
    await session.wait((r) => r.type === 'agent_settled', 'agent_settled after steer');
    return 'one steer during run start was accepted';
  } finally { await session.close(); }
}

const SMOKE_STEPS = [
  ['smoke:version', smokeVersion],
  ['smoke:turn', smokeTurn],
  ['smoke:tools-read-only', smokeToolsRead],
  ['smoke:mcp', smokeMcp],
  ['smoke:lead', smokeLead],
  ['smoke:tools-full', smokeToolsFull],
  ['smoke:resume', smokeResume],
  ['smoke:compact', smokeCompact],
  ['smoke:steer', smokeSteer],
];

async function smoke(bin, version, onStep) {
  const keyed = needKeyed();
  const ctx = { bin, version, keyed };
  for (const [name, fn] of SMOKE_STEPS) await onStep(name, () => fn(ctx));
}

// ---- switch record --------------------------------------------------------------------------

function readRecord() {
  let raw = null;
  try { raw = fs.readFileSync(CURRENT, 'utf8'); } catch { return { raw: null, record: null }; }
  try {
    const record = JSON.parse(raw);
    return { raw, record: record && typeof record === 'object' ? record : null };
  } catch { return { raw, record: null }; }
}

function writeRecord(record) {
  const tmp = path.join(RUNTIME, `.current-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(tmp, CURRENT);
}

function restoreRecord(before) {
  if (before === null) fs.rmSync(CURRENT, { force: true });
  else {
    const tmp = path.join(RUNTIME, `.current-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(tmp, before);
    fs.renameSync(tmp, CURRENT);
  }
}

function expectedCommand(target, pin) {
  return comparePiVersions(target, pin) > 0 ? piVersionedLayout(ROOT, PLATFORM, target).command : piRuntimeLayout(ROOT, PLATFORM).command;
}

/** The switch's re-read through THE resolver (task 3536): a mismatch restores. */
function verifySwitch(target, pin, before) {
  let resolved;
  try {
    resolved = resolvePiInstall({ machine: 'local', pin, repo: ROOT, platform: PLATFORM, facts: readLocalPiInstall(ROOT, PLATFORM) });
  } catch (error) {
    restoreRecord(before);
    throw fail('switch', `the switch record does not resolve (${error.message}); restored the previous current.json`);
  }
  const expected = expectedCommand(target, pin);
  if (resolved.command !== expected) {
    restoreRecord(before);
    throw fail('switch', `the switch resolved ${resolved.command}, expected ${expected}; restored the previous current.json`);
  }
  return resolved;
}

// ---- modes ----------------------------------------------------------------------------------

// While the lock is held every .staging-* tree is dead by construction.
function sweepDeadStaging() {
  fs.mkdirSync(VERSIONS, { recursive: true });
  for (const entry of fs.readdirSync(VERSIONS)) {
    if (entry.startsWith('.staging-')) { fs.rmSync(path.join(VERSIONS, entry), { recursive: true, force: true }); }
  }
}

function stageTree(version, staging) {
  const target = path.join(VERSIONS, version);
  if (fs.existsSync(target)) throw fail('stage', `versions/${version} already exists at ${target}; remove it first or rollback`);
  const pkg = JSON.parse(fs.readFileSync(path.join(RUNTIME, 'package.json'), 'utf8'));
  pkg.dependencies[PI_PACKAGE] = version;
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  step('stage', `staged ${staging} (package.json pins ${PI_PACKAGE}@${version}, overrides kept)`);
}

async function installStaging(staging) {
  // The install child additionally admits registry/proxy/TLS configuration (PI_INSTALL_ENV):
  // updates behind a private registry or a custom CA broke when the allowlist dropped them.
  const install = await run('npm', ['install', '--ignore-scripts'], { cwd: staging, timeoutMs: 30 * 60_000, env: seatEnv({}, true) });
  if (install.code !== 0) throw fail('install', `npm install --ignore-scripts failed (${install.code}): ${redact((install.err || install.out).trim()).slice(-400)}`);
  step('install', 'npm install --ignore-scripts passed');
}

async function logStep(name, fn) {
  let detail;
  try { detail = await fn(); } catch (error) { throw error.step ? error : fail(name, error.message); }
  step(name, `ok — ${detail}`);
}

function commitSwitch(version, pin) {
  const before = readRecord();
  const previous = typeof before.record?.version === 'string' && VERSION_RE.test(before.record.version) ? before.record.version : pin;
  writeRecord({ version, previous, switchedAt: new Date().toISOString() });
  const resolved = verifySwitch(version, pin, before.raw);
  step('switch', `current.json switched to ${version} (previous ${previous}); resolves to ${resolved.command}`);
}

async function update(version) {
  report.mode = 'update';
  report.version = version;
  if (typeof version !== 'string' || !VERSION_RE.test(version)) throw fail('validate', `version ${JSON.stringify(version)} fails ^\\d+\\.\\d+\\.\\d+$`);
  acquireLock();
  let moved = false;
  const staging = path.join(VERSIONS, `.staging-${version}`);
  try {
    sweepDeadStaging();
    step('lock', `machine lock taken; dead staging trees swept`);
    const pin = piPinVersion(ROOT);
    stageTree(version, staging);
    await installStaging(staging);
    fs.renameSync(staging, path.join(VERSIONS, version));
    moved = true;
    step('move', `renamed to versions/${version}`);
    await smoke(piVersionedLayout(ROOT, PLATFORM, version).command, version, logStep);
    commitSwitch(version, pin);
    return version;
  } catch (error) {
    if (moved) fs.rmSync(path.join(VERSIONS, version), { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

function readRollbackRecord() {
  const before = readRecord();
  const target = before.record?.version, previous = before.record?.previous;
  if (!before.raw || typeof target !== 'string' || typeof previous !== 'string' || !VERSION_RE.test(target) || !VERSION_RE.test(previous)) {
    throw fail('rollback', `${CURRENT} has no switch record with a version and a previous version to roll back to`);
  }
  return { before, target, previous };
}

async function verifyRollback(resolved, previous, pin) {
  const running = comparePiVersions(previous, pin) > 0 ? previous : pin;
  const versioned = await run(resolved.command, ['--version']);
  if (versioned.code !== 0 || !versioned.out.includes(running)) {
    throw fail('smoke:version', `--version printed ${JSON.stringify(redact((versioned.out || versioned.err).trim()).slice(0, 160))}, expected ${running}`);
  }
  step('smoke:version', `ok — --version reports ${running}`);
  const keyed = needKeyed();
  const usage = await turnOn(resolved.command, keyed, 'Reply with exactly the single word: ok');
  if (!usage) throw fail('smoke:turn', 'the turn reported no usage fields');
  step('smoke:turn', 'ok — one real RPC turn completed with usage fields present');
}

async function rollback() {
  report.mode = 'rollback';
  acquireLock();
  try {
    sweepDeadStaging();
    step('lock', 'machine lock taken; dead staging trees swept');
    const { before, target, previous } = readRollbackRecord();
    report.version = previous;
    const pin = piPinVersion(ROOT);
    writeRecord({ version: previous, previous: target, switchedAt: new Date().toISOString() });
    const resolved = verifySwitch(previous, pin, before.raw);
    step('switch', `current.json rolled back to ${previous} (previous ${target}); resolves to ${resolved.command}`);
    try {
      await verifyRollback(resolved, previous, pin);
    } catch (error) {
      restoreRecord(before.raw);
      throw new StepError(error.step ?? 'smoke:turn', `${error.message}; restored the pre-rollback current.json`);
    }
    return previous;
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

// A job must always report: an unexpected crash still prints the summary line.
process.on('uncaughtException', (error) => {
  report.failedStep = report.failedStep ?? 'crash';
  report.error = redact(`uncaught: ${error.stack ?? error}`);
  process.stdout.write(`pi-client: ${JSON.stringify(report)}\n`, () => process.exit(1));
});
process.on('unhandledRejection', (error) => {
  report.failedStep = report.failedStep ?? 'crash';
  report.error = redact(`unhandled rejection: ${error?.stack ?? error}`);
  process.stdout.write(`pi-client: ${JSON.stringify(report)}\n`, () => process.exit(1));
});
// ---- CLI ------------------------------------------------------------------------------------

const [mode, version] = process.argv.slice(2);
try {
  if (mode === 'update' && version !== undefined) await update(version);
  else if (mode === 'rollback' && version === undefined) await rollback();
  else throw fail('usage', 'usage: pi-client-job.mjs update <version> | rollback');
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.failedStep = error.step ?? 'unknown';
  report.error = error.message;
  process.exitCode = 1;
}
process.stdout.write(`pi-client: ${JSON.stringify(report)}\n`);
process.on('exit', () => { fs.rmSync(SMOKE_DIR, { recursive: true, force: true }); });
