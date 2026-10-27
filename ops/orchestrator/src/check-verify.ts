/**
 * Reruns a coder's claimed-pass checks in its worktree (task 1561, arXiv 2608.04804: coders
 * over-report passing checks). Only allow-listed command shapes run, without a shell, each under its
 * own cap and all under one total budget; a check that cannot be judged is `unverified`, never
 * `fail`. SeatManager runs it after each coder turn (slice b).
 */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { prioritySpawn, withCargoBuildJobs } from './priority-launch.ts';
import { spawnProvider } from './providers/spawn.ts';
import { killTree } from './worktrees.ts';

/** A report's check entry (report.ts validates the shape; tail is ignored here). */
export type ClaimedCheck = { command: string; result: string; tail?: string };

export type VerifiedCheck = {
  command: string;
  claimed: 'pass';
  result: 'pass' | 'fail' | 'unverified';
  host?: string;
  reason?: string;
  /** The shortest decisive failing output line. */
  line?: string;
};

/** A check command as reruns are matched: control characters folded, one trailing (…)/[…] note dropped. */
export function checkCommand(raw: string): string {
  // Fold control characters before matching reruns; a seat-written command must not split the digest.
  // eslint-disable-next-line no-control-regex -- the control characters are the subject of the match
  return raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim()
    .replace(/\s+(?:\[[^[\]]+\]|\([^()]+\))$/, '');
}

/** The last result of each check command: a rerun after a red-before-fix run decides (lesson 11947). */
export function lastCheckResults(report: Record<string, unknown> | null): Map<string, string> {
  const results = new Map<string, string>();
  for (const check of (report?.checks ?? []) as ClaimedCheck[]) results.set(checkCommand(check.command), check.result);
  return results;
}

/** `offline`: the tool's own refusal to fetch, which makes a non-zero exit unverified rather than fail. */
type Plan = { argv: string[]; cost: number; offline?: RegExp };
/**
 * cargo --offline refuses rather than fetch: a missing prerequisite, not a failed check. Only cargo's
 * own lines count, so a failing check whose output merely quotes the phrase elsewhere still fails.
 */
const CARGO_OFFLINE = /^\s*attempting to make an HTTP request, but --offline was specified\s*$|^As a reminder, you're using offline mode \(--offline\)/m;
/** Why a claimed check is not run: it stays unverified with this reason. */
type Refusal = { refused: string };
const NOT_ALLOWED: Refusal = { refused: 'not allow-listed' };

