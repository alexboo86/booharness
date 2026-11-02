// The host-agent core: PROTOCOL.md v1, agent side. It dials orch over TLS,
// pairs or authenticates inside the raw-TLS prelude, becomes the HTTP/2 server
// after the switch barrier, and serves control, exec, forward and rotation
// traffic until the connection is terminal. Node built-ins and this module only.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { constants, createServer as createHttp2Server } from 'node:http2';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createServer as createNetServer, isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { connect as dialTls } from 'node:tls';
import { parseExecHeader } from './exec-header.mjs';
import { pipeExec } from './streams.mjs';
import { compareVersions, stageArtifact } from './install/manager.mjs';

const MAX_LINE = 65536;
const PRELUDE_BUDGET = 65536;
const PRELUDE_TIMEOUT_MS = 10000;
const MAX_EXECS = 64;
const MAX_FORWARD_SOCKETS = 32;
const MAX_FORWARDS = 32;
const OFFER_TIMEOUT_MS = 30000;
const FORWARD_CLAIM_TIMEOUT_MS = 15000;
const PENDING_PIN_TTL_MS = 10 * 60 * 1000;
const MAX_UPDATE_BYTES = 67_108_864;
const ALPN = 'orch-host-agent/1';
const ERROR_CODES = new Set(['version', 'auth', 'protocol', 'denied', 'busy', 'failed', 'no-runtime']);
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const TYPED_ALPHABET = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

class ProtocolError extends Error {
  constructor(message) { super(message); this.code = 'ERR_HOST_AGENT_PROTOCOL'; }
}
class Terminal extends Error {
  constructor(reason) { super(reason); this.terminal = true; }
}
class SpawnRefused extends Error {}

const decodeStrict = new TextDecoder('utf-8', { fatal: true });

// ---- strict JSON: no duplicate keys, no trailing content, exact grammar ----

function skipWhitespace(text, at) {
  while (at < text.length) {
    const char = text[at];
    if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') break;
    at += 1;
  }
  return at;
}

function hex4(parser) {
  const digits = parser.text.slice(parser.at, parser.at + 4);
  if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw new ProtocolError('invalid JSON escape');
  parser.at += 4;
  return Number.parseInt(digits, 16);
}

function parseUnicodeEscape(parser) {
  const high = hex4(parser);
  if (high < 0xd800 || high > 0xdfff) return String.fromCharCode(high);
  if (high > 0xdbff) throw new ProtocolError('lone JSON surrogate');
  if (parser.text.slice(parser.at, parser.at + 2) !== '\\u') throw new ProtocolError('lone JSON surrogate');
  parser.at += 2;
  const low = hex4(parser);
  if (low < 0xdc00 || low > 0xdfff) throw new ProtocolError('lone JSON surrogate');
  return String.fromCharCode(high, low);
}

function parseEscape(parser) {
  const char = parser.text[parser.at + 1];
  const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
  if (char !== undefined && char in simple) { parser.at += 2; return simple[char]; }
  if (char === 'u') { parser.at += 2; return parseUnicodeEscape(parser); }
  throw new ProtocolError('invalid JSON escape');
}

function parseString(parser) {
  if (parser.text[parser.at] !== '"') throw new ProtocolError('expected JSON string');
  parser.at += 1;
  let out = '';
  for (;;) {
    const char = parser.text[parser.at];
    if (char === undefined) throw new ProtocolError('unterminated JSON string');
    if (char === '"') { parser.at += 1; return out; }
    if (char === '\\') { out += parseEscape(parser); continue; }
    if (char < ' ') throw new ProtocolError('control character in JSON string');
    out += char;
    parser.at += 1;
  }
}

function parseNumber(parser) {
  const start = parser.at;
  while (parser.at < parser.length) {
    const char = parser.text[parser.at];
    if ((char < '0' || char > '9') && !'+-.eE'.includes(char)) break;
    parser.at += 1;
  }
  const literal = parser.text.slice(start, parser.at);
  if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(literal)) throw new ProtocolError('invalid JSON number');
  const value = Number(literal);
  if (!Number.isFinite(value)) throw new ProtocolError('invalid JSON number');
  return value;
}

function parseLiteral(parser) {
  for (const [word, value] of [['true', true], ['false', false], ['null', null]]) {
    if (parser.text.startsWith(word, parser.at)) { parser.at += word.length; return value; }
  }
  throw new ProtocolError('invalid JSON literal');
}

function parseObject(parser) {
  parser.at = skipWhitespace(parser.text, parser.at + 1);
  const out = {};
  if (parser.text[parser.at] === '}') { parser.at += 1; return out; }
  for (;;) {
    parser.at = skipWhitespace(parser.text, parser.at);
    const key = parseString(parser);
    parser.at = skipWhitespace(parser.text, parser.at);
    if (parser.text[parser.at] !== ':') throw new ProtocolError('invalid JSON object');
    parser.at = skipWhitespace(parser.text, parser.at + 1);
    if (Object.hasOwn(out, key)) throw new ProtocolError('duplicate JSON key');
    out[key] = parseValue(parser);
    parser.at = skipWhitespace(parser.text, parser.at);
    const separator = parser.text[parser.at];
    if (separator === ',') { parser.at += 1; continue; }
    if (separator === '}') { parser.at += 1; return out; }
    throw new ProtocolError('invalid JSON object');
  }
}

function parseArray(parser) {
  parser.at = skipWhitespace(parser.text, parser.at + 1);
  const out = [];
  if (parser.text[parser.at] === ']') { parser.at += 1; return out; }
  for (;;) {
    parser.at = skipWhitespace(parser.text, parser.at);
    out.push(parseValue(parser));
    parser.at = skipWhitespace(parser.text, parser.at);
    const separator = parser.text[parser.at];
    if (separator === ',') { parser.at += 1; continue; }
    if (separator === ']') { parser.at += 1; return out; }
    throw new ProtocolError('invalid JSON array');
  }
}

function parseValue(parser) {
  const char = parser.text[parser.at];
  if (char === '{') return parseObject(parser);
  if (char === '[') return parseArray(parser);
  if (char === '"') return parseString(parser);
  if (char === '-' || (char >= '0' && char <= '9')) return parseNumber(parser);
  return parseLiteral(parser);
}

function parseJsonLine(line) {
  const parser = { text: line, at: 0, length: line.length };
  parser.at = skipWhitespace(line, 0);
  const value = parseValue(parser);
  parser.at = skipWhitespace(line, parser.at);
  if (parser.at !== line.length) throw new ProtocolError('trailing JSON content');
  return value;
}

