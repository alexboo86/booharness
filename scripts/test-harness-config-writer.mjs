import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeHarnessConfig } from './lib/harness-config.mjs';
import { runConfigVerb } from '../ops/bootstrap/harness-config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'ops/bootstrap/harness-config.mjs');
const LIB = path.join(REPO, 'scripts/lib/harness-config.mjs');
const TRACKED = readFileSync(path.join(REPO, 'ops/bootstrap/harness.config.json'), 'utf8');
const BASE = '{\n  "names": {\n    "prefix": "acme-base"\n  },\n  "memory": {\n    "embed": {\n      "model": "m"\n    }\n  }\n}\n';

function fixture(t, bytes = BASE) {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-config-writer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const file = path.join(repoRoot, 'ops/bootstrap/harness.config.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  const read = () => readFileSync(file, 'utf8');
  // Each call names its home: a call with no --home takes the lock of the real one.
  const run = (...args) => runIn(repoRoot, '--home', home, ...args);
  const runIn = async (repo, ...args) => {
    let out = '';
    let err = '';
    const { code } = await runConfigVerb({
      args, repoRoot: repo,
      stdout: { write: (text) => { out += text; } },
      stderr: { write: (text) => { err += text; } },
    });
    return { code, out, err };
  };
  // A refusal changes nothing: the same bytes, and no temp file beside the config.
  const untouched = (bytesBefore) => {
    assert.equal(read(), bytesBefore);
    assert.deepEqual(readdirSync(path.dirname(file)), ['harness.config.json']);
  };
  return { root, repoRoot, home, file, read, run, runIn, untouched };
}

test('the tracked file, read and written back, has the same bytes', async (t) => {
  const f = fixture(t, JSON.stringify(JSON.parse(TRACKED)));
  const result = await writeHarnessConfig({ repoRoot: f.repoRoot, home: f.home, config: JSON.parse(TRACKED) });
  assert.deepEqual(result, { file: f.file, changed: true });
  assert.equal(f.read(), TRACKED);
  assert.equal((await f.run('set', 'names.prefix', JSON.stringify(JSON.parse(TRACKED).names.prefix))).out, `unchanged ${f.file}\n`);
  assert.equal(f.read(), TRACKED);
});

test('equal content in a different key order gives the same bytes in the canonical order', async (t) => {
  const one = {
    install: { userEntries: 'keep' },
    names: { prefix: 'acme' },
    memory: { embed: { model: 'm', url: 'http://127.0.0.1:11434' } },
    families: { enabled: ['codex', 'claude'] },
    mcp: { off: [] },
    skills: { off: [], lead: [] },
    lead: { replyLanguage: 'English', plainStyle: false, briefLanguage: 'off' },
  };
  const other = {
    lead: { briefLanguage: 'off', plainStyle: false, replyLanguage: 'English' },
    skills: { lead: [], off: [] },
    mcp: { off: [] },
    families: { enabled: ['codex', 'claude'] },
    memory: { embed: { url: 'http://127.0.0.1:11434', model: 'm' } },
    names: { prefix: 'acme' },
    install: { userEntries: 'keep' },
  };
  const expected = `{
  "install": {
    "userEntries": "keep"
  },
  "names": {
    "prefix": "acme"
  },
  "memory": {
    "embed": {
      "model": "m",
      "url": "http://127.0.0.1:11434"
    }
  },
  "families": {
    "enabled": [
      "codex",
      "claude"
    ]
  },
  "mcp": {
    "off": []
  },
  "skills": {
    "off": [],
    "lead": []
  },
  "lead": {
    "replyLanguage": "English",
    "plainStyle": false,
    "briefLanguage": "off"
  }
}
`;
  for (const config of [one, other]) {
    const f = fixture(t);
    await writeHarnessConfig({ repoRoot: f.repoRoot, home: f.home, config });
    assert.equal(f.read(), expected);
  }
  // An empty branch and an absent branch are one content.
  const f = fixture(t, 'x');
  await writeHarnessConfig({ repoRoot: f.repoRoot, home: f.home, config: { lead: {}, memory: { embed: { model: 'm' } }, names: { prefix: 'acme-base' } } });
  assert.equal(f.read(), BASE);
});

test('validate and get read the file and write nothing', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.run('validate'), { code: 0, out: 'ok\n', err: '' });
  assert.deepEqual(await f.run('get', 'names.prefix'), { code: 0, out: '"acme-base"\n', err: '' });
  assert.deepEqual(await f.run('get', 'memory'), { code: 0, out: '{"embed":{"model":"m"}}\n', err: '' });
  assert.deepEqual(await f.run('get', 'lead.plainStyle'), { code: 1, out: '', err: 'lead.plainStyle is not set\n' });
  assert.deepEqual(await f.run('get', 'names.other'), { code: 1, out: '', err: 'unknown key names.other\n' });
  assert.equal(existsSync(f.home), false);
  f.untouched(BASE);
  const broken = '{\n  "names": {\n    "prefix": \n';
  writeFileSync(f.file, broken);
  const refused = await f.run('validate');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /^Invalid JSON in harness config [^\n]+\n$/);
  f.untouched(broken);
});

