// An arm is armed only by its own isolated Pi profile and an observed seat
// delivery, never by a name in the live ~/.pi/agent/mcp-adapter.json.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The codex-edit pins live in codex-edit.json: one source for this arm, the
// verified installer and stock codex Pi seats (ops/orchestrator/src/codex-edit.ts).
import { CODEX_EDIT_CONFIG, CODEX_EDIT_FILES, CODEX_EDIT_INTEGRITY, CODEX_EDIT_PACKAGE, CODEX_EDIT_PACKAGE_DIRECTORY, CODEX_EDIT_PINS } from './codex-edit-install.mjs';
import { HASHLINE_451_PACKAGE, HASHLINE_451_TYPEBOX, HASHLINE_451_CONFIG, HASHLINE_500_PACKAGE, HASHLINE_500_TYPEBOX, HASHLINE_500_CONFIG, HASHLINE_500_INTEGRITY } from './hashline-edit-install.mjs';
import { CONTEXT_PRUNING_INTEGRITY, CONTEXT_PRUNING_PACKAGE, CONTEXT_PRUNING_PINS } from './context-pruning-install.mjs';
import { AGENT_LSP_INTEGRITIES, AGENT_LSP_PACKAGE, AGENT_LSP_PACKAGES, agentLspServer } from './agent-lsp-install.mjs';
import { PROBE_INTEGRITY, PROBE_PACKAGE, probeReady } from './probe-install.mjs';
import { GITNEXUS_PACKAGE, gitnexusReadinessProblems } from './gitnexus-install.mjs';
import { JCODEMUNCH_TOOL, jcodemunchMissing } from './jcodemunch-install.mjs';
import { OPENVIKING_CHAT_MODEL_MANIFEST, OPENVIKING_CHAT_MODEL_SHA, OPENVIKING_MCP_URL, OPENVIKING_PACKAGE, OPENVIKING_PINS, OPENVIKING_WHEEL_SHA } from './openviking.mjs';
import { sleevMissingRequires } from './sleev-install.mjs';
import { SOL_PI_CONFIG_FILE, solPiMissing } from './sol-pi-install.mjs';

// Resolved refs/tags/v1.7.0; do not install from a movable tag.
export const SERENA_COMMIT = '949a27ef1e5fda1a6e7b561e777bcece345c6ffd';

export { CODEX_EDIT_CONFIG, CODEX_EDIT_FILES, CODEX_EDIT_INTEGRITY, CODEX_EDIT_PACKAGE };
/** Arm-relative: this arm's npm prefix is <arm>/agent/npm. */
export const CODEX_EDIT_DIRECTORY = `agent/npm/${CODEX_EDIT_PACKAGE_DIRECTORY}`;
export const CODEX_EDIT_RESOURCES = { source: `npm:${CODEX_EDIT_PACKAGE}`, extensions: [CODEX_EDIT_PINS.extension], skills: [], prompts: [], themes: [] };

// One pin source; values and serialized stand profile bytes stay unchanged.
export { HASHLINE_451_PACKAGE, HASHLINE_451_TYPEBOX, HASHLINE_451_CONFIG };
export { HASHLINE_500_PACKAGE, HASHLINE_500_TYPEBOX, HASHLINE_500_CONFIG, HASHLINE_500_INTEGRITY };
export { CONTEXT_PRUNING_INTEGRITY, CONTEXT_PRUNING_PACKAGE, CONTEXT_PRUNING_PINS };

