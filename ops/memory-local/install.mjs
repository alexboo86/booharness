#!/usr/bin/env node
// Runs memoryd on this machine as a per-user LaunchAgent or Windows task, with the embedder dense
// search needs. For a single-machine harness (no NAS).
//
// ops/bootstrap/install-memory.mjs owns the installed files and the launchd
// plist: its LOCAL mode (no --remote, no service.url) copies the service,
// writes the plist with MEMORYCTL_EMBED_URL and the embedding model IT pins
// (qwen3-embedding:0.6b), and records the embed URL in local-service.json.
// This file is the thin half install-memory deliberately does not do: it runs
// install-memory in local mode under the kit's unit name, then loads the unit
// and waits for /health. The label `local.harness.memoryd` and the database
// `~/.local/state/memoryctl/memory.db` are the ones the 2026-10-05 kit
// installed, so re-running this on an installed kit updates it IN PLACE:
// same unit, same database, one writer.
//
//   node ops/memory-local/install.mjs            # install, (re)load, wait for /health
//   node ops/memory-local/install.mjs --dry      # print the plan, touch nothing
//   node ops/memory-local/install.mjs --check     # verify the install, exit 1 on drift
//   node ops/memory-local/install.mjs --uninstall
//
// Options: --port 7717  --embed-url http://127.0.0.1:11434  --node /abs/path/to/node
//          --forward <ssh-host>:<port>   (repeatable; install-memory.mjs owns and judges it)
// An argument outside this list ends with exit 2: no argument is dropped silently.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readHarnessConfig, harnessLabel, harnessPaths, harnessTaskName, embedUrlRefusal } from '../../scripts/lib/harness-config.mjs';
import { importPinnedEmbedModel, readEmbedImportPin } from '../../scripts/lib/import-embed-model.mjs';
import { isMain } from '../../scripts/lib/is-main.mjs';
import { forwardLaunchdLabel, forwardSshArgs, workerPlistPath } from '../../scripts/lib/memory-forward.mjs';
import { currentUserSid, renderTaskXml, queryTask, endTask, createTask, runTask, deleteTask } from '../bootstrap/win-task.mjs';