test('set, unset and apply write the canonical bytes and release the lock', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.run('set', 'lead.plainStyle', 'true'), { code: 0, out: `written ${f.file}\n`, err: '' });
  assert.deepEqual(await f.run('set', 'install.userEntries', '"keep"'), { code: 0, out: `written ${f.file}\n`, err: '' });
  const withBoth = BASE.replace('{\n', '{\n  "install": {\n    "userEntries": "keep"\n  },\n')
    .replace(/\n}\n$/, ',\n  "lead": {\n    "plainStyle": true\n  }\n}\n');
  assert.equal(f.read(), withBoth);
  assert.deepEqual(await f.run('get', 'lead.plainStyle'), { code: 0, out: 'true\n', err: '' });
  assert.equal((await f.run('unset', 'lead.plainStyle')).code, 0);
  assert.equal((await f.run('unset', 'install.userEntries')).code, 0);
  assert.equal(f.read(), BASE);
  assert.deepEqual(await f.run('unset', 'mcp.off'), { code: 0, out: `unchanged ${f.file}\n`, err: '' });
  const answers = path.join(f.root, 'answers.json');
  writeFileSync(answers, JSON.stringify({ memory: { embed: { model: 'other' } }, names: { prefix: 'acme' } }));
  assert.deepEqual(await f.run('apply', answers), { code: 0, out: `written ${f.file}\n`, err: '' });
  assert.equal(f.read(), BASE.replace('acme-base', 'acme').replace('"m"', '"other"'));
  assert.deepEqual(readdirSync(f.home), []);
});

test('orch.lanPort writes the canonical bytes, unsets, and refuses other values', async (t) => {
  const f = fixture(t);
  const withOff = BASE.replace(/\n}\n$/, ',\n  "orch": {\n    "lanPort": "off"\n  }\n}\n');
  assert.deepEqual(await f.run('set', 'orch.lanPort', '"off"'), { code: 0, out: `written ${f.file}\n`, err: '' });
  assert.equal(f.read(), withOff);
  assert.deepEqual(await f.run('set', 'orch.lanPort', '8080'), { code: 0, out: `written ${f.file}\n`, err: '' });
  assert.equal(f.read(), withOff.replace('"off"', '8080'));
  assert.deepEqual(await f.run('unset', 'orch.lanPort'), { code: 0, out: `written ${f.file}\n`, err: '' });
  assert.equal(f.read(), BASE);
  for (const [value, message] of [
    ['"Off"', /orch\.lanPort must be "off" or an integer from 1 to 65535/],
    ['0', /orch\.lanPort must be "off" or an integer from 1 to 65535/],
    ['65536', /orch\.lanPort must be "off" or an integer from 1 to 65535/],
    ['1.5', /orch\.lanPort must be "off" or an integer from 1 to 65535/],
    ['true', /orch\.lanPort must be "off" or an integer from 1 to 65535/],
  ]) {
    const result = await f.run('set', 'orch.lanPort', value);
    assert.equal(result.code, 1, value);
    assert.equal(result.out, '', value);
    assert.match(result.err.trimEnd(), message);
    f.untouched(BASE);
  }
});

