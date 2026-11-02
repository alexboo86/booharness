import { windowsTargetLiveness } from './remote-target-windows.ts';
import { BUILDERS, FLOCK, PERL, RECENT_BUILD_RULE } from './target-sweep-rules.ts';

// Embedded with the target script so host checkouts never supply executable code.
export const targetLivenessScript = String.raw`
const { execFileSync } = require('node:child_process');
const probeOptions = { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, windowsHide: true };
const builders = ${BUILDERS.toString()};
function inside(parent, file) {
  const relative = p.relative(parent, file);
  return relative === '' || (!relative.startsWith('..') && !p.isAbsolute(relative));
}
function gone(e) { return e.code === 'ENOENT' || e.code === 'ESRCH'; }
// Task 3405: foreign-uid permission failures may be skipped; same-uid pids
// require state and privileged path evidence. Unknown ownership still blocks.
function unreadableOwner(proc, error) {
  if (error.code !== 'EACCES' && error.code !== 'EPERM') return null;
  let owner;
  try { owner = fs.lstatSync(proc).uid; }
  catch (ownerError) { throw new Error('liveness unproved for pid ' + p.basename(proc) + ': owner uid unavailable: ' + ownerError.message); }
  const uid = process.getuid();
  if (!Number.isInteger(owner) || owner < 0 || !Number.isInteger(uid) || uid < 0) return null;
  return owner === uid ? 'same' : 'other';
}
function processPathsBusy(target, links) {
  let cwd;
  for (const [kind, file] of links) {
    if (kind === 'cwd') {
      cwd = file;
      if (inside(target, file)) return 'process cwd inside the target';
    } else if (kind === 'exe') {
      if (builders.test(p.basename(file)) && inside(root, cwd)) return p.basename(file) + ' working in the checkout';
      if (inside(target, file)) return 'executable inside the target';
    } else if (inside(target, file)) return 'open file inside the target';
  }
  return null;
}
function* readableProcessPaths(proc) {
  yield ['cwd', fs.readlinkSync(proc + '/cwd')];
  yield ['exe', fs.readlinkSync(proc + '/exe')];
  for (const fd of fs.readdirSync(proc + '/fd')) {
    let link;
    try { link = fs.readlinkSync(proc + '/fd/' + fd); }
    catch (e) { if (gone(e)) continue; throw e; }
    yield ['fd', link];
  }
}
function inactiveProcess(proc) {
  let stat;
  try { stat = fs.readFileSync(proc + '/stat', 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return true; throw e; }
  const end = stat.lastIndexOf(')');
  const state = stat.slice(end + 1).trimStart()[0];
  if (end < 0 || !state) throw new Error('invalid process stat');
  return state === 'Z' || state === 'X';
}
function rootProcessPaths(proc) {
  const output = execFileSync('/usr/bin/sudo', ['-n', '/usr/bin/find', proc + '/cwd', proc + '/exe', proc + '/fd',
    '-maxdepth', '1', '-printf', '%p\\0%l\\0'], {
    ...probeOptions, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }
  });
  const fields = output.split('\0');
  if (fields.pop() !== '' || fields.length % 2) throw new Error('invalid path pairs');
  const paths = new Map();
  for (let i = 0; i < fields.length; i += 2) paths.set(fields[i], fields[i + 1]);
  const cwd = paths.get(proc + '/cwd'), exe = paths.get(proc + '/exe');
  if (!cwd || !exe) throw new Error('cwd or exe link missing or empty');
  return [['cwd', cwd], ['exe', exe], ...Array.from(paths)
    .filter(([file]) => file.startsWith(proc + '/fd/')).map(([, link]) => ['fd', link])];
}
function rootProcessBusy(target, proc) {
  try {
    if (inactiveProcess(proc)) return null;
    return processPathsBusy(target, rootProcessPaths(proc));
  } catch (e) {
    try { if (inactiveProcess(proc)) return null; }
    catch (statError) { e = new Error(e.message + '; stat: ' + statError.message); }
    // Never leak probe ENOENT into gone() or the deleters' missing-path catches.
    throw new Error('liveness unproved for pid ' + p.basename(proc) + ': root probe: ' + e.message);
  }
}
function linuxBusy(target, procRoot) {
  for (const pid of fs.readdirSync(procRoot).filter(name => /^\d+$/.test(name))) {
    const proc = p.join(procRoot, pid);
    try {
      const busy = processPathsBusy(target, readableProcessPaths(proc));
      if (busy) return busy;
    } catch (e) {
      if (gone(e)) continue;
      const owner = unreadableOwner(proc, e);
      if (owner === 'other') continue;
      if (owner === 'same') {
        const busy = rootProcessBusy(target, proc);
        if (busy) return busy;
        continue;
      }
      throw new Error('liveness unproved for pid ' + pid + ': ' + e.message);
    }
  }
  return null;
}
function macBusy(target) {
  // One all-process query includes cwd, executable and open paths; failure keeps the target.
  const output = execFileSync('/usr/sbin/lsof', ['-n', '-P', '-Fpcfn'], probeOptions);
  let command = '', kind = '';
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) { command = ''; kind = ''; }
    if (line.startsWith('c')) command = line.slice(1);
    if (line.startsWith('f')) kind = line.slice(1);
    if (!line.startsWith('n')) continue;
    const file = line.slice(1);
    if (inside(target, file)) return 'open file, executable or cwd inside the target';
    if (kind === 'cwd' && builders.test(command) && inside(root, file)) return command + ' working in the checkout';
  }
  return null;
}
// Task 3423: probes run absolute binaries only. remote-exec puts the seat's gate shim
// directory first in PATH, so a PATH-resolved flock or perl could answer 'not held'; a
// missing absolute probe answers held (refuses the drop), never 'not held'.
const FLOCK = ${JSON.stringify(FLOCK)}, PERL = ${JSON.stringify(PERL)};
function cargoLockHeld(target) {
  for (const profile of ${JSON.stringify(RECENT_BUILD_RULE.profiles)}) {
    const lock = p.join(target, profile, '.cargo-lock');
    let stat;
    try { stat = fs.lstatSync(lock); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('not a plain cargo lock');
    let file, args;
    try {
      execFileSync(FLOCK, ['-n', '/dev/null', '-c', 'true'], probeOptions);
      file = FLOCK; args = ['-n', lock, '-c', 'true'];
    } catch {
      try { execFileSync(PERL, ['-e', '0'], probeOptions); }
      catch (probeError) {
        if (probeError.code === 'ENOENT') return profile + ' cargo lock held: no absolute lock probe (' + FLOCK + ' or ' + PERL + ')';
        throw probeError;
      }
      file = PERL; args = ['-e', 'open(F,"<",$ARGV[0]) or exit 2; unless(flock(F,6)){exit 1} exit 0', '--', lock];
    }
    try { execFileSync(file, args, probeOptions); }
    catch (e) {
      if (e.code === 'ENOENT') return profile + ' cargo lock held: absolute lock probe ' + file + ' unavailable';
      return profile + ' cargo lock held';
    }
  }
  return null;
}
function powershellProbe(args, options = probeOptions) {
  const powershell = p.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return execFileSync(powershell, args, options);
}
// Internal proc-root injection permits isolated Linux tests without reading real /proc.
function targetBusy(target, procRoot = '/proc') {
  if (process.platform === 'win32') {
    const program = ${JSON.stringify(windowsTargetLiveness)};
    // Task 3423: absolute binary only; a PATH shim must not fake the Windows probe.
    // A missing probe throws and the deleters keep the target: never 'free'.
    const output = powershellProbe(['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], {
      ...probeOptions, env: { ...process.env, ORCH_TARGET_ROOT: root, ORCH_TARGET_DIR: target }
    }).trim();
    if (output !== 'free') return output || 'Windows liveness unproved';
    return null;
  }
  const busy = process.platform === 'linux' ? linuxBusy(target, procRoot)
    : process.platform === 'darwin' ? macBusy(target) : 'unsupported host liveness platform';
  return busy || cargoLockHeld(target);
}
`;
