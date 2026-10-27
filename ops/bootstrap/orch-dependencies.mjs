// The installer and wizard share the dependency sets, their markers, npm resolution and argv.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { canonicalSearchDirs, resolveOnPath } from './resolve-runtime-path.mjs';

// Each set a checkout loads before a seat starts: its directory and the files that prove the install.
// `orch` marks what every orch command loads: skill-router imports yaml from the root, the hook
// checks import typescript from it. pi-runtime is the pinned Pi, which only a Pi seat loads.
export const DEPENDENCY_SETS = [
  { name: 'root', dir: '.', orch: true, markers: ['node_modules/yaml/package.json', 'node_modules/typescript/package.json'] },
  { name: 'orchestrator', dir: 'ops/orchestrator', orch: true, markers: ['node_modules/@modelcontextprotocol/sdk/package.json', 'node_modules/undici/package.json'] },
  { name: 'pi-runtime', dir: 'ops/pi-runtime', orch: false, markers: ['node_modules/@earendil-works/pi-coding-agent/package.json'] },
];
const ORCH_SET = DEPENDENCY_SETS[1];

// A checkout that ships no lockfile for a set has nothing to install there; the orchestrator set is always tried.
export const shippedSets = (repo) =>
  DEPENDENCY_SETS.filter((set) => set === ORCH_SET || existsSync(path.join(repo, set.dir, 'package-lock.json')));

// The installer stays synchronous; the wizard supplies its asynchronous runner.
export function orchDependencies(ctx, workdir, { set = ORCH_SET, runner = spawnSync, dryRun = false, onCommand = () => {} } = {}) {
  const absent = () => set.markers.filter((marker) => !existsSync(path.join(workdir, marker)));
  if (absent().length === 0) return { state: 'present' };
  // On Windows npm.cmd cannot be spawned without a shell; use npm-cli.js.
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  let file;
  let prefix = [];
  if (ctx.platform === 'win32' && process.platform === 'win32' && existsSync(npmCli)) {
    file = process.execPath;
    prefix = [npmCli];
  } else {
    file = resolveOnPath('npm', canonicalSearchDirs({ home: ctx.home, platform: ctx.platform, systemDirs: ctx.systemDirs }), {
      platform: ctx.platform,
    });
  }
  if (!file) return { state: 'missing', reason: `${set.name} dependencies: npm is not on the canonical search path` };
  // npm ci refuses the lockfile under a --prefix that crosses a symlink (EUSAGE,
  // "Missing: <directory>@<version> from lock file"), whatever its working directory: it gets the real path.
  const argv = [...prefix, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', realpathSync(workdir)];
  onCommand(file, argv);
  if (dryRun) return { state: 'planned' };
  const finish = (result) => {
    const left = absent();
    if (result.status !== 0 || left.length > 0) {
      const said = (result.stderr || result.stdout || result.error?.message || '').trim().slice(-400);
      // A zero exit can still leave a marker out: --omit=dev drops a package that is a devDependency there.
      const exit = result.status === 0 ? `0 without ${left.join(', ')}` : result.status;
      return { state: 'missing', reason: `${set.name} dependencies: ${[file, ...argv].join(' ')}: npm ci exited ${exit}: ${said}` };
    }
    return { state: 'installed', npm: file };
  };
  // An outer `npm run` exports its allow-scripts setting as npm_config_allow_scripts, and npm ci
  // refuses that flag in a project-scoped install ("--allow-scripts is not allowed in project-scoped
  // installs"). Without the variable the user's .npmrc still applies.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_allow[-_]scripts$/i.test(key)));
  const result = runner(file, argv, { encoding: 'utf8', shell: false, env });
  return result?.then ? result.then(finish) : finish(result);
}

// RPC seats only read the saved catalog. Refresh once after npm installs Pi,
// not on every installer run. Pi skips providers without a resolvable login.
export function refreshPiModels(ctx, workdir) {
  if (ctx.platform !== process.platform) {
    return { state: 'skipped', reason: `cross-platform install (${process.platform} -> ${ctx.platform}): refresh models on the target host after provider login` };
  }
  const agentDir = path.join(ctx.home, '.pi', 'agent');
  const bin = path.join(workdir, 'node_modules', '.bin', ctx.platform === 'win32' ? 'pi.cmd' : 'pi');
  const hint = `Log in to the provider in Pi (auth.json in ${JSON.stringify(agentDir)}), then set PI_CODING_AGENT_DIR to ${JSON.stringify(agentDir)} and run: ${JSON.stringify(bin)} update --models`;
  try {
    let file = bin;
    let prefix = [];
    if (ctx.platform === 'win32') {
      // Never spawn the .cmd shim through a shell.
      const packageDir = path.join(workdir, 'node_modules', '@earendil-works', 'pi-coding-agent');
      const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
      const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.pi;
      if (typeof entry !== 'string' || !entry) throw new Error('pinned Pi package declares no pi bin');
      file = process.execPath;
      prefix = [path.resolve(packageDir, entry)];
    }
    const result = spawnSync(file, [...prefix, 'update', '--models'], {
      encoding: 'utf8', shell: false, timeout: 60_000, killSignal: 'SIGKILL',
      env: {
        ...process.env, HOME: ctx.home, USERPROFILE: ctx.home, PI_CODING_AGENT_DIR: agentDir,
        PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
      },
    });
    if (result.status === 0 && !result.error) {
      let store = {};
      try { store = JSON.parse(readFileSync(path.join(agentDir, 'models-store.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const models = new Set(Object.values(store ?? {}).flatMap((entry) =>
        Array.isArray(entry?.models) ? entry.models.map((model) => model?.id) : []));
      // Loaded here, not at module load: install-harness imports this file, and a Node without
      // type stripping must still reach the installer's own Node >= 24 diagnostic.
      const { MODELS_OUTSIDE_PINNED_CATALOG } = createRequire(import.meta.url)('../orchestrator/src/model-input.ts');
      const missingModels = Object.keys(MODELS_OUTSIDE_PINNED_CATALOG).filter((model) => !models.has(model));
      return missingModels.length
        ? { state: 'incomplete', missingModels, hint }
        : { state: 'refreshed' };
    }
    const detail = (result.stderr || result.stdout || '').trim().slice(-400);
    return { state: 'failed', reason: `Pi model refresh: ${result.error?.message || `exit ${result.status}`}: ${detail}`, hint };
  } catch (error) {
    return { state: 'failed', reason: `Pi model refresh: ${error.message}`, hint };
  }
}
