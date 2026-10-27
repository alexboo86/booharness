#!/usr/bin/env node
// Real Pi RPC sessions with orch's adapter, extension, access guard and RTK.
// This script makes model turns (including codex-edit); do not run without quota approval.
// These are smoke calls, NOT scored A/B matrix repetitions.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterFor } from '../orchestrator/src/providers/index.ts';
import { standEnv } from '../orchestrator/src/stand.ts';
import { ARMS, profileHash, requireBillionContextStatusProof, requireCodexEditResources, requireContextPruningProof, requireHashlineReadProof, standDirectory } from './arms.mjs';
import { requireProbeSearchProof } from './probe-install.mjs';
import { GITNEXUS_REPO, indexGitnexus, requireGitnexusQueryProof } from './gitnexus-install.mjs';
import { requireJcodemunchIndexProof, JCODEMUNCH_TOOL } from './jcodemunch-install.mjs';
import { requireSleevGatewayProof } from './sleev-install.mjs';
import { requireSolPiFusionProof } from './sol-pi-install.mjs';
import { indexWithOllama, withOllama } from './ollama.mjs';
import { indexWithOpenViking, withOpenVikingServer } from './openviking.mjs';

const arg = process.argv[2];
const arm = process.argv[3];
if (arg !== '--arm' || !Object.hasOwn(ARMS, arm ?? '')) throw new Error(`usage: node ops/ab-stand/smoke.mjs --arm <${Object.keys(ARMS).join('|')}>`);
const stateDir = path.join(os.homedir(), '.local', 'state', 'orch');
const dir = standDirectory(arm);
if (!existsSync(path.join(dir, 'install.json'))) throw new Error(`install ${arm} first`);
// agent-lsp must prove TypeScript intelligence against this repository, not sample.js.
const fixture = arm === 'agent-lsp' ? fileURLToPath(new URL('../../', import.meta.url)) : path.join(stateDir, 'ab-stand', 'smoke-fixture');
if (arm !== 'agent-lsp' && !existsSync(path.join(fixture, '.git'))) {
  mkdirSync(fixture, { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q', fixture]);
  writeFileSync(path.join(fixture, 'sample.js'), 'export function greet(name) { return `Hello, ${name}`; }\n');
}
const editsSample = arm === 'codex-edit' || arm === 'sol-pi';
const originalSample = editsSample ? readFileSync(path.join(fixture, 'sample.js')) : null;
// Aider's repo map enumerates indexed Git paths. Stage only this disposable
// fixture (never a commit or a change to the product checkout).
if (arm !== 'agent-lsp') execFileSync('git', ['-C', fixture, 'add', '--', 'sample.js']);
const baseSmoke = arm === 'base' || arm === 'no-lessons';
// Observe 5.0.0's mutating replace_within tool without granting it to scouts.
// sol-pi: Action Fusion's edit exists only on a full-access seat.
const fullAccessSmoke = arm === 'codex-edit' || arm === 'hashline-edit-500' || arm === 'sol-pi';
if (baseSmoke && !existsSync(path.join(fixture, '.codegraph'))) {
  const codegraphEnv = { ...process.env, HOME: path.join(dir, 'home') };
  execFileSync('codegraph', ['telemetry', 'off'], { env: codegraphEnv, stdio: 'ignore' });
  execFileSync('codegraph', ['init', '-y', fixture], { env: codegraphEnv, stdio: 'ignore', timeout: 90_000 });
}
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const jcodemunchTarget = path.join(repoRoot, 'ops', 'ab-stand');
const probeRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const basePrompt = 'Call codegraph_explore for the symbol greet in sample.js in this checkout. If it cannot find it, report the error.';
const prompts = {
  base: basePrompt,
  'no-lessons': basePrompt,
  'no-codegraph': 'Use bash to run ast-grep run --lang javascript -p "function $F($$$ARGS) { $$$BODY }" sample.js; report result.',
  'context-mode': 'Use the mcp gateway to call context-mode_ctx_stats from the context-mode server. Do not call other MCP servers.',
  'pi-condense': 'Call the context_tree_query tool once with ref t1. If t1 has not been pruned yet, report that error; do not use any other tools.',
  'obs-mask': 'Call bash once with git status --short, then answer READY.',
  'hashline-edit': 'Call the read tool exactly once on sample.js and report the first returned line.',
  'hashline-edit-451': 'Call the read tool exactly once on sample.js and report the first returned line.',
  'hashline-edit-500': 'Call the read tool exactly once on sample.js and report the first returned line.',
  'sol-pi': 'Call the edit tool exactly once on sample.js: change Hello, to Hi, in the greet function, and in the same call pass then_run with command "git status --short". Do not call write or bash. Report the result.',
  'billion-context': 'Call the acp_status tool exactly once with no arguments and report its first returned line.',
  'codex-edit': 'Call apply_patch exactly once, using raw patch text (not JSON) to update sample.js: change Hello, to Hi, in the greet function. Do not use edit, write, or bash. Report the result.',
  'codebase-memory-mcp': 'Use the mcp gateway to discover tools belonging to codebase-memory-mcp, then CALL its index_repository for this small repository. Do not call any other MCP server.',
  'open-codebase-index': 'Call the codebase_context tool on the question "Where is greet in sample.js?" and report the result.',
  'aider-repo-map': 'Call bash with the EXACT command aider --show-repo-map (no other flags or commands). Report the map or its error.',
  serena: 'Use the mcp gateway to call serena_find_symbol from the serena server: search for greet in sample.js, and report the exact definition. Do not call other MCP servers.',
  'context-pruning': 'Call bash exactly once with git status --short, then answer READY. Do not use other tools.',
  'agent-lsp': `Use only the mcp gateway and server agent-lsp. Call start_lsp with object args {root_dir:${JSON.stringify(fixture)},language_id:"typescript"}. Then open_document with {file_path:${JSON.stringify(path.join(fixture, 'ops/orchestrator/src/stand.ts'))},language_id:"typescript"}. Then list_symbols with the same file_path and language_id, format:"json". Report the isStandArm symbol. Do not edit, build or run tests.`,
  probe: `Use the mcp gateway to call search_code from the probe server only. Set path to exactly ${probeRepo} and query to "standDirectory" with exact true. Report a hit that names ops/ab-stand/arms.mjs. Do not call any other MCP server and do not search the smoke fixture.`,
  gitnexus: 'Use the mcp gateway to call the query tool from the gitnexus server with search_query standEnv, for this repository. Do not call other MCP servers. Report the tool result.',
  jcodemunch: `Use the mcp gateway to call jcodemunch_order from the jcodemunch server with action "index_folder", args {path:${JSON.stringify(jcodemunchTarget)},use_ai_summaries:false} and allow_state_change true. Copy the path character for character; do not shorten, retype from memory or guess it. The pinned server exposes only the order dispatcher; there is no index_folder tool. Do not call other MCP servers. Report the result.`,
  openviking: 'Use the mcp gateway to call openviking_grep from the openviking server: uri viking://resources, pattern greet (case sensitive). Report the matched lines and their viking:// URIs. Do not call other MCP servers.',
  sleev: 'Call bash with the EXACT command sleev gateway status (no other flags or commands). Report the gateway status fields it prints.',
};
const env = { ...standEnv(stateDir, arm, process.env.PATH ?? ''), SEAT_POLICY_ROLE: fullAccessSmoke ? 'coder' : 'scout', ORCH_SEAT_ID: `ab-smoke-${arm}`,
  ...(ARMS[arm].instruments?.codegraph === false ? { ORCH_SEAT_INSTRUMENTS_OFF: 'codegraph' } : {}) };
// pi-hashline-edit-pro downloads a ripgrep binary at runtime when rg is absent;
// the arm requires a preinstalled rg, so smoke refuses to run without it.
if ((arm === 'hashline-edit' || arm === 'hashline-edit-451' || arm === 'hashline-edit-500') && spawnSync('sh', ['-c', 'command -v rg'], { env, stdio: 'ignore' }).status !== 0) throw new Error(`${arm}: rg must already be on PATH for the arm env; pi-hashline-edit-pro downloads rg at runtime otherwise`);
// Pi discovers .js (not .mjs) files in the isolated agent/extensions directory
// even with orch's explicit -e guard; install copies obs-mask.mjs as .js. The observer is smoke-only and sees the context
// *after* obs-mask; get_messages alone is original session history, not context.
const observer = path.join(dir, 'agent', 'extensions', 'zz-obs-mask-smoke.js');
const proofFile = path.join(dir, 'obs-mask-smoke.json');
const diagnosticFile = path.join(dir, 'obs-mask-diagnostic.json');
function installObserver() {
  if (existsSync(observer)) throw new Error(`refusing to overwrite ${observer}`);
  rmSync(proofFile, { force: true });
  rmSync(diagnosticFile, { force: true });
  writeFileSync(observer, `import { writeFileSync } from 'node:fs';
export default function (pi) {
  pi.on('context', (event) => {
    const results = event.messages.filter((message) => message.role === 'toolResult');
    const stub = (message) => message.content.length === 1 && message.content[0].type === 'text' && /^Old environment output: \\(\\d+ lines omitted\\)$/.test(message.content[0].text);
    const masked = results.filter(stub);
    writeFileSync(${JSON.stringify(diagnosticFile)}, JSON.stringify({ results: results.length, masked: masked.length }));
    if (results.length >= 16 && masked.length >= 5 && !stub(results[0]) && results.slice(-10).every((result) => !stub(result))) {
      writeFileSync(${JSON.stringify(proofFile)}, JSON.stringify({ results: results.length, masked: masked.length, maskedIds: masked.map((result) => result.toolCallId), firstId: results[0].toolCallId, newestIds: results.slice(-10).map((result) => result.toolCallId) }));
    }
  });
}
`, { mode: 0o600 });
}
// The RPC exposes no active-tools list, so for hashline-edit-451 and
// hashline-edit-500 a smoke-only observer records pi.getActiveTools() on
// before_agent_start (after the package's session_start applied its config).
const hashlineObserver = path.join(dir, 'agent', 'extensions', arm === 'hashline-edit-500' ? 'zz-hashline-500-smoke.js' : 'zz-hashline-451-smoke.js');
const hashlineToolsFile = path.join(dir, arm === 'hashline-edit-500' ? 'hashline-500-smoke.json' : 'hashline-451-smoke.json');
function installHashlineObserver() {
  if (existsSync(hashlineObserver)) throw new Error(`refusing to overwrite ${hashlineObserver}`);
  rmSync(hashlineToolsFile, { force: true });
  writeFileSync(hashlineObserver, `import { writeFileSync } from 'node:fs';
export default function (pi) {
  pi.on('before_agent_start', async () => {
    writeFileSync(${JSON.stringify(hashlineToolsFile)}, JSON.stringify(pi.getActiveTools()));
  });
}
`, { mode: 0o600 });
}
// Pi's mcp gateway records `args` exactly as the model sent it: a JSON string or
// an object. `server` may be absent when the tool name is already server-prefixed.
const mcpCallArgs = (entry) => {
  const raw = entry?.arguments?.args;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return {}; } }
  return {};
};
async function smoke() {
if (arm === 'open-codebase-index') indexWithOllama(fixture, dir);
if (arm === 'gitnexus') indexGitnexus(GITNEXUS_REPO, dir);
if (arm === 'openviking') indexWithOpenViking(fixture, dir);
if (arm === 'obs-mask') installObserver();
if (arm === 'hashline-edit-451' || arm === 'hashline-edit-500') installHashlineObserver();
let session;
let toolkitResources;
try {
if (arm === 'codex-edit') {
  toolkitResources = requireCodexEditResources(dir, fixture);
  writeFileSync(path.join(fixture, 'sample.js'), 'export function greet(name) { return `Hello, ${name}`; }\n');
}
if (arm === 'sol-pi') writeFileSync(path.join(fixture, 'sample.js'), 'export function greet(name) { return `Hello, ${name}`; }\n');
// sol-pi: qwen3.8-flash sent then_run as a JSON string 5 of 5 times and Action Fusion's schema wants an object (2026-10-02).
const codexSmoke = arm === 'codex-edit' || arm === 'sol-pi';
session = await adapterFor(codexSmoke ? 'codex' : 'qwen', 'pi').start({ family: codexSmoke ? 'codex' : 'qwen', cwd: arm === 'gitnexus' ? GITNEXUS_REPO : fixture, model: codexSmoke ? 'gpt-6.1-sol' : 'qwen3.8-flash', access: fullAccessSmoke ? 'full' : 'read-only', instrumentsOff: ARMS[arm].instruments?.codegraph === false ? ['codegraph'] : [], env });
if (arm === 'codex-edit') {
  const state = await session.command('get_state');
  if (state.model?.id !== 'gpt-6.1-sol' || !['openai-responses', 'openai-codex-responses'].includes(state.model?.api)) throw new Error('codex-edit: smoke must use gpt-6.1-sol on a supported responses API');
}
const calls = [];
const onEvent = (event) => { if (event.kind === 'tool' && event.status === 'started') calls.push({ name: event.name, args: event.args }); };
  const commands = await session.command('get_commands');
  if (arm === 'pi-condense' && !commands.commands.some((entry) => entry.name === 'pruner')) throw new Error('pruner command absent: extension did not load');
  if (arm === 'context-pruning') {
    const loaded = commands.commands.filter((entry) => entry.source === 'extension' && (entry.name === 'context-pruning' || entry.name === 'prune') && JSON.stringify(entry.sourceInfo ?? '').includes('pi-dynamic-context-pruning'));
    if (loaded.length !== 2) throw new Error(`context-pruning: extension commands not loaded from pi-dynamic-context-pruning: ${JSON.stringify(commands.commands.map((entry) => entry.name))}`);
  }
  let pruningStatus = null;
  let rtkCommand;
  for (let attempt = 0; attempt < 2 && !rtkCommand; attempt++) {
    const rtk = await session.prompt('For this hook smoke, make exactly one bash tool call with command git status --short. Do not call MCP or memory tools. After bash completes, answer READY.', { timeoutMs: 90_000, onEvent });
    if (rtk.error) throw new Error(`rtk prompt: ${rtk.error}`);
    rtkCommand = calls.find((call) => call.name === 'bash' && call.args?.command?.startsWith('rtk '))?.args.command;
  }
  if (!rtkCommand) throw new Error(`rtk did not rewrite a Pi bash call: ${JSON.stringify(calls)}`);
  if (arm === 'context-pruning') {
    // The rtk turn already fired the context hook. /context-pruning status is an extension
    // command: disposition handled means the handler ran; notify text is the proof it is
    // ENABLED and has a snapshot. A package that is only installed does not handle the command.
    const notices = [];
    const onData = (chunk) => { notices.push(String(chunk)); };
    session.child.stdout.on('data', onData);
    let disposition;
    try {
      disposition = await session.command('prompt', { message: '/context-pruning status' });
    } finally {
      session.child.stdout.off('data', onData);
    }
    if (disposition?.disposition !== 'handled') {
      await session.command('abort').catch(() => {});
      throw new Error(`context-pruning: /context-pruning status was not handled (${JSON.stringify(disposition)}); extension is not active`);
    }
    pruningStatus = notices.join('').split(/\r?\n/).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((event) => event?.type === 'extension_ui_request' && event.method === 'notify').map((event) => event.message).join('\n');
    requireContextPruningProof(arm, pruningStatus);
  }
  const start = calls.length;
  let result = await session.prompt(prompts[arm], { timeoutMs: 120_000, onEvent });
  if (arm === 'aider-repo-map' && !calls.slice(start).some((call) => call.name === 'bash' && call.args?.command === 'aider --show-repo-map')) {
    result = await session.prompt('The attempted which/--version command was refused. Do not investigate. Call bash with EXACTLY aider --show-repo-map and no other characters, then report its result.', { timeoutMs: 120_000, onEvent });
  }
  if (arm === 'no-codegraph' && !calls.slice(start).some((call) => call.name === 'bash' && /\b(ast-grep|sg) run\b/.test(call.args?.command ?? ''))) {
    result = await session.prompt('For this smoke, call bash with ast-grep run --lang javascript -p "function $F($$$ARGS) { $$$BODY }" sample.js and report the match. Do not call codegraph.', { timeoutMs: 120_000, onEvent });
  }
  if (baseSmoke && !calls.slice(start).some((call) => call.name === 'codegraph_explore')) {
    result = await session.prompt('For this smoke use ONLY codegraph_explore for greet in sample.js now. Do not call memoryctl or other tools.', { timeoutMs: 120_000, onEvent });
  }
  if (arm === 'sleev' && !calls.slice(start).some((call) => call.name === 'bash' && /\bsleev gateway status\b/.test(call.args?.command ?? ''))) {
    result = await session.prompt('For this smoke call bash with EXACTLY sleev gateway status and no other characters, then report the fields it prints. Do not use other tools.', { timeoutMs: 120_000, onEvent });
  }
  if ((arm === 'hashline-edit' || arm === 'hashline-edit-451' || arm === 'hashline-edit-500') && !calls.slice(start).some((call) => call.name === 'read')) {
    result = await session.prompt('For this smoke call the read tool exactly once on sample.js and report its first returned line. Do not use bash.', { timeoutMs: 120_000, onEvent });
  }
  if (arm === 'sol-pi' && !calls.slice(start).some((call) => call.name === 'edit' && call.args?.then_run)) {
    result = await session.prompt('For this smoke call the edit tool exactly once on sample.js, changing Hello, to Hi, with then_run {"command":"git status --short"} in the same call. Do not use bash or write.', { timeoutMs: 120_000, onEvent });
  }
  if (arm === 'billion-context' && !calls.slice(start).some((call) => call.name === 'acp_status')) {
    result = await session.prompt('For this smoke call the acp_status tool exactly once with no arguments and report its first returned line. Do not use bash.', { timeoutMs: 120_000, onEvent });
  }
  if (arm === 'probe' && !calls.slice(start).some((call) => call.name === 'search_code' || call.name === 'probe_search_code' || (call.name === 'mcp' && call.args?.server === 'probe' && (call.args?.tool === 'search_code' || call.args?.tool === 'probe_search_code')))) {
    result = await session.prompt(`For this smoke use the mcp gateway to call search_code on server probe only. path must be exactly ${probeRepo}, query "standDirectory", exact true. Report the hit in ops/ab-stand/arms.mjs. Do not use bash.`, { timeoutMs: 120_000, onEvent });
  }
  if (arm === 'gitnexus' && !calls.slice(start).some((call) => call.name === 'mcp' && (call.args?.tool === 'query' || call.args?.tool === 'gitnexus_query'))) {
    result = await session.prompt('For this smoke use ONLY the mcp gateway to call query on the gitnexus server with search_query standEnv. Do not use bash.', { timeoutMs: 120_000, onEvent });
  }
  if (arm === 'jcodemunch') {
    // One in-run retry when the first attempt did not land a successful
    // index_folder against this repository (e.g. a mistyped path); a failed
    // call is never accepted as proof.
    const seen = (await session.command('get_messages')).messages;
    const orderIds = seen.flatMap((message) => message.role === 'assistant' ? (message.content ?? []).filter((entry) => entry.type === 'toolCall') : [])
      .filter((entry) => entry.name === 'mcp' && entry.arguments?.tool === 'jcodemunch_order' && (!entry.arguments?.server || entry.arguments?.server === 'jcodemunch') && mcpCallArgs(entry).action === 'index_folder' && typeof mcpCallArgs(entry).args?.path === 'string' && path.resolve(mcpCallArgs(entry).args.path) === jcodemunchTarget)
      .map((entry) => entry.id);
    const landed = seen.some((message) => message.role === 'toolResult' && orderIds.includes(message.toolCallId) && message.isError === false && /"success"\s*:\s*true/.test(message.content?.[0]?.text ?? ''));
    if (!landed) result = await session.prompt(`Retry once: the previous attempt did not index the target. Call jcodemunch_order on server jcodemunch with action "index_folder", allow_state_change true, and args {path:"${jcodemunchTarget}",use_ai_summaries:false} — copy that path exactly as written. Do not call other tools.`, { timeoutMs: 120_000, onEvent });
  }
  if (arm === 'obs-mask') {
    // Each prompt requests one completed real bash call, hence one observation-
    // bearing assistant turn. 16 turns cross KEEP_NEWEST=10 + first + MASK_BATCH=5.
    // Use the saved context hook proof, not get_messages (which stays unmasked).
    for (let i = 0; i < 16 && !existsSync(proofFile); i++) {
      result = await session.prompt(`Obs-mask smoke ${i + 1}/16: call bash exactly once with git status --short; after its result answer READY.`, { timeoutMs: 90_000, onEvent });
      if (result.error) throw new Error(`obs-mask observation ${i + 1}: ${result.error}`);
    }
    if (!existsSync(proofFile)) throw new Error(`obs-mask: no masked context after 16 real observation prompts; observer: ${existsSync(diagnosticFile) ? readFileSync(diagnosticFile, 'utf8') : 'not loaded'}`);
  }
  const observed = calls.slice(start);
  const tools = observed.map((call) => call.name).concat(observed.filter((call) => call.name === 'mcp').map((call) => String(call.args?.tool ?? '')));
  // The MCP gateway accepts either the server-qualified name or (with `server`) its short name.
  if (arm === 'codebase-memory-mcp' && tools.includes('codebase-memory-mcp_index_repository')) tools.push('index_repository');
  // Unprefixed list_symbols is accepted without `server`: the profile's other servers (codegraph, memoryctl)
  // expose no tool of that name, and the proof below pins the call's file_path and the isStandArm result.
  if (arm === 'agent-lsp' && observed.some((call) => call.name === 'mcp' && (call.args?.tool === 'list_symbols' || call.args?.tool === 'agent-lsp_list_symbols') && (!call.args?.server || call.args?.server === 'agent-lsp'))) tools.push('agent-lsp_list_symbols');
  const required = ARMS[arm].requires?.tool ?? (baseSmoke ? 'codegraph_explore' : 'bash');
  if (arm === 'jcodemunch' && observed.some((call) => call.name === 'mcp' && (call.args?.tool === JCODEMUNCH_TOOL || call.args?.tool === 'jcodemunch_order') && (!call.args?.server || call.args?.server === 'jcodemunch'))) tools.push(required);
  if (arm === 'probe' && (tools.includes('probe_search_code') || tools.includes('search_code'))) tools.push('search_code');
  if (arm === 'gitnexus' && tools.includes('gitnexus_query')) tools.push('query');
  const messages = (await session.command('get_messages')).messages;
  const toolCalls = messages.flatMap((message) => message.role === 'assistant' ? (message.content ?? []).filter((entry) => entry.type === 'toolCall') : []);
  const targetIds = new Set(toolCalls.filter((entry) => (arm !== 'agent-lsp' && entry.name === required && (arm !== 'sol-pi' || entry.arguments?.then_run) && (arm !== 'no-codegraph' || /\b(ast-grep|sg) run\b/.test(entry.arguments?.command ?? ''))) ||
    (arm !== 'agent-lsp' && entry.name === 'mcp' && (entry.arguments?.tool === required && (arm !== 'codebase-memory-mcp' || entry.arguments?.server === 'codebase-memory-mcp') ||
      (arm === 'codebase-memory-mcp' && entry.arguments?.tool === 'codebase-memory-mcp_index_repository'))) ||
    (arm === 'agent-lsp' && entry.name === 'mcp' && (entry.arguments?.tool === 'agent-lsp_list_symbols' || (entry.arguments?.tool === 'list_symbols' && (!entry.arguments?.server || entry.arguments?.server === 'agent-lsp'))) &&
      mcpCallArgs(entry).file_path === path.join(fixture, 'ops/orchestrator/src/stand.ts') && mcpCallArgs(entry).language_id === 'typescript') ||
    (arm === 'jcodemunch' && entry.name === 'mcp' && entry.arguments?.tool === 'jcodemunch_order' && (!entry.arguments?.server || entry.arguments?.server === 'jcodemunch') &&
      mcpCallArgs(entry).action === 'index_folder' && typeof mcpCallArgs(entry).args?.path === 'string' && path.resolve(mcpCallArgs(entry).args.path) === jcodemunchTarget) ||
    (arm === 'aider-repo-map' && entry.name === 'bash' && entry.arguments?.command === 'aider --show-repo-map') || (arm === 'gitnexus' && entry.name === 'mcp' && entry.arguments?.tool === 'gitnexus_query')).map((entry) => entry.id));
  if (arm === 'probe') for (const entry of toolCalls) {
    const args = entry.arguments ?? {};
    if (entry.name === 'probe_search_code' || (entry.name === 'mcp' && ((args.tool === 'probe_search_code' && (!args.server || args.server === 'probe')) || (args.tool === 'search_code' && args.server === 'probe')))) targetIds.add(entry.id);
  }
  const success = messages.find((message) => message.role === 'toolResult' && targetIds.has(message.toolCallId) && message.isError === false &&
    (!['base', 'no-lessons', 'no-codegraph', 'open-codebase-index', 'aider-repo-map', 'serena', 'openviking', 'hashline-edit', 'hashline-edit-451', 'hashline-edit-500'].includes(arm) || /greet/.test(message.content?.[0]?.text ?? '')) &&
    (arm !== 'codebase-memory-mcp' || /"status":"indexed"/.test(message.content?.[0]?.text ?? '')) &&
    (arm !== 'jcodemunch' || /"success"\s*:\s*true/.test(message.content?.[0]?.text ?? '')) &&
    (arm !== 'agent-lsp' || /"name"\s*:\s*"isStandArm"/.test(message.content?.[0]?.text ?? '')));
  const delivered = (tools.includes(required) || (arm === 'codebase-memory-mcp' && tools.includes('codebase-memory-mcp_index_repository'))) && success !== undefined;
  const maskProof = arm === 'obs-mask' ? JSON.parse(readFileSync(proofFile, 'utf8')) : null;
  if (maskProof && !maskProof.maskedIds.every((id) => messages.some((message) => message.role === 'toolResult' && message.toolCallId === id && !/^Old environment output:/.test(message.content?.[0]?.text ?? '')))) throw new Error('obs-mask: session history mutated or context proof not linked to real results');
  // Distinctive proof: only the replaced read serves `anchor│content` rows
  // (HASH_SEP/HASH_CLASS from pi-hashline-edit-pro 4.4.4 and 4.5.1); built-in read never does.
  requireHashlineReadProof(arm, success);
  let hashlineActiveTools = null;
  if (arm === 'hashline-edit-451' || arm === 'hashline-edit-500') {
    if (!existsSync(hashlineToolsFile)) throw new Error(`${arm}: active-tools observer did not fire`);
    hashlineActiveTools = JSON.parse(readFileSync(hashlineToolsFile, 'utf8'));
    const forbidden = ['copy', 'move', 'anchor_grep'];
    for (const tool of forbidden) if (hashlineActiveTools.includes(tool)) throw new Error(`${arm}: ${tool} present in active tools despite copyMoveEnabled/anchorGrepEnabled false: ${hashlineActiveTools}`);
    if (arm === 'hashline-edit-500' && !hashlineActiveTools.includes('replace_within')) throw new Error(`${arm}: replace_within absent from active tools despite replaceWithinEnabled true: ${hashlineActiveTools}`);
    if (!hashlineActiveTools.includes('read')) throw new Error(`${arm}: read missing from active tools: ${hashlineActiveTools}`);
  }
  // A stood-down billion-context-pi still answers acp_status, with its refusal text.
  requireBillionContextStatusProof(arm, success);
  requireGitnexusQueryProof(arm, success);
  // Only Action Fusion's edit runs then_run and marks it; the built-in edit never does.
  requireSolPiFusionProof(arm, success);
  if (arm === 'jcodemunch') requireJcodemunchIndexProof(arm, success?.content?.[0]?.text, repoRoot);
  // The sleev delivery proof is seat-side: the arm PATH exposes the pinned CLI
  // and only a live gateway answers `sleev gateway status` with the pinned version.
  let gatewayStatus = null;
  if (arm === 'sleev') {
    const statusIds = new Set(toolCalls.filter((entry) => entry.name === 'bash' && /\bsleev gateway status\b/.test(entry.arguments?.command ?? '')).map((entry) => entry.id));
    gatewayStatus = messages.find((message) => message.role === 'toolResult' && statusIds.has(message.toolCallId) && message.isError === false)?.content?.[0]?.text ?? null;
    requireSleevGatewayProof(arm, gatewayStatus);
  }
  // The model may name the fixture file relative or absolute; either is the same one operation.
  if (arm === 'codex-edit' && (![`Applied 1 file operation(s): sample.js`, `Applied 1 file operation(s): ${path.join(fixture, 'sample.js')}`].includes(success?.content?.[0]?.text ?? '') ||!readFileSync(path.join(fixture, 'sample.js'), 'utf8').includes('Hi, ${name}'))) throw new Error('codex-edit: apply_patch did not update the fixture successfully');
  const record = { arm, profileHash: profileHash(dir), ...(arm === 'codex-edit' ? { model: 'gpt-6.1-sol', toolkitResources } : {}), ...(arm === 'hashline-edit-451' || arm === 'hashline-edit-500' ? { activeTools: hashlineActiveTools } : {}), ...(arm === 'context-pruning' ? { status: pruningStatus } : {}), ...(arm === 'sleev' ? { gatewayStatus } : {}), ...(arm === 'sol-pi' ? { fused: true, model: 'gpt-6.1-sol' } : {}), commands: commands.commands.map((entry) => entry.name), tools, maskProof,
    ...(arm === 'agent-lsp' && success ? { agentLspSymbol: 'isStandArm', repository: fixture } : {}),
    rtkCommand, stop: result.stopReason, error: result.error, toolResult: success?.content?.[0]?.text?.slice(0, 350) ?? null,
    answer: result.text.slice(0, 500) };
  if (arm === 'jcodemunch') record.indexTarget = 'ops/ab-stand';
  console.log(JSON.stringify(record));
  requireProbeSearchProof(arm, messages, probeRepo);
  if (result.error || !delivered) throw new Error(`${arm}: distinctive tool ${required} did not return a successful result`);
  if (ARMS[arm].requires) writeFileSync(path.join(dir, 'delivery.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
} finally {
  try {
    if (session) await session.close();
  } finally {
    if (editsSample) writeFileSync(path.join(fixture, 'sample.js'), originalSample);
    if (arm === 'hashline-edit-451' || arm === 'hashline-edit-500') { rmSync(hashlineToolsFile, { force: true }); rmSync(hashlineObserver, { force: true }); }
    if (arm === 'obs-mask') { rmSync(proofFile, { force: true }); rmSync(diagnosticFile, { force: true }); rmSync(observer, { force: true }); }
  }
}
}
if (arm === 'open-codebase-index') await withOllama(smoke);
else if (arm === 'openviking') await withOpenVikingServer(smoke);
else await smoke();