const psString = (text) => `'${String(text).replaceAll("'", "''")}'`;
const powershell = (script) => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${script}`], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`powershell.exe failed (exit ${result.status}): ${result.stdout || ''}${result.stderr || ''}`);
  return result.stdout.trim();
};

// cmd.exe rebuilds a task-launched command line before the child sees it: a
// quoted executable gains a second space before its first argument and
// stripped 1>>/2>> redirections leave a trailing space (live run A: '"node.exe"
// "memoryd.mjs"' with two spaces, the forward's ssh line with both). The
// wrapper's own children carry the executable path plus these argument
// tokens, never the spacing of the line. An empty quoted argument ("") is a
// token too: \S+ never matches empty, so every empty token here is a real
// argument a foreign line carries and the owned one does not.
const commandTokens = (line) => [...String(line).matchAll(/"[^"]*"|\S+/g)]
  .map((token) => token[0].replaceAll('"', ''));
const sameCommandLine = (left, right) => left === right
  || commandTokens(left).join('\u0000') === commandTokens(right).join('\u0000');

// `schtasks /Query /XML` declares UTF-16 and can mean it (FF FE plus wide
// bytes), but on a real host (build 10.0.26300) the piped bytes are the console
// code page while the declaration still says UTF-16 (first bytes 3c 3f 78 6d
// 6c). The bytes decide: a BOM or any NUL means UTF-16LE, anything else is
// single-byte and decoded in the console's code page, which chcp names.
// CP437 and CP850, the OEM pages of US/Western-European consoles, have no
// TextDecoder label: their 128-entry high-half tables (bytes 0x80..0xFF) are
// spelled out instead, generated from Python's cp437 and cp850 codecs (the
// test pins each table against that codec's output). Every byte of a
// single-byte page decodes, so a table decoder cannot fail.
const CP437_HIGH = [
  /* 0x80 */ 0x00C7, 0x00FC, 0x00E9, 0x00E2, 0x00E4, 0x00E0, 0x00E5, 0x00E7, 0x00EA, 0x00EB, 0x00E8, 0x00EF, 0x00EE, 0x00EC, 0x00C4, 0x00C5,
  /* 0x90 */ 0x00C9, 0x00E6, 0x00C6, 0x00F4, 0x00F6, 0x00F2, 0x00FB, 0x00F9, 0x00FF, 0x00D6, 0x00DC, 0x00A2, 0x00A3, 0x00A5, 0x20A7, 0x0192,
  /* 0xA0 */ 0x00E1, 0x00ED, 0x00F3, 0x00FA, 0x00F1, 0x00D1, 0x00AA, 0x00BA, 0x00BF, 0x2310, 0x00AC, 0x00BD, 0x00BC, 0x00A1, 0x00AB, 0x00BB,
  /* 0xB0 */ 0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556, 0x2555, 0x2563, 0x2551, 0x2557, 0x255D, 0x255C, 0x255B, 0x2510,
  /* 0xC0 */ 0x2514, 0x2534, 0x252C, 0x251C, 0x2500, 0x253C, 0x255E, 0x255F, 0x255A, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256C, 0x2567,
  /* 0xD0 */ 0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256B, 0x256A, 0x2518, 0x250C, 0x2588, 0x2584, 0x258C, 0x2590, 0x2580,
  /* 0xE0 */ 0x03B1, 0x00DF, 0x0393, 0x03C0, 0x03A3, 0x03C3, 0x00B5, 0x03C4, 0x03A6, 0x0398, 0x03A9, 0x03B4, 0x221E, 0x03C6, 0x03B5, 0x2229,
  /* 0xF0 */ 0x2261, 0x00B1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00F7, 0x2248, 0x00B0, 0x2219, 0x00B7, 0x221A, 0x207F, 0x00B2, 0x25A0, 0x00A0,
];
const CP850_HIGH = [
  /* 0x80 */ 0x00C7, 0x00FC, 0x00E9, 0x00E2, 0x00E4, 0x00E0, 0x00E5, 0x00E7, 0x00EA, 0x00EB, 0x00E8, 0x00EF, 0x00EE, 0x00EC, 0x00C4, 0x00C5,
  /* 0x90 */ 0x00C9, 0x00E6, 0x00C6, 0x00F4, 0x00F6, 0x00F2, 0x00FB, 0x00F9, 0x00FF, 0x00D6, 0x00DC, 0x00F8, 0x00A3, 0x00D8, 0x00D7, 0x0192,
  /* 0xA0 */ 0x00E1, 0x00ED, 0x00F3, 0x00FA, 0x00F1, 0x00D1, 0x00AA, 0x00BA, 0x00BF, 0x00AE, 0x00AC, 0x00BD, 0x00BC, 0x00A1, 0x00AB, 0x00BB,
  /* 0xB0 */ 0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x00C1, 0x00C2, 0x00C0, 0x00A9, 0x2563, 0x2551, 0x2557, 0x255D, 0x00A2, 0x00A5, 0x2510,
  /* 0xC0 */ 0x2514, 0x2534, 0x252C, 0x251C, 0x2500, 0x253C, 0x00E3, 0x00C3, 0x255A, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256C, 0x00A4,
  /* 0xD0 */ 0x00F0, 0x00D0, 0x00CA, 0x00CB, 0x00C8, 0x0131, 0x00CD, 0x00CE, 0x00CF, 0x2518, 0x250C, 0x2588, 0x2584, 0x00A6, 0x00CC, 0x2580,
  /* 0xE0 */ 0x00D3, 0x00DF, 0x00D4, 0x00D2, 0x00F5, 0x00D5, 0x00B5, 0x00FE, 0x00DE, 0x00DA, 0x00DB, 0x00D9, 0x00FD, 0x00DD, 0x00AF, 0x00B4,
  /* 0xF0 */ 0x00AD, 0x00B1, 0x2017, 0x00BE, 0x00B6, 0x00A7, 0x00F7, 0x00B8, 0x00B0, 0x00A8, 0x00B7, 0x00B9, 0x00B3, 0x00B2, 0x25A0, 0x00A0,
];
const tableDecoder = (table) => ({
  decode: (buffer) => [...buffer].map((byte) => (byte < 0x80 ? String.fromCharCode(byte)
    : String.fromCodePoint(table[byte - 0x80]))).join(''),
});
let singleByteXmlDecoder;
function consoleCodePageDecoder() {
  const chcp = spawnSync(path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'chcp.com'), [], { shell: false, encoding: 'utf8' });
  const page = [...`${chcp.stdout || ''}${chcp.stderr || ''}`.matchAll(/\d+/g)].at(-1)?.[0];
  if (page === '437') return tableDecoder(CP437_HIGH);
  if (page === '850') return tableDecoder(CP850_HIGH);
  const label = { 65001: 'utf-8', 866: 'ibm866', 20866: 'koi8-r', 21866: 'koi8-u' }[page]
    ?? (/^125[0-8]$/.test(page ?? '') ? `windows-${page}` : null);
  // A page without a decoder is a refusal, not a latin1 guess: latin1 reads a
  // non-ASCII path byte as the wrong character and reports drift on a healthy
  // task. Decoding is fatal for the same reason — a silent replacement
  // character would let malformed bytes pass --check unread. Both errors name
  // the page so the console can be switched.
  let decoder = null;
  if (label != null) {
    try { decoder = new TextDecoder(label, { fatal: true }); } catch { decoder = null; }
  }
  if (decoder == null) {
    throw new Error(`cannot decode task XML from console code page ${page ?? '(unknown)'}: no decoder for it; switch the console (for example chcp 65001) and query again`);
  }
  return {
    decode: (buffer) => {
      try { return decoder.decode(buffer); }
      catch (error) { throw new Error(`task XML bytes are not valid ${label} (console code page ${page}): ${error.message}`); }
    },
  };
}
function decodeTaskXmlBytes(bytes) {
  const buffer = Buffer.from(bytes ?? '');
  if ((buffer[0] === 0xff && buffer[1] === 0xfe) || buffer.includes(0)) {
    return buffer.toString('utf16le').replace(/^\uFEFF/, '');
  }
  singleByteXmlDecoder ??= consoleCodePageDecoder();
  return singleByteXmlDecoder.decode(buffer);
}

function stopProcess(process) {
  const pid = Number(process.ProcessId);
  if (!Number.isSafeInteger(pid) || pid < 1
    || ![process.ExecutablePath, process.CommandLine, process.CreationDate].every(value => typeof value === 'string' && value.length > 0)) {
    throw new Error(`cannot establish process ${process.ProcessId} identity; refusing to stop it`);
  }
  // Recheck all three identity fields in the same OS call that stops the PID.
  powershell(`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p -and $p.ExecutablePath -ceq ${psString(process.ExecutablePath)} -and $p.CommandLine -ceq ${psString(process.CommandLine)} -and $p.CreationDate.ToString('o') -ceq ${psString(process.CreationDate)}) { Stop-Process -Id $p.ProcessId -Force } elseif ($p) { throw 'process ${pid} identity changed; refusing to stop it' }`);
}

// Read only Task Scheduler's element/attribute tree, not a general XML format.
// Reject DTDs; no external input is resolved.
function taskTree(xml) {
  const decode = (text) => text.replace(/&(#x[\da-f]+|#\d+|quot|apos|lt|gt|amp);/g, (_, entity) => {
    if (entity[0] === '#') return String.fromCodePoint(entity[1] === 'x'
      ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
    return { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' }[entity];
  });
  const root = { name: '', children: [], attributes: {}, text: '' };
  const stack = [root];
  const source = xml.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    .replace(/<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->/g, '');
  let end = 0;
  for (const match of source.matchAll(/<([^>]+)>|([^<]+)/g)) {
    if (match.index !== end) throw new Error('invalid XML');
    end = match.index + match[0].length;
    const parent = stack.at(-1);
    if (match[2] != null) { parent.text += decode(match[2]); continue; }
    const tag = match[1];
    if (tag.startsWith('/')) {
      if (stack.length < 2 || tag.slice(1).trim() !== parent.tag) throw new Error('invalid XML closing tag');
      stack.pop();
      continue;
    }
    const open = /^([\w:-]+)([\s\S]*?)(\/?)$/.exec(tag);
    if (!open) throw new Error('unsupported XML declaration');
    const attributes = {};
    const remainder = open[2].replace(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_, name, double, single) => {
      if (Object.hasOwn(attributes, name)) throw new Error('duplicate XML attribute');
      attributes[name] = decode(double ?? single);
      return '';
    });
    if (remainder.trim()) throw new Error('invalid XML attributes');
    const node = { tag: open[1], name: open[1].split(':').at(-1), attributes, children: [], text: '' };
    parent.children.push(node);
    if (!open[3]) stack.push(node);
  }
  if (end !== source.length || stack.length !== 1 || root.text.trim()
    || root.children.length !== 1 || root.children[0].name !== 'Task') throw new Error('invalid Task XML');
  return root.children[0];
}

// The registered XML is Task Scheduler's own rendering of the task, not a copy
// of ours (live run A, memory 17320 item 3): it turns the LogonTrigger UserId
// SID into DOMAIN\user, drops default elements (RunLevel, Priority, trigger
// Enabled, StopAtDurationEnd, ...), adds Settings/UseUnifiedSchedulingEngine,
// reorders elements and writes quotes raw. So drift is only a difference in a
// field this wrapper owns: what the task runs (Exec Command, Arguments,
// WorkingDirectory), when it runs (the trigger kinds), and as whom (Principal
// LogonType and the user, where a SID and the DOMAIN\user of the same account
// name the same user). Every other difference — Settings, RegistrationInfo,
// attributes, element order, dropped or added defaults — is the Scheduler's
// business and is not drift. A missing owned field is drift.
function taskDrift(expectedXml, registeredXml, account) {
  const expected = taskTree(expectedXml);
  const actual = taskTree(registeredXml);
  const only = (node, name) => {
    const found = node?.children.filter(child => child.name === name) ?? [];
    return found.length === 1 ? found[0] : null;
  };
  const text = (node, name) => {
    const child = only(node, name);
    return child == null ? null : child.text.trim();
  };
  // The renderer writes one Exec action, one Principal and one trigger of each
  // kind; a missing one, or a second one, changes what the task would run.
  const kinds = (tree) => (only(tree, 'Triggers')?.children ?? []).map(child => child.name);
  const wantedKinds = kinds(expected);
  const foundKinds = kinds(actual);
  const count = (names, name) => names.filter(other => other === name).length;
  const kind = [...new Set([...wantedKinds, ...foundKinds])]
    .find(name => count(wantedKinds, name) !== count(foundKinds, name));
  if (kind != null) return `Triggers/${kind}`;
  const sameUser = (wanted, found) => wanted === found
    || (account != null && found != null && found.toLowerCase() === account.toLowerCase());
  const wantedTriggerUser = text(only(only(expected, 'Triggers'), 'LogonTrigger'), 'UserId');
  const foundTriggerUser = text(only(only(actual, 'Triggers'), 'LogonTrigger'), 'UserId');
  if (wantedTriggerUser == null || foundTriggerUser == null || !sameUser(wantedTriggerUser, foundTriggerUser)) return 'Triggers/LogonTrigger/UserId';
  const expectedPrincipal = only(only(expected, 'Principals'), 'Principal');
  const actualPrincipal = only(only(actual, 'Principals'), 'Principal');
  if (!expectedPrincipal || !actualPrincipal) return 'Principals/Principal';
  if (text(expectedPrincipal, 'LogonType') !== text(actualPrincipal, 'LogonType')) return 'Principals/Principal/LogonType';
  const wantedPrincipalUser = text(expectedPrincipal, 'UserId');
  const foundPrincipalUser = text(actualPrincipal, 'UserId');
  if (wantedPrincipalUser == null || foundPrincipalUser == null || !sameUser(wantedPrincipalUser, foundPrincipalUser)) return 'Principals/Principal/UserId';
  const expectedExec = only(only(expected, 'Actions'), 'Exec');
  const actualExec = only(only(actual, 'Actions'), 'Exec');
  if (!expectedExec || !actualExec) return 'Actions/Exec';
  for (const name of ['Command', 'Arguments', 'WorkingDirectory']) {
    const wanted = text(expectedExec, name);
    const found = text(actualExec, name);
    if (wanted == null || found == null || wanted !== found) return `Actions/Exec/${name}`;
  }
  return null;
}

// whoami with no arguments prints the Scheduler's DOMAIN\user form of the
// current user, the form the registered trigger UserId is rewritten into.
function currentAccountName({ systemRoot }) {
  if (!systemRoot) throw new Error('SystemRoot is not set; cannot locate whoami.exe');
  const who = spawnSync(path.win32.join(systemRoot, 'System32', 'whoami.exe'), [], { encoding: 'utf8', shell: false });
  const name = `${who.stdout || ''}`.trim();
  if (who.status !== 0 || !name || /[\r\n]/.test(name) || !name.includes('\\')) {
    throw new Error(`whoami gave no DOMAIN\\user name (exit ${who.status}): ${name || who.stderr || who.error || 'no output'}`);
  }
  return name;
}

async function waitForGone(find, message) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (find().length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(message);
}

// The kit's macOS route never pulls an embedding model to an endpoint it does
// not own: plain http to the loopback, no credentials, path, query or fragment
// (the install.sh local_embed_url rule, INSTALL.md 6.1). The Windows route's
// pull decision answers the same question.
const localEmbedUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
};

// C2 will call this after ending a forward task. A reverse forward has no local
// listening port: only this executable and the exact rendered line identify it.
export async function stopForward(commandLine) {
  if (process.platform !== 'win32') throw new Error('SSH forward stopper requires Windows');
  if (typeof commandLine !== 'string' || !commandLine) throw new Error('SSH forward stopper requires a command line');
  const sshExe = String.raw`C:\Windows\System32\OpenSSH\ssh.exe`;
  const find = () => {
    const rows = JSON.parse(powershell(`$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToString('o')}}); ConvertTo-Json -InputObject $rows -Compress`));
    if (!Array.isArray(rows)) throw new Error('cannot enumerate SSH forward processes');
    return rows.filter(row => row.ExecutablePath === sshExe && sameCommandLine(row.CommandLine, commandLine));
  };
  for (const process of find()) stopProcess(process);
  await waitForGone(find, 'ssh forward is still running after stop');
}

async function install() {
const LABEL = 'local.harness.memoryd';
const HOME = process.env.MEMORYCTL_HOME || os.homedir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const config = readHarnessConfig({ repoRoot: path.resolve(HERE, '../..') });
const foreignLabel = harnessLabel({ prefix: config.names.prefix, name: 'memoryctl' });
const INSTALL_MEMORY = path.resolve(HERE, '../bootstrap/install-memory.mjs');
const STATE_DIR = (process.platform === 'win32' && process.env.MEMORYCTL_STATE_DIR)
  || path.join(HOME, '.local', 'state', 'memoryctl');
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const FOREIGN_PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${foreignLabel}.plist`);

