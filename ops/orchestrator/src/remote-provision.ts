// Provisioning of a remote orch checkout: the same worktree-setup.json steps
// provisionWorktree runs for a local seat, run on the host through
// spawnProvider({ host }) with cwd = the host checkout. Not yet connected to
// seat creation. Differences from a local seat, by design:
// - ORCH_SOURCE_CHECKOUT_PATH is host.repo, the host's own clone;
// - the .env step is skipped with a reason: secrets stay on the Mac;
// - a win32 host runs every step with Git for Windows' bash, located from
//   `git --exec-path` and proven by `uname -s`, never whatever bash.exe is on
//   PATH (WSL's WindowsApps\bash.exe can sit there on a Windows host).
import { readFile } from 'node:fs/promises';
import { readHost } from './config.ts';
import { remotePiMcpConfig } from './remote-pi-mcp.ts';
import { codexEditHostPrefix, type CodexEditVerdict } from './codex-edit.ts';
import { hashlineEditHostPrefix } from './hashline-edit.ts';
import { spawnProvider } from './providers/spawn.ts';
import { gatedSetupLine, type ProvisionStep, SLOT_ACQUIRED_MARKER, slotWaitMs } from './worktrees.ts';
import { withHostClone } from './remote-repo.ts';
import { createKeyedQueue } from './keyed-queue.ts';
import { codegraphIndexNote, normalizedPath } from './codegraph-seed.ts';
import { CODEGRAPH_INVOCATION, remoteCodegraphSeed } from './remote-codegraph.ts';
export { codegraphIndexNote } from './codegraph-seed.ts';

const CONFIG = 'ops/orchestrator/worktree-setup.json';
const withPyToolsInstall = createKeyedQueue();
const ENV_FILE = /(?<![\w.])\.env\b/;
// Fail closed if the reviewed setup step changes: a read-only host must never run an arbitrary checkout command.
const CODEGRAPH_INIT = 'command -v codegraph >/dev/null 2>&1 && codegraph init --yes . >/dev/null 2>&1 || true';
// npm ci replaces its destination. On Windows a junction at node_modules can
// make that destination another seat's checkout; inspect links on the host.
const NPM_DESTINATION_GUARD = `node -e 'const fs=require("node:fs"),p=require("node:path");const root=fs.realpathSync(".");for(const rel of ["node_modules","ops/orchestrator/node_modules","ops/mcp-vendor/node_modules"]){const full=p.resolve(rel);let stat;try{stat=fs.lstatSync(full)}catch(e){if(e.code==="ENOENT")continue;throw e}if(!stat.isSymbolicLink())continue;const target=fs.realpathSync(full),r=p.relative(root,target);if(r===".."||r.startsWith(".."+p.sep)||p.isAbsolute(r))throw new Error("npm destination links outside checkout: "+rel+" -> "+target)}'`;

export type RemoteStep = { line: string; skip?: string };

/** Full setup for writing seats; read-only seats run only the reviewed host index step. */
export function remoteSetup(setup: string[], hostRtkLine?: string, readOnly = false): RemoteStep[] {
  const selected = readOnly ? setup.filter(line => line === CODEGRAPH_INIT) : setup;
  if (readOnly && selected.length !== 1) throw new Error('read-only remote setup needs exactly one canonical codegraph init step');
  return selected.map((line) => {
    // A seat's HEAD may predate the host path matcher; use orch's gate on win32 only.
    const command = hostRtkLine && line.includes('rtk trust --list') ? hostRtkLine : line;
    return ENV_FILE.test(command)
      ? { line: command, skip: 'skipped on a remote host: the .env step would copy secrets, and secrets stay on the Mac' }
      : { line: command.includes('npm ci') ? `${NPM_DESTINATION_GUARD} && ${command}` : command };
  });
}

/** What a host runs to find its bash: a win32 host asks git where Git for Windows lives. */
export function bashResolution(platform: NodeJS.Platform): { command: string; args: string[] } | null {
  return platform === 'win32' ? { command: 'git', args: ['--exec-path'] } : null;
}

/** Git for Windows' bash from `git --exec-path` (`<root>/<mingw64|clangarm64|...>/libexec/git-core`). */
export function gitBashFromExecPath(execPath: string): string {
  const parts = execPath.trim().replaceAll('\\', '/').replace(/\/+$/, '').split('/');
  if (parts.length < 5 || parts.at(-1)?.toLowerCase() !== 'git-core' || parts.at(-2)?.toLowerCase() !== 'libexec') {
    throw new Error(`git --exec-path '${execPath.trim()}' is not a Git for Windows layout`);
  }
  return [...parts.slice(0, -3), 'bin', 'bash.exe'].join('/');
}

