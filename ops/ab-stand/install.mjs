#!/usr/bin/env node
// The stand is a separate Pi home, not a change to the operator's Pi install.
// Every dependency and cache created here belongs to one removable directory.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ARMS, CODEX_EDIT_CONFIG, CODEX_EDIT_INTEGRITY, CODEX_EDIT_PACKAGE, CODEX_EDIT_RESOURCES, CONTEXT_PRUNING_INTEGRITY, CONTEXT_PRUNING_PACKAGE, CONTEXT_PRUNING_PINS, HASHLINE_451_CONFIG, HASHLINE_451_PACKAGE, HASHLINE_451_TYPEBOX, HASHLINE_500_CONFIG, HASHLINE_500_INTEGRITY, HASHLINE_500_PACKAGE, HASHLINE_500_TYPEBOX, SERENA_COMMIT, requireCodexEditResources, standDirectory } from './arms.mjs';
// One verified codex-edit install path, shared with stock codex Pi seats.
import { ensureCodexEdit, verifiedTarball } from './codex-edit-install.mjs';
import { installProbe, stampProbeInstall } from './probe-install.mjs';
import { GITNEXUS_INTEGRITY, GITNEXUS_PACKAGE, GITNEXUS_PINS, gitnexusMcpServer, prepareGitnexusLock } from './gitnexus-install.mjs';
import { installJcodemunch, jcodemunchMcp, JCODEMUNCH_INTEGRITY, JCODEMUNCH_PYTHON } from './jcodemunch-install.mjs';
import { installOpenViking, OPENVIKING_CHAT_MODEL_SHA, OPENVIKING_MCP_URL, OPENVIKING_PACKAGE, OPENVIKING_WHEEL_SHA } from './openviking.mjs';
// sleev arm: pins, env, readiness and the gateway-status proof (ops/ab-stand/sleev.json).
import { SLEEV_BINARY_SHA256, SLEEV_PACKAGE, SLEEV_PLATFORM_INTEGRITY, SLEEV_PINS, SLEEV_STAND_ENV, SLEEV_WRAPPER_INTEGRITY, sleevMissingRequires } from './sleev-install.mjs';
import { installOllama } from './ollama.mjs';
// sol-pi arm: one pinned git commit, its config and its model-free load check (ops/ab-stand/sol-pi.json).
import { SOL_PI_COMMIT, SOL_PI_PINS, installSolPi, solPiMissing, solPiPackage } from './sol-pi-install.mjs';
import { syncStandAuth } from './auth.mjs';
import { requirePiRuntime } from './pi-runtime.mjs';
import { AGENT_LSP_INTEGRITIES, AGENT_LSP_PACKAGE, AGENT_LSP_PACKAGES, agentLspServer } from './agent-lsp-install.mjs';