export const ARMS = {
  base: { instruments: null },
  // Base Pi profile/tools; only orch's lesson injection differs.
  'no-lessons': { instruments: null },
  'no-codegraph': { instruments: { codegraph: false } },
  'context-mode': { instruments: null, requires: { package: 'context-mode@1.0.169', mcp: 'context-mode', tool: 'context-mode_ctx_stats' } },
  'pi-condense': { instruments: null, requires: { package: 'pi-condense@2.10.6', tool: 'context_tree_query' } },
  // No tool of its own: smoke proves the live /context-pruning handler, and bash is the observed delivery call.
  'context-pruning': { instruments: null, requires: { package: CONTEXT_PRUNING_PACKAGE, tool: 'bash' } },
  // `hint` is appended to the fixture brief (run.mjs): the seat's role context names only rg and
  // codegraph, so an arm's tool that the brief never mentions is never called.
  'agent-lsp': { instruments: { codegraph: false }, requires: { npm: AGENT_LSP_PACKAGE, mcp: 'agent-lsp', tool: 'agent-lsp_list_symbols' },
    // An ordering rule with a first call, not a mention: the one-sentence form of this hint got zero LSP calls
    // from qwen3.8-max at low effort (scout-1, 2026-10-01).
    hint: 'Rule for this seat: locate every symbol with the agent-lsp MCP server before any bash, rg or read call. Call the `mcp` tool with server "agent-lsp" and tool "list_symbols" (args: file_path), "find_symbol", "find_references", "go_to_definition" or "find_callers". Start with list_symbols on the file the task names. Fall back to rg only after an agent-lsp call has failed.' },
  // Code search MCP, measured against base's codegraph: the arm turns codegraph off, like serena.
  probe: { instruments: { codegraph: false }, requires: { npm: PROBE_PACKAGE, mcp: 'probe', tool: 'search_code' },
    hint: 'This seat has the probe MCP server (mcp gateway, server "probe", tool search_code with path and query). Use it to find code, before grep or rg.' },
  gitnexus: { instruments: { codegraph: false }, requires: { npm: GITNEXUS_PACKAGE, mcp: 'gitnexus', tool: 'query' },
    hint: 'This seat has the gitnexus MCP server (mcp gateway, server "gitnexus", tool query with search_query). Use it to find code and its relations, before grep or rg.' },
  // Code index. codegraph is off, as on serena and the other code-index arms, so the trial is jcodemunch.
  jcodemunch: { instruments: { codegraph: false }, requires: { mcp: 'jcodemunch', tool: JCODEMUNCH_TOOL },
    hint: 'This seat has the jcodemunch MCP server (mcp gateway, server "jcodemunch", tool jcodemunch_order): a code index of this repository. Use it to find symbols and code, before grep or rg.' },
  // AGPL-3.0 context database behind an arm-local MCP server; navigation goes through
  // it instead of codegraph (off here), and smoke proves openviking_grep on real content.
  openviking: { instruments: { codegraph: false }, requires: { python: OPENVIKING_PACKAGE, tool: 'openviking_grep' } },
  // CLI + local gateway, not a Pi package: readiness lives in sleev-install.mjs and
  // smoke proves the live gateway by a seat `sleev gateway status` bash call.
  sleev: { instruments: null, requires: { tool: 'bash' } },
  'obs-mask': { instruments: null, requires: { extension: 'obs-mask.js', tool: 'bash' } },
  'hashline-edit': { instruments: null, requires: { package: 'pi-hashline-edit-pro@4.4.4', tool: 'read' } },
  'hashline-edit-451': { instruments: null, requires: { package: HASHLINE_451_PACKAGE, tool: 'read' } },
  'hashline-edit-500': { instruments: null, requires: { package: HASHLINE_500_PACKAGE, tool: 'read' } },
  // Git checkout of one pinned commit, not an npm package: readiness lives in sol-pi-install.mjs.
  // Action Fusion re-registers edit and write under their built-in names; smoke proves a fused edit.
  'sol-pi': { instruments: null, requires: { tool: 'edit' } },
  'billion-context': { instruments: null, requires: { package: 'billion-context-pi@0.1.82', tool: 'acp_status' } },
  'codex-edit': { instruments: null, requires: { package: CODEX_EDIT_PACKAGE, tool: 'apply_patch' } },
  'codebase-memory-mcp': { instruments: { codegraph: false }, requires: { npm: 'codebase-memory-mcp@0.11.0', mcp: 'codebase-memory-mcp', tool: 'index_repository' } },
  'open-codebase-index': { instruments: { codegraph: false }, requires: { package: 'open-codebase-index@0.32.1', tool: 'codebase_context' } },
  'aider-repo-map': { instruments: { codegraph: false }, requires: { python: 'aider-chat==0.86.1', binary: 'aider', tool: 'bash' } },
  serena: { instruments: { codegraph: false }, requires: { python: 'serena v1.7.0', mcp: 'serena', tool: 'serena_find_symbol' } },
};