/** Refuse shell syntax and quotes except the punctuation in a validated Node test-pattern argv. */
const SHELL_CHARS = /[|&;<>`$(){}\\'"*?~!#\n\r]/;
const CRATE = /^[A-Za-z0-9_-]+$/;

/**
 * Whitespace tokenisation cannot preserve quoted patterns: accept only the no-space = form.
 * Pattern punctuation is safe only in this validated argv, never in a shell or a file argument.
 */
function nodeTestWords(command: string): string[] | undefined {
  if (/[\n\r]/.test(command)) return;
  let words = command.trim().split(/\s+/);
  // `bypass` is 1.0.1's canonical name for `proxy` (a silent alias): both peel.
  if (words[0] === 'rtk') words = words.slice(words[1] === 'proxy' || words[1] === 'bypass' ? 2 : 1);
  if (words[0] !== 'node' || words[1] !== '--test' || words.length < 3) return;
  const file = words[words.length - 1];
  if (file.startsWith('-') || SHELL_CHARS.test(file)) return;
  const seen = new Set<string>();
  for (const flag of words.slice(2, -1)) {
    let key: string;
    if (/^--test-timeout=\d{1,7}$/.test(flag)) key = '--test-timeout';
    else if (flag === '--test-force-exit') key = flag;
    else if (/^--test-name-pattern=[A-Za-z0-9_.:,()#-]+$/.test(flag)) key = '--test-name-pattern';
    else return;
    if (seen.has(key)) return;
    seen.add(key);
  }
  return words;
}

/**
 * A repo-relative path whose real location, every symlink followed, sits inside the real worktree
 * root; else why not. A link inside the tree to a script outside it would otherwise run that script.
 */
function confine(root: string, file: string): string | Refusal {
  if (!file || file.startsWith('-') || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) return NOT_ALLOWED;
  let real: string;
  try { real = realpathSync(path.resolve(root, file)); } catch { return { refused: `path does not exist: ${file}` }; }
  return real === root || real.startsWith(root + path.sep) ? file : { refused: `path escapes the worktree: ${file}` };
}

/**
 * The argv to run for an allow-listed command, with its cost rank (syntax, single-file tests and
 * type checks before broader checks), or why it is refused. A leading `rtk` (and its silent-alias pair `rtk proxy`/`rtk bypass`) is dropped: it only filters output.
 */
export function planCheck(worktree: string, command: string, remote?: { root: string; paths: Record<string, string | null>; platform: NodeJS.Platform }): Plan | Refusal {
  const testWords = nodeTestWords(command);
  if (SHELL_CHARS.test(command) && !testWords) return NOT_ALLOWED;
  // Remote paths are resolved by node in the host checkout, not by the unprovisioned Mac mirror.
  let root: string;
  try { root = remote?.root ?? realpathSync(path.resolve(worktree)); } catch { return { refused: 'worktree does not exist' }; }
  const confined = (file: string): string | Refusal => {
    if (!remote) return confine(root, file);
    if (!file || file.startsWith('-') || (remote.platform === 'win32' ? path.win32 : path.posix).isAbsolute(file) || file.split(/[\\/]/).includes('..')) return NOT_ALLOWED;
    const real = remote.paths[file];
    if (real === undefined || real === null) return { refused: `path does not exist: ${file}` };
    const normal = (s: string) => remote.platform === 'win32' ? s.replaceAll('\\', '/').toLowerCase() : s;
    return normal(real) === normal(root) || normal(real).startsWith(normal(root).replace(/\/$/, '') + '/')
      ? file : { refused: `path escapes the worktree: ${file}` };
  };
  let words = command.trim().split(/\s+/);
  if (words[0] === 'rtk') words = words.slice(words[1] === 'proxy' || words[1] === 'bypass' ? 2 : 1);
  const [head, ...rest] = words;
  const at = (i: number) => rest[i] ?? '';
  const on = (arg: string, plan: (file: string) => Plan | Refusal): Plan | Refusal => {
    const file = confined(arg);
    return typeof file === 'string' ? plan(file) : file;
  };
  if (testWords) return on(testWords[testWords.length - 1], (file) => ({ argv: [...testWords.slice(0, -1), file], cost: 0 }));
  if (head === 'node') {
    if (rest.length === 2 && at(0) === '--check') return on(at(1), (file) => ({ argv: ['node', '--check', file], cost: 0 }));
    if (rest.length === 1 && /^scripts\/(?:check|test)-[^/]+\.mjs$/.test(at(0))) return on(at(0), (file) => ({ argv: ['node', file], cost: 2 }));
    return NOT_ALLOWED;
  }
  // The worktree's own binary, never npx/npm: no registry fetch or arbitrary package scripts.
  // Confine .bin locally; on Windows use the package's JS entry with host Node, not a shim.
  const local = (tool: 'tsc' | 'eslint' | 'vitest', args: string[], cost: number): Plan | Refusal => {
    const bin = confined(remote?.platform === 'win32'
      ? `node_modules/${tool === 'tsc' ? 'typescript/bin/tsc' : tool === 'eslint' ? 'eslint/bin/eslint.js' : 'vitest/vitest.mjs'}`
      : `node_modules/.bin/${tool}`);
    if (typeof bin !== 'string') return bin.refused.startsWith('path does not exist') ? { refused: `node_modules/.bin/${tool} missing` } : bin;
    if (remote?.platform === 'win32') return { argv: ['node', bin, ...args], cost };
    return { argv: [remote ? path.posix.join(root, bin) : path.join(root, bin), ...args], cost };
  };
  if (head === 'npm' && rest.length === 2 && at(0) === 'run' && at(1) === 'lint')
    return local('eslint', ['.'], 2);
  if (head === 'npx') {
    if (rest.length === 4 && at(0) === 'tsc' && at(1) === '--noEmit' && at(2) === '-p')
      return on(at(3), (file) => local('tsc', ['--noEmit', '-p', file], 1));
    if (rest.length === 2 && at(0) === 'eslint' && at(1) === '.') return local('eslint', ['.'], 2);
    if (rest.length === 3 && at(0) === 'vitest' && at(1) === 'run')
      return on(at(2), (file) => local('vitest', ['run', file], /\.[cm]?[jt]sx?$/.test(file) ? 0 : 3));
    return NOT_ALLOWED;
  }
  if (head === 'cargo' && rest.length === 3 && at(0) === 'check' && at(1) === '-p' && CRATE.test(at(2)))
    return { argv: ['cargo', 'check', '--offline', '-p', at(2)], cost: 3, offline: CARGO_OFFLINE };
  return NOT_ALLOWED;
}

/** An error or assertion message: `AssertionError [ERR_ASSERTION]: …`, `error TS2322: …`, `error[E0308]: …`. */
const ERROR = /\b\w*Error(?: \[\w+\])?:|\berror(?:\[E\d+\])?:|\berror TS\d+:/;
/** Other lines that name a failure: a failed test's name, `not ok`, `FAIL`. */
const FAILURE = /\b(?:not ok|fail(?:ed|ure|ures|s)?|errors?|assert(?:ion)?\w*)\b|✗|✖|×/i;
/** Runner summaries and headers are counts, not the failure: "ℹ fail 1", "# fail 0", "0 errors", "✖ failing tests:". */
const SUMMARY = /^(?:ℹ|#)\s*(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b|failing tests:$|\b0 (?:errors?|fail(?:ed|ures?)?)\b|\b(?:fail(?:ed|ures?)?|errors?)\s*[:=]?\s*0\b/i;
const LINE_CAP = 300;

const shortest = (lines: string[]) => lines.reduce<string | undefined>((a, b) => (a === undefined || b.length < a.length ? b : a), undefined);

/** The shortest error line of a failing output, else its shortest failure line, else its last non-empty line. */
export function decisiveLine(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !SUMMARY.test(line));
  const pick = shortest(lines.filter((line) => ERROR.test(line))) ?? shortest(lines.filter((line) => FAILURE.test(line))) ?? lines.at(-1);
  return pick?.slice(0, LINE_CAP);
}

const OUTPUT_CAP = 256 * 1024;

// Ask Node on the host to resolve every candidate in its checkout, including .bin links.
// Only path facts cross back; the allow-list remains in planCheck on the orchestrator.
const HOST_PATHS = `const fs=require('node:fs'),p=require('node:path');
const root=fs.realpathSync(process.cwd());
const paths={};
for(const file of JSON.parse(process.argv[1])) {
  try { paths[file]=fs.realpathSync(p.resolve(root,file)); } catch { paths[file]=null; }
}
process.stdout.write(JSON.stringify({root,paths}));`;

// remote-exec emits the resolver/spawn stack for a missing executable; a test merely quoting
// "not on PATH" must remain a failed check, like the local runner's error-event distinction.
const HOST_MISSING_TOOL = /^Error: (?:'[^'\n]+' is not on PATH|spawn [^\n]* ENOENT|ENOENT:)[\s\S]*\n\s+at (?:resolveCommand|ChildProcess\._handle\.onexit)\b/;


/** Clear a node --test parent's NODE_TEST_CONTEXT so a failing rerun cannot exit 0 as its subtest. */
export function checkEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, CI: '1' };
  delete env.NODE_TEST_CONTEXT;
  return withCargoBuildJobs(env);
}

/** What `run` spawns: nice 10 on darwin, checkEnv otherwise as the caller set it. */
export function checkCommandLaunch(argv: string[], platform: NodeJS.Platform = process.platform, base: NodeJS.ProcessEnv = process.env): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const [file, ...args] = argv;
  const env = checkEnv(base);
  return { ...prioritySpawn(file, args, env, platform), env };
}

type Run = { code: number | null; timedOut: boolean; output: string; error?: string };

/** How long pipes may stay open after the child exited or was killed: a descendant that left the group can hold them forever. */
const PIPE_GRACE_MS = 2000;

function run(argv: string[], cwd: string, ms: number, signal?: AbortSignal, host?: string): Promise<Run> {
  return new Promise((resolve) => {
    const group = process.platform !== 'win32';
    let output = '';
    let timedOut = false;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const launch = host ? null : checkCommandLaunch(argv);
    // The remote-exec child inherits the host environment. Only the check-specific CI marker crosses SSH.
    const child = host
      ? spawnProvider({ host, cwd, command: argv[0], args: argv.slice(1), env: { CI: '1' } })
      : spawn(launch!.file, launch!.args, { cwd, shell: false, detached: group, stdio: ['ignore', 'pipe', 'pipe'], env: launch!.env });
    // Locally kill the detached group; remotely close SSH so remote-exec kills its host process tree.
    const kill = () => { if (host) child.kill('SIGKILL'); else if (child.pid) killTree(child.pid); };
    // Settles once, on 'close' or when the grace after exit or kill runs out (lesson #10743: 'close' may never come).
    const finish = (result: Omit<Run, 'timedOut' | 'output'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener('abort', stop);
      // The check's children share the group; none may outlive it.
      if (group && !host && child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already empty */ }
      if (host) child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ ...result, timedOut, output });
    };
    const settleSoon = (code: number | null) => { grace ??= setTimeout(() => finish({ code }), PIPE_GRACE_MS); };
    const stop = () => { kill(); settleSoon(null); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
    const take = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-OUTPUT_CAP); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (error) => finish({ code: null, error: error.message }));
    // Exited on its own: the per-check cap no longer applies, only the pipe grace.
    child.on('exit', (code) => { if (!timedOut) clearTimeout(timer); settleSoon(code); });
    child.on('close', (code) => finish({ code }));
  });
}

/**
 * Reruns at most `max` claimed-pass checks, cheapest first, in `worktree`. Returns one entry per
 * claimed-pass command (the last entry of a command decides its claim); a claimed fail is not rerun.
 * An aborted `signal` (the seat is closing) kills the running check and leaves the rest unverified.
 */
export async function verifyChecks({ worktree, checks, perCheckMs = 120_000, totalMs = 240_000, max = 2, signal, host, platform,
  remoteRun = run }: {
  worktree: string; checks: ClaimedCheck[]; perCheckMs?: number; totalMs?: number; max?: number; signal?: AbortSignal;
  host?: string; platform?: NodeJS.Platform; remoteRun?: typeof run;
}): Promise<VerifiedCheck[]> {
  const root = host ? worktree : path.resolve(worktree);
  const claimed = [...lastCheckResults({ checks })].filter(([, result]) => result === 'pass').map(([command]) => command);
  const results = new Map<string, VerifiedCheck>();
  const plans: { command: string; plan: Plan; budget: number }[] = [];
  const deadline = Date.now() + totalMs;
  for (const command of claimed) {
    const checkStarted = Date.now();
    let remote: { root: string; paths: Record<string, string | null>; platform: NodeJS.Platform } | undefined;
    if (host && (!SHELL_CHARS.test(command) || nodeTestWords(command))) {
      const words = command.trim().split(/\s+/);
      const candidates = [...words.slice(1), ...(platform === 'win32'
        ? ['node_modules/typescript/bin/tsc', 'node_modules/eslint/bin/eslint.js', 'node_modules/vitest/vitest.mjs']
        : ['node_modules/.bin/tsc', 'node_modules/.bin/eslint', 'node_modules/.bin/vitest'])];
      const left = deadline - Date.now();
      if (signal?.aborted || left <= 0) {
        results.set(command, { command, claimed: 'pass', result: 'unverified', reason: signal?.aborted ? 'seat closed' : 'total budget spent' });
        continue;
      }
      const probe = await remoteRun(['node', '-e', HOST_PATHS, JSON.stringify(candidates)], root, Math.min(perCheckMs, left), signal, host);
      if (probe.timedOut || probe.error || probe.code !== 0) {
        results.set(command, { command, claimed: 'pass', result: 'unverified', reason: probe.timedOut ? 'timeout resolving host paths' : `host path probe failed: ${probe.error ?? decisiveLine(probe.output) ?? `exit ${probe.code}`}` });
        continue;
      }
      try { remote = { ...JSON.parse(probe.output) as { root: string; paths: Record<string, string | null> }, platform: platform ?? 'win32' }; }
      catch { results.set(command, { command, claimed: 'pass', result: 'unverified', reason: 'invalid host path probe' }); continue; }
    }
    const plan = planCheck(root, command, remote);
    if ('refused' in plan) results.set(command, { command, claimed: 'pass', result: 'unverified', reason: plan.refused });
    else plans.push({ command, plan, budget: host ? perCheckMs - (Date.now() - checkStarted) : perCheckMs });
  }
  plans.sort((a, b) => a.plan.cost - b.plan.cost);
  for (const [i, { command, plan, budget }] of plans.entries()) {
    if (i >= max) { results.set(command, { command, claimed: 'pass', result: 'unverified', reason: `not selected: at most ${max} run` }); continue; }
    const left = deadline - Date.now();
    if (signal?.aborted) { results.set(command, { command, claimed: 'pass', result: 'unverified', reason: 'seat closed' }); continue; }
    if (left <= 0) { results.set(command, { command, claimed: 'pass', result: 'unverified', reason: 'total budget spent' }); continue; }
    if (budget <= 0) { results.set(command, { command, claimed: 'pass', result: 'unverified', reason: 'timeout' }); continue; }
    const ran = await (host ? remoteRun : run)(plan.argv, root, Math.min(budget, left), signal, host);
    if (signal?.aborted) results.set(command, { command, claimed: 'pass', result: 'unverified', reason: 'seat closed' });
    else if (ran.timedOut) results.set(command, { command, claimed: 'pass', result: 'unverified', reason: 'timeout' });
    else if (ran.error || (host && HOST_MISSING_TOOL.test(ran.output))) results.set(command, { command, claimed: 'pass', result: 'unverified', reason: `could not start: ${ran.error ?? decisiveLine(ran.output)}` });
    else if (ran.code === 0) results.set(command, { command, claimed: 'pass', result: 'pass' });
    else if (plan.offline?.test(ran.output)) results.set(command, { command, claimed: 'pass', result: 'unverified', reason: 'needs network', line: decisiveLine(ran.output) });
    else results.set(command, { command, claimed: 'pass', result: 'fail', line: decisiveLine(ran.output) });
  }
  return claimed.map((command) => results.get(command)!);
}