// ---- shared validation helpers ----

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isPlainObject(value) && [...Object.keys(value)].sort().join(',') === [...keys].sort().join(',');
}

function utf8AtMost(value, limit) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= limit;
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function randomId() { return randomBytes(8).toString('base64url'); }

function fingerprintHex(der) { return createHash('sha256').update(der).digest('hex'); }

const SECRET_DUMMY_LEFT = createHash('sha256').update('orch-host-agent/dummy-left').digest();
const SECRET_DUMMY_RIGHT = createHash('sha256').update('orch-host-agent/dummy-right').digest();

function sameSecret(a, b) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // PROTOCOL.md: a wrong-length secret still pays one fixed-length
    // timing-safe compare before rejection; no length fast-fail that leaks
    // whether the length or the content check refused the input.
    timingSafeEqual(SECRET_DUMMY_LEFT, SECRET_DUMMY_RIGHT);
    return false;
  }
  return timingSafeEqual(left, right);
}

function checkCode(secret, der) {
  const message = Buffer.concat([Buffer.from('orch-host-agent/check/v1\0', 'utf8'), createHash('sha256').update(der).digest()]);
  const digest = createHmac('sha256', Buffer.from(secret.toUpperCase(), 'ascii')).update(message).digest();
  return String(digest.readUInt32BE(0) % 1000000).padStart(6, '0');
}

// ---- credential state: owner-only file, atomic replace, never logged ----

function loadState(statePath) {
  try {
    const value = JSON.parse(readFileSync(statePath, 'utf8'));
    if (exactKeys(value, ['version', 'agentId', 'credential', 'pin', 'pendingPin'])) return { ...value, pendingPinExpiresAt: null };
    return exactKeys(value, ['version', 'agentId', 'credential', 'pin', 'pendingPin', 'pendingPinExpiresAt']) ? value : null;
  } catch { return null; }
}

function saveState(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true });
  const staging = join(dirname(statePath), `.state-${process.pid}-${randomId()}.tmp`);
  writeFileSync(staging, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(staging, statePath);
}

function dropCredential(statePath, state) {
  saveState(statePath, { version: 1, agentId: null, credential: null, pin: state.pin, pendingPin: null, pendingPinExpiresAt: null });
}

// ---- LF line framing with byte bounds and an optional deadline ----

function lineReader(source, budget) {
  const state = { source, budget, pending: Buffer.alloc(0), consumed: 0, ended: false };
  source.pause();
  return { read: (deadline) => readLine(state, deadline), leftover: () => state.pending };
}

function waitReadable(state, deadline) {
  const { source } = state;
  return new Promise((resolveWait, rejectWait) => {
    let timer = null;
    const finish = (error) => {
      if (timer !== null) clearTimeout(timer);
      source.off('readable', onReady);
      source.off('end', onDone);
      source.off('close', onDone);
      source.off('error', onFailure);
      if (error) rejectWait(error); else resolveWait();
    };
    const onReady = () => finish(null);
    const onDone = () => { state.ended = true; finish(null); };
    const onFailure = (error) => finish(error);
    source.once('readable', onReady);
    source.once('end', onDone);
    source.once('close', onDone);
    source.once('error', onFailure);
    if (Number.isFinite(deadline)) timer = setTimeout(() => finish(new ProtocolError('read timeout')), Math.max(0, deadline - Date.now()));
  });
}

function consumeLine(state, lf) {
  if (lf > MAX_LINE) throw new ProtocolError('oversized line');
  const line = state.pending.subarray(0, lf);
  state.pending = state.pending.subarray(lf + 1);
  state.consumed += lf + 1;
  if (state.consumed > state.budget) throw new ProtocolError('byte budget exceeded');
  try { return decodeStrict.decode(line); }
  catch { throw new ProtocolError('invalid UTF-8'); }
}

async function readLine(state, deadline) {
  const { source } = state;
  for (;;) {
    const lf = state.pending.indexOf(10);
    if (lf !== -1) return consumeLine(state, lf);
    if (state.pending.length > MAX_LINE) throw new ProtocolError('oversized line');
    if (state.ended || source.destroyed || source.readableEnded) throw new ProtocolError('connection closed');
    const chunk = source.read();
    if (chunk !== null) { state.pending = Buffer.concat([state.pending, chunk]); continue; }
    await waitReadable(state, deadline);
  }
}

async function readMessage(reader, deadline) {
  const value = parseJsonLine(await reader.read(deadline));
  if (!isPlainObject(value) || typeof value.type !== 'string') throw new ProtocolError('message is not an object');
  return value;
}

function expectMessage(value, type, keys) {
  if (value.type === 'error') {
    if (!exactKeys(value, ['type', 'id', 'code']) || !ERROR_CODES.has(value.code)) throw new ProtocolError('invalid error');
    throw new Terminal(`orch-error:${value.code}`);
  }
  if (value.type !== type || !exactKeys(value, keys)) throw new ProtocolError(`expected ${type}`);
  return value;
}

async function writeLine(target, message) {
  const bytes = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
  await new Promise((resolveWrite, rejectWrite) => {
    target.write(bytes, (error) => { if (error) rejectWrite(error); else resolveWrite(); });
  });
}

// ---- platform process-tree ownership ----

function posixKiller(child, log) {
  let killed = false;
  return () => {
    if (killed) return;
    killed = true;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) {
      if (error.code !== 'ESRCH') log({ event: 'kill-failed', code: String(error.code ?? error.name) });
    }
  };
}

function holderKiller(child) {
  let killed = false;
  return () => {
    if (killed) return;
    killed = true;
    child.kill('SIGKILL');
  };
}