export function standDirectory(arm, home = os.homedir()) {
  if (!Object.hasOwn(ARMS, arm)) throw new Error(`unknown arm '${arm}'`);
  return path.join(home, '.local', 'state', 'orch', 'ab-stand', 'arms', arm);
}
export function seatMcpJson(arm, home = os.homedir()) {
  return path.join(standDirectory(arm, home), 'agent', 'mcp-adapter.json');
}
function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
export function profileHash(dir) {
  const hash = createHash('sha256');
  const arm = readJson(path.join(dir, 'install.json'))?.arm;
  for (const file of ['install.json', 'agent/settings.json', 'agent/mcp-adapter.json', ...(arm === 'obs-mask' ? ['agent/extensions/obs-mask.js'] : []), ...(arm === 'codex-edit' ? CODEX_EDIT_FILES.map((file) => `${CODEX_EDIT_DIRECTORY}/${file}`) : []), ...(arm === 'hashline-edit-451' || arm === 'hashline-edit-500' ? ['hashline/config.json'] : []), ...(arm === 'sleev' ? ['agent/models.json'] : []), ...(arm === 'sol-pi' ? [SOL_PI_CONFIG_FILE] : [])]) hash.update(readFileSync(path.join(dir, file)));
  return hash.digest('hex');
}

/** Resolve with Pi itself, without loading extension code or making model turns. */
export function requireCodexEditResources(dir, cwd = dir) {
  return JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('./codex-edit-resources.mjs', import.meta.url)), dir, cwd], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, HOME: path.join(dir, 'home'), PI_CODING_AGENT_DIR: path.join(dir, 'agent'), PI_PACKAGE_DIR: path.join(dir, 'packages'), PI_OFFLINE: '1', PI_TELEMETRY: '0', npm_config_cache: path.join(dir, 'cache', 'npm'), XDG_CACHE_HOME: path.join(dir, 'cache') },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

