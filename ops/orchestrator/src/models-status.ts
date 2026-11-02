import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { checkLogin, keyLogin, loadFamilyLogins, writeLoginSecrets } from '../../../scripts/lib/family-logins.mjs';
import { readHosts, stateDirFor, type RemoteHost } from './config.ts';
import { leadWriteAllowed, readJson, sendJson } from './http-leads.ts';
import { spawnHost } from './providers/spawn.ts';
import { ROLE_CATALOGUE } from './role-policy.ts';

const DEADLINE_MS = 25_000;
const OUTPUT_LIMIT = 128 * 1024;
const LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok', glm: 'GLM', kimi: 'Kimi', opencode: 'OpenCode', qwen: 'Qwen', mimo: 'MiMo', jev: 'Jev' };
const DETAILS = {
  'signed-in': 'Credential is present and valid.', expired: 'Credential has expired.',
  missing: 'No usable credential found.', unknown: 'Credential could not be read or verified.',
};
const REMOTE_FAILURES = ['Host command could not start.', 'Host command timed out.', 'Host command output exceeded the limit.', 'Host is unreachable (SSH exit 255).', 'Host command failed.', 'Host returned an invalid status.'] as const;
type Status = keyof typeof DETAILS;
type Quota = { status: 'known'; checkedAt: string; readings: { window: string; used: number; resetsAt: string | null }[] } | { status: 'unknown'; detail: string };
type Machine = { host: string; status: Status; checkedAt: string; detail: string; quota?: Quota };
type Command = { families: string[]; key?: string; quota?: boolean };
type Context = { stateDir: string; port: () => number };

function unknown(host: string, detail = DETAILS.unknown): Machine {
  return { host, status: 'unknown', checkedAt: new Date().toISOString(), detail };
}

/** Collect without ever retaining stderr or putting child errors into a response/log. */
function collect(child: ChildProcessWithoutNullStreams, input: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    let failure: string | undefined;
    const stop = (reason: string) => {
      failure ??= reason;
      child.kill('SIGKILL');
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => stop(REMOTE_FAILURES[1]), DEADLINE_MS);
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) stop(REMOTE_FAILURES[2]);
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) stop(REMOTE_FAILURES[2]);
    });
    child.once('error', () => { failure = REMOTE_FAILURES[0]; });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure || code !== 0) {
        reject(new Error(failure ?? (code === 255 ? REMOTE_FAILURES[3] : REMOTE_FAILURES[4])));
        return;
      }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error(REMOTE_FAILURES[5])); }
    });
    child.stdin.end(input);
  });
}

/** Only numeric usage and recognized window/date fields leave the credential-reading child. */
function quotaReading(row: Record<string, unknown>) {
  if (!row || typeof row.window !== 'string' || !/^(?:\d+(?:m|h|d|month)|month|period|window)(?:·[\p{L}\p{N} ._-]{1,40})?$/u.test(row.window)) throw new Error('Invalid quota window.');
  if (typeof row.used !== 'number' || !Number.isFinite(row.used)) throw new Error('Invalid quota usage.');
  const reset = row.resetsAt == null ? null : Date.parse(String(row.resetsAt));
  if (reset !== null && !Number.isFinite(reset)) throw new Error('Invalid quota reset.');
  return { window: row.window, used: row.used, resetsAt: reset === null ? null : new Date(reset).toISOString() };
}

function quotaProjection(value: unknown): Quota {
  const bad: Quota = { status: 'unknown', detail: 'Live quota could not be read or verified.' };
  if (!value || typeof value !== 'object') return bad;
  const readings = (value as { readings?: unknown }).readings;
  if (!Array.isArray(readings) || !readings.length || readings.length > 32) return bad;
  try { return { status: 'known', checkedAt: new Date().toISOString(), readings: readings.map(quotaReading) }; }
  catch { return bad; }
}

