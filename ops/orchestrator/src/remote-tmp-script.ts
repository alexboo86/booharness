import { targetLivenessScript } from './remote-target-liveness.ts';

// These programs are shipped by the orchestrator, never loaded from a host checkout.
const common = String.raw`
const fs = require('node:fs'), p = require('node:path'), os = require('node:os');
const options = JSON.parse(process.argv[1]);
if (!p.isAbsolute(options.repo)) throw new Error('repo must be absolute');
// resolve: a win32 hosts.json repo such as C:/work/repo must match the backslash roots join builds.
const base = p.dirname(p.resolve(options.repo)), homeTmp = p.join(os.homedir(), 'orch-tmp');
const tmpName = name => name === 'tmp' || name.endsWith('-tmp') || name.startsWith('tmp-') || name.includes('-tmp-');
function plainDirectory(dir) {
  for (let current = dir;; current = p.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a plain directory: ' + current);
    if (p.dirname(current) === current) break;
  }
  return fs.lstatSync(dir);
}
function same(a, b) { return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs; }
function* directories(dir) {
  plainDirectory(dir);
  const handle = fs.opendirSync(dir);
  let count = 0;
  try {
    for (let entry; (entry = handle.readSync());) {
      if (++count > 100000) throw new Error('directory listing bound exceeded');
      if (entry.isDirectory() && !entry.isSymbolicLink()) yield entry.name;
    }
  } finally { handle.closeSync(); }
}
function skip(result, path, error) {
  // A missing candidate is harmless; a missing probe leaves liveness unproved.
  if (error.code !== 'ENOENT' || error.syscall?.startsWith('spawn')) result.skipped.push({ path, reason: error.message });
}
`;

export const remoteTmpScanScript = common + String.raw`
const result = { candidates: [], skipped: [] };
function scan(root, lead) {
  try {
    for (const name of directories(root)) {
      if (!lead || name.startsWith('target-')) result.candidates.push({ root, name });
    }
  } catch (error) { skip(result, root, error); }
}
if (options.kind === 'lead') scan(p.join(base, 'lead-check'), true);
else if (options.kind === 'tmp') {
  try { for (const name of directories(base)) if (tmpName(name)) scan(p.join(base, name), false); }
  catch (error) { skip(result, base, error); }
  scan(homeTmp, false);
} else throw new Error('unknown scan kind');
console.log(JSON.stringify(result));
`;

export const remoteTmpDropScript = common + String.raw`
const root = options.root, name = options.name;
if (!p.isAbsolute(root) || p.resolve(root) !== root) throw new Error('unsafe tmp root');
if (root !== homeTmp && !(p.dirname(root) === base && tmpName(p.basename(root)))) throw new Error('root outside host tmp scope');
if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new Error('unsafe tmp candidate name');
if (!(options.window > 0) || !(options.dropGrace > 0)) throw new Error('invalid retention');
const rootIdentity = plainDirectory(root), target = p.join(root, name);
const result = { removed: [], bytesBefore: null, skipped: [] };
${targetLivenessScript}
function candidate() {
  if (!same(rootIdentity, plainDirectory(root))) throw new Error('tmp root changed');
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a plain candidate directory');
  return stat;
}
function leftover() {
  if (!name.includes('.dropping-')) return false;
  const stamp = /\.dropping-(\d+)$/.exec(name);
  const time = stamp ? Number(stamp[1]) : NaN;
  if (!Number.isSafeInteger(time) || time < 0) throw new Error('invalid dropping timestamp');
  if (Date.now() - time < options.dropGrace) throw new Error('drop already in progress');
  return true;
}
// A limit is a refusal, never proof that the unseen remainder is old.
function proveOld() {
  const started = Date.now(), cutoff = started - options.window;
  let count = 0;
  function walk(file, depth) {
    if (++count > 100000 || depth > 32 || Date.now() - started > 10000) throw new Error('age walk bound exceeded');
    const stat = fs.lstatSync(file);
    if (stat.mtimeMs >= cutoff) throw new Error('modified within 24h');
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const handle = fs.opendirSync(file);
    try { for (let entry; (entry = handle.readSync());) walk(p.join(file, entry.name), depth + 1); }
    finally { handle.closeSync(); }
  }
  walk(target, 0);
}
function argvBusy(paths) {
  const output = process.platform === 'win32'
    ? powershellProbe(['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; (Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine) -join [Environment]::NewLine"])
    : execFileSync('/bin/ps', ['-axww', '-o', 'args='], probeOptions);
  const normalize = value => {
    const normalized = value.replace(/[\\/]+/g, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  if (paths.some(file => normalize(output).includes(normalize(file)))) throw new Error('process argv references tmp candidate');
}
function live(isLeftover) {
  const busy = targetBusy(target);
  if (busy) throw new Error('tmp candidate in use: ' + busy);
  const paths = [target];
  if (isLeftover) paths.push(p.join(root, name.replace(/\.dropping-\d+$/, '')));
  argvBusy(paths);
}
try {
  const retry = leftover(), before = candidate();
  if (!retry) proveOld();
  live(retry);
  if (!retry) proveOld();
  // Repeat cwd, argv, open-file and lock clauses at this candidate's rename boundary.
  live(retry);
  const final = candidate();
  if (!same(before, final) || before.mtimeMs !== final.mtimeMs || before.ctimeMs !== final.ctimeMs) throw new Error('tmp candidate changed during inspection');
  const dropping = retry ? target : target + '.dropping-' + Date.now();
  if (!retry) {
    try { fs.lstatSync(dropping); throw new Error('dropping destination already exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.renameSync(target, dropping);
  }
  if (!same(before, plainDirectory(dropping))) throw new Error('renamed tmp candidate changed');
  fs.rmSync(dropping, { recursive: true, force: true });
  result.removed.push(target);
} catch (error) { skip(result, target, error); }
console.log(JSON.stringify(result));
`;