// A kill-on-close Job Object holder: the powershell process owns the job; when
// the agent terminates the holder, its only job handle closes and the kernel
// kills every remaining descendant. No admin rights and no shell are involved.
const HOLDER_SOURCE = [
  'param([string]$Spec)',
  '$ErrorActionPreference = \'Stop\'',
  'try {',
  '  $jobSpec = Get-Content -LiteralPath $Spec -Raw -Encoding UTF8 | ConvertFrom-Json',
  '  Remove-Item -LiteralPath $Spec -Force',
  '} catch { Exit 97 }',
  'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices;',
  'public static class OrchJob {',
  '  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attrs, string name);',
  '  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Limits info, int size);',
  '  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);',
  '  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();',
  '  [StructLayout(LayoutKind.Sequential)] public struct BasicLimits { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit;',
  '    public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;',
  '    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct Limits { public BasicLimits Basic; public IoCounters Io;',
  '    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }',
  '}\'',
  '$job = [OrchJob]::CreateJobObject([IntPtr]::Zero, $null)',
  'if ($job -eq [IntPtr]::Zero) { Exit 96 }',
  '$limits = New-Object OrchJob+Limits',
  '$basic = New-Object OrchJob+BasicLimits',
  '$basic.LimitFlags = 0x2000',
  '$limits.Basic = $basic',
  '$size = [System.Runtime.InteropServices.Marshal]::SizeOf([type][OrchJob+Limits])',
  'if (-not [OrchJob]::SetInformationJobObject($job, 9, [ref]$limits, $size)) { throw "SetInformationJobObject failed" }',
  'if (-not [OrchJob]::AssignProcessToJobObject($job, [OrchJob]::GetCurrentProcess())) { throw "AssignProcessToJobObject failed" }',
  '$start = New-Object System.Diagnostics.ProcessStartInfo',
  '$start.FileName = [string]$jobSpec.command',
  '$start.Arguments = [string]$jobSpec.arguments',
  '$start.WorkingDirectory = [string]$jobSpec.cwd',
  '$start.UseShellExecute = $false',
  '$vars = $start.EnvironmentVariables',
  '$vars.Clear()',
  'foreach ($item in $jobSpec.env.PSObject.Properties) { [void]$vars.Add($item.Name, [string]$item.Value) }',
  '$proc = New-Object System.Diagnostics.Process',
  '$proc.StartInfo = $start',
  '[void]$proc.Start()',
  '$proc.WaitForExit()',
  'Exit $proc.ExitCode',
  '',
].join('\n');

function windowsArguments(args) {
  return args.map(quoteWindowsArgument).join(' ');
}

function quoteWindowsArgument(arg) {
  if (arg === '') return '""';
  let out = '"';
  let slashes = 0;
  for (const char of arg) {
    if (char === '\\') { slashes += 1; continue; }
    if (char === '"') { out += `${'\\'.repeat(slashes * 2 + 1)}"`; slashes = 0; continue; }
    out += '\\'.repeat(slashes) + char;
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

function windowsHolder(stateDir) {
  const holder = join(stateDir, 'jobwrap.ps1');
  if (!existsSync(holder) || readFileSync(holder, 'utf8') !== HOLDER_SOURCE) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(holder, HOLDER_SOURCE, { mode: 0o600 });
  }
  return holder;
}

function windowsSpawn(header, stateDir, log) {
  // win32 cannot spawn a shebang or .cmd with shell:false, and a shell is never
  // the answer: only an explicit .exe path may run.
  if (!/\.exe$/i.test(header.command)) throw new SpawnRefused('win32 commands must be explicit .exe paths');
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!existsSync(powershell)) throw new SpawnRefused('powershell.exe unavailable for the job holder');
  const spec = join(stateDir, `spec-${randomId()}.json`);
  writeFileSync(spec, JSON.stringify({
    cwd: header.cwd, command: header.command, arguments: windowsArguments(header.args), env: header.env,
  }), { mode: 0o600 });
  const child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', windowsHolder(stateDir), '-Spec', spec], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  // Terminating the holder closes its Job Object handle and kills the tree.
  const killTree = holderKiller(child);
  child.once('close', () => { try { unlinkSync(spec); } catch { /* the holder removes it first */ } });
  log({ event: 'holder-spawn' });
  return { child, killTree };
}