/** `uname -s` of Git for Windows' bash is MINGW64_NT-…/MSYS_NT-…; WSL's says Linux. */
export function assertGitBash(bash: string, uname: string): void {
  if (!/^(MINGW|MSYS)/.test(uname.trim())) throw new Error(`${bash} is not Git for Windows bash: uname -s = '${uname.trim()}'`);
}

type Run = { code: number | null; output: string; ms: number };

// `keepBytes` bounds the retained output: a step's tail, or a whole file read back.
// A gated step (host build-gate --exec) only queues until the gate prints SLOT_ACQUIRED_MARKER,
// so its timeoutMs starts at the marker and a longer cap bounds the slot wait (task 2930), the
// same contract as runStep in worktrees.ts. The cap reads this daemon's env, not the host's.
function runOnHost(host: string | undefined, command: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs: number, keepBytes = 4000, gated = false): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let slotTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(slotTimer);
      resolve({ code, output, ms: Date.now() - started });
    };
    let child: ReturnType<typeof spawnProvider>;
    try { child = spawnProvider({ host, command, args, cwd, env }); }
    catch (error) { output = (error as Error).message; finish(null); return; }
    const kill = (note: string) => {
      if (settled) return;
      output += note;
      // Killing ssh ends remote-exec's stdin, and remote-exec then kills the host process tree.
      child.kill();
      setTimeout(() => finish(null), 5000).unref();
    };
    const armExecutionTimer = () => { timer = setTimeout(() => kill(`\n[orch] killed after ${timeoutMs} ms`), timeoutMs); };
    // The marker is detected on the stderr stream alone, against a stderr-only rolling tail: stdout
    // chunks interleaved between marker fragments must not push a fragment out of view (task 2930).
    let stderrTail = '';
    const onStdout = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-keepBytes); };
    const onStderr = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (gated && timer === undefined) {
        const merged = stderrTail + text;
        if (merged.includes(SLOT_ACQUIRED_MARKER)) {
          clearTimeout(slotTimer);
          armExecutionTimer();
        }
        stderrTail = merged.slice(-(SLOT_ACQUIRED_MARKER.length - 1));
      }
      output = (output + text).slice(-keepBytes);
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    if (gated) {
      const waitMs = slotWaitMs();
      slotTimer = setTimeout(() => kill(`\n[orch] no build slot came within ${waitMs} ms`), waitMs);
    } else armExecutionTimer();
    child.on('error', (error) => { output += `\n${error.message}`; finish(null); });
    // stdin stays open until the command exits: remote-exec treats its EOF as a disconnect.
    child.on('close', (code) => finish(code));
  });
}

async function hostBash(host: string | undefined, platform: NodeJS.Platform, dir: string): Promise<string> {
  const resolution = bashResolution(platform);
  if (!resolution) return 'bash';
  const found = await runOnHost(host, resolution.command, resolution.args, dir, {}, 60_000);
  if (found.code !== 0) throw new Error(`git --exec-path failed on ${host}: ${found.output.trim()}`);
  const bash = gitBashFromExecPath(found.output);
  const uname = await runOnHost(host, bash, ['-c', 'uname -s'], dir, {}, 60_000);
  if (uname.code !== 0) throw new Error(`${bash} did not run on ${host}: ${uname.output.trim()}`);
  assertGitBash(bash, uname.output);
  return bash;
}

/** Only dependency installation for lead checks: no .env, MCP config or index setup. */
export async function provisionCheckDependencies(host: string | undefined, dir: string, roots: string[]): Promise<void> {
  if (!roots.length) return;
  if (roots.some(root => !['', 'ops/orchestrator', 'ops/mcp-vendor'].includes(root))) throw new Error('invalid dependency root');
  const config = host === undefined ? undefined : readHost(host);
  const bash = await hostBash(host, config?.platform ?? process.platform, dir);
  for (const root of roots) {
    const install = `npm ci --no-audit --no-fund${root ? ` --ignore-scripts --prefix ${root}` : ''}`;
    const [{ line }] = remoteSetup([install]);
    const args = config ? [`${config.repo}/ops/orchestrator/build-gate.mjs`, '--exec', bash, '-c', line] : ['-c', line];
    const run = await runOnHost(host, config ? 'node' : bash, args, dir, {}, 20 * 60_000, 4000, Boolean(config));
    if (run.code !== 0) throw new Error(`check-on dependency install (${root || 'root'}) exit ${run.code}: ${run.output.trim()}`);
  }
}