async function liveQuota(family: string): Promise<Quota> {
  try {
    // A child bounds even native Keychain/cookie readers; no credential is in argv.
    const script = `import { readFamilyUsage } from ${JSON.stringify(new URL('../../usage-snapshot.mjs', import.meta.url).href)};\ntry { console.log(JSON.stringify(await readFamilyUsage(${JSON.stringify(family)}))); } catch { process.exitCode = 1; }`;
    const child = spawn(process.execPath, ['--input-type=module'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    return quotaProjection(await collect(child, script));
  } catch { return { status: 'unknown', detail: 'Live quota could not be read or verified.' }; }
}

/** Local service and remote Node entry share the canonical login checker and secret writer. */
export async function readModelsOnMachine(command: Command, stateDir = stateDirFor(homedir())): Promise<Machine[]> {
  const options = { home: homedir(), orchStateDir: stateDir };
  if (command.key !== undefined) {
    const login = keyLogin(command.families[0]);
    if (!('entries' in login) || login.entries.length !== 1) throw new Error('Key write refused.');
    try { writeLoginSecrets(command.families[0], { ...options, values: { [login.entries[0]]: command.key } }); }
    catch { throw new Error('Key write refused.'); }
  }
  return Promise.all(command.families.map(async (family) => {
    let machine: Machine;
    try {
      const result = checkLogin(family, options);
      const status: Status = result.state === 'ok' ? 'signed-in' : result.state;
      machine = { host: 'mac', status, checkedAt: new Date().toISOString(), detail: DETAILS[status] };
    } catch { machine = unknown('mac'); }
    if (command.quota && family !== 'jev') machine.quota = await liveQuota(family);
    return machine;
  }));
}

function machineProjection(value: unknown, host: string): Machine {
  if (!value || typeof value !== 'object') return unknown(host, REMOTE_FAILURES[5]);
  const row = value as Machine;
  if (!Object.hasOwn(DETAILS, row.status)) return unknown(host, REMOTE_FAILURES[5]);
  const machine: Machine = { host, status: row.status, checkedAt: new Date().toISOString(), detail: DETAILS[row.status] };
  if (row.quota) machine.quota = quotaProjection(row.quota);
  return machine;
}

async function onRemote(host: string, config: RemoteHost, command: Command): Promise<Machine[]> {
  try {
    const p = config.platform === 'win32' ? path.win32 : path.posix;
    const modulePath = p.join(config.repo, 'ops/orchestrator/src/models-status.ts');
    // Code and payload go over encrypted stdin, not argv. No shell interpolation of a key.
    const script = `import { pathToFileURL } from 'node:url';\ntry { const { readModelsOnMachine } = await import(pathToFileURL(${JSON.stringify(modulePath)})); console.log(JSON.stringify(await readModelsOnMachine(${JSON.stringify(command)}))); } catch { process.exitCode = 1; }`;
    // The facade routes by the host entry's transport: managed ssh or the paired agent exec stream.
    const child = spawnHost({ entry: config, kind: 'bootstrap', command: config.node, args: ['--input-type=module'], cwd: config.repo, stdin: 'pipe', ownGroup: true });
    const rows = await collect(child, script);
    if (!Array.isArray(rows) || rows.length !== command.families.length) throw new Error(REMOTE_FAILURES[5]);
    return rows.map((row) => machineProjection(row, host));
  } catch (error) {
    const message = (error as Error).message;
    const reason = REMOTE_FAILURES.find((item) => item === message) ?? REMOTE_FAILURES[0];
    return command.families.map(() => unknown(host, reason));
  }
}

async function listModels(ctx: Context) {
  const logins = loadFamilyLogins();
  const families = Object.keys(logins);
  const hosts = readHosts(ctx.stateDir);
  const machines = await Promise.all([
    readModelsOnMachine({ families }, ctx.stateDir),
    ...Object.entries(hosts).map(([name, host]) => onRemote(name, host, { families })),
  ]);
  return families.map((family, index) => ({ family, kind: logins[family].login.kind, label: LABELS[family], machines: machines.map((rows) => rows[index]) }));
}

const EFFORT_ORDER = ['low', 'medium', 'high', 'max'];

/** Role matrix, appearance-ordered: family -> model -> effort ids any role names. */
function catalogMatrix(): Map<string, Map<string, Set<string>>> {
  const matrix = new Map<string, Map<string, Set<string>>>();
  for (const entry of ROLE_CATALOGUE) {
    for (const [family, cell] of Object.entries(entry.models)) {
      let byModel = matrix.get(family);
      if (byModel === undefined) matrix.set(family, byModel = new Map());
      let efforts = byModel.get(cell.model);
      if (efforts === undefined) byModel.set(cell.model, efforts = new Set());
      if (cell.effort !== null) efforts.add(cell.effort);
    }
  }
  return matrix;
}

function catalogModel(model: string, efforts: Set<string>) {
  return {
    id: model,
    name: model,
    ...(efforts.size === 0 ? {} : { reasoning: { efforts: [...efforts]
      .sort((a, b) => (EFFORT_ORDER.indexOf(a) + 1 || EFFORT_ORDER.length) - (EFFORT_ORDER.indexOf(b) + 1 || EFFORT_ORDER.length))
      .map((id) => ({ id, name: id })) } }),
  };
}

/** The matrix's first row: a wire default the selector never displays. */
function catalogDefault() {
  const first = ROLE_CATALOGUE[0]?.models === undefined ? undefined : Object.entries(ROLE_CATALOGUE[0].models)[0];
  if (first === undefined) throw new Error('The role catalogue names no model.');
  const [family, cell] = first;
  return { provider: family, model: cell.model, ...(cell.effort === null ? {} : { reasoningEffort: cell.effort }) };
}

/** GET /api/models/catalog (task 3459 M1.3): the model selector's list over orch's real
 *  data — the role matrix's family/model rows for families some machine is signed in for,
 *  plus one failure row per family nothing is signed in for. Never a hardcoded list.
 *  `default` is the matrix's first row: the wire needs a default and orch names none (a pi
 *  start must name its family, L0c), and the selector never displays it — a session with no
 *  lead resolves no model-selection projection and shows its own empty state. */
async function listCatalog(ctx: Context) {
  const rows = await listModels(ctx);
  const state = new Map(rows.map((row) => [row.family, row]));
  const connected = (family: string): boolean => (state.get(family)?.machines ?? []).some((machine) => machine.status === 'signed-in');
  const matrix = catalogMatrix();
  const families = [...new Set([...matrix.keys(), ...state.keys()])];
  const groups = families.filter(connected).map((family) => ({
    id: family,
    name: LABELS[family] ?? family,
    models: [...(matrix.get(family) ?? new Map<string, Set<string>>())].map(([model, efforts]) => catalogModel(model, efforts)),
  }));
  const failures = families.filter((family) => !connected(family)).map((family) => {
    const machine = state.get(family)?.machines[0];
    return {
      id: family,
      name: LABELS[family] ?? family,
      message: machine === undefined ? 'No login is configured for this family.' : `${machine.host}: ${machine.detail}`,
    };
  });
  return { default: catalogDefault(), groups, failures };
}

function objectBody(raw: unknown, action: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid models request.');
  const body = raw as Record<string, unknown>;
  const allowed = action === 'key' ? ['host', 'key'] : ['host'];
  if (Object.keys(body).some((name) => !allowed.includes(name))) throw new Error('Invalid models request.');
  return body;
}

async function postModel(ctx: Context, req: IncomingMessage, family: string, action: string): Promise<Machine> {
  const logins = loadFamilyLogins();
  if (!Object.hasOwn(logins, family)) throw new Error('Invalid models request.');
  const body = objectBody(await readJson(req, 64 * 1024), action);
  const host = body.host ?? 'mac';
  if (typeof host !== 'string') throw new Error('Invalid models request.');
  const hosts = readHosts(ctx.stateDir);
  if (host !== 'mac' && !Object.hasOwn(hosts, host)) throw new Error('Invalid models request.');
  const command: Command = { families: [family], quota: action === 'check' };
  if (action === 'key') command.key = validatedKey(logins[family].login.kind, body.key);
  const rows = host === 'mac' ? await readModelsOnMachine(command, ctx.stateDir) : await onRemote(host, hosts[host], command);
  return rows[0];
}

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function validatedKey(kind: string, key: unknown): string {
  if (kind !== 'key' || typeof key !== 'string' || !key.trim() || key.length > 8192 || hasControlChar(key)) throw new Error('Invalid models request.');
  return key;
}

async function serveModelPost(ctx: Context, req: IncomingMessage, res: ServerResponse, match: RegExpExecArray) {
  if (!leadWriteAllowed(req, ctx.port())) {
    sendJson(res, 403, { error: 'Models writes require the daemon origin and X-Orch-Chat: 1.' });
    return;
  }
  try { sendJson(res, 200, await postModel(ctx, req, match[1], match[2])); }
  catch { sendJson(res, 400, { error: 'Models request refused; no login was confirmed.' }); }
}

/** Loopback listener calls this after rejectReason; POSTs also need the exact daemon origin/header. */
const MODEL_READS = new Map<string, { answer: (ctx: Context) => Promise<unknown>; failure: string }>([
  ['/api/models', { answer: listModels, failure: 'Models status could not be read.' }],
  ['/api/models/catalog', { answer: listCatalog, failure: 'Model catalog could not be read.' }],
]);

export async function handleModels(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/models' && !url.pathname.startsWith('/api/models/')) return false;
  res.setHeader('cache-control', 'no-store');
  const match = /^\/api\/models\/([a-z]+)\/(key|check)$/.exec(url.pathname);
  const read = req.method === 'GET' ? MODEL_READS.get(url.pathname) : undefined;
  if (req.method === 'POST' && match) {
    await serveModelPost(ctx, req, res, match);
  } else if (read !== undefined) {
    try { sendJson(res, 200, await read.answer(ctx)); }
    catch { sendJson(res, 503, { error: read.failure }); }
  } else sendJson(res, 404, { error: 'Not found.' });
  return true;
}

/** Await this service before falling through to lead/MCP routing. */
export async function serveModels(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL, next: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>): Promise<boolean> {
  return (await handleModels(ctx, req, res, url)) || next(req, res, url);
}