const home = os.homedir();
const root = path.join(home, '.local', 'state', 'orch', 'ab-stand');
const live = path.join(home, '.pi', 'agent');
const arm = process.argv[2];
if (arm !== '--all' && !Object.hasOwn(ARMS, arm ?? '')) throw new Error(`usage: node ops/ab-stand/install.mjs --all | <${Object.keys(ARMS).join('|')}>`);
const arms = arm === '--all' ? Object.keys(ARMS) : [arm];
if (arms.includes('agent-lsp') && (process.platform !== 'darwin' || process.arch !== 'arm64')) throw new Error('agent-lsp stand profile is pinned for macOS arm64 only');
const npmPins = { 'context-mode': '1.0.169', 'pi-condense': '2.10.6', 'codebase-memory-mcp': '0.11.0', 'open-codebase-index': '0.32.1' };
const uvEnv = { UV_PYTHON_INSTALL_DIR: path.join(root, 'python'), UV_CACHE_DIR: path.join(root, 'cache', 'uv') };
// PI_PACKAGE_DIR is Pi's own distribution root (built-in themes live under
// dist), NOT the npm package cache. Copy its runtime assets into the arm.
const piRuntime = requirePiRuntime();
const piRoot = piRuntime.packageRoot;
function run(command, args, cwd, env = {}) {
  console.log(`stand install: ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd, env: { ...process.env, ...uvEnv, ...env }, stdio: 'inherit', timeout: 15 * 60_000 });
}
function privateDir(dir) {
  if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())) throw new Error(`unsafe stand path: ${dir}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}
function json(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function save(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); chmodSync(file, 0o600); }

privateDir(root);
for (const id of arms) {
  const dir = standDirectory(id);
  const agent = path.join(dir, 'agent');
  for (const part of [dir, agent, path.join(agent, 'extensions'), path.join(dir, 'cache'), path.join(dir, 'packages'), path.join(dir, 'sessions'), path.join(dir, 'home'), path.join(dir, 'hashline'), path.join(dir, 'home', '.local', 'state', 'memoryctl')]) privateDir(part);
  const memoryUrl = path.join(home, '.local', 'state', 'memoryctl', 'service.url');
  if (existsSync(memoryUrl)) copyFileSync(memoryUrl, path.join(dir, 'home', '.local', 'state', 'memoryctl', 'service.url')); 
  cpSync(path.join(piRoot, 'dist'), path.join(dir, 'packages', 'dist'), { recursive: true });
  copyFileSync(path.join(piRoot, 'package.json'), path.join(dir, 'packages', 'package.json'));
  const env = {
    HOME: path.join(dir, 'home'),
    PI_CODING_AGENT_DIR: agent,
    PI_PACKAGE_DIR: path.join(dir, 'packages'),
    PI_CODING_AGENT_SESSION_DIR: path.join(dir, 'sessions'),
    PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_MCP_CONFIG_MODE: 'exclusive',
    npm_config_cache: path.join(dir, 'cache', 'npm'), XDG_CACHE_HOME: path.join(dir, 'cache'),
  };
  // Never install a rotatable grant, including when this profile already exists.
  syncStandAuth(id);
  copyFileSync(path.join(live, 'extensions', 'rtk.ts'), path.join(agent, 'extensions', 'rtk.ts'));
  if (id === 'obs-mask') copyFileSync(new URL('./obs-mask.mjs', import.meta.url), path.join(agent, 'extensions', 'obs-mask.js'));
  const common = json(path.join(live, 'mcp-adapter.json'));
  const servers = Object.fromEntries(['codegraph', 'memoryctl'].map((name) => {
    if (!common.mcpServers?.[name]) throw new Error(`live Pi config lacks baseline ${name}`);
    return [name, common.mcpServers[name]];
  }));
  const settings = { packages: [...(id === 'hashline-edit' ? ['npm:pi-hashline-edit-pro@4.4.4'] : []), ...(id === 'hashline-edit-451' ? [`npm:${HASHLINE_451_PACKAGE}`] : []), ...(id === 'hashline-edit-500' ? [`npm:${HASHLINE_500_PACKAGE}`] : []), ...(id === 'billion-context' ? ['npm:billion-context-pi@0.1.82'] : []), ...(id === 'context-pruning' ? [`npm:${CONTEXT_PRUNING_PACKAGE}`] : [])], ...(id === 'pi-condense' ? { contextPrune: { enabled: true, autoBudgetThreshold: 0.8 } } : {}) };
  const mcp = { settings: { hostConfigDiscovery: 'off', jev: false, scriptMode: true }, mcpServers: servers };
  // Pi's package installer uses this profile's directories, not ~/.pi or .pi in a checkout.
  const packages = ['pi-mcp-adapter@5.3.2', ...(['context-mode', 'pi-condense', 'open-codebase-index'].includes(id) ? [`${id}@${npmPins[id]}`] : [])];
  save(path.join(agent, 'settings.json'), settings);
  for (const pkg of packages) run(piRuntime.command, [...piRuntime.args, 'install', `npm:${pkg}`], dir, env);
  if (id === 'hashline-edit' || id === 'hashline-edit-451' || id === 'hashline-edit-500') {
    // Audit condition: never `pi install` (its npm may run package scripts) and
    // never the stock Pi profile; npm lands the exact version in this arm's own
    // Pi package dir with scripts and audit disabled. rg must preexist: the
    // package downloads a ripgrep binary at runtime otherwise.
    const hashlinePackage = id === 'hashline-edit' ? 'pi-hashline-edit-pro@4.4.4' : id === 'hashline-edit-500' ? HASHLINE_500_PACKAGE : HASHLINE_451_PACKAGE;
    if (spawnSync('sh', ['-c', 'command -v rg'], { stdio: 'ignore' }).status !== 0) throw new Error(`${id}: rg must already be on PATH; pi-hashline-edit-pro downloads rg at runtime otherwise`);
    privateDir(path.join(agent, 'npm'));
    // Keep the adapter exact in every install into the shared Pi npm prefix.
    // 4.5.1 and 5.0.0 moved typebox to a peer ('*'), which --legacy-peer-deps does not
    // install, so the pin is named explicitly.
    const hashlinePeer = id === 'hashline-edit-451' ? HASHLINE_451_TYPEBOX : id === 'hashline-edit-500' ? HASHLINE_500_TYPEBOX : null;
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-save', '--no-package-lock', '--legacy-peer-deps', '--save-exact', '--prefix', path.join(agent, 'npm'), 'pi-mcp-adapter@5.3.2', hashlinePackage, ...(hashlinePeer ? [hashlinePeer] : [])], dir, env);
    if (!existsSync(path.join(agent, 'npm', 'node_modules', 'pi-hashline-edit-pro', 'package.json'))) throw new Error(`${hashlinePackage} missing after npm install`);
    if (hashlinePeer && !existsSync(path.join(agent, 'npm', 'node_modules', 'typebox', 'package.json'))) throw new Error(`${hashlinePeer} missing after npm install: a peer of ${hashlinePackage}`);
    // Keep built-in grep for every role: the package's default swaps grep for
    // anchor_grep, which no role's --tools list grants (pi.ts PI_READ_ONLY_TOOLS).
    // 4.5.1 adds copy/move tools, off for the trial so only read is replaced.
    // 5.0.0 adds replace_within. This trial turns it on (boolean true; a non-boolean falls back to true too) so the A/B measures it.
    save(path.join(dir, 'hashline', 'config.json'), id === 'hashline-edit-451' ? HASHLINE_451_CONFIG : id === 'hashline-edit-500' ? HASHLINE_500_CONFIG : { anchorGrepEnabled: false });
  }
  if (id === 'billion-context') {
    // Same audit conditions as hashline-edit; retain the adapter's exact pin.
    privateDir(path.join(agent, 'npm'));
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-save', '--no-package-lock', '--legacy-peer-deps', '--save-exact', '--prefix', path.join(agent, 'npm'), 'pi-mcp-adapter@5.3.2', 'billion-context-pi@0.1.82'], dir, env);
    if (!existsSync(path.join(agent, 'npm', 'node_modules', 'billion-context-pi', 'package.json'))) throw new Error('billion-context-pi@0.1.82 missing after npm install');
  }
  if (id === 'context-pruning') {
    // Same audit conditions as billion-context. Hash the tarball against the pinned
    // sha512 before npm sees it. Keep the adapter exact in the same command.
    privateDir(path.join(agent, 'npm'));
    const tarball = await verifiedTarball(path.join(dir, 'cache'), (line) => console.log(`stand install: ${line}`), CONTEXT_PRUNING_PINS);
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-save', '--no-package-lock', '--legacy-peer-deps', '--save-exact', '--prefix', path.join(agent, 'npm'), 'pi-mcp-adapter@5.3.2', tarball], dir, env);
    if (!existsSync(path.join(agent, 'npm', 'node_modules', 'pi-dynamic-context-pruning', 'package.json'))) throw new Error(`${CONTEXT_PRUNING_PACKAGE} missing after npm install`);
  }
  if (id === 'sleev') {
    // sleev is a CLI plus local gateway, not a Pi package: it goes into the arm's
    // root npm prefix, which standEnv puts first on the seat PATH, and Pi reaches
    // the gateway through agent/models.json, which sleev itself edits under
    // PI_CODING_AGENT_DIR. Both tarballs are hashed against the pinned sha512
    // before npm sees them, and the platform tarball is named in the same command
    // so npm satisfies the wrapper's sleev-darwin-arm64 optional dependency from
    // verified bytes, never the registry. Guest mode is the account-free local
    // mode: a signed-out `sleev setup --yes` accepts the guest legal terms
    // without a prompt, writes the gateway config under the arm HOME and
    // registers the gateway LaunchAgent (its plist lives in the arm home; see
    // README for rollback).
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('sleev: the pinned sleev-darwin-arm64 package runs on macOS arm64 only');
    privateDir(path.join(dir, 'npm'));
    const log = (line) => console.log(`stand install: ${line}`);
    const wrapperTarball = await verifiedTarball(path.join(dir, 'cache'), log, SLEEV_PINS.wrapper);
    const platformTarball = await verifiedTarball(path.join(dir, 'cache'), log, SLEEV_PINS.platform);
    run('npm', ['install', '--prefix', path.join(dir, 'npm'), '--ignore-scripts', '--no-audit', '--no-save', '--no-package-lock', '--save-exact', wrapperTarball, platformTarball], dir, env);
    const sleev = path.join(dir, 'npm', 'node_modules', '.bin', 'sleev');
    const sleevEnv = { ...env, ...SLEEV_STAND_ENV };
    run(sleev, ['setup', '--yes'], dir, sleevEnv);
    run(sleev, ['harness', 'pi', 'enable', 'qwen-token-plan'], dir, sleevEnv);
    // Sleev 1.8.5 names Bailian qwen-token-plan; orch's qwen pilot uses
    // qwen-token-plan-individual. Apply the CLI's gateway override to that
    // provider too, without replacing any existing models or credentials.
    const modelsFile = path.join(agent, 'models.json');
    const models = json(modelsFile);
    const gateway = models.providers?.['qwen-token-plan'];
    if (!gateway?.baseUrl || !gateway.headers?.['sleev-provider']) throw new Error('sleev: Pi harness did not write the Qwen gateway provider');
    const pilot = models.providers['qwen-token-plan-individual'] ?? {};
    models.providers['qwen-token-plan-individual'] = { ...pilot, baseUrl: gateway.baseUrl, headers: { ...pilot.headers, ...gateway.headers } };
    save(modelsFile, models);
  }
  if (id === 'codex-edit') {
    // The shared verified install (codex-edit-install.mjs) checks the registry
    // integrity and tarball origin, hashes the bytes against the pinned sha512
    // before npm sees them, installs that local tarball with --ignore-scripts and
    // writes the arm-local config.json that allows gpt-6.1-sol exclusively.
    // force: an arm install always re-downloads and replaces the tree, as before.
    privateDir(path.join(agent, 'npm'));
    const verified = await ensureCodexEdit(path.join(agent, 'npm'), {
      force: true, extraPackages: ['pi-mcp-adapter@5.3.2'], cacheDir: path.join(dir, 'cache'), env, cwd: dir,
      log: (line) => console.log(`stand install: ${line}`),
    });
    console.log(`codex-edit: verified ${CODEX_EDIT_INTEGRITY}; extension ${verified.extension}`);
    const installedSettings = json(path.join(agent, 'settings.json'));
    installedSettings.packages.push(CODEX_EDIT_RESOURCES);
    save(path.join(agent, 'settings.json'), installedSettings);
    const resources = requireCodexEditResources(dir);
    console.log(`codex-edit: Pi enabled resources ${JSON.stringify(Object.fromEntries(['extensions', 'skills', 'prompts', 'themes'].map((type) => [type, resources[type].filter((entry) => entry.enabled)])))}`);
  }
  if (id === 'sol-pi') {
    // Not `pi install git:` and not npm: Pi's git packages run npm install, and the registry
    // name `sol-pi` is not upstream's. One commit is fetched and checked out into this arm,
    // verified against the pin, and loaded as a local package: Pi supplies its SDK and typebox.
    installSolPi({ dir, env, privateDir, log: (line) => console.log(`stand install: ${line}`) });
    const installedSettings = json(path.join(agent, 'settings.json'));
    installedSettings.packages.push(solPiPackage(dir));
    save(path.join(agent, 'settings.json'), installedSettings);
  }
  if (id === 'context-mode' || id === 'codebase-memory-mcp') {
    privateDir(path.join(dir, 'npm'));
    run('npm', ['install', '--prefix', path.join(dir, 'npm'), '--no-save', '--no-package-lock', '--save-exact', `${id}@${npmPins[id]}`], dir, env);
    const bin = path.join(dir, 'npm', 'node_modules', '.bin', id);
    if (!existsSync(bin)) throw new Error(`${id} executable missing after npm install`);
    mcp.mcpServers[id] = {
      command: bin, args: [], inheritEnv: false, lifecycle: 'lazy',
      env: { SEAT_POLICY_ROLE: '${SEAT_POLICY_ROLE}', ...(id === 'context-mode' ? { CONTEXT_MODE_DIR: path.join(dir, 'context-mode') } : { CBM_CACHE_DIR: path.join(dir, 'cbm'), XDG_CACHE_HOME: path.join(dir, 'cache') }) },
    };
  }
  if (id === 'agent-lsp') {
    privateDir(path.join(dir, 'npm'));
    privateDir(path.join(dir, 'cache', 'tmp'));
    const tarballs = [];
    for (const pin of AGENT_LSP_PACKAGES) tarballs.push(await verifiedTarball(path.join(dir, 'cache'), (line) => console.log(`stand install: ${line}`), pin));
    // Separate MCP prefix: Pi's saved adapter prefix is not modified. Install
    // the verified native package explicitly, omitting other optional binaries.
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-save', '--no-package-lock', '--save-exact', '--omit=optional', '--prefix', path.join(dir, 'npm'), ...tarballs], dir, env);
    for (const pin of AGENT_LSP_PACKAGES) {
      if (json(path.join(dir, 'npm', 'node_modules', pin.package, 'package.json')).version !== pin.version) throw new Error(`agent-lsp: expected ${pin.package}@${pin.version} after install`);
    }
    mcp.mcpServers['agent-lsp'] = agentLspServer(dir);
    if (!existsSync(mcp.mcpServers['agent-lsp'].command) || !existsSync(path.join(dir, 'npm', 'node_modules', '.bin', 'typescript-language-server'))) throw new Error('agent-lsp: native binary or TypeScript language server absent after install');
  }
  if (id === 'serena' || id === 'aider-repo-map') {
    if (!existsSync(path.join(root, 'python', 'cpython-3.12-macos-aarch64-none', 'bin', 'python3.12'))) run('uv', ['python', 'install', '3.12'], dir);
    if (!existsSync(path.join(dir, 'venv', 'bin', 'python'))) run('uv', ['venv', '--python', '3.12', path.join(dir, 'venv')], dir);
    run('uv', ['pip', 'install', '--python', path.join(dir, 'venv', 'bin', 'python'), id === 'serena' ? `git+https://github.com/oraios/serena.git@${SERENA_COMMIT}` : 'aider-chat==0.86.1'], dir);
    // Aider pins scipy 1.15.3, whose macOS wheel cannot be dlopen'd on this
    // macOS 27 host (__thread_bss offset). 1.16.2 imports and produces the map.
    // The override is confined to this venv; never change the host Python.
    if (id === 'aider-repo-map') run('uv', ['pip', 'install', '--python', path.join(dir, 'venv', 'bin', 'python'), '--no-deps', 'scipy==1.16.2'], dir);
    if (id === 'serena') mcp.mcpServers.serena = {
      command: path.join(dir, 'venv', 'bin', 'serena'), args: ['start-mcp-server', '--context', 'ide-assistant', '--project-from-cwd', '--enable-web-dashboard', 'false', '--open-web-dashboard', 'false', '--enable-gui-log-window', 'false'],
      inheritEnv: false, lifecycle: 'lazy', env: { SEAT_POLICY_ROLE: '${SEAT_POLICY_ROLE}', XDG_CACHE_HOME: path.join(dir, 'cache') },
    };
  }
  if (id === 'probe') mcp.mcpServers.probe = await installProbe({ dir, env, run, privateDir });
  if (id === 'gitnexus') {
    // MCP CLI in this arm's npm prefix, not the Pi package prefix: that prefix
    // already holds pi-mcp-adapter, and a later npm install there re-resolves it.
    // Hash the tarball against the pinned sha512 before npm sees it.
    privateDir(path.join(dir, 'npm'));
    privateDir(path.join(dir, 'gitnexus'));
    privateDir(path.join(dir, 'gitnexus', 'storage'));
    prepareGitnexusLock(path.join(dir, 'npm'));
    // Keep the independent top-level tarball verification; ci also enforces the lock's integrity.
    await verifiedTarball(path.join(dir, 'cache'), (line) => console.log(`stand install: ${line}`), GITNEXUS_PINS);
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--prefix', path.join(dir, 'npm')], dir, env);
    const bin = path.join(dir, 'npm', 'node_modules', '.bin', 'gitnexus');
    if (!existsSync(bin)) throw new Error(`${GITNEXUS_PACKAGE} executable missing after npm install`);
    const installedVersion = json(path.join(dir, 'npm', 'node_modules', 'gitnexus', 'package.json'))?.version;
    if (installedVersion !== GITNEXUS_PINS.version) throw new Error(`gitnexus version ${installedVersion ?? 'missing'}, pinned ${GITNEXUS_PINS.version}`);
    mcp.mcpServers.gitnexus = gitnexusMcpServer(dir, bin);
  }
  if (id === 'jcodemunch') {
    await installJcodemunch({ dir, root, run, privateDir, log: (line) => console.log(`stand install: ${line}`) });
    mcp.mcpServers.jcodemunch = jcodemunchMcp(dir);
  }
  if (id === 'openviking') {
    // PyPI context database in the serena uv shape, from a sha256-verified wheel
    // (ops/ab-stand/openviking.mjs). Its MCP entry is a URL on the arm-local server
    // that smoke/run start on 127.0.0.1:11497 for exactly their duration.
    mcp.mcpServers.openviking = { url: OPENVIKING_MCP_URL };
    await installOpenViking(dir);
  }
  save(path.join(agent, 'mcp-adapter.json'), mcp);
  if (id === 'open-codebase-index') await installOllama();
  // A prior delivery proof is invalid after installation changes; the runner
  // requires a fresh successful stand-seat smoke before a third-party arm runs.
  save(path.join(dir, 'install.json'), { arm: id, packages, npm: npmPins[id] ?? ({ 'hashline-edit': 'pi-hashline-edit-pro@4.4.4', 'hashline-edit-451': HASHLINE_451_PACKAGE, 'hashline-edit-500': HASHLINE_500_PACKAGE, 'billion-context': 'billion-context-pi@0.1.82', 'context-pruning': CONTEXT_PRUNING_PACKAGE, 'agent-lsp': AGENT_LSP_PACKAGE, 'sleev': SLEEV_PACKAGE }[id] ?? null), python: id === 'serena' ? 'serena v1.7.0' : id === 'aider-repo-map' ? 'aider-chat==0.86.1' : id === 'openviking' ? OPENVIKING_PACKAGE : null, ...(id === 'codex-edit' ? { integrity: CODEX_EDIT_INTEGRITY, toolkit: CODEX_EDIT_PACKAGE, configOverride: CODEX_EDIT_CONFIG } : id === 'hashline-edit-500' ? { integrity: HASHLINE_500_INTEGRITY } : id === 'context-pruning' ? { integrity: CONTEXT_PRUNING_INTEGRITY } : id === 'agent-lsp' ? { integrities: AGENT_LSP_INTEGRITIES } : id === 'openviking' ? { wheel: OPENVIKING_WHEEL_SHA, modelManifest: OPENVIKING_CHAT_MODEL_SHA } : id === 'sleev' ? { integrity: SLEEV_WRAPPER_INTEGRITY, platformIntegrity: SLEEV_PLATFORM_INTEGRITY, binarySha256: SLEEV_BINARY_SHA256 } : id === 'sol-pi' ? { git: SOL_PI_PINS.repository, commit: SOL_PI_COMMIT } : {}) });
  if (id === 'sol-pi') {
    // Proves the pinned extension loads on this Mac's Pi before any paid smoke.
    const problems = solPiMissing(dir, json(path.join(dir, 'install.json')), json(path.join(agent, 'settings.json')));
    if (problems.length) throw new Error(`sol-pi: install did not verify: ${problems.join('; ')}`);
  }
  if (id === 'sleev') {
    // Readiness needs both the harness-generated models and this install record.
    const problems = sleevMissingRequires(dir, { skipDeliveryProof: true });
    if (problems.length) throw new Error(`sleev: install did not verify: ${problems.join('; ')}`);
  }
  if (id === 'probe') save(path.join(dir, 'install.json'), stampProbeInstall(json(path.join(dir, 'install.json'))));
  if (id === 'gitnexus') {
    const record = json(path.join(dir, 'install.json'));
    record.npm = GITNEXUS_PACKAGE;
    record.integrity = GITNEXUS_INTEGRITY;
    save(path.join(dir, 'install.json'), record);
  }
  if (id === 'jcodemunch') {
    const record = json(path.join(dir, 'install.json'));
    record.python = JCODEMUNCH_PYTHON;
    record.integrity = JCODEMUNCH_INTEGRITY;
    save(path.join(dir, 'install.json'), record);
  }
  console.log(`${id}: installed in ${dir}; prove delivery with smoke.mjs --arm ${id}`);
}
console.log(`Rollback (after closing stand seats/servers): rm -rf -- '${root}'`);