/** The installer owns readiness; serialize its host-wide site lock independently of clone mutation. */
export async function provisionCheckPyTools(host: string | undefined, dir: string): Promise<void> {
  await withPyToolsInstall(JSON.stringify(host ?? null), async () => {
    const run = await runOnHost(host, 'node', ['ops/py-tools/install.mjs'], dir, {}, 10 * 60_000);
    if (run.code !== 0) throw new Error(`check-on py-tools install exit ${run.code}: ${run.output.trim()}`);
  });
}

/** The checkout's own setup, or orch's copy when the checkout's commit predates the file. */
async function readSetup(host: string, dir: string): Promise<{ setup: string[]; gate?: string[]; source: 'seat' | 'orch' }> {
  // LC_ALL=C: the missing-path test below matches git's English message; a localized host would otherwise throw.
  const shown = await runOnHost(host, 'git', ['show', `HEAD:${CONFIG}`], dir, { LC_ALL: 'C' }, 60_000, Infinity);
  if (shown.code === 0) {
    const parsed = JSON.parse(shown.output);
    return { setup: parsed?.setup ?? [], gate: Array.isArray(parsed?.gate) ? parsed.gate : undefined, source: 'seat' };
  }
  if (!/does not exist in 'HEAD'|exists on disk, but not in 'HEAD'/.test(shown.output)) {
    throw new Error(`cannot read ${CONFIG} in ${dir} on ${host}: ${shown.output.trim()}`);
  }
  const own = JSON.parse(await readFile(new URL('../worktree-setup.json', import.meta.url), 'utf8'));
  return { setup: own?.setup ?? [], gate: Array.isArray(own?.gate) ? own.gate : undefined, source: 'orch' };
}

const CODEGRAPH_TAIL = 400;
const CODEGRAPH_AVAILABLE = 'command -v codegraph >/dev/null 2>&1';
// The reviewed CODEGRAPH_INIT without its `|| true` and stderr discard: a failed init names its exit and stderr.
const CODEGRAPH_INIT_KEPT = 'codegraph init --yes . >/dev/null';
// Only this checkout's own index: a rerun init answers "Already initialized" over a broken one and does not resume.
const CODEGRAPH_REBUILD = `rm -rf ./.codegraph || exit; ${CODEGRAPH_INIT_KEPT}`;
const CODEGRAPH_STATUS = 'codegraph status --json .';

type HostScript = (script: string, timeoutMs: number) => Promise<Run>;

// Keep availability separate: init can itself exit 127, so no init exit code means "missing".
async function runCodegraphInit(run: HostScript, script: string, timeoutMs: number): Promise<Run & { missing: boolean }> {
  const available = await run(CODEGRAPH_AVAILABLE, 60_000);
  if (available.code !== 0) return { ...available, missing: available.code !== null };
  return { ...await run(script, timeoutMs), missing: false };
}

function initFailure(run: Run & { missing: boolean }): string | null {
  if (run.code === 0) return null;
  if (run.missing) return 'codegraph is not installed on this host';
  const tail = run.output.trim().slice(-CODEGRAPH_TAIL);
  return `init exit ${run.code ?? 'none (killed or not started)'}${tail ? `: ${tail}` : ''}`;
}

/**
 * Why this checkout's index needs one rebuild: a definite status failure (a
 * non-zero exit) or an index that is not complete. A killed status (code null)
 * and unreadable exit-0 output say nothing about the database: no rebuild.
 */
export function codegraphRebuildReason(run: { code: number | null; output: string }, dir?: string): string | null {
  if (run.code === null) return null;
  if (run.code !== 0) return `status failed (${run.output.trim().slice(-CODEGRAPH_TAIL) || `exit ${run.code}`})`;
  let status;
  try { status = JSON.parse(run.output); } catch { return null; }
  return codegraphPathMismatch(status, dir) ?? incompleteIndexReason(status);
}