test('a refusal is one stderr line, exit 1, and the old bytes', async (t) => {
  const f = fixture(t);
  const answers = path.join(f.root, 'answers.json');
  writeFileSync(answers, JSON.stringify({ memory: { embed: { model: 'm' } }, names: { prefix: 'acme' }, extra: 1 }));
  const bad = path.join(f.root, 'bad.json');
  writeFileSync(bad, '{\n  "names":\n');
  // Written as text: JSON.stringify gives no __proto__ key.
  const protoKey = path.join(f.root, 'proto.json');
  writeFileSync(protoKey, '{"memory":{"embed":{"model":"m"}},"names":{"prefix":"acme"},"__proto__":{"polluted":true}}');
  const nestedProtoKey = path.join(f.root, 'nested-proto.json');
  writeFileSync(nestedProtoKey, '{"memory":{"embed":{"model":"m"}},"names":{"prefix":"acme","__proto__":{"polluted":true}}}');
  const constructorKey = path.join(f.root, 'constructor.json');
  writeFileSync(constructorKey, '{"memory":{"embed":{"model":"m"}},"names":{"prefix":"acme"},"constructor":{"prototype":{"polluted":true}}}');
  for (const [args, message] of [
    [['set', 'names.prefix', '"Bad"'], /names\.prefix must match/],
    [['set', 'names.prefix', 'acme'], /the value of names\.prefix is not JSON/],
    [['set', 'lead.plainStyle', '"yes"'], /lead\.plainStyle must be boolean/],
    [['set', 'names.other', '1'], /^unknown key names\.other$/],
    [['set', 'names', '{"prefix":"acme"}'], /^unknown key names$/],
    [['unset', 'names.prefix'], /^names\.prefix is a required key/],
    [['unset', 'memory.embed.model'], /^memory\.embed\.model is a required key/],
    [['set', '__proto__', '1'], /^unknown key __proto__$/],
    [['set', 'names.__proto__', '1'], /^unknown key names\.__proto__$/],
    [['set', 'constructor.prototype', '1'], /^unknown key constructor\.prototype$/],
    [['unset', '__proto__'], /^unknown key __proto__$/],
    [['get', '__proto__'], /^unknown key __proto__$/],
    [['get', 'constructor.prototype'], /^unknown key constructor\.prototype$/],
    [['apply', protoKey], /unknown key __proto__$/],
    [['apply', nestedProtoKey], /unknown key names\.__proto__$/],
    [['apply', constructorKey], /unknown key constructor$/],
    [['apply', answers], /unknown key extra/],
    [['apply', bad], /Invalid JSON in answers file/],
    [['apply', path.join(f.root, 'absent.json')], /Cannot read answers file/],
  ]) {
    const result = await f.run(...args);
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(result.out, '', args.join(' '));
    assert.equal(result.err.split('\n').length, 2, result.err);
    assert.match(result.err.trimEnd(), message);
    f.untouched(BASE);
  }
  assert.equal({}.polluted, undefined);
  for (const args of [[], ['set', 'names.prefix'], ['get'], ['validate', 'more'], ['drop', 'names.prefix']]) {
    const result = await f.run(...args);
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.err, /^usage: harness-config validate/);
    f.untouched(BASE);
  }
});

test('a held installer lock refuses the write', async (t) => {
  const f = fixture(t);
  mkdirSync(f.home, { recursive: true });
  const lock = path.join(f.home, '.harness-install.lock');
  const held = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`;
  writeFileSync(lock, held);
  const result = await f.run('set', 'names.prefix', '"acme"');
  assert.equal(result.code, 1);
  assert.match(result.err, /^Installer lock held by live pid \d+: [^\n]+\n$/);
  f.untouched(BASE);
  assert.equal(readFileSync(lock, 'utf8'), held);
  await assert.rejects(
    writeHarnessConfig({ repoRoot: f.repoRoot, home: f.home, config: { memory: { embed: { model: 'm' } }, names: { prefix: 'acme' } } }),
    /Installer lock held by live pid/,
  );
  f.untouched(BASE);
});

test('the CLI runs when it is started through a symlink', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-config-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'harness-config.mjs');
  symlinkSync(CLI, link);
  const run = spawnSync(process.execPath, [link, 'validate'], { encoding: 'utf8' });
  assert.deepEqual({ status: run.status, stdout: run.stdout, stderr: run.stderr }, { status: 0, stdout: 'ok\n', stderr: '' });
});

test('a killed write: the next write takes over its lock and removes its temp file', async (t) => {
  const f = fixture(t);
  // The child dies with the lock held and a temp file of its own pid beside the config.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs';
    import { writeHarnessConfig } from ${JSON.stringify(pathToFileURL(LIB).href)};
    const [repoRoot, home, file] = process.argv.slice(1);
    await writeHarnessConfig({ repoRoot, home, config: () => {
      writeFileSync(file + '.' + process.pid + '.0123456789ab.tmp', 'partial');
      process.kill(process.pid, 'SIGKILL');
      for (;;);
    } });
  `, f.repoRoot, f.home, f.file], { encoding: 'utf8' });
  assert.notEqual(child.status, 0);
  const lock = path.join(f.home, '.harness-install.lock');
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, child.pid);
  const dead = `harness.config.json.${child.pid}.0123456789ab.tmp`;
  const live = `harness.config.json.${process.pid}.0123456789ab.tmp`;
  const foreign = 'harness.config.json.notes.tmp';
  for (const name of [live, foreign]) writeFileSync(path.join(path.dirname(f.file), name), 'keep');
  assert.deepEqual(readdirSync(path.dirname(f.file)).sort(), ['harness.config.json', dead, live, foreign].sort());
  assert.equal(f.read(), BASE);
  assert.deepEqual(await f.run('set', 'names.prefix', '"acme"'), { code: 0, out: `written ${f.file}\n`, err: '' });
  assert.equal(f.read(), BASE.replace('acme-base', 'acme'));
  assert.deepEqual(readdirSync(path.dirname(f.file)).sort(), ['harness.config.json', live, foreign].sort());
  assert.deepEqual(readdirSync(f.home), []);
});

