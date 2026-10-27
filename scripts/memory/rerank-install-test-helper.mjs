// Package-manager/model-runtime double for isolated installer tests. The real
// worker is separately smoked with pinned wheels and the measured snapshot.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BODY = `const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(CALLS, JSON.stringify(args)+'\\n');
if (args[0] === '-c' && String(args[1] || '').includes('version_info')) {
  console.log('3.12'); process.exit(0);
}
const stage = args[1] === 'venv' ? 'venv' : args[1] === '--download' ? 'download'
  : args.length === 1 ? 'smoke' : null;
if (stage && process.env.FIXTURE_RERANK_FAIL === stage) {
  console.error('fixture '+stage+' failed'); process.exit(1);
}
if (args[0] === '-m' && args[1] === 'venv') {
  fs.mkdirSync(path.join(args[2], 'bin'), {recursive:true});
  fs.mkdirSync(path.join(args[2], 'Scripts'), {recursive:true});
  fs.writeFileSync(path.join(args[2], 'pyvenv.cfg'), 'fixture venv');
  // Both layouts: a darwin venv is bin/python, a win32 one Scripts/python.exe.
  for (const python of [path.join(args[2], 'bin', 'python'), path.join(args[2], 'Scripts', 'python.exe')]) {
    fs.copyFileSync(__filename, python);
    fs.chmodSync(python, 0o755);
  }
} else if (args[0] === '-m' && args[1] === 'pip') {
  // No network or wheel install in a plumbing test.
} else if (args[1] === '--requirements') {
  const result = spawnSync('python3', args, {encoding:'utf8'});
  if (result.status === 0 && result.stdout) {
    process.stdout.write(process.env.FIXTURE_RERANK_CRLF ? result.stdout.replace(/\\n/g, '\\r\\n') : result.stdout);
    process.exit(0);
  }
  const text = fs.readFileSync(args[0], 'utf8');
  const body = text.match(/REQUIREMENTS = \\{([\\s\\S]*?)\\}/);
  const pins = body ? [...body[1].matchAll(/"([a-z_]+)": "(\\d+\\.\\d+\\.\\d+)"/g)] : [];
  if (!pins.length) {
    process.stderr.write(result.stderr || 'cannot read pinned requirements\\n');
    process.exit(1);
  }
  process.stdout.write(pins.map((pin) => pin[1] + '==' + pin[2]).join(process.env.FIXTURE_RERANK_CRLF ? '\\r\\n' : '\\n') + (process.env.FIXTURE_RERANK_CRLF ? '\\r\\n' : '\\n'));
} else if (args[1] === '--download') {
  fs.mkdirSync(process.env.HF_HOME, {recursive:true});
  fs.writeFileSync(path.join(process.env.HF_HOME, 'snapshot'), 'fixture model');
} else {
  if (!fs.existsSync(path.join(process.env.HF_HOME, 'snapshot'))) {
    console.error('pinned snapshot missing'); process.exit(1);
  }
  const device = process.env.RERANK_DEVICE;
  if (device !== 'mps' && device !== 'cpu') {
    console.error('RERANK_DEVICE must be mps or cpu'); process.exit(1);
  }
  if (device === 'mps' && process.env.FIXTURE_RERANK_MPS === 'fail') {
    console.error('Metal pipeline state object: unsupported deferred-static-alloca-size');
    process.exit(1);
  }
  if (device === 'cpu' && process.env.FIXTURE_RERANK_CPU === 'fail') {
    console.error('cpu smoke failed'); process.exit(1);
  }
  let input = '';
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    const req = JSON.parse(input);
    console.log(JSON.stringify({ready:true, device}));
    console.log(JSON.stringify({id:req.id,scores:req.docs.map(() => 1)}));
  });
}
`;

// spawnSync on win32 CreateProcess-es only real executables: a shebang fixture
// is ENOENT there before any pip argv (lesson 19454). Loaded into the installer
// under test with --require, the hook reroutes fixture spawns to node, whose
// module loader strips the shebang line itself. Bare names (the body's own
// python3 probe) pass through.
const HOOK = `const cp = require('node:child_process');
const path = require('node:path');
const original = cp.spawnSync;
cp.spawnSync = (command, args, options) => {
  const text = String(command);
  if (path.isAbsolute(text) && /^python(\\d|\\.exe|$)/.test(path.basename(text))) {
    return original(process.execPath, [text, ...(args ?? [])], options);
  }
  return original(command, args, options);
};
`;

// The interpreter form is the TARGET platform's, not the host's, so a darwin
// run exercises the same selection a win32 host gets: an explicit 'win32'
// target writes python.exe plus the spawn hook; anything else keeps the POSIX
// extensionless shebang byte-for-byte.
export function fixturePython(root, target = process.platform) {
  mkdirSync(root, { recursive: true });
  const file = path.join(root, target === 'win32' ? 'python.exe' : 'python');
  writeFileSync(file, `#!${process.execPath}\n` + BODY.replaceAll('CALLS', JSON.stringify(path.join(root, 'calls.jsonl'))), { mode: 0o755 });
  if (target === 'win32') writeFileSync(path.join(root, 'spawn-hook.cjs'), HOOK);
  return file;
}

// The --require argument an installer spawn needs when the fixture beside it
// targets win32; null everywhere else, so POSIX runs are byte-unchanged.
export function fixtureSpawnHook(pythonBin) {
  if (!pythonBin) return null;
  const hook = path.join(path.dirname(pythonBin), 'spawn-hook.cjs');
  return existsSync(hook) ? hook : null;
}