const USAGE = 'usage: node ops/memory-local/install.mjs [--dry | --check | --uninstall] [--port <n>] [--embed-url <url>] [--node <path>] [--forward <ssh-host>:<port>]...';
let cli;
try {
  cli = parseArgs({ options: {
    dry: { type: 'boolean' },
    check: { type: 'boolean' },
    uninstall: { type: 'boolean' },
    port: { type: 'string' },
    'embed-url': { type: 'string' },
    node: { type: 'string' },
    forward: { type: 'string', multiple: true },
  } });
} catch (error) {
  console.error(`memory-local: ${error.message}\n${USAGE}`);
  process.exit(2);
}
const flag = (name) => cli.values[name.slice(2)] === true;
const opt = (name, fallback) => cli.values[name.slice(2)] ?? fallback;
const port = opt('--port', '7717');
const userEmbedUrl = opt('--embed-url', null);
const fail = (message) => { console.error(`memory-local: ${message}`); process.exit(1); };
function savedEmbedAddress() {
  const file = path.join(STATE_DIR, 'local-service.json');
  if (!existsSync(file)) return null;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (!saved || typeof saved !== 'object' || !Array.isArray(saved.forwards)) return undefined;
    return saved.embedUrl ?? null;
  } catch {
    return undefined;
  }
}
// process.execPath resolves symlinks. Keep the bootstrap's stable invocation
// path, or the local-bin link, so a runtime upgrade does not strand launchd.
const localNode = path.join(HOME, '.local', 'bin', 'node');
const nodeBin = opt('--node', process.platform === 'darwin'
  ? process.env.MEMORYCTL_NODE_BIN || (existsSync(localNode) ? localNode : process.execPath)
  : process.execPath);

