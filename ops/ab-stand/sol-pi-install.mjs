// sol-pi arm (operator #13470): github.com/NVlabs/SoL-Pi (MIT) with only Action
// Fusion and ObservationPack on. Upstream publishes no npm package, so the arm
// holds one git checkout of the commit pinned in sol-pi.json, inside the arm.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { requirePiRuntime } from './pi-runtime.mjs';

export const SOL_PI_PINS = JSON.parse(readFileSync(new URL('./sol-pi.json', import.meta.url), 'utf8'));
export const SOL_PI_COMMIT = SOL_PI_PINS.commit;
export const SOL_PI_CONFIG = SOL_PI_PINS.config;
/** Arm-relative checkout: the arm's own prefix, never ~/.pi/agent. */
export const SOL_PI_DIRECTORY = 'sol-pi';
/** Arm-relative: SoL-Pi reads <Pi agent dir>/sol-pi.json; a project .pi/sol-pi.json needs a trusted project. */
export const SOL_PI_CONFIG_FILE = 'agent/sol-pi.json';

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
// No user or system git config, no hooks, no credential prompt: the checkout runs nothing of ours or upstream's.
function git(checkout, args, env = {}) {
  return execFileSync('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'advice.detachedHead=false', '-C', checkout, ...args], {
    encoding: 'utf8', timeout: 5 * 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

/** Plain include plus empty resource types: only the extension loads (lesson #13017). */
export function solPiPackage(dir) {
  return { source: path.join(dir, SOL_PI_DIRECTORY), extensions: [SOL_PI_PINS.extension], skills: [], prompts: [], themes: [] };
}

/** HEAD is the pinned commit and the working tree is exactly its tree. */
export function solPiCheckoutProblems(dir) {
  const checkout = path.join(dir, SOL_PI_DIRECTORY);
  try {
    const head = git(checkout, ['rev-parse', 'HEAD']);
    if (head !== SOL_PI_COMMIT) return [`sol-pi: checkout is ${head}, pinned ${SOL_PI_COMMIT} in ${checkout}`];
    const dirty = git(checkout, ['status', '--porcelain', '--untracked-files=all', '--ignored']);
    return dirty ? [`sol-pi: checkout differs from the pinned commit in ${checkout}: ${dirty.split('\n')[0]}`] : [];
  } catch (error) {
    return [`sol-pi: pinned checkout absent or unreadable in ${checkout}: ${String(error.message).split('\n')[0]}`];
  }
}

/** Fetch that one commit only; git's own object hashing ties the tree to the sha. No npm, no lifecycle scripts. */
export function installSolPi({ dir, env, privateDir, log = () => {} }) {
  const checkout = path.join(dir, SOL_PI_DIRECTORY);
  rmSync(checkout, { recursive: true, force: true });
  privateDir(checkout);
  log(`git fetch --depth 1 ${SOL_PI_PINS.repository} ${SOL_PI_COMMIT}`);
  git(checkout, ['init', '-q', '--template='], env);
  git(checkout, ['fetch', '-q', '--depth', '1', '--no-tags', SOL_PI_PINS.repository, SOL_PI_COMMIT], env);
  git(checkout, ['checkout', '-q', '--detach', 'FETCH_HEAD'], env);
  const problems = solPiCheckoutProblems(dir);
  if (problems.length) throw new Error(problems.join('; '));
  writeFileSync(path.join(dir, SOL_PI_CONFIG_FILE), `${JSON.stringify(SOL_PI_CONFIG, null, 2)}\n`, { mode: 0o600 });
}

/** What Pi itself activates for this arm, free of model calls: RPC mode with stdin closed starts
 *  the session and shuts it down. SoL-Pi registers its tools inside session_start, after an
 *  observer's own session_start handler ran, so the observer samples at session_shutdown. */
export function solPiLoadedTools(dir) {
  const piRuntime = requirePiRuntime();
  const scratch = mkdtempSync(path.join(dir, 'cache', 'sol-pi-probe-'));
  try {
    const observer = path.join(scratch, 'observer.js');
    const out = path.join(scratch, 'tools.json');
    writeFileSync(observer, `import { writeFileSync } from 'node:fs';
export default function (pi) {
  pi.on('session_shutdown', () => {
    const active = new Set(pi.getActiveTools());
    writeFileSync(${JSON.stringify(out)}, JSON.stringify({ active: [...active], fused: pi.getAllTools().filter((tool) => active.has(tool.name) && tool.parameters?.properties?.then_run).map((tool) => tool.name) }));
  });
}
`, { mode: 0o600 });
    const run = spawnSync(piRuntime.command, [...piRuntime.args, '--mode', 'rpc', '--no-session', '--no-skills', '--no-context-files', '-e', observer], {
      cwd: scratch, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, HOME: path.join(dir, 'home'), PI_CODING_AGENT_DIR: path.join(dir, 'agent'), PI_PACKAGE_DIR: path.join(dir, 'packages'), PI_CODING_AGENT_SESSION_DIR: path.join(dir, 'sessions'), PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_MCP_CONFIG_MODE: 'exclusive', npm_config_cache: path.join(dir, 'cache', 'npm'), XDG_CACHE_HOME: path.join(dir, 'cache') },
    });
    const tools = readJson(out);
    if (!tools) throw new Error(`pi exited ${run.status ?? run.signal ?? run.error?.message} before the observer wrote: ${String(run.stderr ?? '').trim().split('\n').slice(-3).join(' | ')}`);
    return tools;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Everything but the paid delivery proof: the pin, the checkout, the config and the live load. */
export function solPiMissing(dir, installed, settings) {
  const missing = [];
  // The recorded pin is compared here, not only written (lesson #13184).
  if (installed?.commit !== SOL_PI_COMMIT) missing.push(`sol-pi: pinned commit ${SOL_PI_COMMIT} absent in ${dir}`);
  missing.push(...solPiCheckoutProblems(dir));
  const loaded = settings?.packages?.filter((entry) => typeof entry !== 'string' || !entry.startsWith('npm:pi-mcp-adapter@'));
  if (loaded?.length !== 1 || JSON.stringify(loaded[0]) !== JSON.stringify(solPiPackage(dir))) missing.push(`sol-pi: only the pinned SoL-Pi extension may load beside pi-mcp-adapter in ${dir}`);
  if (JSON.stringify(readJson(path.join(dir, SOL_PI_CONFIG_FILE))) !== JSON.stringify(SOL_PI_CONFIG)) missing.push(`sol-pi: Action Fusion + ObservationPack config absent in ${path.join(dir, SOL_PI_CONFIG_FILE)}`);
  if (missing.length) return missing;
  try {
    const tools = solPiLoadedTools(dir);
    const absent = SOL_PI_PINS.tools.filter((name) => !tools.active.includes(name));
    if (absent.length) missing.push(`sol-pi: Pi did not activate ${absent.join(', ')}: ${tools.active.join(', ')}`);
    for (const name of ['edit', 'write']) if (!tools.fused.includes(name)) missing.push(`sol-pi: ${name} has no then_run; the built-in tool is active instead of Action Fusion`);
  } catch (error) {
    missing.push(`sol-pi: extension did not load on this Pi: ${error.message}`);
  }
  return missing;
}

/** Only Action Fusion's edit appends this marker; the built-in edit rejects or drops then_run. */
export function requireSolPiFusionProof(arm, toolResult) {
  if (arm !== 'sol-pi') return;
  if (!(toolResult?.content ?? []).some((part) => part.type === 'text' && part.text?.includes('[then_run:succeeded]'))) throw new Error('sol-pi: edit result has no [then_run:succeeded]; the built-in edit ran instead of Action Fusion');
}