function codegraphPathMismatch(status: { projectPath?: string }, dir?: string): string | null {
  const win = /^[a-z]:[\\/]/i.test(dir ?? '');
  return dir && typeof status?.projectPath === 'string' && normalizedPath(status.projectPath, win) !== normalizedPath(dir, win)
    ? `index belongs to another checkout (${status.projectPath})` : null;
}

function incompleteIndexReason(status: { index?: { state?: string }; fileCount?: number } | null): string | null {
  const state = status?.index?.state;
  return state === 'complete' ? null : `incomplete index (state ${JSON.stringify(state ?? null)}, ${status?.fileCount ?? 'unknown'} files)`;
}

async function seedRemoteCodegraph(run: HostScript, host: string, timeoutMs: number, repo?: string): Promise<ProvisionStep[]> {
  if (!repo) return [];
  const seed = await run(remoteCodegraphSeed(repo), timeoutMs);
  return [{ command: `[${host}] codegraph seed`, code: seed.code, ms: seed.ms, tail: seed.output.slice(-1500) }];
}

/**
 * The checkout's codegraph index: init, verify, and at most one rebuild of this
 * checkout's .codegraph on a definite failure or an incomplete index. A status
 * killed by its timeout is retried once and never deletes the index. Never
 * fatal: a seat without an index keeps the rg fallback. `note` is what the seat
 * should know (null for a clean, verified index).
 */
export async function provisionCodegraph(run: HostScript, dir: string, host: string, initLabel: string, timeoutMs: number, repo?: string): Promise<{ steps: ProvisionStep[]; note: string | null }> {
  const steps = await seedRemoteCodegraph(run, host, timeoutMs, repo);
  const init = await runCodegraphInit(run, CODEGRAPH_INIT_KEPT, timeoutMs);
  const initNote = initFailure(init);
  steps.push({ command: initLabel, code: init.code, ms: init.ms, tail: initNote ? `codegraph init failed: ${initNote}` : 'codegraph init ok' });
  if (init.missing) {
    const note = `codegraph index unavailable: ${initNote}`;
    steps.push({ command: `[${host}] ${CODEGRAPH_STATUS}`, code: null, ms: 0, tail: note });
    return { steps, note };
  }
  const verify = async () => {
    for (let attempt = 1; ; attempt++) {
      const status = await run(CODEGRAPH_STATUS, 60_000);
      steps.push({ command: `[${host}] ${CODEGRAPH_STATUS}`, code: status.code, ms: status.ms, tail: '' });
      if (status.code !== null || attempt === 2) return status;
      steps[steps.length - 1].tail = `codegraph status did not answer (${status.output.trim().slice(-200)}); retrying once`;
    }
  };
  let status = await verify();
  const reason = codegraphRebuildReason(status, dir);
  let rebuildNote: string | null = null;
  if (reason) {
    // The first status step records why a rebuild ran; the final status step carries the note.
    steps[steps.length - 1].tail = `codegraph index needs a rebuild: ${reason}`;
    const rebuild = await runCodegraphInit(run, CODEGRAPH_REBUILD, timeoutMs);
    const failure = initFailure(rebuild);
    rebuildNote = failure ? `rebuild after ${reason} failed: ${failure}` : `rebuilt after ${reason}`;
    steps.push({ command: `[${host}] rm -rf .codegraph && codegraph init --yes .`, code: rebuild.code, ms: rebuild.ms, tail: `codegraph ${rebuildNote}` });
    status = await verify();
  }
  const history = [initNote, rebuildNote].filter(Boolean).join('; ');
  const unavailable = status.code === null
    ? `codegraph index unverified: status did not answer twice (${status.output.trim().slice(-200)}); index left in place`
    : codegraphIndexNote(status, dir);
  const note = unavailable
    ? `${unavailable}${history ? `; ${history}` : ''}`
    : history ? `codegraph index verified (${history})` : null;
  steps[steps.length - 1].tail = note ?? 'codegraph index verified';
  return { steps, note };
}

/**
 * The verified codex-edit extension for a codex seat that edits (operator #13098),
 * installed by the HOST's own copy of the stand installer inside the host's runtime
 * clone: the pinned sha512 is checked on the host, npm runs --ignore-scripts, and
 * nothing is written to the host operator's ~/.pi or ~/.local/bin. One install per
 * host (the script reuses a prefix that already verifies). Failure fails
 * provisioning, so a codex seat never reaches ready without the extension it must
 * load, and Pi is never started with a path orch did not write and record.
 */