/** Local readiness is not delivery: the smoke marker records a real tool call. */
export function missingRequires(arm, deps = {}) {
  if (!Object.hasOwn(ARMS, arm)) return [`unknown arm '${arm}'; known arms: ${Object.keys(ARMS).join(', ')}`];
  const dir = deps.dir ?? standDirectory(arm);
  const installed = readJson(path.join(dir, 'install.json'));
  const settings = readJson(path.join(dir, 'agent', 'settings.json'));
  const mcp = readJson(path.join(dir, 'agent', 'mcp-adapter.json'));
  const packageVersion = (name) => readJson(path.join(dir, 'agent', 'npm', 'node_modules', name, 'package.json'))?.version;
  if (installed?.arm !== arm || !settings || !mcp || !settings.packages?.includes('npm:pi-mcp-adapter@5.3.2') || packageVersion('pi-mcp-adapter') !== '5.3.2' || mcp.settings?.hostConfigDiscovery !== 'off' || mcp.settings?.scriptMode !== true) return [`isolated Pi profile not installed in ${dir}`];
  const need = ARMS[arm].requires;
  if (!need) return [];
  const missing = [];
  if (need.extension && (!existsSync(path.join(dir, 'agent', 'extensions', need.extension)) ||
    !readFileSync(path.join(dir, 'agent', 'extensions', need.extension)).equals(readFileSync(new URL('./obs-mask.mjs', import.meta.url))))) missing.push(`local Pi extension ${need.extension} absent or stale in ${dir}`);
  if (need.package) {
    const at = need.package.lastIndexOf('@');
    const name = need.package.slice(0, at), version = need.package.slice(at + 1);
    if (!settings.packages?.some((entry) => (typeof entry === 'string' ? entry : entry?.source) === `npm:${need.package}`) || packageVersion(name) !== version) missing.push(`Pi package ${need.package} absent in ${dir}`);
  }
  // grep must survive the trial: the package swaps grep for anchor_grep when
  // anchorGrepEnabled, but no role's --tools list grants anchor_grep (pi.ts).
  const hashlineArm = arm === 'hashline-edit' || arm === 'hashline-edit-451' || arm === 'hashline-edit-500';
  const hashlineConfig = hashlineArm ? readJson(path.join(dir, 'hashline', 'config.json')) : null;
  if (hashlineArm && hashlineConfig?.anchorGrepEnabled !== false) missing.push(`hashline grep config anchorGrepEnabled:false absent in ${dir}`);
  if (arm === 'hashline-edit-451' || arm === 'hashline-edit-500') {
    if (hashlineConfig?.copyMoveEnabled !== false) missing.push(`hashline copy/move config copyMoveEnabled:false absent in ${dir}`);
    const typebox = arm === 'hashline-edit-500' ? HASHLINE_500_TYPEBOX : HASHLINE_451_TYPEBOX;
    const pinned = arm === 'hashline-edit-500' ? HASHLINE_500_PACKAGE : HASHLINE_451_PACKAGE;
    if (packageVersion('typebox') !== typebox.slice(typebox.indexOf('@') + 1)) missing.push(`peer ${typebox} of ${pinned} absent in ${dir}`);
  }
  if (arm === 'hashline-edit-500' && hashlineConfig?.replaceWithinEnabled !== true) missing.push(`hashline replace_within config replaceWithinEnabled:true absent in ${dir}`);
  if (arm === 'hashline-edit-500' && installed.integrity !== HASHLINE_500_INTEGRITY) missing.push(`hashline-edit-500: pinned integrity absent in ${dir}`);
  if (arm === 'context-pruning' && installed.integrity !== CONTEXT_PRUNING_INTEGRITY) missing.push(`context-pruning: pinned integrity absent in ${dir}`);
  if (arm === 'probe') {
    if (installed.integrity !== PROBE_INTEGRITY) missing.push(`probe: pinned integrity absent in ${dir}`);
    missing.push(...probeReady(dir));
  }
  if (arm === 'gitnexus') missing.push(...gitnexusReadinessProblems(dir, installed, mcp));
  if (arm === 'jcodemunch') missing.push(...jcodemunchMissing(dir, installed, mcp));
  if (arm === 'sleev') missing.push(...sleevMissingRequires(dir));
  if (arm === 'sol-pi') missing.push(...solPiMissing(dir, installed, settings));
  if (arm === 'codex-edit') {
    const toolkit = settings.packages?.filter((entry) => (typeof entry === 'string' ? entry : entry?.source)?.startsWith('npm:@maxiaochao/pi-toolkit'));
    if (toolkit?.length !== 1 || JSON.stringify(toolkit[0]) !== JSON.stringify(CODEX_EDIT_RESOURCES)) missing.push(`codex-edit: only the filtered codex-edit extension may load in ${dir}`);
    try { requireCodexEditResources(dir); } catch (error) { missing.push(`codex-edit: Pi resource resolution refused: ${error.message}`); }
    if (JSON.stringify(readJson(path.join(dir, CODEX_EDIT_DIRECTORY, 'config.json'))) !== JSON.stringify(CODEX_EDIT_CONFIG) || installed.integrity !== CODEX_EDIT_INTEGRITY) missing.push(`codex-edit: verified integrity + gpt-6.1-sol config absent in ${dir}`);
  }
  if (need.npm) {
    const at = need.npm.lastIndexOf('@');
    const name = need.npm.slice(0, at), version = need.npm.slice(at + 1);
    if (readJson(path.join(dir, 'npm', 'node_modules', name, 'package.json'))?.version !== version) missing.push(`local npm ${need.npm} absent in ${dir}`);
  }
  if (arm === 'agent-lsp') {
    for (const pin of AGENT_LSP_PACKAGES) {
      if (readJson(path.join(dir, 'npm', 'node_modules', pin.package, 'package.json'))?.version !== pin.version ||
        installed.integrities?.[pin.package] !== AGENT_LSP_INTEGRITIES[pin.package]) missing.push(`agent-lsp: verified ${pin.package}@${pin.version} absent in ${dir}`);
    }
    // Whole-object compare on purpose: env.PATH names the node that runs the
    // language-server shim, so every segment is pinned (lesson #13264). Node moved
    // (brew upgrade): reinstall the arm.
    if (JSON.stringify(mcp.mcpServers?.['agent-lsp']) !== JSON.stringify(agentLspServer(dir)) ||
      !existsSync(path.join(dir, 'npm', 'node_modules', '.bin', 'typescript-language-server'))) missing.push(`agent-lsp: isolated TypeScript MCP config absent or stale in ${dir}`);
  }
  if (need.python) {
    const [name, version] = arm === 'serena' ? ['serena_agent', '1.7.0'] : arm === 'openviking' ? [OPENVIKING_PINS.package, OPENVIKING_PINS.version] : ['aider_chat', '0.86.1'];
    const metadata = path.join(dir, 'venv', 'lib', 'python3.12', 'site-packages', `${name}-${version}.dist-info`, 'METADATA');
    if (installed.python !== need.python || !existsSync(metadata) || !readFileSync(metadata, 'utf8').includes(`Version: ${version}\n`)) missing.push(`Python package ${need.python} absent in ${dir}`);
    if (arm === 'serena') {
      const origin = readJson(path.join(path.dirname(metadata), 'direct_url.json'));
      if (origin?.url !== 'https://github.com/oraios/serena.git' || origin.vcs_info?.vcs !== 'git' ||
        origin.vcs_info?.commit_id !== SERENA_COMMIT) missing.push(`Serena git commit ${SERENA_COMMIT} absent in ${dir}`);
    }
  }
  if (need.binary && !existsSync(path.join(dir, 'venv', 'bin', need.binary))) missing.push(`binary ${need.binary} absent in ${dir}`);
  if (arm === 'openviking') {
    // A URL MCP server, not a command: the shared need.mcp check resolves a command
    // inside the arm and cannot judge a url entry, so this arm checks its own pin.
    if (mcp.mcpServers?.openviking?.url !== OPENVIKING_MCP_URL) missing.push(`openviking MCP url ${OPENVIKING_MCP_URL} absent in ${seatMcpJson(arm)}`);
    if (installed.wheel !== OPENVIKING_WHEEL_SHA) missing.push(`openviking: pinned wheel sha256 absent in ${dir}`);
    if (!existsSync(OPENVIKING_CHAT_MODEL_MANIFEST) || createHash('sha256').update(readFileSync(OPENVIKING_CHAT_MODEL_MANIFEST)).digest('hex') !== OPENVIKING_CHAT_MODEL_SHA) missing.push(`openviking: Ollama chat model digest pin absent at ${OPENVIKING_CHAT_MODEL_MANIFEST}`);
  }
  if (need.mcp && (!mcp.mcpServers?.[need.mcp] || !path.resolve(mcp.mcpServers[need.mcp].command).startsWith(`${dir}${path.sep}`) || !existsSync(mcp.mcpServers[need.mcp].command))) missing.push(`MCP server ${need.mcp} absent in ${seatMcpJson(arm)}`);
  const proof = readJson(path.join(dir, 'delivery.json'));
  let hash;
  try { hash = profileHash(dir); } catch { /* missing profile: refuse */ }
  if (proof?.arm !== arm || proof.profileHash !== hash || !proof.tools?.includes(need.tool) || !proof.rtkCommand?.startsWith('rtk ') || (arm === 'codex-edit' && proof.model !== 'gpt-6.1-sol') || (arm === 'context-pruning' && !/Dynamic context pruning: ENABLED[\s\S]*Last call: raw=\d+ tok/.test(proof?.status ?? '')) || (arm === 'agent-lsp' && proof?.agentLspSymbol !== 'isStandArm') || (arm === 'sol-pi' && proof?.fused !== true)) missing.push(`stand seat tool ${need.tool} + rtk not observed; run smoke.mjs --arm ${arm}`);
  return missing;
}