function posixSpawn(header, log) {
  const child = spawn(header.command, header.args, {
    cwd: header.cwd, env: header.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  return { child, killTree: posixKiller(child, log) };
}

// A bootstrap command runs over the agent's platform floor. The spawn holders
// run the child with exactly the header's env (the win32 holder clears the
// block first), and without the OS's own floor a bare spawn dies before main():
// win32 node aborts in ncrypto::CSPRNG without SystemRoot, and HOME/PATH-less
// posix tools cannot work. header.env wins over the floor and only these named
// keys come from the agent — no other agent variable may leak into a remote
// command. A seat env stays exactly what orch sent (PROTOCOL.md).
const ENV_FLOOR = process.platform === 'win32'
  ? ['SystemRoot', 'PATH', 'TEMP', 'USERPROFILE']
  : ['HOME', 'PATH'];

function execEnv(header) {
  if (header.kind !== 'bootstrap') return header.env;
  const fold = process.platform === 'win32' ? (key) => key.toLowerCase() : (key) => key;
  const env = { ...header.env };
  const present = new Set(Object.keys(env).map(fold));
  for (const key of ENV_FLOOR) {
    if (!present.has(fold(key)) && process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function platformSpawn(header, stateDir, log) {
  const env = execEnv(header);
  const spawned = process.platform === 'win32' ? windowsSpawn({ ...header, env }, stateDir, log) : posixSpawn({ ...header, env }, log);
  await new Promise((resolveSpawn, rejectSpawn) => {
    spawned.child.once('spawn', resolveSpawn);
    spawned.child.once('error', rejectSpawn);
  });
  return spawned;
}

// ---- exec policy: run literally what orch resolved, inside the declared bounds ----

function canonicalOrNull(path) {
  try { return realpathSync(path); } catch { return null; }
}

// PROTOCOL.md: canonical path containment. Lexical prefixes are not a bound:
// a symlink or win32 junction created inside a root must not escape it, so both
// sides are resolved to their canonical paths; an unresolvable path refuses.
function withinRoots(roots, cwd) {
  const target = canonicalOrNull(resolve(cwd));
  if (target === null) return false;
  const fold = process.platform === 'win32' ? (value) => value.toLowerCase() : (value) => value;
  const wanted = fold(target);
  const separator = process.platform === 'win32' ? '\\' : '/';
  return roots.some((root) => {
    const base = canonicalOrNull(resolve(root));
    if (base === null) return false;
    const allowed = fold(base);
    return wanted === allowed || wanted.startsWith(allowed + separator);
  });
}

function bootstrapAllowed(policy, header) {
  return (policy?.bootstrap ?? []).some((allowed) => {
    const matchesPrefix = allowed.argsPrefix.every((arg, index) => header.args[index] === arg);
    return allowed.command === header.command && matchesPrefix
      && withinRoots(allowed.roots ?? policy?.roots ?? [], header.cwd);
  });
}

function authorizeExec(policy, header, runtimeCommit, daemonCommit) {
  if (header.kind === 'seat') {
    if (runtimeCommit !== daemonCommit) return 'protocol';
    return 'no-runtime'; // The commit-pinned runtime transfer is a later slice.
  }
  return bootstrapAllowed(policy, header) ? null : 'denied';
}

// ---- one authenticated session ----

function parseOrigin(origin) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('origin must be a bare https://host:port address');
  }
  return { host: url.hostname, port: url.port === '' ? 443 : Number(url.port) };
}

function peerDer(socket) {
  const certificate = socket.getPeerCertificate(false);
  if (!certificate || !certificate.raw) throw new ProtocolError('peer certificate unavailable');
  return Buffer.from(certificate.raw);
}

// An explicit pairing option also recovers stale persisted credentials/pins.
// Once pairing succeeds in this run, reconnects must not replay its secret.
function pairingFresh(options, ctx) {
  return Boolean(options.pair) && !ctx.paired;
}

function pendingPinFresh(state) {
  return Number.isSafeInteger(state.pendingPinExpiresAt) && Date.now() < state.pendingPinExpiresAt;
}

function decidePin({ options, state, seen, ctx }) {
  if (pairingFresh(options, ctx)) {
    // QR pins the supplied fingerprint before any secret can be written.
    if (options.pair.mode === 'qr' && !sameSecret(seen, options.pair.fingerprint)) throw new Terminal('pairing-failed');
    return null;
  }
  if (!state?.credential) throw new Terminal('pairing-required');
  if (pendingPinFresh(state) && sameSecret(seen, state.pendingPin ?? '')) return 'promote';
  if (!sameSecret(seen, state.pin)) throw new Terminal('re-pair-needed');
  return null;
}

function validateOrchHello(hello) {
  if (hello.version !== 1 || !utf8AtMost(hello.orchVersion, 64) || !utf8AtMost(hello.daemonCommit, 64)) {
    throw new ProtocolError('bad hello');
  }
}

// Human confirmation does not suspend the prelude timer (PROTOCOL.md): a
// stalled approval rejects at the deadline so the agent reconnects and
// repeats after confirmation instead of blocking the dial forever.
function raceApproval(promise, deadline) {
  return new Promise((resolveRace, rejectRace) => {
    let timer = null;
    const settle = (finish) => { if (timer !== null) clearTimeout(timer); finish(); };
    promise.then((value) => settle(() => resolveRace(value)), (error) => settle(() => rejectRace(error)));
    if (Number.isFinite(deadline)) {
      timer = setTimeout(() => settle(() => rejectRace(new ProtocolError('approval timeout'))), Math.max(0, deadline - Date.now()));
    }
  });
}

function typedApproval(options, ctx, seen) {
  if (ctx.approvedFingerprint === seen) return Promise.resolve(true);
  if (!ctx.approval || ctx.approval.fingerprint !== seen) {
    const offer = { code: checkCode(options.pair.secret, options.der), fingerprint: seen };
    ctx.approval = {
      fingerprint: seen,
      promise: Promise.resolve().then(() => options.approveCheckCode(offer)).then((approved) => {
        if (approved) ctx.approvedFingerprint = seen;
        return approved;
      }, (error) => { ctx.approval = null; throw error; }),
    };
  }
  return ctx.approval.promise;
}

async function pairOverWire(socket, reader, options, seen, log, ctx) {
  if (options.pair.mode === 'typed') {
    // All reconnects in this install share one operator decision, including a
    // decision still pending when the quarantined connection times out.
    const approved = await raceApproval(typedApproval(options, ctx, seen), options.deadline);
    if (!approved) throw new Terminal('pairing-cancelled');
  }
  await writeLine(socket, { type: 'pair', id: options.operationId, mode: options.pair.mode, secret: options.pair.secret });
  const paired = expectMessage(await readMessage(reader, options.deadline), 'paired', ['type', 'id', 'agentId', 'credential']);
  const valid = paired.id === options.operationId && utf8AtMost(paired.agentId, 256) && /^[A-Za-z0-9_-]{43}$/.test(paired.credential);
  if (!valid) throw new ProtocolError('bad paired');
  const state = { version: 1, agentId: paired.agentId, credential: paired.credential, pin: seen, pendingPin: null, pendingPinExpiresAt: null };
  saveState(options.statePath, state);
  ctx.paired = true;
  await options.onPaired?.();
  log({ event: 'paired', agentId: paired.agentId });
  return state;
}

async function authOverWire(socket, reader, options, state, seen, log, promote) {
  await writeLine(socket, { type: 'auth', id: options.operationId, agentId: state.agentId, credential: state.credential });
  const answer = await readMessage(reader, options.deadline);
  if (answer.type === 'error') {
    if (!exactKeys(answer, ['type', 'id', 'code']) || !ERROR_CODES.has(answer.code)) throw new ProtocolError('invalid error');
    if (answer.code === 'auth') {
      dropCredential(options.statePath, state);
      throw new Terminal('revoked');
    }
    if (answer.code === 'busy') throw new Terminal('busy');
    throw new Terminal(`orch-error:${answer.code}`);
  }
  const authenticated = expectMessage(answer, 'authenticated', ['type', 'id', 'agentId']);
  if (authenticated.id !== options.operationId || authenticated.agentId !== state.agentId) throw new ProtocolError('bad authenticated');
  if (promote) {
    saveState(options.statePath, { ...state, pin: seen, pendingPin: null, pendingPinExpiresAt: null });
    log({ event: 'pin-promoted' });
  }
  log({ event: 'authenticated' });
  return state;
}

async function prelude(socket, options, state, log, deadline, ctx) {
  const reader = lineReader(socket, PRELUDE_BUDGET);
  const der = peerDer(socket);
  const seen = fingerprintHex(der);
  const promote = decidePin({ options, state, seen, ctx });
  const wire = { ...options, operationId: randomId(), deadline, der };
  await writeLine(socket, {
    type: 'hello', version: 1, agentVersion: options.agentVersion, nodeVersion: process.version,
    platform: process.platform, arch: process.arch,
  });
  const hello = expectMessage(await readMessage(reader, deadline), 'hello', ['type', 'version', 'orchVersion', 'daemonCommit']);
  validateOrchHello(hello);
  const newState = pairingFresh(options, ctx)
    ? await pairOverWire(socket, reader, wire, seen, log, ctx)
    : await authOverWire(socket, reader, wire, state, seen, log, promote);
  await writeLine(socket, { type: 'switch', version: 1 });
  const ready = expectMessage(await readMessage(reader, deadline), 'switch-ready', ['type', 'version']);
  if (ready.version !== 1) throw new ProtocolError('bad switch-ready');
  return { leftover: reader.leftover(), daemonCommit: hello.daemonCommit, state: newState };
}

function createSession(options, log) {
  const state = {
    options, log, running: new Map(), offers: new Map(), usedIds: new Set(), updates: new Map(),
    forwards: new Map(), pendingSockets: new Map(), control: null,
    session: null, closed: false, daemonCommit: null,
  };
  return {
    attach: (socket, leftover, commit) => attachSession(state, socket, leftover, commit),
    failSession: (reason) => failSession(state, reason),
  };
}

async function sendEvent(state, message) {
    const { control } = state;
    if (!control || control.destroyed || control.closed) return;
    if (!control.write(`${JSON.stringify(message)}\n`)) {
      await Promise.race([once(control, 'drain').catch(() => {}), once(control, 'close').catch(() => {})]);
    }
  }

function closeForward(state, forward) {
    forward.server.close();
    for (const [id, entry] of state.pendingSockets) {
      if (forward.sockets.has(entry.socket)) {
        clearTimeout(entry.timer);
        state.pendingSockets.delete(id);
      }
    }
    for (const socket of forward.sockets) socket.destroy();
    forward.sockets.clear();
  }

function discardUpdates(state) {
  for (const update of state.updates.values()) {
    if (!update.temporary) continue;
    try { unlinkSync(update.temporary); } catch { /* already staged or removed */ }
  }
  state.updates.clear();
}

function failSession(state, reason) {
    if (state.closed) return;
    state.closed = true;
    state.log({ event: 'session-fatal', reason });
    for (const exec of state.running.values()) exec.killTree();
    state.running.clear();
    for (const offer of state.offers.values()) clearTimeout(offer.timer);
    state.offers.clear();
    discardUpdates(state);
    for (const entry of state.pendingSockets.values()) clearTimeout(entry.timer);
    for (const forward of state.forwards.values()) closeForward(state, forward);
    state.forwards.clear();
    state.pendingSockets.clear();
    // Stream close can run inside nghttp2's receive callback. Defer session
    // destruction until that native stack unwinds (RST submission is reentrant).
    setImmediate(() => { state.session?.destroy(); state.control?.destroy(); });
}

function commandError(state, id, code) { return sendEvent(state, { type: 'error', id, code }); }

// An offer orch never claims must not pin memory forever; the id stays consumed
// for the connection (PROTOCOL.md: ids are single-use).
function registerOffer(state, id, header) {
  const entry = { header, timer: setTimeout(() => {
    if (state.offers.get(id) === entry) {
      state.offers.delete(id);
      state.log({ event: 'offer-expired', id });
    }
  }, OFFER_TIMEOUT_MS) };
  entry.timer.unref();
  state.offers.set(id, entry);
}

async function handleExecCommand(state, value) {
    const { options, log, running, offers, usedIds, daemonCommit } = state;
    const shaped = exactKeys(value, ['type', 'id', 'header', 'runtimeCommit']) && validId(value.id)
      && (value.runtimeCommit === null || typeof value.runtimeCommit === 'string');
    if (!shaped) throw new ProtocolError('bad exec offer');
    if (usedIds.has(value.id)) throw new ProtocolError('duplicate operation id');
    if (running.size + offers.size >= MAX_EXECS) return commandError(state, value.id, 'busy');
    let header;
    try { header = parseExecHeader(JSON.stringify(value.header)); }
    catch { return commandError(state, value.id, 'protocol'); }
    const verdict = authorizeExec(options.policy, header, value.runtimeCommit, daemonCommit);
    if (verdict === 'no-runtime') {
      log({ event: 'exec-refused', id: value.id, reason: 'seat runtime not available in this slice' });
      return commandError(state, value.id, 'no-runtime');
    }
    if (verdict) return commandError(state, value.id, verdict);
    usedIds.add(value.id);
    registerOffer(state, value.id, header);
    return sendEvent(state, { type: 'exec-ready', id: value.id });
  }

async function handleForwardOpen(state, value) {
    const { forwards } = state;
    const shaped = exactKeys(value, ['type', 'id', 'seatId', 'endpointId']) && validId(value.id)
      && utf8AtMost(value.seatId, 256) && utf8AtMost(value.endpointId, 256);
    if (!shaped) throw new ProtocolError('bad forward-open');
    if (forwards.has(value.id)) throw new ProtocolError('duplicate operation id');
    if (forwards.size >= MAX_FORWARDS) return commandError(state, value.id, 'busy');
    // PROTOCOL.md: one binding belongs to a live seat on this connection; the
    // seat is kept so a later slice can retire bindings with their seat.
    const forward = { seatId: value.seatId, server: createNetServer(), sockets: new Set() };
    forward.server.on('connection', (socket) => acceptForwardSocket(state, forward, value.id, socket));
    forwards.set(value.id, forward);
    try {
      // Reverse bindings are loopback-only: 127.0.0.1, never a wildcard.
      await new Promise((resolveListen, rejectListen) => {
        forward.server.once('error', rejectListen);
        forward.server.listen(0, '127.0.0.1', () => { forward.server.off('error', rejectListen); resolveListen(); });
      });
    } catch (error) {
      forwards.delete(value.id);
      closeForward(state, forward);
      return commandError(state, value.id, 'failed');
    }
    return sendEvent(state, { type: 'forward-ready', id: value.id, port: forward.server.address().port });
  }

function handleForwardClose(state, value) {
    const { forwards } = state;
    if (!exactKeys(value, ['type', 'id']) || !validId(value.id)) throw new ProtocolError('bad forward-close');
    const forward = forwards.get(value.id);
    if (!forward) return commandError(state, value.id, 'denied');
    forwards.delete(value.id);
    closeForward(state, forward);
    return sendEvent(state, { type: 'forward-closed', id: value.id });
  }

function validateCertRotate(value) {
  const shaped = exactKeys(value, ['type', 'id', 'fingerprint', 'certificate', 'activateAfter'])
    && validId(value.id)
    && /^[a-f0-9]{64}$/.test(value.fingerprint) && Number.isSafeInteger(value.activateAfter) && value.activateAfter >= 0
    && typeof value.certificate === 'string' && /^[A-Za-z0-9_-]+$/.test(value.certificate);
  if (!shaped) throw new ProtocolError('bad cert-rotate');
}

async function handleCertRotate(state, value) {
    const { options, log, usedIds } = state;
    validateCertRotate(value);
    if (usedIds.has(value.id)) throw new ProtocolError('duplicate operation id');
    const der = Buffer.from(value.certificate, 'base64url');
    if (der.length === 0 || der.length > 16384 || fingerprintHex(der) !== value.fingerprint) return commandError(state, value.id, 'protocol');
    const current = loadState(options.statePath);
    if (!current) return commandError(state, value.id, 'denied');
    usedIds.add(value.id);
    // activateAfter is orch's activation plan, not an agent decision: the pin
    // only promotes after a successful authentication under the new certificate,
    // which cannot happen before orch actually activates it, so a local time
    // check would add no safety. The field stays a validated nonnegative integer.
    saveState(options.statePath, { ...current, pendingPin: value.fingerprint, pendingPinExpiresAt: Date.now() + PENDING_PIN_TTL_MS });
    log({ event: 'rotation-persisted', id: value.id });
    return sendEvent(state, { type: 'cert-rotate-ready', id: value.id });
  }

function validateUpdateOffer(value) {
  const shaped = exactKeys(value, ['type', 'id', 'version', 'platform', 'arch', 'size', 'sha256'])
    && validId(value.id) && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= MAX_UPDATE_BYTES
    && /^[a-f0-9]{64}$/.test(value.sha256) && utf8AtMost(value.version, 64);
  if (!shaped) throw new ProtocolError('bad update offer');
}

async function handleUpdate(state, value) {
  validateUpdateOffer(value);
  if (state.usedIds.has(value.id)) throw new ProtocolError('duplicate operation id');
  if (state.updates.size >= 4) return commandError(state, value.id, 'busy');
  if (!state.options.update?.root || !state.options.update.activate) return commandError(state, value.id, 'denied');
  if (value.platform !== process.platform || value.arch !== process.arch) return commandError(state, value.id, 'denied');
  try { if (compareVersions(value.version, state.options.agentVersion) <= 0) return commandError(state, value.id, 'denied'); }
  catch { return commandError(state, value.id, 'protocol'); }
  state.usedIds.add(value.id);
  const temporary = join(state.options.update.root, '.incoming', `${randomId()}.tar`);
  state.updates.set(value.id, { ...value, temporary, claimed: false, pointer: null });
  return sendEvent(state, { type: 'update-ready', id: value.id });
}

async function receiveUpdate(stream, offer) {
  const output = createWriteStream(offer.temporary, { flags: 'wx', mode: 0o600 });
  const completion = finished(output);
  completion.catch(() => {}); // handled below, including early disk errors
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > offer.size) throw new ProtocolError('oversized update');
      hash.update(chunk);
      if (!output.write(chunk)) await once(output, 'drain');
    }
    output.end();
    await completion;
  } catch (error) {
    output.destroy();
    await completion.catch(() => {});
    throw error;
  }
  if (size !== offer.size || hash.digest('hex') !== offer.sha256) throw new ProtocolError('update digest mismatch');
  const fd = openSync(offer.temporary, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

async function updateStream(state, stream, id) {
  const offer = state.updates.get(id);
  if (!offer || offer.claimed || offer.pointer) {
    stream.respond({ ':status': 404 });
    stream.end();
    return;
  }
  offer.claimed = true;
  try {
    mkdirSync(dirname(offer.temporary), { recursive: true, mode: 0o700 });
    await receiveUpdate(stream, offer);
    offer.pointer = stageArtifact({
      root: state.options.update.root, artifact: offer.temporary,
      expectedSha256: offer.sha256, expectedVersion: offer.version,
    });
    unlinkSync(offer.temporary);
    offer.temporary = null;
    stream.respond({ ':status': 200 });
    stream.end();
    await sendEvent(state, { type: 'update-staged', id });
  } catch (error) {
    if (offer.temporary) try { unlinkSync(offer.temporary); } catch { /* best-effort cleanup */ }
    state.updates.delete(id);
    try { stream.respond({ ':status': 400 }); } catch { /* peer already reset */ }
    stream.end();
    state.log({ event: 'update-refused', id, code: String(error.code ?? error.name) });
    await commandError(state, id, 'failed');
  }
}

async function handleUpdateActivate(state, value) {
  if (!exactKeys(value, ['type', 'id']) || !validId(value.id)) throw new ProtocolError('bad update-activate');
  const offer = state.updates.get(value.id);
  if (!offer?.pointer || offer.activated) return commandError(state, value.id, 'denied');
  if (state.running.size || state.forwards.size) return commandError(state, value.id, 'busy');
  offer.activated = true;
  try {
    await state.options.update.activate(offer.pointer);
    state.log({ event: 'update-activated', id: value.id, version: offer.version });
  } catch (error) {
    state.log({ event: 'update-rollback', id: value.id, code: String(error.code ?? error.name) });
    await commandError(state, value.id, 'failed');
  }
}

function refuseLaterSlice(state, value, keys, name) {
    if (!exactKeys(value, keys) || !validId(value.id)) throw new ProtocolError(`bad ${name} offer`);
    return commandError(state, value.id, 'denied');
}

function acceptForwardSocket(state, forward, forwardId, socket) {
  if (state.closed || forward.sockets.size >= MAX_FORWARD_SOCKETS) { socket.destroy(); return; }
  const id = randomId();
  socket.pause(); // Buffer bytes until orch claims the connection stream.
  forward.sockets.add(socket);
  // A local socket orch never claims must not linger on the loopback listener.
  const entry = { socket, timer: setTimeout(() => { state.pendingSockets.delete(id); socket.destroy(); }, FORWARD_CLAIM_TIMEOUT_MS) };
  entry.timer.unref();
  state.pendingSockets.set(id, entry);
  socket.on('error', () => socket.destroy());
  socket.once('close', () => {
    clearTimeout(entry.timer);
    forward.sockets.delete(socket);
    state.pendingSockets.delete(id);
  });
  void sendEvent(state, { type: 'forward-connect', id, forwardId });
}

  const handlers = {
    exec: handleExecCommand,
    'forward-open': handleForwardOpen,
    'forward-close': handleForwardClose,
    'cert-rotate': handleCertRotate,
    // Runtime transfer is a later slice: refuse, never guess.
    runtime: (state, value) => refuseLaterSlice(state, value, ['type', 'id', 'commit', 'manifestSha256', 'size'], 'runtime'),
    update: handleUpdate,
    'update-activate': handleUpdateActivate,
  };

function localUpdateResult(file) {
  try {
    const result = parseJsonLine(readFileSync(file, 'utf8'));
    const activated = exactKeys(result, ['status', 'version', 'at']) && result.status === 'activated'
      && utf8AtMost(result.version, 64) && utf8AtMost(result.at, 64);
    const failed = exactKeys(result, ['status', 'message', 'at']) && result.status === 'rolled-back-or-failed'
      && utf8AtMost(result.message, 4096) && utf8AtMost(result.at, 64);
    if (activated || failed) return result;
  } catch {
    // A corrupt local result must never wedge every reconnect (this throw used
    // to kill controlLoop before the link could come up).
  }
  // Report the failure naming the corrupt file; the caller drops the file.
  return { status: 'rolled-back-or-failed', message: 'corrupt update-result.json', at: new Date().toISOString() };
}

async function reportUpdateResult(state) {
  const root = state.options.update?.root;
  if (!root) return;
  const file = join(root, 'update-result.json');
  if (!existsSync(file)) return;
  // At most once: the file goes only after the send, with no acknowledgement.
  await sendEvent(state, { type: 'update-result', ...localUpdateResult(file) });
  unlinkSync(file);
}

async function controlLoop(state, stream) {
    const { log } = state;
    stream.respond({ ':status': 200, 'content-type': 'application/x-ndjson' });
    state.control = stream;
    await reportUpdateResult(state);
    const reader = lineReader(stream, Number.POSITIVE_INFINITY);
    stream.once('close', () => failSession(state, 'control-closed'));
    for (;;) {
      let value;
      try { value = parseJsonLine(await reader.read(Number.POSITIVE_INFINITY)); }
      catch { return failSession(state, 'control-line'); }
      if (!isPlainObject(value) || typeof value.type !== 'string') return failSession(state, 'control-shape');
      const handler = handlers[value.type];
      if (!handler) return failSession(state, 'control-unknown');
      try { await handler(state, value); }
      catch (error) {
        if (error instanceof ProtocolError) return failSession(state, 'control-handler');
        log({ event: 'handler-error', type: value.type, code: String(error.code ?? error.name) });
        return failSession(state, 'control-handler');
      }
    }
  }

async function execStream(state, stream, id) {
    const { offers, options, log, running } = state;
    const entry = offers.get(id);
    if (!entry || !validId(id)) {
      stream.respond({ ':status': 403, 'content-type': 'application/x-ndjson' });
      stream.close(constants.NGHTTP2_CANCEL);
      return;
    }
    offers.delete(id);
    clearTimeout(entry.timer);
    const cwd = canonicalOrNull(resolve(entry.header.cwd));
    const header = { ...entry.header, cwd };
    // The offer can sit for 30s: a directory may become a symlink/junction in
    // that window. Re-authorize at use and spawn the canonical path we checked.
    if (cwd === null || !bootstrapAllowed(options.policy, header)) {
      stream.respond({ ':status': 403 });
      stream.close(constants.NGHTTP2_CANCEL);
      return commandError(state, id, 'denied');
    }
    stream.respond({ ':status': 200, 'content-type': 'application/octet-stream' }, { waitForTrailers: true });
    let spawned;
    let cancelled = false;
    const cancel = () => { cancelled = true; spawned?.killTree(); };
    const detachCancel = () => {
      stream.off('aborted', cancel);
      stream.off('close', cancel);
      stream.off('error', cancel);
    };
    stream.once('aborted', cancel);
    stream.once('close', cancel);
    stream.once('error', cancel);
    try {
      spawned = await platformSpawn(header, dirname(options.statePath), log);
    } catch (error) {
      log({ event: 'spawn-refused', id, reason: error instanceof SpawnRefused ? error.message : 'spawn failed' });
      stream.close(constants.NGHTTP2_INTERNAL_ERROR);
      return commandError(state, id, 'failed');
    } finally {
      detachCancel();
    }
    if (cancelled) {
      spawned.killTree();
      return;
    }
    running.set(id, { killTree: spawned.killTree });
    log({ event: 'exec-started', id });
    pipeExec(stream, spawned.child, { killTree: spawned.killTree }).then(
      (result) => { running.delete(id); log({ event: 'exec-exit', id, code: result.code, signal: result.signal }); },
      (error) => { running.delete(id); log({ event: 'exec-failed', id, code: String(error.code ?? error.name) }); },
    );
  }

function forwardStream(state, stream, id) {
    const { pendingSockets } = state;
    const entry = pendingSockets.get(id);
    if (!entry || !ID_PATTERN.test(id)) {
      stream.respond({ ':status': 403, 'content-type': 'application/x-ndjson' });
      stream.close(constants.NGHTTP2_CANCEL);
      return;
    }
    pendingSockets.delete(id);
    clearTimeout(entry.timer);
    const local = entry.socket;
    stream.respond({ ':status': 200, 'content-type': 'application/octet-stream' });
    const teardown = () => { local.destroy(); if (!stream.destroyed) stream.close(constants.NGHTTP2_CANCEL); };
    stream.once('aborted', teardown);
    stream.once('close', () => local.destroy());
    stream.on('error', teardown);
    local.once('close', () => { if (!stream.destroyed) stream.end(); });
    local.on('error', () => stream.end());
    local.on('data', (chunk) => { if (!stream.write(chunk)) local.pause(); });
    stream.on('drain', () => local.resume());
    stream.pipe(local); // request DATA to the local socket; END_STREAM half-closes
    local.resume();
  }

function onStream(state, stream, headers) {
    stream.on('error', () => {});
    if (headers[':method'] !== 'POST') {
      stream.respond({ ':status': 404 });
      stream.end();
      return;
    }
    const path = headers[':path'] ?? '';
    if (path === '/v1/control') return void controlLoop(state, stream).catch(() => failSession(state, 'control-loop'));
    if (path.startsWith('/v1/exec/')) return void execStream(state, stream, path.slice(9));
    if (path.startsWith('/v1/forward/')) return void forwardStream(state, stream, path.slice(12));
    if (path.startsWith('/v1/update/')) return void updateStream(state, stream, path.slice(11));
    stream.respond({ ':status': 404 });
    stream.end();
  }

function attachSession(state, socket, leftover, commit) {
      state.daemonCommit = commit;
      const server = createHttp2Server({ settings: { maxConcurrentStreams: 256, maxHeaderListSize: 16384 } });
      server.on('stream', (stream, headers) => onStream(state, stream, headers));
      const ended = new Promise((resolveEnd) => {
        server.once('session', (established) => {
          state.session = established;
          established.once('close', () => { failSession(state, 'session-closed'); resolveEnd(); });
          established.once('error', () => { failSession(state, 'session-error'); resolveEnd(); });
        });
        server.once('error', () => { failSession(state, 'server-error'); resolveEnd(); });
      });
      // The server handler is installed before the socket resumes; bytes
      // coalesced after the barrier LF go back to the socket untouched.
      if (leftover.length) socket.unshift(leftover);
      server.emit('connection', socket);
      socket.resume();
      return ended;
}

// The prelude limit starts at dial: TCP connect and TLS handshake are bounded
// by the same deadline as the prelude reads, and a destroyed socket (stop(),
// peer reset) settles the promise instead of leaving the dial pending forever.
function awaitSecureConnect(socket, deadline) {
  return new Promise((resolveConnect, rejectConnect) => {
    let timer = null;
    const finish = (error) => {
      if (timer !== null) clearTimeout(timer);
      socket.off('secureConnect', onSecure);
      socket.off('error', onFailure);
      socket.off('close', onClosed);
      if (error) rejectConnect(error); else resolveConnect();
    };
    const onSecure = () => finish(null);
    const onFailure = (error) => finish(error);
    const onClosed = () => finish(new ProtocolError('connection closed'));
    socket.once('secureConnect', onSecure);
    socket.once('error', onFailure);
    socket.once('close', onClosed);
    if (Number.isFinite(deadline)) timer = setTimeout(() => finish(new ProtocolError('connect timeout')), Math.max(0, deadline - Date.now()));
  });
}

async function connectSession(options, state, log, ctx) {
  const address = parseOrigin(options.origin);
  const deadline = Date.now() + PRELUDE_TIMEOUT_MS;
  const dial = {
    host: address.host, port: address.port,
    minVersion: 'TLSv1.3', ALPNProtocols: [ALPN], rejectUnauthorized: false,
  };
  // Node refuses an IP-literal servername and SNI is not defined for IPs anyway.
  if (isIP(address.host) === 0) dial.servername = address.host;
  const socket = dialTls(dial);
  // Errors surface through the awaited paths (connect, prelude reads/writes);
  // this bare listener keeps a kernel RST delivered after those paths detached
  // their own listeners from crashing the process as an unhandled 'error'.
  socket.on('error', () => {});
  ctx.socket = socket;
  socket.setNoDelay(true);
  try {
    await awaitSecureConnect(socket, deadline);
    if (socket.alpnProtocol !== ALPN) throw new ProtocolError('alpn mismatch');
    const barrier = await prelude(socket, options, state, log, deadline, ctx);
    const session = createSession(options, log);
    ctx.kill = session.failSession;
    return session.attach(socket, barrier.leftover, barrier.daemonCommit);
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function backoffMs(backoff, attempt) {
  const initial = backoff?.initialMs ?? 1000;
  const max = backoff?.maxMs ?? 30000;
  return Math.min(initial * 2 ** (attempt - 1), max);
}

function validateOptions(options) {
  parseOrigin(options.origin);
  if (!utf8AtMost(options.agentVersion, 64) || !options.agentVersion.trim()) throw new Error('agentVersion must be at most 64 bytes');
  if (typeof options.statePath !== 'string' || !options.statePath) throw new Error('statePath is required');
  validatePairOptions(options);
  if (options.approvedFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(options.approvedFingerprint)) {
    throw new Error('approvedFingerprint must be a full fingerprint');
  }
}

function validatePairOptions(options) {
  if (!options.pair) return;
  if (options.pair.mode === 'typed') return validateTypedOptions(options);
  if (options.pair.mode === 'qr') return validateQrOptions(options.pair);
  throw new Error('unsupported pairing mode');
}

function validateTypedOptions({ pair, approveCheckCode }) {
  if (typeof approveCheckCode !== 'function') throw new Error('typed pairing requires approveCheckCode');
  if (!TYPED_ALPHABET.test(pair.secret ?? '')) throw new Error('typed secret must be eight characters of the pairing alphabet');
}

function validateQrOptions(pair) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(pair.secret ?? '')) throw new Error('qr secret must be 16 base64url bytes');
  if (!/^[a-f0-9]{64}$/.test(pair.fingerprint ?? '')) throw new Error('qr pairing requires a full fingerprint pin');
}

function reconnectWait(ctx, delay) {
  if (ctx.stopped) return Promise.resolve();
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, delay);
    ctx.wake = () => { clearTimeout(timer); resolveSleep(); };
  });
}