export async function provisionCodexEdit(host: string, options: { timeoutMs?: number } = {}): Promise<{ ok: boolean; steps: ProvisionStep[]; extension?: string }> {
  return provisionPinnedEdit(host, 'codex-edit', codexEditHostPrefix(readHost(host)), options);
}

/** The hashline-edit twin of provisionCodexEdit (task 1914 lazy re-provision also calls it directly). */
export async function provisionHashlineEdit(host: string, options: { timeoutMs?: number } = {}): Promise<{ ok: boolean; steps: ProvisionStep[]; extension?: string }> {
  return provisionPinnedEdit(host, 'hashline-edit', hashlineEditHostPrefix(readHost(host)), options);
}

type PinnedEditResult = { ok: boolean; steps: ProvisionStep[]; extension?: string };

/**
 * One install per host prefix at a time, at the ONE boundary every caller crosses: initial
 * provisioning (provisionRemote) and a pre-rollout seat's lazy start (task 1914) alike. A caller
 * arriving while an install runs awaits and REUSES that install's verified result: prefix, pins
 * and installer are identical for the same host+name, and a lazy seat still re-proves the bytes
 * with its own per-start --check. The entry is released on success and on failure, so a failed
 * install never poisons a later attempt.
 */
const pinnedEditInFlight = new Map<string, Promise<PinnedEditResult>>();

async function provisionPinnedEdit(host: string, name: string, prefix: string, options: { timeoutMs?: number } = {}): Promise<PinnedEditResult> {
  const key = `${host}:${name}`;
  const running = pinnedEditInFlight.get(key);
  if (running) return running;
  const install = (async (): Promise<PinnedEditResult> => {
    const { repo } = readHost(host);
    const timeoutMs = options.timeoutMs ?? 10 * 60_000;
    const script = `${repo}/ops/ab-stand/${name}-install.mjs`;
    const command = `[${host}] node ops/ab-stand/${name}-install.mjs --ensure --prefix ${prefix}`;
    const run = await runOnHost(host, 'node', [script, '--ensure', '--prefix', prefix], repo, {}, timeoutMs);
    const steps: ProvisionStep[] = [{ command, code: run.code, ms: run.ms, tail: run.output.slice(-1500) }];
    if (run.code !== 0) return { ok: false, steps };
    let reported: { ok?: boolean; extension?: string; reason?: string } | null = null;
    try { reported = JSON.parse(run.output.trim().split(/\r?\n/).pop() ?? '') as typeof reported; } catch { reported = null; }
    if (reported?.ok !== true || typeof reported.extension !== 'string') {
      steps.push({ command: `${name} verdict on ${host}`, code: run.code, ms: 0, tail: reported?.reason ?? `no JSON verdict in: ${run.output.slice(-300)}` });
      return { ok: false, steps };
    }
    return { ok: true, steps, extension: reported.extension };
  })();
  pinnedEditInFlight.set(key, install);
  try { return await install; } finally { pinnedEditInFlight.delete(key); }
}

/**
 * Per-start proof for a remote codex seat: the host re-verifies its own install
 * (pins, per-file sha256, toolkit version, config content, containment) before Pi
 * is started with that `-e` path, exactly as a local seat start does. A tampered,
 * stale or missing host file fails the start instead of quietly running a codex
 * coder on Pi's stock edit tools.
 */
export async function checkCodexEditOnHost(host: string, options: { timeoutMs?: number } = {}): Promise<CodexEditVerdict> {
  return checkPinnedEditOnHost(host, 'codex-edit', codexEditHostPrefix(readHost(host)), options);
}

export async function checkHashlineEditOnHost(host: string, options: { timeoutMs?: number } = {}): Promise<CodexEditVerdict> {
  return checkPinnedEditOnHost(host, 'hashline-edit', hashlineEditHostPrefix(readHost(host)), options);
}

async function checkPinnedEditOnHost(host: string, name: string, prefix: string, options: { timeoutMs?: number }): Promise<CodexEditVerdict> {
  const { repo } = readHost(host);
  const run = await runOnHost(host, 'node', [`${repo}/ops/ab-stand/${name}-install.mjs`, '--check', '--prefix', prefix], repo, {}, options.timeoutMs ?? 120_000);
  const line = run.output.trim().split(/\r?\n/).pop() ?? '';
  let verdict: CodexEditVerdict | null = null;
  try { const parsed = JSON.parse(line) as CodexEditVerdict; verdict = typeof parsed?.ok === 'boolean' ? parsed : null; } catch { verdict = null; }
  return verdict && (!verdict.ok || run.code === 0) ? verdict : { ok: false, prefix, reason: `host ${host} reported no ${name} verdict (exit ${run.code}): ${run.output.trim().slice(-300)}` };
}