/** A loaded pi-dynamic-context-pruning answers /context-pruning status ENABLED and, after a real turn, with a context-hook snapshot. Installed-but-not-loaded has no handler; a stood-down config says disabled and has no snapshot. */
export function requireContextPruningProof(arm, statusText) {
  if (arm !== 'context-pruning') return;
  if (!/Dynamic context pruning: ENABLED[\s\S]*Last call: raw=\d+ tok/.test(statusText ?? '')) throw new Error('context-pruning: /context-pruning status did not report ENABLED with a context-hook snapshot; the extension stood down or did not run its context hook');
}
export function armInstruments(arm, deps = {}) {
  const missing = missingRequires(arm, deps);
  if (missing.length) throw new Error(`arm '${arm}' is declared but not armed: ${missing.join('; ')}`);
  return ARMS[arm].instruments;
}

/** The replaced read is proven only by its anchor rows; built-in read never emits them.
 * 4.4.4, 4.5.1 and 5.0.0 share the format: HASH_CLASS [A-Za-z]{4} + HASH_SEP "│" (5.0.0 src/hashline/hash.ts is unchanged from 4.5.1). */
export function requireHashlineReadProof(arm, toolResult) {
  if (arm !== 'hashline-edit' && arm !== 'hashline-edit-451' && arm !== 'hashline-edit-500') return;
  if (!/^[A-Za-z]{4}│/m.test(toolResult?.content?.[0]?.text ?? '')) throw new Error(`${arm}: read result has no anchor|content rows; the built-in read ran instead of the replaced tool`);
}

/** A live billion-context-pi answers acp_status with its overview; a stood-down one returns its refusal text instead. */
export function requireBillionContextStatusProof(arm, toolResult) {
  if (arm !== 'billion-context') return;
  if (!/^CONTEXT BREAKDOWN$/m.test(toolResult?.content?.[0]?.text ?? '')) throw new Error('billion-context: acp_status returned no CONTEXT BREAKDOWN overview; the extension stood down or did not load');
}