test('a config path that is a link to a file is written through the link', async (t) => {
  const f = fixture(t);
  const target = path.join(f.root, 'elsewhere', 'real.json');
  mkdirSync(path.dirname(target));
  writeFileSync(target, BASE);
  rmSync(f.file);
  symlinkSync(target, f.file);
  assert.deepEqual(await f.run('set', 'names.prefix', '"acme"'), { code: 0, out: `written ${f.file}\n`, err: '' });
  assert.ok(lstatSync(f.file).isSymbolicLink());
  assert.equal(readlinkSync(f.file), target);
  assert.equal(readFileSync(target, 'utf8'), BASE.replace('acme-base', 'acme'));
  assert.deepEqual(readdirSync(path.dirname(target)), ['real.json']);
  assert.deepEqual(readdirSync(path.dirname(f.file)), ['harness.config.json']);
  // A link with no target is refused: a rename onto it would replace the link.
  rmSync(target);
  const answers = path.join(f.root, 'answers.json');
  writeFileSync(answers, BASE);
  const refused = await f.run('apply', answers);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /^Cannot read harness config [^\n]+: it is a link with no target\n$/);
  assert.equal(readlinkSync(f.file), target);
  assert.deepEqual(readdirSync(path.dirname(target)), []);
});

test('a directory at the config path is refused and no temp file is left', async (t) => {
  const f = fixture(t);
  rmSync(f.file);
  mkdirSync(f.file);
  const answers = path.join(f.root, 'answers.json');
  writeFileSync(answers, BASE);
  for (const args of [['apply', answers], ['set', 'names.prefix', '"acme"']]) {
    const refused = await f.run(...args);
    assert.equal(refused.code, 1, args.join(' '));
    assert.match(refused.err, /^Cannot read harness config [^\n]+EISDIR[^\n]*\n$/);
    assert.deepEqual(readdirSync(path.dirname(f.file)), ['harness.config.json']);
    assert.deepEqual(readdirSync(f.file), []);
    assert.deepEqual(readdirSync(f.root).sort(), ['answers.json', 'home', 'repo']);
  }
});

test('--home names the home whose installer lock a write takes; without it the installer default holds', async (t) => {
  const f = fixture(t);
  const other = path.join(f.root, 'other-home');
  mkdirSync(other);
  const lock = path.join(other, '.harness-install.lock');
  writeFileSync(lock, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  const held = new RegExp(`^Installer lock held by live pid ${process.pid}: ${lock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`);
  // The flag, at either side of the verb.
  for (const args of [['--home', other, 'set', 'names.prefix', '"acme"'], ['set', 'names.prefix', '--home', other, '"acme"']]) {
    const refused = await f.runIn(f.repoRoot, ...args);
    assert.equal(refused.code, 1, args.join(' '));
    assert.match(refused.err, held);
    f.untouched(BASE);
  }
  // No flag: HARNESS_HOME, as an installer run with no --home. The flag wins over it.
  const before = process.env.HARNESS_HOME;
  t.after(() => {
    if (before === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = before;
  });
  process.env.HARNESS_HOME = other;
  const byEnv = await f.runIn(f.repoRoot, 'set', 'names.prefix', '"acme"');
  assert.equal(byEnv.code, 1);
  assert.match(byEnv.err, held);
  f.untouched(BASE);
  assert.equal((await f.run('set', 'names.prefix', '"acme"')).code, 0);
  assert.equal(f.read(), BASE.replace('acme-base', 'acme'));
  // A wrong flag is a wrong call: the reason, the usage, exit 2.
  for (const [args, reason] of [
    [['set', 'names.prefix', '"other"', '--home'], '--home requires a value\n'],
    [['--home', '--other', 'set', 'names.prefix', '"other"'], '--home requires a value\n'],
    [['--home', '', 'set', 'names.prefix', '"other"'], '--home requires a nonempty value\n'],
  ]) {
    const refused = await f.runIn(f.repoRoot, ...args);
    assert.equal(refused.code, 2, args.join(' '));
    assert.ok(refused.err.startsWith(`${reason}usage: harness-config validate`), refused.err);
    assert.equal(f.read(), BASE.replace('acme-base', 'acme'));
  }
});