async function sessionAttempt(options, state, log, ctx) {
  try {
    await connectSession(options, state, log, ctx);
    // connectSession resolved: a fully authenticated session ran and ended,
    // so the reconnect ladder restarts from the initial delay.
    ctx.attempt = 0;
    return null;
  } catch (error) {
    if (ctx.stopped) return null;
    if (error.terminal) throw error;
    return error;
  }
}

async function agentLoop(options, log, ctx) {
  let state = loadState(options.statePath);
  try {
    while (!ctx.stopped) {
      const failure = await sessionAttempt(options, state, log, ctx);
      if (ctx.stopped) break;
      state = loadState(options.statePath) ?? state;
      ctx.attempt += 1;
      const delay = backoffMs(options.backoff, ctx.attempt);
      log({ event: 'reconnect', attempt: ctx.attempt, delayMs: delay, code: String(failure?.code ?? failure?.name ?? 'session-end') });
      await reconnectWait(ctx, delay);
    }
    return { reason: 'stopped' };
  } catch (error) {
    if (!error.terminal) throw error;
    log({ event: 'terminal', reason: error.message });
    return { reason: error.message };
  }
}

/** Run the host agent until a terminal reason. Returns { promise, stop() }. */
export function runAgent(options) {
  if (!['win32', 'darwin', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
  }
  validateOptions(options);
  const log = options.log ?? ((entry) => { console.error(JSON.stringify(entry)); });
  const ctx = {
    socket: null, kill: null, wake: null, stopped: false, attempt: 0, paired: false,
    approvedFingerprint: options.approvedFingerprint ?? null, approval: null,
  };
  const promise = agentLoop(options, log, ctx);
  return {
    promise,
    stop() {
      ctx.stopped = true;
      ctx.kill?.();
      ctx.socket?.destroy();
      ctx.wake?.();
    },
  };
}
