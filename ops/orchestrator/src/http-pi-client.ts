// Task 3536 slice B: the Pi client routes behind the loopback surface. No UI and no MCP tool:
// GET reports one machine's runtime state, check records npm's dist-tags.latest, update and
// rollback run `ops/orchestrator/pi-client-job.mjs` on the machine via the managed check
// transport (remote-repo.ts runCheckCommand). POSTs refuse a foreign Origin exactly like the
// chat receipts (http.ts): X-Orch-Chat: 1 and no Origin or the daemon origin.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { readHost, readHosts } from './config.ts';
import { runCheckCommand } from './remote-repo.ts';
import { hostOf, readJson, sendJson } from './http-leads.ts';
import { piChildEnv, piPinVersion, probePiInstall, readLocalPiInstall, resolvePiInstall, resolveCommand, redactPiSecrets, type PiInstallFacts } from './providers/index.ts';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export type PiClientRuntime = { stateDir: string; port: () => number };
type Route = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const VERSION = /^\d+\.\d+\.\d+$/;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const JOB = path.join('ops', 'orchestrator', 'pi-client-job.mjs');

/** The last check's answer (task 3536): an update's version must equal it. In-memory on
 *  purpose — a restarted daemon refuses updates until a fresh check answers. */
let lastCheck: { version: string; at: number } | null = null;

function machineOf(value: unknown): { machine: string; repo: string; platform: NodeJS.Platform } {
  const name = typeof value === 'string' ? value : 'local';
  if (name === 'local') return { machine: 'local', repo: REPO, platform: process.platform };
  const hosts = readHosts();
  if (!Object.hasOwn(hosts, name)) throw new Error(`machine must be local or a hosts.json name: ${JSON.stringify(name)}`);
  const host = readHost(name);
  return { machine: name, repo: host.repo, platform: host.platform };
}

async function machineState(machine: string, repo: string, platform: NodeJS.Platform) {
  let facts: PiInstallFacts;
  if (machine === 'local') facts = readLocalPiInstall(repo, platform);
  else facts = await probePiInstall(machine, repo, platform);
  let record: unknown = null;
  try { record = facts.current == null ? null : JSON.parse(String(facts.current)); } catch { record = String(facts.current); }
  let pin: string | null = null;
  let resolved: { command: string; status: string | null } | { error: string };
  try {
    pin = piPinVersion(repo);
    resolved = resolvePiInstall({ machine, pin, repo, platform, facts });
  } catch (error) {
    resolved = { error: (error as Error).message };
  }
  let versions: string[] | null = null;
  if (machine === 'local') {
    try {
      versions = fs.readdirSync(path.join(repo, 'ops', 'pi-runtime', 'versions'))
        .filter((entry) => VERSION.test(entry)).sort();
    } catch { versions = []; }
  }
  return { machine, repo, platform, pin, record, resolved, versions, lastCheck };
}

function npmLatest(): Promise<string> {
  return new Promise((resolve, reject) => {
    // win32: a .cmd shim must go through the shared resolver (spawn EINVAL otherwise).
    // Slice B correction 2 (CWE-532): the check child gets the shared tool-child allowlist
    // (piChildEnv, install set: registry/proxy/TLS configuration admitted) — a credential
    // the daemon carries can neither reach the child nor be echoed back into the answer.
    const npm = resolveCommand('npm');
    const child = spawn(npm.file, [...npm.args, 'view', PI_PACKAGE, 'dist-tags.latest'], { cwd: REPO, env: piChildEnv(process.env, {}, true), windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('npm view dist-tags.latest timed out after 60 s')); }, 60_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      const version = out.trim().split(/\r?\n/).at(-1) ?? '';
      // Task 3536 slice B correction: redact BEFORE the keep-last-300 slice — a cut landing
      // inside a credential would leave its raw suffix beyond what later redaction can match.
      if (code !== 0) return reject(new Error(`npm view dist-tags.latest failed (${code}): ${redactPiSecrets((err || out).trim()).slice(-300)}`));
      if (!VERSION.test(version)) return reject(new Error(`npm dist-tags.latest is unreadable: ${JSON.stringify(version.slice(0, 120))}`));
      resolve(version);
    });
  });
}

function sink(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  return { stream: new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }), text: () => Buffer.concat(chunks).toString('utf8') };
}

async function runJob(mode: 'update' | 'rollback', machine: string, repo: string, version?: string) {
  const out = sink(), err = sink();
  const code = await runCheckCommand(machine === 'local' ? undefined : machine, repo,
    ['node', JOB, mode, ...(version ? [version] : [])], out.stream, err.stream);
  const log = `${out.text()}\n${err.text()}`.trim();
  const summaryLine = out.text().trim().split(/\r?\n/).filter((line) => line.startsWith('pi-client: {')).at(-1);
  let summary: unknown = null;
  try { summary = JSON.parse(summaryLine ? summaryLine.slice('pi-client: '.length) : ''); } catch { summary = null; }
  // Redact before the keep-last-2000 slice: a cut inside a credential would leak its raw
  // suffix past what the route's redactAnswer could still match.
  return { ok: code === 0, exitCode: code, summary, tail: redactPiSecrets(log).slice(-2000) };
}

