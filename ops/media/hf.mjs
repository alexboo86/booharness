#!/usr/bin/env node
// Operator-credit boundary, not protection against a deliberate same-user bypass.
import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync,
  closeSync, renameSync, unlinkSync, rmdirSync,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

class Refusal extends Error {}
const refuse = message => { throw new Refusal(message); };
const home = process.env.HOME;
if (!home || !isAbsolute(home)) {
  console.error('hf: HOME must be an absolute directory');
  process.exit(1);
}
const state = join(home, '.local/state/orch');
const ledger = join(state, 'higgsfield-ledger.jsonl');
const ceilings = join(state, 'higgsfield-ceilings.json');
const lock = join(state, 'higgsfield.lock');
const cli = process.env.ORCH_HIGGSFIELD_BIN || '/opt/homebrew/bin/higgsfield';
const childEnv = { ...process.env, HOME: join(state, 'higgsfield-home') };
const role = process.env.SEAT_POLICY_ROLE;
const seat = process.env.ORCH_SEAT_ID;
const isSeat = role !== undefined || seat !== undefined;
const args = process.argv.slice(2);
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function readOptional(file, absent) {
  try { return readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return absent;
    throw error;
  }
}

function readCeilings() {
  const result = JSON.parse(readOptional(ceilings, '{}'));
  if (!object(result) || !Object.values(result).every(numeric)) refuse('invalid ceilings file');
  return result;
}

function durableWrite(file, content, flags) {
  const fd = openSync(file, flags, 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function append(row) {
  durableWrite(ledger, `${JSON.stringify(row)}\n`, 'a');
}

async function locked(action) {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') refuse('higgsfield.lock exists; busy or interrupted operation (lead must inspect)');
    throw error;
  }
  try { return await action(); }
  finally { rmdirSync(lock); }
}

function setCeiling() {
  if (args.length !== 3 || !args[1]?.trim() || !args[2]?.trim()) refuse('usage: --set-ceiling <seat> <credits>');
  const credits = Number(args[2]);
  if (!numeric(credits)) refuse('ceiling must be a finite non-negative number');
  const values = readCeilings();
  Object.defineProperty(values, args[1], { value: credits, enumerable: true, configurable: true });
  const temp = `${ceilings}.${randomUUID()}.tmp`;
  try {
    durableWrite(temp, `${JSON.stringify(values)}\n`, 'wx');
    renameSync(temp, ceilings);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  return { code: 0 };
}

function authorize() {
  if (!isSeat) return;
  if (!['designer', 'motion'].includes(role)) refuse('only designer and motion seats may use Higgsfield');
  const allowed = {
    model: ['list', 'get'],
    generate: ['cost', 'get', 'wait', 'list', 'create'],
  };
  if (['preset', 'account'].includes(args[0])) return;
  if (!allowed[args[0]]?.includes(args[1])) refuse('verb not permitted for seats');
}

// Only create needs a tee to record IDs; ordinary calls inherit all three fds.
function run(argv, mode = 'inherit') {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, argv, {
      env: childEnv,
      stdio: ['inherit', mode === 'inherit' ? 'inherit' : 'pipe', 'inherit'],
    });
    let output = '';
    let oversized = false;
    child.stdout?.on('data', chunk => {
      if (mode === 'tee') process.stdout.write(chunk);
      if (output.length + chunk.length <= 1024 * 1024) output += chunk.toString();
      else oversized = true;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, output, oversized }));
  });
}

function reservationCost(row) {
  if (!object(row) || !['reserve', 'job'].includes(row.type)) refuse('invalid ledger row');
  if (row.type === 'job') return 0;
  if (!row.seat || !numeric(row.cost)) refuse('invalid reservation');
  return row.seat === seat ? row.cost : 0;
}

function readSpend() {
  const text = readOptional(ledger, '');
  if (text && !text.endsWith('\n')) refuse('incomplete ledger; lead must inspect');
  let spend = 0;
  for (const line of text.split('\n').filter(Boolean)) {
    spend += reservationCost(JSON.parse(line));
  }
  if (!numeric(spend)) refuse('invalid accumulated spend');
  return spend;
}

async function estimate() {
  const result = await run(['generate', 'cost', ...args.slice(2), '--json'], 'capture');
  if (result.code !== 0 || result.oversized) refuse('cost estimation failed; create refused');
  let cost;
  try { cost = JSON.parse(result.output).credits; }
  catch { refuse('cost estimate has no numeric credits; create refused'); }
  if (!numeric(cost)) refuse('cost estimate has no numeric credits; create refused');
  return cost;
}

function jobIds(output) {
  // Human output prints UUIDs; --json may instead return job_id / job_ids.
  try {
    const data = JSON.parse(output);
    const ids = data.job_ids ?? [data.job_id ?? data.id];
    if (Array.isArray(ids) && ids.length && ids.every(id => typeof id === 'string' && id.length > 0)) return ids;
  } catch { /* Human-readable output is not JSON. */ }
  return [...new Set(output.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) ?? [])];
}

function createModel() {
  if (!seat?.trim()) refuse('generate create requires ORCH_SEAT_ID');
  const model = args[2];
  if (!model || model.startsWith('-')) refuse('generate create requires a positional model');
  return model;
}

async function create() {
  const model = createModel();
  const limits = readCeilings();
  if (!Object.hasOwn(limits, seat)) refuse('no ceiling for this seat');
  const spend = readSpend();
  const cost = await estimate();
  if (!numeric(spend + cost) || spend + cost > limits[seat]) refuse('seat credit ceiling exceeded');
  const reservation = randomUUID();
  append({ type: 'reserve', reservation, seat, role, ts: new Date().toISOString(), model, cost });
  const result = await run(args, 'tee');
  const ids = jobIds(result.output);
  append({ type: 'job', reservation, seat, role, ts: new Date().toISOString(), model,
    jobIds: ids, exitCode: result.code, signal: result.signal });
  if (result.code === 0 && (result.oversized || !ids.length)) {
    console.error('hf: warning: create returned no readable job ID; reservation retained, lead must inspect');
  }
  return result;
}

async function main() {
  if (existsSync(join(home, '.config/higgsfield/credentials.json'))) {
    console.error('hf: warning: legacy Higgsfield credentials exist; lead must move the session to higgsfield-home');
  }
  if (!isAbsolute(cli)) refuse('ORCH_HIGGSFIELD_BIN must be an absolute executable path');
  authorize();
  if (args[0] === '--set-ceiling') return locked(setCeiling);
  if (isSeat && args[0] === 'generate' && args[1] === 'create') return locked(create);
  return run(args);
}

try {
  const result = await main();
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code;
} catch (error) {
  console.error(`hf: ${error instanceof Refusal ? error.message : 'operation failed; no further work attempted (lead must inspect state)'}`);
  process.exitCode = 1;
}