if (!['darwin', 'win32'].includes(process.platform)) fail('this installer loads a launchd unit; macOS only');
if (!/^\d{2,5}$/.test(port)) fail(`--port expects a number, got '${port}'`);
// Argument, then saved options, then memory.embed.url, then this kit's default.
// Pass --embed-url only for a value install-memory would not already choose:
// the user's argument, or the default when saved options and the key are both absent.
const savedAddress = savedEmbedAddress();
const keyUrl = config.memory.embed.url ?? null;
const passEmbedUrl = userEmbedUrl != null
  ? userEmbedUrl.replace(/\/+$/, '')
  : (savedAddress === null && keyUrl == null ? 'http://127.0.0.1:11434' : null);
if (passEmbedUrl != null && !/^https?:\/\/[^\s<>"&]+$/.test(passEmbedUrl)) fail(`--embed-url expects http(s)://host[:port], got '${passEmbedUrl}'`);
if (!path.isAbsolute(nodeBin) || !existsSync(nodeBin)) fail(`node interpreter not found: '${nodeBin}'`);
if (!existsSync(INSTALL_MEMORY)) fail(`${INSTALL_MEMORY} is missing: run this from the harness home repository`);

// install-memory reads service.url and would flip to REMOTE mode: it retires
// the local unit and refuses --embed-url. On a single machine the local mode
// is the right one and the client already defaults to http://127.0.0.1:<port>
// with no service.url, so the fix is to remove that file — but this script
// never deletes state it did not write; it stops and names the command.
const urlFile = path.join(STATE_DIR, 'service.url');
if (existsSync(urlFile)) {
  const recorded = readFileSync(urlFile, 'utf8').trim();
  if (recorded === `http://127.0.0.1:${port}`) {
    fail(`${urlFile} points this machine at itself (left by an older remote-mode install). Local mode replaces it: run \`rm ${urlFile}\`, then this command again.`);
  }
  fail(`${urlFile} holds '${recorded}': another service owns memory on this machine. Remove it only if you are sure that service is gone, then run this again.`);
}
if (process.platform === 'darwin' && existsSync(FOREIGN_PLIST)) fail(`${FOREIGN_PLIST} exists: that unit would be a second writer on the same database. Run \`launchctl bootout gui/$(id -u)/${foreignLabel}\` and remove the plist, then this again.`);

// The env install-memory needs to render OUR unit: its label, our port, and a
// node path that survives runtime upgrades. MEMORYCTL_HOME passes through, so a
// sandbox HOME reaches install-memory exactly as it reaches this file.
// MEMORYCTL_JOB_CHECK=off: THIS file loads the unit (print/bootout/bootstrap
// below), so the donor must not judge the loaded job itself - its query would
// only duplicate the reload decision this thin half owns.
const env = {
  ...process.env,
  MEMORYCTL_HOME: HOME,
  MEMORYCTL_LAUNCHD_LABEL: LABEL,
  MEMORYCTL_PORT: port,
  MEMORYCTL_NODE_BIN: nodeBin,
  MEMORYCTL_JOB_CHECK: 'off',
};
const installArgs = [INSTALL_MEMORY];
if (passEmbedUrl != null) installArgs.push('--embed-url', passEmbedUrl);
for (const forward of cli.values.forward ?? []) installArgs.push('--forward', forward);

// A win32 host running a darwin-mocked kit still spawns this donor as a real
// win32 child. The fixture hook beside MEMORYCTL_PYTHON_BIN must be an argv
// element: NODE_OPTIONS splits on whitespace and drops a temp path with a space.
function donorArgv(...extra) {
  const python = process.env.MEMORYCTL_PYTHON_BIN;
  const hookFile = python ? path.join(path.dirname(python), 'spawn-hook.cjs') : null;
  const hook = hookFile && existsSync(hookFile) ? ['--require', hookFile] : [];
  return [...hook, ...installArgs, ...extra];
}
if (process.platform === 'win32') {
  try { await windows(); } catch (error) { fail(error.message); }
  process.exit(0);
}

async function windows() {
  const sqlite = spawnSync(nodeBin, ['--input-type=module', '-e', 'import("node:sqlite")'], { encoding: 'utf8' });
  if (sqlite.status !== 0) fail(`${nodeBin}: ${sqlite.stderr?.trim() || sqlite.error || 'unknown runtime'}; node:sqlite is required`);
  if (Number(port) > 65535 || Number(port) < 1) fail(`--port is outside 1..65535: '${port}'`);
  const taskName = harnessTaskName({ prefix: config.names.prefix });
  // Pin the donor to the same names and paths even when its caller has overrides.
  env.MEMORYCTL_TASK_NAME = taskName;
  env.MEMORYCTL_STATE_DIR = STATE_DIR;
  const serviceDir = process.env.MEMORYCTL_SERVICE_DIR
    || path.join(harnessPaths({ prefix: config.names.prefix, home: HOME }).shareDir, 'scripts', 'memory');
  const daemon = path.join(serviceDir, 'memoryd.mjs');
  const launcherPath = path.join(STATE_DIR, 'memoryd.cmd');
  const xmlPath = path.join(STATE_DIR, 'memoryd-task.xml');
  const savedFile = path.join(STATE_DIR, 'local-service.json');
  const saved = existsSync(savedFile) ? JSON.parse(readFileSync(savedFile, 'utf8')) : {};
  if (saved.forwards != null && !Array.isArray(saved.forwards)) fail(`invalid local options in ${savedFile}`);
  const embedUrl = passEmbedUrl ?? saved.embedUrl ?? keyUrl;
  const embedModel = saved.embedModel ?? config.memory.embed.model;
  if (embedUrl != null && embedUrlRefusal(embedUrl)) fail(`--embed-url ${embedUrlRefusal(embedUrl)}`);
  // cmd expands percent signs even inside quotes; do not render paths or values
  // that it would silently change, or allow a newline/quote to become a command.
  const cmdValue = (value) => {
    if (/[%"\r\n\0]/.test(value)) throw new Error(`cannot safely put this value in memoryd.cmd: ${JSON.stringify(value)}`);
    return value;
  };
  const launcher = [
    '@chcp 65001 >nul', '@echo off', 'setlocal DisableDelayedExpansion',
    `set "MEMORYCTL_STATE_DIR=${cmdValue(STATE_DIR)}"`,
    `set "MEMORYCTL_PORT=${port}"`,
    `set "MEMORYCTL_EMBED_URL=${cmdValue(embedUrl ?? '')}"`,
    `set "MEMORYCTL_EMBED_MODEL=${cmdValue(embedModel)}"`,
    // Managed (absent or "local"): memoryd needs the venv interpreter the
    // donor install builds; "off" tells memoryd not to rerank at all.
    ...(config.memory.rerank === 'off'
      ? ['set "MEMORYCTL_RERANK=off"']
      : [
          `set "MEMORYCTL_RERANK_PYTHON=${cmdValue(path.join(STATE_DIR, 'rerank-venv', 'Scripts', 'python.exe'))}"`,
          'set "RERANK_DEVICE=cpu"',
        ]),
    `"${cmdValue(nodeBin)}" "${cmdValue(daemon)}"`,
    '',
  ].join('\r\n');
  const taskArgs = (file) => `--headless "${path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')}" /d /s /c ""${cmdValue(file)}""`;
  const args = taskArgs(launcherPath);
  const sshExe = String.raw`C:\Windows\System32\OpenSSH\ssh.exe`;
  const forwardPrefix = `${taskName}-forward-`;
  const maxHostBytes = Math.min(200, 255 - Buffer.byteLength(`${harnessLabel({ prefix: config.names.prefix, name: 'memory-forward' })}..plist`));
  const validHost = (host) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host) && host.length <= maxHostBytes;
  const forwardPaths = (host) => {
    if (!validHost(host)) fail('--forward expects an SSH host alias within the filename budget');
    const file = path.join(STATE_DIR, `memory-forward-${host}.cmd`);
    if (file.length > 259) fail(`--forward launcher path exceeds 259 characters: ${file}`);
    return { taskName: `${forwardPrefix}${host}`, launcherPath: file,
      xmlPath: path.join(STATE_DIR, `memory-forward-${host}.xml`),
      log: path.join(STATE_DIR, `memory-forward.${host}.log`),
      errLog: path.join(STATE_DIR, `memory-forward.${host}.err.log`), args: taskArgs(file) };
  };
  const renderForward = (host, target, servicePort = port) => {
    const files = forwardPaths(host);
    const commandLine = `"${sshExe}" ${forwardSshArgs({ host, target, servicePort }).join(' ')}`;
    const launcher = ['@chcp 65001 >nul', '@echo off', 'setlocal DisableDelayedExpansion',
      `${commandLine} 1>>"${cmdValue(files.log)}" 2>>"${cmdValue(files.errLog)}"`, ''].join('\r\n');
    return { ...files, commandLine, launcher };
  };
  const forwards = new Map();
  const hosts = new Set();
  for (const value of cli.values.forward?.length ? cli.values.forward : saved.forwards ?? []) {
    const match = typeof value === 'string' && /^([a-zA-Z0-9][a-zA-Z0-9._-]*):(.+)$/.exec(value);
    if (!match || /[\x00-\x1f\x7f]/.test(value)) fail('--forward expects an SSH host alias and port');
    const [, host, target] = match;
    if (!validHost(host)) fail(`--forward host must be at most ${maxHostBytes} bytes`);
    if (!/^\d+$/.test(target) || Number(target) < 1 || Number(target) > 65535) fail('--forward requires a port from 1 to 65535');
    if (Number(target) === Number(port)) fail('--forward port must differ from the service port');
    // Windows filenames and task names cannot distinguish aliases by case.
    if (hosts.has(host.toLowerCase())) fail(`--forward repeats SSH host ${host}`);
    hosts.add(host.toLowerCase());
    const forward = renderForward(host, String(Number(target)));
    forwards.set(forward.taskName, forward);
  }
  // Inventory even when the requested list is empty: stale workers must not
  // survive a changed list or uninstall. Refuse every foreign action pre-write.
  const list = spawnSync('schtasks', ['/Query', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  if (list.status !== 0) fail(`could not establish ownership of forward tasks: ${list.stderr || list.error || list.stdout}`);
  const registeredForwards = new Map();
  const queryXml = (name) => {
    // /XML is UTF-16 when the bytes are; on a real host they are the console
    // code page instead (see decodeTaskXmlBytes), so the raw buffer is
    // decoded by what it actually holds, not by the declaration.
    const result = spawnSync('schtasks', ['/Query', '/TN', name, '/XML'], { encoding: 'buffer', shell: false });
    return { ...result, xml: decodeTaskXmlBytes(result.stdout) };
  };
  const decode = (text) => text.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  for (const line of (list.stdout || '').split(/\r?\n/)) {
    const name = /^"\\([^"]+)",/.exec(line)?.[1];
    if (!name?.toLowerCase().startsWith(forwardPrefix.toLowerCase())) continue;
    const host = name.slice(forwardPrefix.length);
    const files = forwardPaths(host);
    const task = queryXml(name);
    if (flag('--check')) {
      if (task.status !== 0) fail(`task drift: ${name}: XML query failed`);
      registeredForwards.set(name, { ...files, xml: task.xml });
      continue;
    }
    const actions = [...task.xml.matchAll(/<Arguments>([\s\S]*?)<\/Arguments>/g)];
    const workdir = /<WorkingDirectory>([\s\S]*?)<\/WorkingDirectory>/.exec(task.xml)?.[1];
    const commands = [...task.xml.matchAll(/<Command>([\s\S]*?)<\/Command>/g)];
    if (task.status !== 0 || actions.length !== 1 || decode(actions[0][1]) !== files.args
      || decode(workdir || '') !== STATE_DIR || commands.length !== 1
      || decode(commands[0][1]).toLowerCase() !== '%systemroot%\\system32\\conhost.exe'
      || name !== files.taskName) {
      fail(`foreign task ${name}: it does not launch ${files.launcherPath}; no files were written`);
    }
    registeredForwards.set(name, files);
  }
  const previousForwards = new Map();
  if (!flag('--check') && !flag('--dry')) {
    for (const [name, files] of new Map([...forwards, ...registeredForwards])) {
      const previous = existsSync(files.launcherPath) ? readFileSync(files.launcherPath, 'utf8') : '';
      if (!previous && !registeredForwards.has(name)) continue;
      const host = name.slice(forwardPrefix.length);
      const line = previous.split(/\r?\n/).find(line => line.startsWith(`"${sshExe}" `));
      const ports = / -R 127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+) /.exec(line || '');
      const old = ports && renderForward(host, ports[1], ports[2]);
      if (!old || line !== old.launcher.split('\r\n')[3]) {
        fail(`cannot identify previous SSH command in ${files.launcherPath}; refusing to stop a process`);
      }
      previousForwards.set(name, { launcher: previous, commandLine: old.commandLine });
    }
  }
  const query = queryTask({ taskName });
  if (query.status == null) fail(`schtasks /Query /TN ${taskName} failed: ${query.error || query.out}`);
  const registered = query.status === 0;
  if (!registered) {
    // A failed named query alone does not prove absence (access denied and a
    // missing scheduler also fail). Confirm absence through a successful list.
    const list = spawnSync('schtasks', ['/Query', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    if (list.status !== 0 || (list.stdout || '').split(/\r?\n/).some((line) => line.startsWith(`"\\${taskName}",`))) {
      fail(`schtasks /Query /TN ${taskName} could not establish ownership: ${query.out}; ${list.stderr || ''}`);
    }
  }
  let registeredXml;
  if (registered) {
    const task = queryXml(taskName);
    registeredXml = task.xml;
    if (flag('--check') && task.status !== 0) fail(`task drift: ${taskName}: XML query failed`);
    // Mutating modes must establish ownership before stopping or replacing tasks.
    const decode = (text) => text.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
    const action = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(task.xml)?.[1];
    const workdir = /<WorkingDirectory>([\s\S]*?)<\/WorkingDirectory>/.exec(task.xml)?.[1];
    const command = /<Command>([\s\S]*?)<\/Command>/.exec(task.xml)?.[1];
    if (!flag('--check') && (task.status !== 0 || decode(action || '') !== args || decode(workdir || '') !== STATE_DIR
      || decode(command || '').toLowerCase() !== '%systemroot%\\system32\\conhost.exe')) {
      fail(`foreign task ${taskName}: it does not launch ${launcherPath}; no files were written`);
    }
  }
  if (flag('--dry')) {
    const user = currentUserSid({ systemRoot: process.env.SystemRoot });
    const xml = renderTaskXml({ taskName, command: '%SystemRoot%\\System32\\conhost.exe', args, workdir: STATE_DIR,
      description: `memory-local memoryd (${STATE_DIR})`, user });
    console.log(`memory-local plan (nothing written):
  ${process.execPath} ${installArgs.join(' ')}
  task: ${taskName}   XML: ${xmlPath}
  launcher: ${launcherPath}
${launcher}  then: schtasks /End /TN ${taskName}; stop only this state's memoryd
        schtasks /Create /TN ${taskName} /XML ${xmlPath} /F
        schtasks /Run /TN ${taskName}
        wait for http://127.0.0.1:${port}/health
  database: ${path.join(STATE_DIR, 'memory.db')}
  embed model: ${embedUrl == null ? `${embedModel}; no embedding endpoint, nothing is pulled` : `${embedModel} at ${embedUrl}, imported from the pinned GGUF when it is the default and missing, otherwise pulled only when the endpoint lacks it; a non-local endpoint is never pulled`}
${xml}`);
    for (const forward of forwards.values()) {
      console.log(`  task: ${forward.taskName}   XML: ${forward.xmlPath}
  launcher: ${forward.launcherPath}
${forward.launcher}  after memoryd /health: schtasks /Create /TN ${forward.taskName} /XML ${forward.xmlPath} /F
        schtasks /Run /TN ${forward.taskName}; wait 10 seconds and probe ssh`);
    }
    return;
  }
  const donor = (check) => spawnSync(process.execPath, [...installArgs, ...(check ? ['--check'] : [])], { env, stdio: 'inherit' });
  if (flag('--check')) {
    const check = donor(true);
    if (check.status !== 0) process.exit(check.status ?? 1);
    if (!registered) fail(`task drift: ${taskName} is absent`);
    const user = currentUserSid({ systemRoot: process.env.SystemRoot });
    const account = currentAccountName({ systemRoot: process.env.SystemRoot });
    const checkXml = (name, actual, taskArgs, description) => {
      const expected = renderTaskXml({ taskName: name, command: '%SystemRoot%\\System32\\conhost.exe',
        args: taskArgs, workdir: STATE_DIR, description, user });
      let field;
      try { field = taskDrift(expected, actual, account); }
      catch (error) { fail(`task drift: ${name}: XML (${error.message})`); }
      if (field) fail(`task drift: ${name}: ${field}`);
    };
    checkXml(taskName, registeredXml, args, `memory-local memoryd (${STATE_DIR})`);
    if (!existsSync(launcherPath) || readFileSync(launcherPath, 'utf8') !== launcher) fail(`launcher drift: ${launcherPath}`);
    for (const forward of forwards.values()) {
      if (!registeredForwards.has(forward.taskName)) fail(`task drift: ${forward.taskName} is absent`);
      checkXml(forward.taskName, registeredForwards.get(forward.taskName).xml, forward.args,
        `memory-local SSH forward (${STATE_DIR})`);
      if (!existsSync(forward.launcherPath) || readFileSync(forward.launcherPath, 'utf8') !== forward.launcher) fail(`launcher drift: ${forward.launcherPath}`);
    }
    for (const name of registeredForwards.keys()) {
      if (!forwards.has(name)) fail(`task drift: ${name} is unlisted`);
    }
    console.log(`memory-local: ${taskName} and launcher match`);
    return;
  }
  const previous = existsSync(launcherPath) ? readFileSync(launcherPath, 'utf8') : '';
  const oldPort = /set "MEMORYCTL_PORT=(\d+)"/.exec(previous)?.[1];
  if (previous && (!previous.includes(`set "MEMORYCTL_STATE_DIR=${STATE_DIR}"`) || !oldPort)) {
    fail(`cannot identify the previous state/port in ${launcherPath}; refusing to stop a process`);
  }
  const listeners = () => {
    const ports = [...new Set([port, oldPort].filter(Boolean))].join(',');
    const out = powershell(`$ports = @(${ports}); $rows = @(Get-NetTCPConnection | Where-Object { $_.State -eq 'Listen' -and $_.LocalPort -in $ports } | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId=$_" } | Select-Object ProcessId,ExecutablePath,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToString('o')}}); ConvertTo-Json -InputObject $rows -Compress`);
    return JSON.parse(out);
  };
  const requireCall = (verb, result, name = taskName) => {
    if (result.status !== 0) throw new Error(`schtasks ${verb} /TN ${name} failed (exit ${result.status}): ${result.out}`);
  };
  const stopForwardTask = async (forward) => {
    const name = forward.taskName;
    if (registeredForwards.has(name)) {
      const state = powershell(`$task = Get-ScheduledTask -TaskName ${psString(name)} -TaskPath '\\'; [int]$task.State`);
      if (state === '4') requireCall('/End', endTask({ taskName: name }), name);
      else if (!/^[0-3]$/.test(state)) throw new Error(`cannot determine task state for ${name}: ${state}`);
    }
    const previous = previousForwards.get(name);
    if (previous) await stopForward(previous.commandLine);
  };
  const retireForward = async (forward) => {
    await stopForwardTask(forward);
    requireCall('/Delete /F', deleteTask({ taskName: forward.taskName }), forward.taskName);
    rmSync(forward.launcherPath, { force: true });
    rmSync(forward.xmlPath, { force: true });
  };
  const reconcileForwards = async (user) => {
    for (const [name, forward] of registeredForwards) {
      if (!forwards.has(name)) await retireForward(forward);
    }
    const started = [];
    for (const [name, forward] of forwards) {
      if (registeredForwards.has(name) && previousForwards.get(name)?.launcher === forward.launcher) continue;
      await stopForwardTask(forward);
      writeFileSync(forward.launcherPath, forward.launcher, 'utf8');
      const xml = renderTaskXml({ taskName: name, command: '%SystemRoot%\\System32\\conhost.exe',
        args: forward.args, workdir: STATE_DIR, description: `memory-local SSH forward (${STATE_DIR})`, user });
      writeFileSync(forward.xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
      requireCall('/Create /F', createTask({ taskName: name, xmlPath: forward.xmlPath }), name);
      requireCall('/Run', runTask({ taskName: name }), name);
      started.push(forward);
    }
    if (started.length) await new Promise(resolve => setTimeout(resolve, 10000));
    for (const forward of started) {
      const rows = JSON.parse(powershell(`$rows = @(Get-CimInstance Win32_Process | Select-Object ExecutablePath,CommandLine); ConvertTo-Json -InputObject $rows -Compress`));
      if (!Array.isArray(rows)) throw new Error('cannot enumerate SSH forward processes');
      if (!rows.some(row => row.ExecutablePath === sshExe && sameCommandLine(row.CommandLine, forward.commandLine))) {
        const tail = existsSync(forward.errLog) ? readFileSync(forward.errLog, 'utf8').trimEnd().split(/\r?\n/).slice(-20).join('\n') : '(no stderr log)';
        throw new Error(`ssh for ${forward.taskName} is not running after 10 seconds; ${forward.errLog}:\n${tail}`);
      }
    }
  };
  const stop = async () => {
    // A stopped task needs no /End, but may still have an orphaned node.
    if (registered) {
      const state = powershell(`$task = Get-ScheduledTask -TaskName ${psString(taskName)} -TaskPath '\\'; [int]$task.State`);
      if (state === '4') requireCall('/End', endTask({ taskName }));
      else if (!/^[0-3]$/.test(state)) throw new Error(`cannot determine task state for ${taskName}: ${state}`);
    }
    for (const process of listeners()) {
      const expected = `"${nodeBin}" "${daemon}"`;
      const oldCommand = previous.split(/\r?\n/).find((line) => line.startsWith('"'));
      const oldNode = /^"([^"]+)"/.exec(oldCommand || '')?.[1];
      if (!previous || !sameCommandLine(String(process.CommandLine ?? '').toLowerCase(), String(oldCommand ?? '').toLowerCase())
        || process.ExecutablePath?.toLowerCase() !== oldNode?.toLowerCase()
        || !oldCommand?.toLowerCase().endsWith(` "${daemon}"`.toLowerCase())) {
        throw new Error(`port belongs to a foreign process ${process.ProcessId}; refusing to stop it (expected ${expected})`);
      }
      stopProcess(process);
    }
    await waitForGone(listeners, 'memoryd port is still listening after stop; no new writer was started');
  };
  if (flag('--uninstall')) {
    for (const forward of registeredForwards.values()) await retireForward(forward);
    await stop();
    if (registered) requireCall('/Delete /F', deleteTask({ taskName }));
    rmSync(xmlPath, { force: true });
    rmSync(launcherPath, { force: true });
    console.log(`memory-local: ${taskName} removed; the database in ${STATE_DIR} is untouched`);
    return;
  }
  const user = currentUserSid({ systemRoot: process.env.SystemRoot });
  // The macOS kit route imports the pinned default embedding model (or pulls a
  // different configured model) only when the endpoint lacks it, and never to a
  // non-local endpoint (INSTALL.md 6.1). The Windows route must answer the same
  // question at the same endpoint memoryd embeds against, BEFORE any file, task
  // or process changes: a clean install without the model leaves dense search
  // answering 503 (task 2414, VM run W5). A failed check, import or pull fails
  // this step with the endpoint's own message; it is never a silent skip.
  if (embedUrl != null) {
    const wanted = embedModel.includes(':') ? embedModel : `${embedModel}:latest`;
    const listModels = async (stage) => {
      const response = await fetch(new URL('/api/tags', embedUrl), { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`${stage}: /api/tags HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const data = await response.json();
      if (!data || !Array.isArray(data.models)) throw new Error(`${stage}: /api/tags listed no models`);
      return data.models.map((row) => row?.name).filter((name) => typeof name === 'string');
    };
    try {
      if (!(await listModels('embedding endpoint check failed')).includes(wanted)) {
        if (!localEmbedUrl(embedUrl)) {
          fail(`embedding model ${embedModel} is missing at non-local endpoint ${embedUrl}; refusing ollama pull`);
        }
        const embedPin = readEmbedImportPin(JSON.parse(readFileSync(path.join(path.resolve(HERE, '../..'), 'ops/bootstrap/tool-pins.json'), 'utf8')));
        if (embedModel === embedPin.model) {
          const run = (file, args, options = {}) => {
            const result = spawnSync(file, args, { encoding: 'utf8', env: { ...process.env, OLLAMA_HOST: embedUrl }, ...options });
            if (result.error) throw result.error;
            if (result.status !== 0) {
              const detail = `${result.stderr || ''}${result.stdout || ''}`.trim().slice(0, 200);
              throw new Error(`${path.basename(String(file))} ${args[0]} failed${detail ? `: ${detail}` : ''}`);
            }
            return result.stdout ?? '';
          };
          await importPinnedEmbedModel({ binary: 'ollama', pin: embedPin, env: { ...process.env, OLLAMA_HOST: embedUrl }, run });
        } else {
          const response = await fetch(new URL('/api/pull', embedUrl), {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: embedModel, stream: false }), signal: AbortSignal.timeout(600_000),
          });
          const data = await response.json().catch(() => null);
          if (!response.ok || data?.error || data?.status !== 'success') {
            fail(`ollama pull ${embedModel} at ${embedUrl} failed: ${data?.error ?? (data ? JSON.stringify(data).slice(0, 200) : `HTTP ${response.status}`)}`);
          }
        }
        if (!(await listModels('ollama did not serve the embedding model')).includes(wanted)) {
          fail(`ollama still lacks ${embedModel} at ${embedUrl} after ${embedModel === embedPin.model ? 'import' : 'pull'}`);
        }
      }
    } catch (error) {
      const cause = error?.cause?.code ?? error?.cause?.message;
      fail(`${embedUrl}: ${error.message}${cause ? ` (${cause})` : ''}`);
    }
  }
  // The stop refusal comes first: a port held by a foreign process must
  // leave every file — the donor's local-service.json included — exactly as
  // it was. Stopping before any write also keeps the old launcher (and its
  // port) in place for a retry, so no rollback is needed anymore.
  await stop();
  const install = donor(false);
  if (install.status !== 0) fail(`install-memory.mjs exited ${install.status}: fix that first`);
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(launcherPath, launcher, 'utf8');
  const xml = renderTaskXml({ taskName, command: '%SystemRoot%\\System32\\conhost.exe', args, workdir: STATE_DIR,
    description: `memory-local memoryd (${STATE_DIR})`, user });
  writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
  requireCall('/Create /F', createTask({ taskName, xmlPath }));
  requireCall('/Run', runTask({ taskName }));
  let health;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      const body = await response.json();
      if (response.ok && body.ok === true) { health = body; break; }
    } catch { /* Not listening yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!health) fail(`memoryd did not answer http://127.0.0.1:${port}/health within 30 attempts; read ${STATE_DIR}/memoryd.log`);
  await reconcileForwards(user);
  console.log(`memory-local: ${taskName} is running\n${JSON.stringify(health)}`);
}
// --check: re-verify the installed files and the unit against this checkout, with the
// SAME env the install used (label, port, node bin); install-memory's own --check would
// otherwise render the plist with a different node path and report drift. It takes the
// SAME arguments too: a --forward given here is judged, never dropped.
if (flag('--check')) {
  const check = spawnSync(process.execPath, donorArgv('--check'), { env, stdio: 'inherit' });
  process.exit(check.status ?? 1);
}


if (flag('--dry')) {
  process.stdout.write(`memory-local plan (nothing written):
  env MEMORYCTL_HOME=${HOME} MEMORYCTL_LAUNCHD_LABEL=${LABEL} MEMORYCTL_PORT=${port} MEMORYCTL_NODE_BIN=${nodeBin}
  ${process.execPath} ${installArgs.join(' ')}
  then: launchctl bootout gui/${process.getuid()}/${LABEL} (harmless if unloaded)
        launchctl bootstrap gui/${process.getuid()} ${PLIST}
        wait for http://127.0.0.1:${port}/health
  unit: ${PLIST}   database: ${path.join(STATE_DIR, 'memory.db')}
  embedding model: pinned by install-memory.mjs (MEMORYCTL_EMBED_MODEL in the plist)\n`);
  process.exit(0);
}

const domain = `gui/${process.getuid()}`;
const launchctl = (...args) => spawnSync('launchctl', args, { encoding: 'utf8' });

if (flag('--uninstall')) {
  const savedFile = path.join(STATE_DIR, 'local-service.json');
  const workers = new Map();
  try {
    const saved = existsSync(savedFile) ? JSON.parse(readFileSync(savedFile, 'utf8')) : { forwards: [] };
    if (!Array.isArray(saved?.forwards)) throw new Error(`invalid local options in ${savedFile}`);
    for (const value of saved.forwards) {
      const host = typeof value === 'string' && /^([a-zA-Z0-9][a-zA-Z0-9._-]*):/.exec(value)?.[1];
      const label = forwardLaunchdLabel({ prefix: config.names.prefix, host });
      const file = workerPlistPath(PLIST, label);
      if (existsSync(file)) {
        const labels = [...readFileSync(file, 'utf8').matchAll(/<key>Label<\/key>\s*<string>([^<]*)<\/string>/g)];
        if (labels.length !== 1 || labels[0][1] !== label) {
          throw new Error(`foreign forward plist ${file}: its label is not ${label}; refusing to uninstall`);
        }
      }
      workers.set(label, file);
    }
  } catch (error) { fail(error.message); }
  for (const [label, file] of workers) {
    launchctl('bootout', `${domain}/${label}`);
    if (existsSync(file)) unlinkSync(file);
  }
  launchctl('bootout', `${domain}/${LABEL}`);
  if (existsSync(PLIST)) unlinkSync(PLIST);
  console.log(`memory-local: ${LABEL} unloaded and removed; the database in ${STATE_DIR} is untouched`);
  process.exit(0);
}

// bootout and bootstrap restart the one writer, so they need a reason: the unit
// is not loaded, or install-memory's own check finds an installed file stale.
const wasLoaded = launchctl('print', `${domain}/${LABEL}`).status === 0;
const current = spawnSync(process.execPath, donorArgv('--check'), { env, stdio: 'ignore' }).status === 0;
if (wasLoaded && current) {
  console.log(`memory-local: nothing changed: ${LABEL} is loaded and every installed file matches this checkout`);
  process.exit(0);
}

const install = spawnSync(process.execPath, donorArgv(), { env, stdio: 'inherit' });
if (install.status !== 0) fail(`install-memory.mjs exited ${install.status}: fix that first (its message names the cause)`);
if (!existsSync(PLIST)) fail(`${PLIST} was not written by install-memory.mjs`);

// bootout of a unit that is not loaded fails harmlessly; bootstrap right after a
// bootout can answer "5: Input/output error" until launchd lets go, so retry.
launchctl('bootout', `${domain}/${LABEL}`);
let loaded = false;
for (let attempt = 0; attempt < 20 && !loaded; attempt += 1) {
  loaded = launchctl('bootstrap', domain, PLIST).status === 0;
  if (!loaded) spawnSync('sleep', ['1']);
}
if (!loaded) fail(`launchctl bootstrap ${domain} ${PLIST} kept failing; read ${STATE_DIR}/service.err.log`);

let health = null;
for (let attempt = 0; attempt < 30 && !health; attempt += 1) {
  const probe = spawnSync('curl', ['-sS', '-m', '2', `http://127.0.0.1:${port}/health`], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout.includes('"ok":true')) health = probe.stdout.trim();
  else spawnSync('sleep', ['1']);
}
if (!health) fail(`memoryd did not answer http://127.0.0.1:${port}/health within 30 s; read ${STATE_DIR}/service.err.log`);
console.log(`memory-local: ${LABEL} is running\n${health}`);
console.log('The embedder reports reachable:true only after the first successful embed: run `memoryctl search "first probe"` once, then read /health again.');
}

// Keep the unwired C1 stopper callable without running the installer.
if (isMain(import.meta.url)) await install();