/** Task 3536 test seam (`piClientJobRunner`): the single place a request can start a machine
 *  job. Route tests replace `run` to prove which requests start one — and that every refusal
 *  starts none. */
export const piClientJobRunner: { run: typeof runJob } = { run: runJob };

type Body = Record<string, unknown>;

/** Task 3536 slice B review: a job's child stderr or npm error can echo a credential this
 *  machine carries; every string in an answer is scrubbed at the boundary, not at each producer. */
function redactAnswer(value: unknown): unknown {
  if (typeof value === 'string') return redactPiSecrets(value);
  if (Array.isArray(value)) return value.map(redactAnswer);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactAnswer(item)]));
  return value;
}

async function readBody(req: IncomingMessage, bodyKeys: readonly string[]): Promise<Body> {
  const raw = await readJson(req, 4096);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('body must be a JSON object');
  const body = raw as Body;
  for (const key of Object.keys(body)) if (!bodyKeys.includes(key)) throw new Error(`pi-client route takes no '${key}'`);
  return body;
}

async function checkAction(): Promise<unknown> {
  const version = await npmLatest();
  lastCheck = { version, at: Date.now() };
  return { version };
}

async function updateAction(machine: string, repo: string, body: Body): Promise<unknown> {
  const version = body.version;
  if (typeof version !== 'string' || !VERSION.test(version)) throw new Error(`version must match ^\\d+\\.\\d+\\.\\d+$: ${JSON.stringify(version)}`);
  if (!lastCheck || version !== lastCheck.version) throw new Error(`version must equal the last check's answer (${lastCheck?.version ?? 'no check ran yet'})`);
  return { machine, version, ...(await piClientJobRunner.run('update', machine, repo, version)) };
}

async function rollbackAction(machine: string, repo: string): Promise<unknown> {
  return { machine, ...(await piClientJobRunner.run('rollback', machine, repo)) };
}

async function action(req: IncomingMessage, url: URL, bodyKeys: readonly string[]): Promise<unknown> {
  const body = await readBody(req, bodyKeys);
  if (url.pathname === '/api/pi-client/check') return await checkAction();
  const { machine, repo } = machineOf(body.machine);
  if (url.pathname === '/api/pi-client/update') return await updateAction(machine, repo, body);
  if (url.pathname === '/api/pi-client/rollback') return await rollbackAction(machine, repo);
  throw new Error('unknown pi-client route');
}

const POST_ROUTES = ['/api/pi-client/check', '/api/pi-client/update', '/api/pi-client/rollback'];

function postAllowed(rt: PiClientRuntime, req: IncomingMessage): boolean {
  // Hooks and CLI callers have no Origin; browser callers must use this daemon's exact
  // origin. The custom header requires a preflight, which this server never grants.
  const ownOrigin = new URL(`http://${hostOf(req.headers.host!)}:${rt.port()}`).origin;
  return req.headers['x-orch-chat'] === '1' &&
    (req.headers.origin === undefined || req.headers.origin === ownOrigin);
}

async function handlePost(rt: PiClientRuntime, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!postAllowed(rt, req)) {
    sendJson(res, 403, { error: 'pi-client writes require X-Orch-Chat: 1 and no Origin or the daemon origin' });
    return;
  }
  res.setTimeout(0);
  const keys = url.pathname === '/api/pi-client/check' ? [] : url.pathname === '/api/pi-client/update' ? ['machine', 'version'] : ['machine'];
  sendJson(res, 200, redactAnswer(await action(req, url, keys)));
}

async function servePiClient(rt: PiClientRuntime, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/pi-client' && !url.pathname.startsWith('/api/pi-client/')) return false;
  try {
    if (req.method === 'GET' && url.pathname === '/api/pi-client') {
      const { machine, repo, platform } = machineOf(url.searchParams.get('machine'));
      sendJson(res, 200, await machineState(machine, repo, platform));
      return true;
    }
    if (req.method === 'POST' && POST_ROUTES.includes(url.pathname)) {
      await handlePost(rt, req, res, url);
      return true;
    }
    sendJson(res, 404, { error: 'unknown pi-client route or method' });
    return true;
  } catch (error) {
    sendJson(res, 400, { error: redactPiSecrets((error as Error).message) });
    return true;
  }
}
/** One route-pipeline mount, without adding branches to createHttpServer. */
export function withPiClientRoutes(rt: PiClientRuntime, next: Route): Route {
  return async (req, res, url) => await servePiClient(rt, req, res, url) || next(req, res, url);
}