// Seed gates sync internally and streams the slot marker through stderr.
function runCodegraphOnHost(host: string, dir: string, repo: string, bash: string, env: Record<string, string>, body: string, ms: number): Promise<Run> {
  if (body.startsWith('// orch-codegraph-seed')) return runOnHost(host, 'node', ['-e', body], dir, env, ms, 4000, true);
  if (/codegraph (?:init|sync)\b/.test(body)) {
    return runOnHost(host, 'node', [`${repo}/ops/orchestrator/build-gate.mjs`, '--exec', bash, '-c', body], dir, env, ms, 4000, true);
  }
  return runOnHost(host, bash, ['-c', body], dir, env, ms);
}

/** `notes` is everything the seat should know about its checkout; seats store it as remoteProvisionNotes. */
export async function provisionRemote(host: string, dir: string, options: { readOnly?: boolean; timeoutMs?: number; codexEdit?: boolean; hashlineEdit?: boolean; role?: string } = {}): Promise<{ ok: boolean; steps: ProvisionStep[]; notes: string[]; codexEditExtension?: string; hashlineEditExtension?: string }> {
  const { readOnly = false, codexEdit = false, hashlineEdit = false, timeoutMs = 20 * 60_000, role } = options;
  const { platform, repo } = readHost(host);
  const bash = await hostBash(host, platform, dir);
  const { setup, gate: gateMarkers, source } = await readSetup(host, dir);
  const own = platform === 'win32' || readOnly ? JSON.parse(await readFile(new URL('../worktree-setup.json', import.meta.url), 'utf8')).setup as string[] : [];
  const hostRtkLine = own.find(line => line.includes('rtk trust --list'));
  const env = { ORCH_SOURCE_CHECKOUT_PATH: repo };
  // Heavy steps run inside the host's own build gate (task 1803): the gate
  // script lives in the host's clone, and its slots sit in the host's orch
  // state directory, so the machine that runs the step is the gated machine.
  const hostGate = `${repo}/ops/orchestrator/build-gate.mjs`;
  const onHost = (line: string, ms: number) => gatedSetupLine(line, gateMarkers)
    ? runOnHost(host, 'node', [hostGate, '--exec', bash, '-c', line], dir, env, ms, 4000, true)
    : runOnHost(host, bash, ['-c', line], dir, env, ms);
  const steps: ProvisionStep[] = [];
  const notes: string[] = [];
  for (const { line, skip } of remoteSetup(readOnly ? own : setup, hostRtkLine, readOnly)) {
    const command = `[${source} ${CONFIG} on ${host}] ${line}`;
    if (skip) {
      steps.push({ command, code: 0, ms: 0, tail: skip });
      continue;
    }
    if (line === CODEGRAPH_INIT) {
      const script: HostScript = (body, ms) => runCodegraphOnHost(host, dir, repo, bash, env, body, ms);
      const index = await provisionCodegraph(script, dir, host, command, timeoutMs, repo);
      steps.push(...index.steps);
      if (index.note) notes.push(index.note);
      continue;
    }
    const run = await onHost(line, timeoutMs);
    steps.push({ command, code: run.code, ms: run.ms, tail: run.output.slice(-1500) });
    if (run.code !== 0) return { ok: false, steps, notes };
    if (line.includes('codegraph init')) {
      const status = await runOnHost(host, bash, ['-c', 'codegraph status --json .'], dir, env, 60_000);
      const note = codegraphIndexNote({ code: status.code, output: status.output }, dir);
      steps.push({ command: `[${host}] codegraph status --json .`, code: status.code, ms: status.ms, tail: note ?? 'codegraph index verified' });
      if (note) notes.push(note);
    }
  }
  // inheritEnv:false intentionally leaves MCP children without PATH. Resolve
  // CodeGraph's installed npm shim on the host before writing the seat config;
  // spawning a bare `codegraph` would fail inside the role gate on Windows.
  const probe = `${CODEGRAPH_INVOCATION}process.stdout.write(JSON.stringify(invocation));`;
  const detected = await runOnHost(host, 'node', ['-e', probe], dir, {}, timeoutMs);
  steps.push({ command: `resolve host codegraph for seat MCP on ${host}`, code: detected.code, ms: detected.ms, tail: detected.output.slice(-1500) });
  if (detected.code !== 0) return { ok: false, steps, notes };
  // The installed Pi profile belongs to the host operator. Provision only this
  // checkout's ignored MCP file; remote Pi selects it with --mcp-config.
  const content = remotePiMcpConfig(readHost(host), dir, JSON.parse(detected.output), role);
  if (Object.hasOwn(JSON.parse(content).mcpServers, 'brightdata-web')) {
    // The runtime checkout and its lockfile can move during sync. Check, install
    // and mark under the same host turn, including concurrent seat provisions.
    const ready = await withHostClone(host, async () => {
      const state = `const fs=require('node:fs'),crypto=require('node:crypto');
        const base='ops/mcp-vendor/',marker=base+'node_modules/.orch-lock-sha256';
        const server=base+'node_modules/@brightdata/mcp/server.js';
        const hash=crypto.createHash('sha256').update(fs.readFileSync(base+'package-lock.json')).digest('hex');`;
      const inspect = await runOnHost(host, 'node', ['-e', `${state}
        let saved;try{saved=fs.readFileSync(marker,'utf8').trim()}catch(e){if(e.code!=='ENOENT')throw e}
        process.stdout.write(JSON.stringify({hash,ready:fs.existsSync(server)&&saved===hash}));`], repo, {}, timeoutMs);
      steps.push({ command: `check host vendor MCP on ${host}`, code: inspect.code, ms: inspect.ms, tail: inspect.output.slice(-1500) });
      if (inspect.code !== 0) return false;
      const installed = JSON.parse(inspect.output) as { hash: string; ready: boolean };
      if (installed.ready) return true;
      const npm = platform === 'win32' ? 'npm.cmd' : 'npm';
      const line = `${NPM_DESTINATION_GUARD} && ${npm} ci --prefix ops/mcp-vendor`;
      const install = await runOnHost(host, 'node', [hostGate, '--exec', bash, '-c', line], repo, {}, timeoutMs, 4000, true);
      steps.push({ command: `[${host}] ${npm} ci --prefix ops/mcp-vendor`, code: install.code, ms: install.ms,
        tail: `host '${host}' vendor npm exit ${install.code ?? 'unknown'}` });
      if (install.code !== 0) return false;
      // Never bless an incomplete install (or a lock changed outside our queue).
      const marked = await runOnHost(host, 'node', ['-e', `${state}
        if(!fs.existsSync(server))throw new Error('vendor MCP server missing after npm ci');
        if(hash!==process.argv[1])throw new Error('vendor lock changed during npm ci');
        fs.writeFileSync(marker,hash+'\\n');`, installed.hash], repo, {}, timeoutMs);
      steps.push({ command: `mark host vendor MCP on ${host}`, code: marked.code, ms: marked.ms, tail: marked.output.slice(-1500) });
      return marked.code === 0;
    }, AbortSignal.timeout(600_000));
    if (!ready) return { ok: false, steps, notes };
  }
  const script = 'require("node:fs").writeFileSync(".mcp.json", Buffer.from(process.argv[1], "base64"))';
  const run = await runOnHost(host, 'node', ['-e', script, Buffer.from(content).toString('base64')], dir, {}, timeoutMs);
  steps.push({ command: `write seat .mcp.json on ${host}`, code: run.code, ms: run.ms, tail: run.output.slice(-1500) });
  if (run.code !== 0) return { ok: false, steps, notes };
  if (hashlineEdit && !readOnly) {
    const edit = await provisionPinnedEdit(host, 'hashline-edit', hashlineEditHostPrefix(readHost(host)), { timeoutMs });
    steps.push(...edit.steps);
    if (!edit.ok || edit.extension === undefined) return { ok: false, steps, notes };
    return { ok: true, steps, notes, hashlineEditExtension: edit.extension };
  }
  if (!codexEdit) return { ok: true, steps, notes };
  const edit = await provisionCodexEdit(host, { timeoutMs });
  steps.push(...edit.steps);
  if (!edit.ok || edit.extension === undefined) return { ok: false, steps, notes };
  return { ok: true, steps, notes, codexEditExtension: edit.extension };
}
