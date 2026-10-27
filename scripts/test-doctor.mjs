import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { after, before } from 'node:test';
import { scrubbedGitEnv } from './git-env.mjs';
import { HARNESS_FAMILIES } from './lib/harness-config.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));
const memory = 'ops/bootstrap/install-memory.mjs';
const skills = 'scripts/check-skills-drift.mjs';
const orch = 'ops/orchestrator/src/main.ts';
const installer = 'node ops/bootstrap/install-harness.mjs --only skills';
const textTools = [
  { id: 'hooks', file: 'scripts/check-hook-topology.mjs', label: 'hook-topology' },
  { id: 'mcp', file: 'scripts/check-mcp-delivery.mjs', label: 'mcp-delivery' },
];
// Each check adds one row when no remote hosts are registered.
const rowCount = 11 + HARNESS_FAMILIES.length;
const memoryHealth = { ok: true, service: 'memoryctl' };

// The doctor runs under spawnSync, which blocks this process: a stub service
// must answer from a process of its own. `silent` accepts and closes with no answer.
async function stubService(t, { status = 200, body = memoryHealth, silent = false } = {}) {
  const child = spawn(process.execPath, ['-e', `
const answer = (req, res) => { res.writeHead(${status}, { 'content-type': 'application/json' }); res.end(${JSON.stringify(JSON.stringify(body))}); };
const server = ${silent} ? require('node:net').createServer((socket) => socket.destroy()) : require('node:http').createServer(answer);
server.listen(0, '127.0.0.1', () => console.log(server.address().port));`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const stop = () => child.kill('SIGKILL');
  t.after(stop);
  const [port] = await once(child.stdout, 'data');
  return { port: Number(port), pid: child.pid };
}

// The files the real memory client loads, found by its own import lines.
const clientFiles = (() => {
  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    for (const [, next] of readFileSync(join(source, rel), 'utf8').matchAll(/^(?:import|export)\b[^'"]*?from\s+['"](\.[^'"]+)['"]/gms)) {
      walk(join(dirname(rel), next));
    }
  };
  walk('scripts/memory/service-client.mjs');
  return [...seen];
})();

async function closedPort(host = '127.0.0.1') {
  const server = createServer().listen(0, host);
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

let healthyPort;
const shared = { after(stop) { this.stop = stop; } };
before(async () => { ({ port: healthyPort } = await stubService(shared)); });
after(() => shared.stop());

function fixture(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'doctor-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const repo = join(scratch, 'repo');
  const home = join(scratch, 'home');
  mkdirSync(home);
  const state = join(home, '.local/state/memoryctl');
  mkdirSync(state, { recursive: true });
  const env = { ...scrubbedGitEnv(), HOME: home, USERPROFILE: home, HARNESS_HOME: home, MEMORYCTL_HOME: home, MEMORYCTL_STATE_DIR: state };
  for (const name of ['MEMORYCTL_URL', 'ORCH_PORT', 'ORCH_STATE_DIR']) delete env[name];
  const serviceUrl = (port) => writeFileSync(join(state, 'service.url'), `http://127.0.0.1:${port}\n`);
  serviceUrl(healthyPort);
  const write = (rel, body) => {
    const file = join(repo, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  };
  const copy = (rel) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    copyFileSync(join(source, rel), join(repo, rel));
  };
  for (const rel of ['ops/bootstrap/doctor.mjs', 'scripts/lib/harness-config.mjs', 'scripts/lib/is-main.mjs',
    'scripts/lib/memory-installer.mjs',
    ...clientFiles]) copy(rel);
  const config = { memory: { embed: { model: 'fixture' } }, names: { prefix: 'fixture' } };
  write('ops/bootstrap/harness.config.json', JSON.stringify(config));
  const orchCommands = (responses = {}) => write(orch, `
import assert from 'node:assert/strict';
const responses = ${JSON.stringify({
    status: { data: { running: true, port: 7760 } },
    'hosts list': { data: {} },
    'roles show --json': { data: { coder: { mark: 'compiled', cells: {} } } },
    ...responses,
  })};
const command = process.argv.slice(2).join(' ');
assert.ok(Object.hasOwn(responses, command), 'unexpected orch command: ' + command);
const response = responses[command];
if (response.data !== undefined) console.log(JSON.stringify(response.data));
if (response.stdout) console.log(response.stdout);
if (response.stderr) console.error(response.stderr);
process.exitCode = response.status ?? 0;`);
  const tool = (rel, data, status = 0, suffix = '') => {
    if (rel === orch) return orchCommands({ status: { data, status } });
    write(rel, `console.log(${JSON.stringify(JSON.stringify(data))});\n${suffix}\nprocess.exitCode = ${status};\n`);
  };
  const logins = (results = {}) => write('scripts/lib/family-logins.mjs', `
import assert from 'node:assert/strict';
import { join } from 'node:path';
export function checkLogin(family, { home, orchStateDir }) {
  assert.equal(home, process.env.HOME);
  assert.equal(orchStateDir, join(home, '.local', 'state', 'orch'));
  const result = ${JSON.stringify(results)}[family] ?? { state: 'ok', detail: 'credential proved' };
  if (result.error) throw new Error(result.error);
  return result;
}
export function keyLogin(family) {
  return ['glm', 'qwen'].includes(family) ? { entries: ['fixture-entry'] }
    : { command: family === 'mimo' ? '/login' : family + ' sign-in' };
}`);
  logins();
  for (const { file, label } of textTools) write(file, `
import assert from 'node:assert/strict';
assert.deepEqual(process.argv.slice(2), []);
console.log('ok: claude — fixture proof\\n${label}: 1 checks green');`);
  tool(memory, { ok: true, mode: 'check', targets: [] });
  tool(skills, { canon: 1, report: [{ runtime: 'codex', bad: 0 }], retired: [], drift: [] }, 0,
    "console.log('\\ncheck-skills-drift: OK');");
  tool(orch, { running: true, port: 7760 });
  // Unrelated doctor cases must never invoke the real macOS capture tool.
  write('ops/orchestrator/src/shared.entry.ts', 'export async function peekabooVerdict() { return { ok: true }; }\n');
  const run = (json = false, platform) => {
    const preload = join(repo, 'platform.mjs');
    if (platform) write('platform.mjs', `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });`);
    return spawnSync(process.execPath,
      [...(platform ? ['--import', pathToFileURL(preload).href] : []),
        join(repo, 'ops/bootstrap/doctor.mjs'), ...(json ? ['--json'] : [])], { env, encoding: 'utf8', timeout: 30_000 });
  };
  const fix = (dry = false, json = false) => spawnSync(process.execPath,
    [join(repo, 'ops/bootstrap/doctor.mjs'), '--fix', ...(dry ? ['--dry-run'] : []), ...(json ? ['--json'] : [])], { env, encoding: 'utf8', timeout: 60_000 });
  return { repo, home, state, env, write, copy, tool, orchCommands, logins, config, run, fix, serviceUrl };
}

function rows(result, status) {
  assert.equal(result.status, status, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

for (const scenario of [
  { name: 'OK', platform: 'darwin', probe: { ok: true, out: JSON.stringify({ data: { permissions: [
    { name: 'Screen Recording', isRequired: true, isGranted: true },
  ] } }) }, state: 'ok', detail: /^OK$/ },
  { name: 'missing binary', platform: 'darwin', probe: { ok: false, out: 'spawn peekaboo ENOENT' },
    state: 'fault', detail: /ENOENT.*brew install peekaboo/ },
  // Task 2414: a kit makes Peekaboo an optional capture tool
  // (ops/harness-kit/INSTALL.md) and installs no Homebrew, so the row reports
  // the state instead of faulting a fresh install on a fix it cannot run.
  { name: 'kit without the binary', platform: 'darwin', probe: { ok: false, out: 'spawn peekaboo ENOENT' },
    kit: true, state: 'ok', detail: /optional in this kit/ },
  { name: 'missing right', platform: 'darwin', probe: { ok: true, out: JSON.stringify({ data: { permissions: [
    { name: 'Screen Recording', isRequired: true, isGranted: false, grantInstructions: 'Enable capture for this app' },
  ] } }) }, state: 'fault', detail: /Screen Recording.*Enable capture for this app/ },
  { name: 'non-darwin', platform: 'linux', state: 'not checked', detail: /Peekaboo runs on macOS only/ },
  { name: 'Windows', platform: 'win32', state: 'not checked', detail: /Peekaboo runs on macOS only/ },
  { name: 'probe throws', platform: 'darwin', state: 'fault', detail: /fixture probe threw/ },
]) {
  test(`peekaboo row: ${scenario.name}`, (t) => {
    const f = fixture(t);
    f.copy('ops/orchestrator/src/peekaboo.ts');
    f.write('ops/orchestrator/src/shared.entry.ts', "export * from './peekaboo.ts';\n");
    if (scenario.kit) f.write('KIT-MANIFEST.json', JSON.stringify({ kit: 'harness-kit' }));
    if (scenario.platform !== 'darwin') unlinkSync(join(f.repo, 'ops/orchestrator/src/peekaboo.ts'));
    f.write('peekaboo-row.mjs', `
import { peekabooRow } from './ops/bootstrap/doctor.mjs';
const row = await peekabooRow({
  platform: ${JSON.stringify(scenario.platform)},
  run() { ${scenario.probe ? `return ${JSON.stringify(scenario.probe)};` : "throw new Error('fixture probe threw');"} },
});
console.log(JSON.stringify([row]));`);
    const [row] = rows(spawnSync(process.execPath, [join(f.repo, 'peekaboo-row.mjs')],
      { env: f.env, encoding: 'utf8', timeout: 30_000 }), 0);
    assert.equal(row.id, 'peekaboo');
    assert.equal(row.state, scenario.state);
    assert.match(row.detail, scenario.detail);
    if (row.state === 'fault') {
      if (scenario.probe) assert.match(row.nextStep, scenario.detail);
      assert.equal(row.fix, undefined, 'permission and installation repairs are not automatic');
    }
    if (scenario.kit) {
      // The kit guide installs no package manager: the optional row names the
      // guide's own route, never the donor's Homebrew fix.
      assert.match(row.detail, /ops\/harness-kit\/INSTALL\.md/);
      assert.doesNotMatch(row.detail, /brew/i);
      assert.equal(row.nextCommand ?? row.nextStep, undefined, 'an optional row owes no repair');
    }
  });
}

for (const failure of ['import failure', 'probe throw']) {
  test(`peekaboo doctor: ${failure} is one fault and other rows still print`, (t) => {
    const f = fixture(t);
    const otherRows = rows(f.run(true, 'darwin'), 0).filter((entry) => entry.id !== 'peekaboo');
    if (failure === 'import failure') unlinkSync(join(f.repo, 'ops/orchestrator/src/shared.entry.ts'));
    else f.write('ops/orchestrator/src/shared.entry.ts',
      "export function peekabooVerdict() { throw new Error('fixture probe threw'); }\n");
    const reason = failure === 'import failure' ? /Cannot find module/ : /fixture probe threw/;
    const report = rows(f.run(true, 'darwin'), 1);
    assert.equal(report.length, rowCount);
    const row = report.find((entry) => entry.id === 'peekaboo');
    assert.equal(row.state, 'fault');
    assert.match(row.detail, reason);
    assert.deepEqual(report.filter((entry) => entry.id !== 'peekaboo'), otherRows);
    const text = f.run(false, 'darwin');
    assert.equal(text.status, 1, text.stderr);
    for (const entry of report) assert.ok(text.stdout.includes(`${entry.id}: ${entry.state} — ${entry.detail}`));
  });
}

test('hosts: empty registry is ok without a probe', (t) => {
  const f = fixture(t);
  const row = rows(f.run(true), 0).find((row) => row.id === 'hosts');
  assert.ok(row);
  assert.equal(row.state, 'ok');
  assert.match(row.detail, /no .*hosts.*registered/i);
});

test('hosts: each registered host gets its own probe result and repair step', (t) => {
  const f = fixture(t);
  f.orchCommands({
    'hosts list': { data: { alpha: { ssh: 'a' }, beta: { ssh: 'b' }, gamma: { ssh: 'c' } } },
    'hosts probe alpha': { data: { host: 'alpha', ok: true, version: 'v24.0.0' } },
    'hosts probe beta': { data: { host: 'beta', ok: false, reason: 'node_not_found', error: 'node: command not found' }, status: 1 },
    'hosts probe gamma': { stdout: 'no readable proof' },
  });
  const report = rows(f.run(true), 1).filter((row) => row.id.startsWith('hosts/'));
  assert.deepEqual(report.map((row) => [row.id, row.state]),
    [['hosts/alpha', 'ok'], ['hosts/beta', 'fault'], ['hosts/gamma', 'not checked']]);
  assert.match(report[0].detail, /v24.0.0/);
  assert.match(report[1].detail, /node_not_found.*node: command not found/);
  assert.match(report[1].nextStep, /beta/);
  assert.ok(report[2].reason);
  const text = f.run();
  assert.equal(text.status, 1);
  for (const row of report) assert.ok(text.stdout.includes(`${row.id}: ${row.state} — ${row.detail}`));
});

for (const failure of ['malformed', 'failed to start', 'owner refusal', 'inconsistent exit', 'wrong host']) {
  test(`hosts: ${failure} cannot become an ok proof`, (t) => {
    const f = fixture(t);
    if (failure === 'failed to start') unlinkSync(join(f.repo, orch));
    else f.orchCommands(failure === 'inconsistent exit' || failure === 'wrong host' ? {
      'hosts list': { data: { alpha: { ssh: 'a' } } },
      'hosts probe alpha': { data: { host: failure === 'wrong host' ? 'beta' : 'alpha', ok: true, version: 'v24.0.0' },
        status: failure === 'inconsistent exit' ? 1 : 0 },
    } : {
      'hosts list': failure === 'owner refusal'
        ? { stderr: 'hosts: hosts.json is invalid', status: 1 } : { data: [] },
    });
    const row = rows(f.run(true), failure === 'owner refusal' ? 1 : 0).find((row) => row.id.startsWith('hosts'));
    assert.ok(row);
    assert.equal(row.state, failure === 'owner refusal' ? 'fault' : 'not checked');
    if (failure === 'owner refusal') {
      assert.match(row.detail, /hosts.json is invalid/);
      assert.ok(row.nextStep);
    } else assert.ok(row.reason);
  });
}

for (const state of ['compiled', 'file', 'refused', 'unreadable', 'failed to start', 'inconsistent exit']) {
  test(`role matrix: ${state}`, (t) => {
    const f = fixture(t);
    if (state === 'failed to start') unlinkSync(join(f.repo, orch));
    else f.orchCommands({ 'roles show --json': state === 'refused'
      ? { stderr: 'roles: roles.json: coder has an invalid family', status: 1 }
      : state === 'unreadable' ? { data: { running: true } }
        : { data: { coder: { mark: state === 'file' ? 'file' : 'compiled', cells: {} } },
          status: state === 'inconsistent exit' ? 1 : 0 } });
    const row = rows(f.run(true), state === 'refused' ? 1 : 0).find((row) => row.id === 'role matrix');
    assert.ok(row);
    assert.equal(row.state, ['compiled', 'file'].includes(state) ? 'ok' : state === 'refused' ? 'fault' : 'not checked');
    if (state === 'compiled') assert.match(row.detail, /no roles.json.*compiled matrix/i);
    if (state === 'file') assert.match(row.detail, /roles.json.*accepted/i);
    if (state === 'refused') {
      assert.match(row.detail, /roles: roles.json: coder has an invalid family/);
      assert.match(row.nextStep, /roles reset <role>/);
      assert.match(row.nextStep, /roles.json/);
    }
    if (row.state === 'not checked') assert.ok(row.reason);
  });
}

for (const scenario of ['donor replace', 'donor keep', 'kit keep', 'kit replace', 'kit absent policy', 'bad manifest', 'unknown manifest', 'bad config']) {
  test(`user entries: ${scenario}`, (t) => {
    const f = fixture(t);
    const policy = scenario.endsWith('keep') ? 'keep' : 'replace';
    f.write('ops/bootstrap/harness.config.json', JSON.stringify({
      ...f.config, ...(scenario === 'kit absent policy' ? {} : { install: { userEntries: policy } }),
    }));
    if (scenario.startsWith('kit')) f.write('KIT-MANIFEST.json', JSON.stringify({ kit: 'harness-kit' }));
    if (scenario === 'bad manifest') f.write('KIT-MANIFEST.json', '{broken');
    if (scenario === 'unknown manifest') f.write('KIT-MANIFEST.json', JSON.stringify({ kit: 'other-kit' }));
    if (scenario === 'bad config') f.write('ops/bootstrap/harness.config.json', '{broken');
    const isFault = ['kit replace', 'kit absent policy'].includes(scenario);
    const unproved = ['bad manifest', 'unknown manifest', 'bad config'].includes(scenario);
    const row = rows(f.run(true), isFault || scenario === 'bad config' ? 1 : 0).find((row) => row.id === 'user entries');
    assert.ok(row);
    assert.equal(row.state, isFault ? 'fault' : unproved ? 'not checked' : 'ok');
    if (!unproved) assert.match(row.detail, new RegExp(policy));
    if (isFault) {
      assert.match(row.detail, /MCP servers.*permission rules/);
      assert.equal(row.nextCommand, `node ops/bootstrap/harness-config.mjs set install.userEntries '"keep"'`);
      const before = readFileSync(join(f.repo, 'ops/bootstrap/harness.config.json'), 'utf8');
      f.run();
      assert.equal(readFileSync(join(f.repo, 'ops/bootstrap/harness.config.json'), 'utf8'), before);
    }
    if (unproved) assert.ok(row.reason);
  });
}

// Transport fixtures model each distinct owning tool's documented output only;
// delivery behavior is exercised below with the real checker and installer.
for (const state of ['ok', 'fault', 'not checked']) {
  test(`CLI renders ${state} in JSON and text with the matching exit and next command`, (t) => {
    const f = fixture(t);
    if (state === 'fault') f.tool(memory, { ok: false, mode: 'check', targets: [{ what: 'client', was: 'absent' }] }, 1);
    if (state === 'not checked') unlinkSync(join(f.repo, memory));
    const status = state === 'fault' ? 1 : 0;
    const report = rows(f.run(true), status);
    assert.equal(report.length, rowCount);
    assert.equal(report[0].state, 'ok');
    assert.equal(report[1].state, state);
    if (state === 'not checked') assert.ok(report[1].reason.includes('Cannot find module'));
    if (state === 'fault') assert.equal(report[1].nextCommand, 'node ops/bootstrap/install-memory.mjs');
    const text = f.run();
    assert.equal(text.status, status, text.stderr);
    for (const row of report) assert.ok(text.stdout.includes(`${row.id}: ${row.state} — ${row.detail}`));
    assert.equal(text.stdout.trim().split('\n').length, rowCount + (state === 'fault' ? 1 : 0));
    if (state === 'fault') assert.ok(text.stdout.endsWith('Next command: node ops/bootstrap/install-memory.mjs\n'));
    else assert.ok(!text.stdout.includes('Next command:'));
  });
}

// 'slow' is a --check past the doctor's 15 s default, as the reranker smoke took
// 17.54 s in a VM (task 2414): the row waits for it instead of cutting it.
for (const state of ['ok', 'slow', 'artifact drift', 'task drift', 'preflight refusal', 'unreadable', 'crash']) {
  test(`kit memory install: ${state} uses the local writer checker and repair`, (t) => {
    const f = fixture(t);
    const local = 'ops/memory-local/install.mjs';
    // The donor alone sees the kit's label as stale. It must not be called directly.
    f.tool(memory, { ok: false, mode: 'check', targets: [] }, 1);
    f.write(local, `
import assert from 'node:assert/strict';
assert.deepEqual(process.argv.slice(2), ['--check']);
${state === 'slow' ? 'await new Promise((done) => setTimeout(done, 16_000));' : ''}
${['ok', 'slow', 'artifact drift', 'task drift'].includes(state)
    ? `console.log(${JSON.stringify(JSON.stringify({ ok: state !== 'artifact drift', mode: 'check', targets: [] }, null, 2))});`
    : ''}
${state === 'ok' ? "console.log('memory-local: fixture-memoryd and launcher match');" : ''}
${['task drift', 'preflight refusal'].includes(state)
    ? `console.error('memory-local: ${state}');` : ''}
${state === 'unreadable' ? "console.log('unexpected output');" : ''}
${state === 'crash' ? "throw new Error('crash');" : ''}
process.exitCode = ${['artifact drift', 'task drift', 'preflight refusal'].includes(state) ? 1 : 0};`);
    const faulted = ['artifact drift', 'task drift', 'preflight refusal', 'crash'].includes(state);
    const row = rows(f.run(true, 'win32'), faulted ? 1 : 0).find((entry) => entry.id === 'memory install');
    assert.equal(row.state, faulted ? 'fault' : ['ok', 'slow'].includes(state) ? 'ok' : 'not checked', row.reason);
    if (faulted) {
      assert.equal(row.nextCommand, `node ${local}`);
      assert.deepEqual(row.fix.argv, [process.execPath, local]);
      assert.ok(row.detail.includes(state === 'artifact drift' ? `node ${local} --check` : state));
    }
    if (state === 'unreadable') assert.ok(row.reason);
  });
}

test('config refusal is a fault and the first command precedes other faults', (t) => {
  const f = fixture(t);
  f.write('ops/bootstrap/harness.config.json', JSON.stringify({ memory: { embed: { model: 'fixture' } }, names: { prefix: 'BAD' } }));
  f.tool(orch, { running: false, stalePid: null }, 1);
  const report = rows(f.run(true), 1);
  assert.equal(report[0].state, 'fault');
  assert.ok(report[0].detail.includes('prefix'));
  assert.equal(report[0].nextCommand, undefined);
  assert.ok(report[0].nextStep.includes('Edit ops/bootstrap/harness.config.json'));
  assert.ok(report[0].nextStep.includes('prefix'));
  assert.equal(report[3].state, 'fault');
  assert.equal(report[3].nextCommand, 'node ops/orchestrator/install.mjs');
  const text = f.run();
  assert.equal(text.status, 1);
  assert.ok(text.stdout.endsWith(`Next step: ${report[0].nextStep}\n`));
});

test('skipped, malformed, failed-to-start and unanswered checks never claim ok', (t) => {
  const f = fixture(t);
  f.write(skills, "console.log('check-skills-drift: SKIPPED — not a git checkout');");
  f.tool(orch, { running: true, healthUnanswered: true }, 0);
  let report = rows(f.run(true), 0);
  assert.equal(report[2].state, 'not checked');
  assert.ok(report[2].reason.includes('SKIPPED'));
  assert.equal(report[3].state, 'not checked');
  assert.ok(report[3].reason.includes('did not answer'));
  f.write(memory, "console.log('{bad json');");
  f.write(skills, "throw new Error('dependency cannot load');");
  unlinkSync(join(f.repo, orch));
  report = rows(f.run(true), 0);
  assert.ok(report.slice(1, 4).every((row) => row.state === 'not checked' && row.reason));
  const text = f.run();
  assert.equal(text.status, 0);
  assert.equal(text.stdout.trim().split('\n').length, rowCount);
});

for (const { id, file, label } of textTools) {
  for (const state of ['ok', 'fault', 'not checked', 'partially checked', 'unreadable', 'failed to start']) {
    test(`${id} text proof: ${state}`, (t) => {
      const f = fixture(t);
      if (state === 'fault') f.write(file, "console.log('skip: another runtime'); console.error('FAIL: delivery absent'); process.exitCode = 1;");
      if (state === 'not checked') f.write(file, `console.log('skip: runtime absent\\n${label}: 0 checks green');`);
      if (state === 'partially checked') f.write(file, `console.log('skip: runtime unreadable\\n${label}: 1 checks green, 1 not measurable from here (see skip: above)');`);
      if (state === 'unreadable') f.write(file, "console.log('unexpected output');");
      if (state === 'failed to start') unlinkSync(join(f.repo, file));
      const status = state === 'fault' ? 1 : 0;
      const report = rows(f.run(true), status);
      const row = report.find((row) => row.id === id);
      assert.ok(row, `${id} row must exist`);
      assert.equal(row.state, ['partially checked', 'unreadable', 'failed to start'].includes(state) ? 'not checked' : state);
      if (state === 'fault') {
        assert.ok(row.detail.includes('FAIL: delivery absent'));
        assert.equal(row.nextCommand, `node ops/bootstrap/install-harness.mjs --only ${id}`);
      }
      if (row.state === 'not checked') assert.ok(row.reason);
      const text = f.run();
      assert.equal(text.status, status, text.stderr);
      assert.ok(text.stdout.includes(`${id}: ${row.state} — ${row.detail}`));
    });
  }
}

// Task 2414 F4, decision 17877: the kit installs only the Claude Code CLI;
// codex, grok, kimi and opencode run inside the pinned Pi, so a fresh install
// has no native vendor CLI. That absence must not leave the hooks and mcp rows
// unproved: they stay ok on the Claude Code proof and name no absent vendor CLI.
test('hooks and mcp stay proved with no codex, kimi or grok CLI (decision 17877)', (t) => {
  const f = fixture(t);
  f.write('scripts/check-hook-topology.mjs', `
import { join } from 'node:path';
const home = process.env.HOME;
console.log('ok: ' + join(home, '.claude', 'settings.json') + ' — prompt-hook wiring status');
console.log('skip: kimi doctor — no kimi on this machine');
console.log('hook-topology: 7 checks green, 1 not measurable from here (see skip: above)');`);
  f.write('scripts/check-mcp-delivery.mjs', `
import { join } from 'node:path';
const home = process.env.HOME;
console.log('ok: claude — FILE READ of ' + join(home, '.claude.json')
  + ' (this runtime has no listing command, so this is our copy and not its answer)');
console.log('skip: codex mcp list — no codex on this machine');
console.log('skip: grok mcp list — no grok on this machine');
console.log('skip: kimi — ' + join(home, '.kimi-code', 'mcp.json') + ' does not exist on this machine');
console.log('mcp-delivery: 3 checks green');`);
  const report = rows(f.run(true), 0);
  for (const id of ['hooks', 'mcp']) {
    const row = report.find((entry) => entry.id === id);
    assert.ok(row, `${id} row must exist`);
    assert.equal(row.state, 'ok', row.reason || row.detail);
    assert.match(row.detail, /claude/, 'the row proves Claude Code');
    assert.doesNotMatch(row.detail, /codex|kimi|grok/, 'the row names no absent vendor CLI');
  }
  assert.equal(f.run().status, 0);
});

// The excusal covers only an ABSENT vendor CLI. A configured one keeps its own
// open skips, and the kit's own runtime unproved keeps the row not checked.
test('a configured vendor CLI and an unproved Claude Code stay open skips', (t) => {
  const f = fixture(t);
  f.write('scripts/check-hook-topology.mjs', `
import { join } from 'node:path';
console.log('ok: ' + join(process.env.HOME, '.claude', 'settings.json') + ' — prompt-hook wiring status');
console.log('skip: ' + join(process.env.HOME, '.kimi-code', 'config.toml')
  + ' — kimi: strict TOML hook-topology verification was retired with Svod');
console.log('hook-topology: 8 checks green, 1 not measurable from here (see skip: above)');`);
  f.write('scripts/check-mcp-delivery.mjs', `
import { join } from 'node:path';
console.log('skip: claude — ' + join(process.env.HOME, '.claude.json') + ' does not exist on this machine');
console.log('skip: codex mcp list — no codex on this machine');
console.log('mcp-delivery: 2 checks green');`);
  const report = rows(f.run(true), 0);
  const hooks = report.find((entry) => entry.id === 'hooks');
  const mcp = report.find((entry) => entry.id === 'mcp');
  assert.equal(hooks.state, 'not checked');
  assert.match(hooks.reason, /kimi: strict TOML/);
  assert.equal(mcp.state, 'not checked');
  assert.match(mcp.reason, /skip: claude — .* does not exist/);
});

for (const state of ['ok', 'missing', 'expired', 'unknown', 'unreadable']) {
  test(`login proofs: ${state} for every default family`, (t) => {
    const f = fixture(t);
    f.logins(Object.fromEntries(HARNESS_FAMILIES.map((family) => [family,
      state === 'unreadable' ? { error: 'credential file is unreadable' } : { state, detail: `proof ${state}` }])));
    const status = ['missing', 'expired'].includes(state) ? 1 : 0;
    const report = rows(f.run(true), status);
    const expectedState = status ? 'fault' : state === 'ok' ? 'ok' : 'not checked';
    for (const family of HARNESS_FAMILIES) {
      const row = report.find((row) => row.id === `logins/${family}`);
      assert.ok(row, `${family} must be checked when families.enabled is absent`);
      assert.equal(row.state, expectedState);
      if (status) {
        assert.equal(row.nextCommand, `node ops/bootstrap/harness-login.mjs ${family}`);
        assert.equal(row.fix.safe, false, 'a login still requires the human');
      }
      if (row.state === 'not checked') assert.ok(row.reason);
    }
    const text = f.run();
    assert.equal(text.status, status, text.stderr);
    for (const row of report) assert.ok(text.stdout.includes(`${row.id}: ${row.state} — ${row.detail}`));
  });
}

test('families.enabled limits login proofs without probing disabled families', (t) => {
  const f = fixture(t);
  f.write('ops/bootstrap/harness.config.json', JSON.stringify({ ...f.config, families: { enabled: ['codex'] } }));
  f.logins(Object.fromEntries(HARNESS_FAMILIES.filter((family) => family !== 'codex')
    .map((family) => [family, { error: 'disabled family must not be checked' }])));
  const report = rows(f.run(true), 0);
  assert.deepEqual(report.filter((row) => row.id.startsWith('logins/')).map((row) => [row.id, row.state]),
    [['logins/codex', 'ok']]);
});

test('real skills installer fixture is ok; deleting a link faults with the skills install command', (t) => {
  const f = fixture(t);
  for (const name of ['plan-before-code', 'memoryctl', 'premortem']) {
    f.write(`.agents/skills/${name}/SKILL.md`, '# Fixture skill\n');
  }
  f.write('.agents/domains/_skill-map.json', JSON.stringify({
    leadInstalledSkills: ['plan-before-code', 'memoryctl'], supportLeadSkills: [],
    skills: { 'plan-before-code': { class: 'core' }, memoryctl: { class: 'lead' }, premortem: { class: 'method' } },
  }));
  const install = () => {
    const result = spawnSync(process.execPath, [join(source, 'ops/bootstrap/install-harness.mjs'),
      '--only', 'skills', '--repo', f.repo, '--home', f.home], { env: f.env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };
  install();
  for (const rel of [skills, 'scripts/git-env.mjs', 'scripts/lib/is-main.mjs']) f.copy(rel);
  const git = spawnSync('git', ['init', f.repo], { env: scrubbedGitEnv(f.env), encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const configFile = join(f.repo, 'ops/bootstrap/harness.config.json');
  const configBefore = readFileSync(configFile);
  let report = rows(f.run(true), 0);
  assert.equal(report[0].state, 'ok');
  assert.equal(report[2].state, 'ok');
  // Negative control: the actual checker must observe loss of an installer-owned link.
  unlinkSync(join(f.home, '.codex/skills/memoryctl'));
  report = rows(f.run(true), 1);
  assert.equal(report[2].state, 'fault');
  assert.equal(report[2].nextCommand, installer);
  const text = f.run();
  assert.equal(text.status, 1);
  assert.ok(text.stdout.endsWith(`Next command: ${installer}\n`));
  assert.ok(!existsSync(join(f.home, '.codex/skills/memoryctl')), 'doctor must not repair the link');
  assert.deepEqual(readFileSync(configFile), configBefore, 'doctor must not rewrite the answers');
  install();
  assert.equal(rows(f.run(true), 0)[2].state, 'ok');
  // RETIRED is a document fault, not something reinstalling links can repair.
  f.write('.agents/skills/memoryctl/SKILL.md', '# Fixture skill\nInvoke `systematic-debugging`.\n');
  report = rows(f.run(true), 1);
  assert.equal(report[2].state, 'fault');
  assert.equal(report[2].nextCommand, undefined);
  assert.ok(report[2].detail.includes('memoryctl/SKILL.md:2'));
  assert.ok(report[2].nextStep.includes('name a document the set still carries, or drop the sentence'));
  assert.ok(f.run().stdout.endsWith(`Next step: ${report[2].nextStep}\n`));
  unlinkSync(join(f.home, '.codex/skills/memoryctl'));
  assert.equal(rows(f.run(true), 1)[2].nextCommand, installer, 'mixed faults still need delivery repair');
  // A failed preflight is a completed fault, not a tool-start failure.
  f.write('.agents/domains/_skill-map.json', '{}');
  assert.equal(rows(f.run(true), 1)[2].state, 'fault');
});

test('a tool ignoring SIGTERM returns not checked near the configured timeout', (t) => {
  const f = fixture(t);
  const marker = join(f.repo, 'probe.pid');
  f.write('probe.mjs', `import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
writeFileSync(${JSON.stringify(marker)}, String(process.pid));
setInterval(() => {}, 1000);`);
  const runner = pathToFileURL(join(source, 'ops/bootstrap/doctor.mjs')).href;
  const script = `import { run } from ${JSON.stringify(runner)};
const start = performance.now();
const row = run({ id: 'probe', file: ${JSON.stringify(join(f.repo, 'probe.mjs'))}, args: [] }, 400);
console.log(JSON.stringify({ row, elapsed: performance.now() - start }));`;
  // An independent outer bound prevents the pre-fix hang from hanging this test.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: f.env, encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL',
  });
  const pid = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : null;
  t.after(() => {
    if (result.error && pid !== null) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  });
  assert.ok(existsSync(marker), 'stub installed its SIGTERM handler before the deadline');
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const { row, elapsed } = JSON.parse(result.stdout);
  assert.equal(row.state, 'not checked');
  assert.ok(row.reason.includes('ETIMEDOUT'));
  assert.ok(elapsed >= 350 && elapsed < 2000, `elapsed ${elapsed}ms for a 400ms deadline`);
});

const memoryRow = (f, status) => rows(f.run(true), status).find((row) => row.id === 'memory service');
const freeStep = (port) => new RegExp(`^Free port ${port}: .*(lsof|netstat)`);

test('memory service: ok names the address read from service.url', (t) => {
  const row = memoryRow(fixture(t), 0);
  assert.equal(row.state, 'ok');
  assert.ok(row.detail.includes(`http://127.0.0.1:${healthyPort}`));
});

test('memory service: a stopped local service faults with the start command of this platform', async (t) => {
  const f = fixture(t);
  const port = await closedPort();
  unlinkSync(join(f.state, 'service.url'));
  f.env.MEMORYCTL_URL = `http://127.0.0.1:${port}`;
  writeFileSync(join(f.state, 'launchd.label'), 'fixture.memoryd\n');
  writeFileSync(join(f.state, 'task.name'), 'FixtureMemory\n');
  let row = memoryRow(f, 1);
  assert.equal(row.state, 'fault');
  assert.ok(row.detail.includes(`nothing listens at http://127.0.0.1:${port}`));
  if (process.platform === 'darwin') assert.equal(row.nextCommand, 'launchctl kickstart -k gui/$(id -u)/fixture.memoryd');
  else if (process.platform === 'win32') assert.ok(row.nextCommand.includes("Start-ScheduledTask -TaskName 'FixtureMemory'"));
  else assert.ok(row.nextStep.includes('start memoryd by hand'));
  // No installed name: only the installer can say how the service starts.
  for (const name of ['launchd.label', 'task.name']) unlinkSync(join(f.state, name));
  row = memoryRow(f, 1);
  if (process.platform === 'darwin' || process.platform === 'win32') assert.equal(row.nextCommand, 'node ops/bootstrap/install-memory.mjs');
});

test('memory service: a client host with a closed route is told to restore the route, not to start a service', async (t) => {
  const f = fixture(t);
  const port = await closedPort();
  f.serviceUrl(port);
  writeFileSync(join(f.state, 'launchd.label'), 'fixture.memoryd\n');
  const row = memoryRow(f, 1);
  assert.equal(row.state, 'fault');
  assert.equal(row.nextCommand, undefined);
  assert.ok(row.nextStep.includes(`Restore the route to http://127.0.0.1:${port}`));
});

// A non-loopback address proves a closed route only by REFUSING a connect to a
// free port: that refusal is the proof the doctor reads (portHeld,
// ops/bootstrap/doctor.mjs). An adapter that drops the SYN — a VPN tun, or a
// firewall that stealths this machine's LAN addresses (Windows host) — gives only
// a timeout, which proves nothing: there the doctor is right to answer
// 'not checked'. Probe this machine's own addresses, first to last, once per
// run, and split them by that proof, so each case below runs on the first
// address that can actually produce it. The probe is lazy, not top-level
// await: an await between test registrations leaves later tests unstarted
// under --test-name-pattern.
let lanProofPromise;
const lanProof = () => lanProofPromise ??= (async () => {
  const refused = [];
  const unproved = [];
  for (const { address: host } of Object.values(networkInterfaces()).flat()
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)) {
    try {
      const port = await closedPort(host);
      const answer = await new Promise((done) => {
        const socket = connect({ host, port, timeout: 1000 });
        const end = (value) => { socket.destroy(); done(value); };
        socket.once('connect', () => end('taken'));
        socket.once('timeout', () => end('dropped'));
        socket.once('error', (error) => end(error.code === 'ECONNREFUSED' ? 'refused' : 'dropped'));
      });
      if (answer === 'refused') refused.push(host);
      if (answer === 'dropped') unproved.push(host);
    } catch { /* this address cannot hold a probe listener: not a candidate */ }
  }
  return { refused, unproved };
})();

test('memory service: MEMORYCTL_URL at an address that is not this machine faults on the closed route, with no local start command',
  async (t) => {
    const { refused } = await lanProof();
    if (!refused.length) {
      return t.skip('no non-loopback address of this machine refuses a connect to a free port, so this host cannot prove a closed route');
    }
    const lanAddress = refused[0];
    const f = fixture(t);
    const port = await closedPort(lanAddress);
    unlinkSync(join(f.state, 'service.url'));
    f.env.MEMORYCTL_URL = `http://${lanAddress}:${port}`;
    writeFileSync(join(f.state, 'launchd.label'), 'fixture.memoryd\n');
    writeFileSync(join(f.state, 'task.name'), 'FixtureMemory\n');
    const row = memoryRow(f, 1);
    assert.equal(row.state, 'fault');
    assert.ok(row.detail.includes(`the route to the memory service at http://${lanAddress}:${port} is closed`));
    assert.equal(row.nextCommand, undefined);
    assert.ok(row.nextStep.includes(`Restore the route to http://${lanAddress}:${port}`));
    assert.ok(!/fixture\.memoryd|FixtureMemory|install-memory/.test(JSON.stringify(row)));
  });

test('memory service: an address that drops the probe of its free port gives no proof, so the doctor answers not checked',
  async (t) => {
    const { unproved } = await lanProof();
    if (!unproved.length) {
      return t.skip('every non-loopback address of this machine refuses a connect to a free port, so no address gives the no-proof case');
    }
    const lanAddress = unproved[0];
    const f = fixture(t);
    const port = await closedPort(lanAddress);
    unlinkSync(join(f.state, 'service.url'));
    f.env.MEMORYCTL_URL = `http://${lanAddress}:${port}`;
    writeFileSync(join(f.state, 'launchd.label'), 'fixture.memoryd\n');
    const row = memoryRow(f, 0);
    assert.equal(row.state, 'not checked');
    assert.ok(row.reason.includes(`http://${lanAddress}:${port}`));
    assert.ok(row.reason.includes('its port gave no proof'));
  });

for (const holder of ['answers as another program', 'accepts and gives no answer']) {
  test(`memory service: a taken port (${holder}) faults with a step to free it, not to start the service`, async (t) => {
    const f = fixture(t);
    const { port } = await stubService(t, holder === 'accepts and gives no answer' ? { silent: true } : { body: { hello: 'other' } });
    unlinkSync(join(f.state, 'service.url'));
    f.env.MEMORYCTL_URL = `http://127.0.0.1:${port}`;
    writeFileSync(join(f.state, 'launchd.label'), 'fixture.memoryd\n');
    const row = memoryRow(f, 1);
    assert.equal(row.state, 'fault');
    assert.ok(row.detail.includes(`http://127.0.0.1:${port}`));
    assert.equal(row.nextCommand, undefined);
    assert.match(row.nextStep, freeStep(port));
    assert.ok(f.run().stdout.includes(`Next step: ${row.nextStep}`));
  });
}

test('memory service: an unreadable health answer or an unloadable client is not checked', async (t) => {
  const f = fixture(t);
  f.serviceUrl((await stubService(t, { body: { ok: false, service: 'memoryctl' } })).port);
  let row = memoryRow(f, 0);
  assert.equal(row.state, 'not checked');
  assert.ok(row.reason.includes('without ok: true'));
  unlinkSync(join(f.repo, 'scripts/memory/service-client.mjs'));
  row = memoryRow(f, 0);
  assert.equal(row.state, 'not checked');
  assert.ok(row.reason.includes("memory client's address"));
});

test('orch daemon: stopped with its port taken faults with a step to free it; a free port keeps the install command', async (t) => {
  const f = fixture(t);
  for (const rel of ['ops/orchestrator/src/config.ts', 'ops/orchestrator/package.json']) f.copy(rel);
  f.tool(orch, { running: false, stalePid: null }, 1);
  const { port } = await stubService(t, { body: { hello: 'other' } });
  f.env.ORCH_PORT = String(port);
  let row = rows(f.run(true), 1).find((row) => row.id === 'orch daemon');
  assert.equal(row.state, 'fault');
  assert.equal(row.nextCommand, undefined);
  assert.match(row.nextStep, freeStep(port));
  assert.ok(row.detail.includes(`holds its port ${port}`));
  f.env.ORCH_PORT = String(await closedPort());
  row = rows(f.run(true), 1).find((row) => row.id === 'orch daemon');
  assert.equal(row.detail, 'orch daemon is not running');
  assert.equal(row.nextCommand, 'node ops/orchestrator/install.mjs');
});

const noLsof = process.platform === 'win32' || Boolean(spawnSync('lsof', ['-v']).error);
test('orch daemon: alive and unanswered tells a different holder of its port from the daemon itself',
  { skip: noLsof && 'the holder of a port is identified with lsof' }, async (t) => {
    const f = fixture(t);
    const { port, pid } = await stubService(t, { silent: true });
    const orchRow = () => rows(f.run(true), f.status).find((row) => row.id === 'orch daemon');
    f.tool(orch, { running: true, healthUnanswered: true, pid: process.pid, port });
    f.status = 1;
    let row = orchRow();
    assert.equal(row.state, 'fault');
    assert.ok(row.detail.includes(`pid ${pid} holds its port ${port}`));
    assert.equal(row.nextCommand, undefined);
    assert.match(row.nextStep, freeStep(port));
    f.tool(orch, { running: true, healthUnanswered: true, pid, port });
    f.status = 0;
    row = orchRow();
    assert.equal(row.state, 'not checked');
    assert.ok(row.reason.includes(`it holds port ${port} itself`));
    f.tool(orch, { running: true, healthUnanswered: true, pid, port: await closedPort() });
    row = orchRow();
    assert.equal(row.state, 'not checked');
    assert.ok(row.reason.includes('was not identified'));
  });

test("a check's own budget outranks the doctor's: a slow tool is read to its end, and is cut without one", async (t) => {
  const f = fixture(t);
  f.write('slow.mjs', "await new Promise((done) => setTimeout(done, 500));\nconsole.log('done');");
  const { run } = await import(pathToFileURL(join(source, 'ops/bootstrap/doctor.mjs')).href);
  const check = {
    id: 'slow', file: join(f.repo, 'slow.mjs'), args: [], text: true,
    result: (stdout) => (stdout.includes('done') ? { id: 'slow', state: 'ok' } : null),
  };
  assert.equal(run({ ...check, timeoutMs: 5000 }, 100).state, 'ok');
  const cut = run(check, 100);
  assert.equal(cut.state, 'not checked');
  assert.ok(cut.reason.includes('ETIMEDOUT'));
});

test('a check that throws or rejects is one not checked row with its reason', async (t) => {
  const f = fixture(t);
  f.write('quick.mjs', "console.log('done');");
  const { run } = await import(pathToFileURL(join(source, 'ops/bootstrap/doctor.mjs')).href);
  const cases = {
    'run throws': { run() { throw new Error('boom in run'); } },
    'run rejects': { run: async () => { throw new Error('boom in run'); } },
    'result rejects': { file: join(f.repo, 'quick.mjs'), args: [], text: true, result: () => Promise.reject(new Error('boom in result')) },
  };
  for (const [id, check] of Object.entries(cases)) {
    const row = await run({ id, ...check });
    assert.equal(row.id, id);
    assert.equal(row.state, 'not checked');
    assert.ok(row.reason.includes(id.startsWith('run') ? 'boom in run' : 'boom in result'), row.reason);
  }
});

// A stub installer step for --fix: it heals this fixture's text tools by
// writing `<step>.installed`, records every run, and fails for named steps.
const installerStub = (f, failSteps = []) => f.write('ops/bootstrap/install-harness.mjs', `
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const step = process.argv[process.argv.indexOf('--only') + 1];
appendFileSync(join(${JSON.stringify('ROOT')}, 'fix.log'), step + '\\n');
if (${JSON.stringify(failSteps)}.includes(step)) process.exit(1);
writeFileSync(join(${JSON.stringify('ROOT')}, step + '.installed'), 'healed');`
  // The placeholder is replaced in its quoted form: a raw Windows path inside
  // a JS string literal loses its backslashes ('\U' is just U) and the stub dies.
  .replaceAll(JSON.stringify('ROOT'), JSON.stringify(f.repo)));

// A skills checker that faults until the stub installer healed its delivery.
const healingSkillsTool = (f) => f.write(skills, `
import { existsSync } from 'node:fs';
if (!existsSync(${JSON.stringify(join(f.repo, 'skills.installed'))})) {
  console.log(JSON.stringify({ report: [{ runtime: 'codex', bad: 1 }], retired: [], drift: [] }));
  process.exit(1);
}
console.log(JSON.stringify({ report: [{ runtime: 'codex', bad: 0 }], retired: [], drift: [] }));`);

// A text tool that faults (used for rows whose repair must not run).
const failingTextTool = (f, file) => f.write(file,
  "console.error('FAIL: delivery absent'); process.exit(1);");

test('--fix runs each safe repair once, in check order, then prints healed rows', (t) => {
  const f = fixture(t);
  installerStub(f);
  healingSkillsTool(f);
  const text = f.fix();
  assert.equal(text.status, 0, text.stderr || text.stdout);
  assert.ok(text.stdout.startsWith('fix: node ops/bootstrap/install-harness.mjs --only skills\n'));
  assert.ok(!text.stdout.includes('fix failed'));
  assert.ok(!text.stdout.includes('fix refused'));
  assert.ok(text.stdout.includes('skills: ok — '));
  assert.ok(!text.stdout.includes('Next command:'));
  assert.equal(readFileSync(join(f.repo, 'fix.log'), 'utf8'), 'skills\n');
});

test('--fix keeps going after a failed repair; the failure is one line with its exit', (t) => {
  const f = fixture(t);
  installerStub(f, ['skills']);
  healingSkillsTool(f);
  const text = f.fix();
  assert.equal(text.status, 1, text.stderr || text.stdout);
  assert.deepEqual(text.stdout.split('\n').slice(0, 2),
    ['fix: node ops/bootstrap/install-harness.mjs --only skills',
     'fix failed: exit 1']);
  assert.equal(text.stdout.split('\n').filter((l) => l.startsWith('fix failed')).length, 1);
  assert.ok(text.stdout.includes('skills: fault — '));
  assert.ok(text.stdout.endsWith('Next command: node ops/bootstrap/install-harness.mjs --only skills\n'));
  assert.equal(readFileSync(join(f.repo, 'fix.log'), 'utf8'), 'skills\n');
});

test('--fix never runs a login, a secret or a config change', (t) => {
  const f = fixture(t);
  f.logins(Object.fromEntries(HARNESS_FAMILIES.map((family) => [family, { state: 'missing', detail: 'no proof' }])));
  f.write('KIT-MANIFEST.json', JSON.stringify({ kit: 'harness-kit' }));
  for (const rel of ['ops/bootstrap/harness-secret.mjs', 'ops/bootstrap/harness-config.mjs']) {
    f.write(rel, `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(join(f.repo, 'fix.log'))}, ${JSON.stringify(rel)} + '\\n');`);
  }
  const config = join(f.repo, 'ops/bootstrap/harness.config.json');
  const before = readFileSync(config, 'utf8');
  const text = f.fix();
  assert.equal(text.status, 1, text.stderr || text.stdout);
  assert.ok(!text.stdout.includes('fix:'), text.stdout);
  assert.ok(!existsSync(join(f.repo, 'fix.log')), 'no never-safe command may run');
  assert.equal(readFileSync(config, 'utf8'), before);
  assert.ok(text.stdout.endsWith(`Next command: node ops/bootstrap/harness-config.mjs set install.userEntries '"keep"'\n`));
  for (const family of HARNESS_FAMILIES) assert.ok(text.stdout.includes(`logins/${family}: fault`));
});

test('--dry-run prints the repairs it would run and runs nothing', (t) => {
  const f = fixture(t);
  installerStub(f);
  healingSkillsTool(f);
  const text = f.fix(true);
  assert.equal(text.status, 1, text.stderr || text.stdout);
  assert.deepEqual(text.stdout.split('\n').filter((l) => l.startsWith('fix:')),
    ['fix: node ops/bootstrap/install-harness.mjs --only skills']);
  assert.ok(!text.stdout.includes('fix failed'));
  // Nothing ran: no installer log, no healed marker, and the fault stands.
  assert.ok(!existsSync(join(f.repo, 'fix.log')));
  assert.ok(!existsSync(join(f.repo, 'skills.installed')));
  assert.ok(text.stdout.includes('skills: fault — '));
});

test('the mcp repair is refused without keep: the row keeps its command and says why', (t) => {
  const f = fixture(t);
  installerStub(f);
  failingTextTool(f, 'scripts/check-mcp-delivery.mjs');
  const row = rows(f.run(true), 1).find((r) => r.id === 'mcp');
  assert.equal(row.fix.safe, false);
  assert.match(row.fix.why, /replace the user's own entries/);
  assert.equal(row.nextCommand, 'node ops/bootstrap/install-harness.mjs --only mcp');
  const text = f.fix();
  assert.equal(text.status, 1, text.stderr || text.stdout);
  assert.ok(!text.stdout.includes('fix: node ops/bootstrap/install-harness.mjs --only mcp'));
  assert.ok(!existsSync(join(f.repo, 'fix.log')), 'a refused repair must not run');
  assert.ok(text.stdout.includes('fix refused: node ops/bootstrap/install-harness.mjs --only mcp — '));
  assert.ok(text.stdout.includes(row.fix.why));
});

test('the mcp repair runs under install.userEntries=keep, and the hooks repair never does', (t) => {
  const f = fixture(t);
  f.write('ops/bootstrap/harness.config.json', JSON.stringify({ ...f.config, install: { userEntries: 'keep' } }));
  installerStub(f);
  failingTextTool(f, 'scripts/check-mcp-delivery.mjs');
  failingTextTool(f, 'scripts/check-hook-topology.mjs');
  let report = rows(f.run(true), 1);
  assert.equal(report.find((r) => r.id === 'mcp').fix.safe, true);
  assert.equal(report.find((r) => r.id === 'hooks').fix.safe, false);
  const text = f.fix();
  assert.ok(text.stdout.includes('fix: node ops/bootstrap/install-harness.mjs --only mcp\n'));
  assert.ok(!text.stdout.split('\n').some((l) => l.startsWith('fix: node ops/bootstrap/install-harness.mjs --only hooks')));
  assert.equal(readFileSync(join(f.repo, 'fix.log'), 'utf8'), 'mcp\n');
});

test('real skills installer step keeps a user-owned skill beside the harness links', (t) => {
  const f = fixture(t);
  for (const name of ['plan-before-code', 'memoryctl', 'premortem']) {
    f.write(`.agents/skills/${name}/SKILL.md`, '# Fixture skill\n');
  }
  f.write('.agents/domains/_skill-map.json', JSON.stringify({
    leadInstalledSkills: ['plan-before-code', 'memoryctl'], supportLeadSkills: [],
    skills: { 'plan-before-code': { class: 'core' }, memoryctl: { class: 'lead' }, premortem: { class: 'method' } },
  }));
  const userSkill = join(f.home, '.codex', 'skills', 'personal-notes', 'SKILL.md');
  mkdirSync(dirname(userSkill), { recursive: true });
  writeFileSync(userSkill, '# My own skill\n');
  const result = spawnSync(process.execPath, [join(source, 'ops/bootstrap/install-harness.mjs'),
    '--only', 'skills', '--repo', f.repo, '--home', f.home], { env: f.env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readFileSync(userSkill, 'utf8'), '# My own skill\n', 'the user-owned skill must survive');
  assert.ok(existsSync(join(f.home, '.codex', 'skills', 'memoryctl')), 'harness link installed');
});

test('real mcp installer step under keep keeps a user-owned MCP server', (t) => {
  const f = fixture(t);
  f.write('ops/bootstrap/harness.config.json', JSON.stringify({ ...f.config, install: { userEntries: 'keep' } }));
  f.write('ops/bootstrap/mcp-servers.json', JSON.stringify({ servers: {} }));
  for (const rel of ['ops/bootstrap/mcp-role-gate.mjs', 'ops/orchestrator/mcp-by-role.json']) f.copy(rel);
  const claude = join(f.home, '.claude.json');
  writeFileSync(claude, JSON.stringify({ mcpServers: { 'personal-mine': { command: 'personal-server', args: [] } } }));
  const result = spawnSync(process.execPath, [join(source, 'ops/bootstrap/install-harness.mjs'),
    '--only', 'mcp', '--repo', f.repo, '--home', f.home], { env: f.env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(readFileSync(claude, 'utf8')).mcpServers['personal-mine'],
    { command: 'personal-server', args: [] }, 'the user-owned server must survive');
});

test('a memory-install fault is healed by the memory installer itself', (t) => {
  const f = fixture(t);
  f.write(memory, `import { existsSync, writeFileSync } from 'node:fs';
const marker = ${JSON.stringify(join(f.repo, 'memory.installed'))};
if (process.argv.includes('--check')) {
  if (existsSync(marker)) console.log(JSON.stringify({ ok: true, mode: 'check', targets: [] }));
  else { console.log(JSON.stringify({ ok: false, mode: 'check', targets: [{ what: 'client', was: 'absent' }] })); process.exitCode = 1; }
} else { writeFileSync(marker, 'installed'); console.log(JSON.stringify({ ok: true, mode: 'install', installed: 1, targets: [] })); }`);
  const report = rows(f.run(true), 1);
  assert.equal(report[1].state, 'fault');
  assert.equal(report[1].fix.safe, true);
  assert.deepEqual(report[1].fix.argv.slice(1), ['ops/bootstrap/install-memory.mjs']);
  const text = f.fix();
  assert.equal(text.status, 0, text.stdout);
  assert.ok(text.stdout.startsWith('fix: node ops/bootstrap/install-memory.mjs\n'));
  assert.ok(text.stdout.includes('memory install: ok — '));
});

test('an orch-daemon fault is repaired by the orch installer script', (t) => {
  const f = fixture(t);
  f.tool(orch, { running: false, stalePid: null }, 1);
  f.write('ops/orchestrator/install.mjs', `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(join(f.repo, 'fix.log'))}, 'orch\\n');`);
  const text = f.fix();
  assert.equal(text.status, 1, text.stderr || text.stdout);
  assert.ok(text.stdout.includes('fix: node ops/orchestrator/install.mjs\n'));
  assert.equal(readFileSync(join(f.repo, 'fix.log'), 'utf8'), 'orch\n');
  assert.ok(text.stdout.includes('orch daemon: fault — '));
});

test('two faults that name one command run it once', async (t) => {
  const f = fixture(t);
  f.write(memory, `import { appendFileSync } from 'node:fs';
if (!process.argv.includes('--check')) { appendFileSync(${JSON.stringify(join(f.repo, 'fix.log'))}, 'install\\n'); process.exit(0); }
console.log(JSON.stringify({ ok: false, mode: 'check', targets: [{ what: 'client', was: 'absent' }] })); process.exitCode = 1;`);
  const port = await closedPort();
  unlinkSync(join(f.state, 'service.url'));
  f.env.MEMORYCTL_URL = `http://127.0.0.1:${port}`;
  const text = f.fix();
  assert.equal(text.status, 1, text.stderr || text.stdout);
  assert.deepEqual(text.stdout.split('\n').filter((l) => l.startsWith('fix:')),
    ['fix: node ops/bootstrap/install-memory.mjs']);
  assert.equal(readFileSync(join(f.repo, 'fix.log'), 'utf8'), 'install\n');
});

test('a stopped memory service on darwin carries its kickstart as safe argv data',
  { skip: process.platform !== 'darwin' && 'the kickstart repair exists on darwin only' }, async (t) => {
    const f = fixture(t);
    const port = await closedPort();
    unlinkSync(join(f.state, 'service.url'));
    f.env.MEMORYCTL_URL = `http://127.0.0.1:${port}`;
    writeFileSync(join(f.state, 'launchd.label'), 'fixture.memoryd\n');
    const row = memoryRow(f, 1);
    assert.equal(row.fix.safe, true);
    assert.deepEqual(row.fix.argv, ['launchctl', 'kickstart', '-k', `gui/${process.getuid()}/fixture.memoryd`]);
    assert.equal(row.nextCommand, 'launchctl kickstart -k gui/$(id -u)/fixture.memoryd');
  });

test('--fix --json reports a successful repair as ran and the healed rows', (t) => {
  const f = fixture(t);
  installerStub(f);
  healingSkillsTool(f);
  const result = f.fix(false, true);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(report).sort(), ['fixes', 'rows']);
  assert.deepEqual(report.fixes, [{ command: installer, state: 'ran', detail: '' }]);
  assert.equal(report.rows.length, rowCount);
  assert.equal(report.rows[2].state, 'ok');
  assert.equal(readFileSync(join(f.repo, 'fix.log'), 'utf8'), 'skills\n');
});

test('--fix --json reports a failed repair as failed with the text reason', (t) => {
  const f = fixture(t);
  installerStub(f, ['skills']);
  healingSkillsTool(f);
  const result = f.fix(false, true);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixes, [{ command: installer, state: 'failed', detail: 'exit 1' }]);
  assert.equal(report.rows[2].state, 'fault');
});

test('--fix --json reports a refused repair with its why', (t) => {
  const f = fixture(t);
  installerStub(f);
  failingTextTool(f, 'scripts/check-mcp-delivery.mjs');
  const row = rows(f.run(true), 1).find((r) => r.id === 'mcp');
  const result = f.fix(false, true);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixes, [{ command: 'node ops/bootstrap/install-harness.mjs --only mcp', state: 'refused', detail: row.fix.why }]);
  assert.ok(!existsSync(join(f.repo, 'fix.log')), 'a refused repair must not run');
});

test('--fix --dry-run --json reports planned repairs and runs nothing', (t) => {
  const f = fixture(t);
  installerStub(f);
  healingSkillsTool(f);
  const result = f.fix(true, true);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixes, [{ command: installer, state: 'planned', detail: '' }]);
  assert.equal(report.rows[2].state, 'fault');
  assert.ok(!existsSync(join(f.repo, 'fix.log')));
  assert.ok(!existsSync(join(f.repo, 'skills.installed')));
});

test('plain --json prints the rows array byte-identically, unwrapped', (t) => {
  const f = fixture(t);
  const plain = f.run(true).stdout;
  const report = JSON.parse(plain);
  assert.ok(Array.isArray(report), 'plain --json is the rows array, not a {fixes,rows} wrapper');
  assert.equal(plain, `${JSON.stringify(report, null, 2)}\n`);
  assert.equal(fixture(t).run(true).stdout, plain, 'a second run prints the same bytes');
});

test('--fix --json: two faults that name one command produce one fixes entry and one run', async (t) => {
  const f = fixture(t);
  f.write(memory, `import { appendFileSync } from 'node:fs';
if (!process.argv.includes('--check')) { appendFileSync(${JSON.stringify(join(f.repo, 'fix.log'))}, 'install\\n'); process.exit(0); }
console.log(JSON.stringify({ ok: false, mode: 'check', targets: [{ what: 'client', was: 'absent' }] })); process.exitCode = 1;`);
  const port = await closedPort();
  unlinkSync(join(f.state, 'service.url'));
  f.env.MEMORYCTL_URL = `http://127.0.0.1:${port}`;
  const result = f.fix(false, true);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixes, [{ command: 'node ops/bootstrap/install-memory.mjs', state: 'ran', detail: '' }]);
  assert.equal(readFileSync(join(f.repo, 'fix.log'), 'utf8'), 'install\n');
});

test('--fix --json keeps a repair child that prints out of the JSON document', (t) => {
  const f = fixture(t);
  f.write('ops/bootstrap/install-harness.mjs', `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
console.log('child stdout line');
console.error('child stderr line');
writeFileSync(join(${JSON.stringify('ROOT')}, 'skills.installed'), 'healed');`
  .replaceAll(JSON.stringify('ROOT'), JSON.stringify(f.repo)));
  healingSkillsTool(f);
  const result = f.fix(false, true);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout); // fails if any child line reached stdout
  assert.equal(result.stderr, '');
  assert.deepEqual(Object.keys(report).sort(), ['fixes', 'rows']);
  assert.deepEqual(report.fixes, [{ command: installer, state: 'ran', detail: '' }]);
  assert.equal(report.rows[2].state, 'ok');
});

test('unknown or mixed arguments are refused without starting checks', (t) => {
  const f = fixture(t);
  f.write(memory, "throw new Error('must not run');");
  for (const argv of [['--wat'], ['--json', '--json'], ['--dry-run'], ['--fix', '--fix'], ['--fix', '--dry-run', '--dry-run'], ['--fix', '--json', '--wat']]) {
    const result = spawnSync(process.execPath, [join(f.repo, 'ops/bootstrap/doctor.mjs'), ...argv],
      { env: f.env, encoding: 'utf8' });
    assert.equal(result.status, 2, argv.join(' '));
    assert.equal(result.stdout, '', argv.join(' '));
    assert.match(result.stderr, /^usage: node ops\/bootstrap\/doctor\.mjs \[--json\] \| \[--fix \[--dry-run\] \[--json\]\]/);
    assert.ok(!result.stderr.includes('must not run'), argv.join(' '));
  }
});
