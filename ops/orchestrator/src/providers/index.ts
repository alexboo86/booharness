// Family -> adapter. Each family speaks its vendor's own protocol (operator
// decision, memory #10451): Claude stream-json, codex app-server, native ACP.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acpAdapter, opencodeExportUsage } from './acp.ts';
import { claudeAdapter } from './claude.ts';
import { CODEX_DEFAULT, codexAdapter } from './codex.ts';
import { piAdapter, type PiRoute } from './pi.ts';
import { resolveCommand } from './spawn.ts';
import { stateDirFor } from '../config.ts';
import type { Family, Harness, ProviderAdapter, SessionSpec, Usage } from './types.ts';
import { landable } from '../role-policy.ts';

export * from './types.ts';

/**
 * The Z.AI endpoint and key for the glm family live in orch's own provider
 * config, `<state dir>/providers.json` (0600): `{ "glm": { "env": {
 * "ANTHROPIC_BASE_URL": ..., "ANTHROPIC_AUTH_TOKEN": ... } } }`. install-harness
 * migrates it once from the retired Paseo location (`~/.paseo/config.json`).
 */
// JSON.parse messages can quote credential bytes; only fixed error classes/codes leave this boundary.
function credentialErrorKind(error: unknown): string {
  if (error instanceof SyntaxError) return 'SyntaxError';
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' ? code : 'Error';
}

export function glmEnv(home = os.homedir()): Record<string, string> {
  const file = path.join(stateDirFor(home), 'providers.json');
  let config: any;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const hint = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? '; run ops/bootstrap/install-harness.mjs to migrate it' : '';
    throw new Error(`glm needs glm.env from ${file}${hint}: ${credentialErrorKind(error)}`);
  }
  const env = config?.glm?.env;
  if (!env?.ANTHROPIC_BASE_URL || !env?.ANTHROPIC_AUTH_TOKEN) {
    throw new Error(`glm needs ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN in glm.env of ${file}`);
  }
  const { PATH: _path, ...rest } = env;
  return rest;
}

/**
 * An API key the operator already gave opencode (`~/.local/share/opencode/auth.json`),
 * handed to Pi as env so the secret is not copied into a second file. Absent
 * means Pi falls back to its own auth.json (`/login`), and says so if that is empty.
 */
export function opencodeKey(name: string, envName: string, home = os.homedir()): Record<string, string> {
  try {
    const entry = JSON.parse(readFileSync(path.join(home, '.local', 'share', 'opencode', 'auth.json'), 'utf8'))[name];
    return entry?.type === 'api' && entry.key ? { [envName]: entry.key } : {};
  } catch {
    return {};
  }
}

/** Native Qwen uses the existing Pi token-plan key, only in the child environment. */
export function qwenKey(home = os.homedir()): Record<string, string> {
  const file = path.join(home, '.pi', 'agent', 'auth.json');
  let entry: { type?: unknown; key?: unknown } | undefined;
  try {
    entry = JSON.parse(readFileSync(file, 'utf8'))?.['qwen-token-plan-individual'];
  } catch (error) {
    throw new Error(`qwen cannot read Pi credentials in ${file}: ${credentialErrorKind(error)}`);
  }
  if (entry?.type !== 'api_key' || typeof entry.key !== 'string' || !entry.key.trim()) {
    throw new Error(`qwen needs an api_key for qwen-token-plan-individual in ${file}`);
  }
  return { OPENAI_API_KEY: entry.key };
}

/** Stable CLI state, separate from the operator's homes and shared by start/resume/export. */
function nativeCliHome(family: 'qwen' | 'mimo', home = os.homedir()): string {
  const dir = path.resolve(process.env.ORCH_STATE_DIR || stateDirFor(home), 'providers', family);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Match the key's endpoint to the selected model in Pi's own provider store. */
export function qwenEnv(model = 'qwen3.8-max', home = os.homedir()): Record<string, string> {
  const file = path.join(home, '.pi', 'agent', 'models-store.json');
  let models: unknown;
  try {
    models = JSON.parse(readFileSync(file, 'utf8'))?.['qwen-token-plan-individual']?.models;
  } catch (error) {
    throw new Error(`qwen cannot read Pi models in ${file}: ${credentialErrorKind(error)}`);
  }
  const entry = Array.isArray(models) ? models.find((candidate) => candidate?.id === model) : undefined;
  if (typeof entry?.baseUrl !== 'string' || !entry.baseUrl.trim()) {
    throw new Error(`qwen needs baseUrl for qwen-token-plan-individual model '${model}' in ${file}`);
  }
  const key = qwenKey(home);
  const cliHome = nativeCliHome('qwen', home);
  // Qwen 0.24.7 separates config (QWEN_HOME) from session/debug output (QWEN_RUNTIME_DIR).
  return { ...key, OPENAI_BASE_URL: entry.baseUrl, OPENAI_MODEL: model, QWEN_HOME: cliHome, QWEN_RUNTIME_DIR: cliHome };
}

// Access alone is insufficient: reviewers and bughunters also have full access.
function nativeCoderArgs(family: 'qwen' | 'mimo', spec: SessionSpec, args: string[]): string[] {
  const role = spec.env?.SEAT_POLICY_ROLE;
  if (typeof role !== 'string' || !landable(role) || spec.access !== 'full') {
    throw new Error(`native ${family} is for a landable role with full access; its read-only mode is not proven (decision #13378)`);
  }
  return args;
}

/** Resolve a MiMo region per seat start; never guess or copy a token into orch state. */
export function mimoProvider(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  let auth: Record<string, unknown> = {};
  const file = path.join(home, '.pi', 'agent', 'auth.json');
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object');
    auth = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`MiMo cannot read Pi credentials in ${file}: ${credentialErrorKind(error)}`);
    }
  }
  for (const region of ['ams', 'sgp', 'cn'] as const) {
    const name = `xiaomi-token-plan-${region}`;
    const key = (auth[name] as { type?: unknown; key?: unknown } | undefined);
    if ((key?.type === 'api_key' && typeof key.key === 'string' && key.key.trim())
      || env[`XIAOMI_TOKEN_PLAN_${region.toUpperCase()}_API_KEY`]?.trim()) return name;
  }
  throw new Error('MiMo needs a Xiaomi Token Plan credential: use Pi /login for xiaomi-token-plan-ams, -sgp or -cn, or set XIAOMI_TOKEN_PLAN_{AMS,SGP,CN}_API_KEY');
}

/** Override native MiMo's saved PAYG login only in this child's environment. */
export function mimoEnv(model = 'mimo-v2.6-pro', home = os.homedir(), env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const provider = mimoProvider(home, env);
  const authFile = path.join(home, '.pi', 'agent', 'auth.json');
  let credential: { type?: unknown; key?: unknown } | undefined;
  try {
    credential = JSON.parse(readFileSync(authFile, 'utf8'))?.[provider];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`mimo cannot read Pi credentials in ${authFile}: ${credentialErrorKind(error)}`);
    }
  }
  const envName = `XIAOMI_TOKEN_PLAN_${provider.slice('xiaomi-token-plan-'.length).toUpperCase()}_API_KEY`;
  const key = credential?.type === 'api_key' && typeof credential.key === 'string' && credential.key.trim()
    ? credential.key : env[envName];
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error(`mimo needs an api_key for ${provider} in ${authFile} or ${envName}`);
  }
  // ACP model ids include the native provider and optionally a reasoning variant.
  const modelId = model.includes('/') ? model.split('/')[1] : model;
  const file = path.join(home, '.pi', 'agent', 'models-store.json');
  let models: unknown;
  try {
    models = JSON.parse(readFileSync(file, 'utf8'))?.[provider]?.models;
  } catch (error) {
    throw new Error(`mimo cannot read Pi models in ${file}: ${credentialErrorKind(error)}`);
  }
  const entry = Array.isArray(models) ? models.find((candidate) => candidate?.id === modelId) : undefined;
  if (typeof entry?.baseUrl !== 'string' || !entry.baseUrl.trim()) {
    throw new Error(`mimo needs baseUrl for ${provider} model '${modelId}' in ${file}`);
  }
  return {
    // MiMo 0.1.15 resolves data/cache/config/state beneath this absolute root.
    MIMOCODE_HOME: nativeCliHome('mimo', home),
    MIMOCODE_CONFIG_CONTENT: JSON.stringify({ provider: { xiaomi: { options: { baseURL: entry.baseUrl } } } }),
    // Auth.all reads this before the saved login; options.apiKey alone can lose
    // to the saved provider key. Never place this JSON in a file or a log.
    MIMOCODE_AUTH_CONTENT: JSON.stringify({ xiaomi: { type: 'api', key } }),
  };
}

// claude's Pi route is an explicit harness:'pi' opt-in only (#11849): Anthropic
// bills a Max OAuth session from Pi as extra usage, not the subscription
// (smoke 2026-09-24, #11848), so claude defaults to native Claude Code.
// OAuth routes (anthropic, openai-codex, xai subscription) need a one-time
// `/login` in Pi, stored in ~/.pi/agent/auth.json.
const PI_ROUTES: Partial<Record<Family, PiRoute>> = {
  claude: { provider: 'anthropic', defaultModel: 'claude-opus-5-5' },
  glm: { provider: 'zai', defaultModel: 'glm-5.3', env: () => ({ ZAI_API_KEY: glmEnv().ANTHROPIC_AUTH_TOKEN }) },
  // The main codex worker: GPT-6.1-Sol at high effort (operator 2026-09-29, memory #12885).
  codex: { provider: 'openai-codex', defaultModel: CODEX_DEFAULT.model, defaultEffort: CODEX_DEFAULT.effort },
  grok: { provider: 'xai', defaultModel: 'grok-4.7' },
  // Pi's own kimi-coding OAuth only: the opencode subscription's kimi key is
  // another account and orch never bills it (operator #12679).
  kimi: { provider: 'kimi-coding', defaultModel: 'k3.1-pro' },
  opencode: { provider: 'opencode-go', defaultModel: 'glm-5.3-flash', env: () => opencodeKey('opencode-go', 'OPENCODE_API_KEY') },
  qwen: { provider: 'qwen-token-plan-individual', defaultModel: 'qwen3.8-max' },
  mimo: { provider: mimoProvider, defaultModel: 'mimo-v2.6-pro' },
};

// opencode 1.18.31 exits before a piped stdout drains: through a pipe the
// export stopped at exactly 64 KiB, through a file it was whole (179 KB). So
// stdout goes to a file.
function opencodeExport(sessionId: string, cli = 'opencode', env?: Record<string, string>): Promise<string | null> {
  const command = resolveCommand(cli);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orch-opencode-export-'));
  const file = path.join(dir, 'export.json');
  const fd = openSync(file, 'w');
  return new Promise<string | null>((resolve) => {
    const child = spawn(command.file, [...command.args, 'export', sessionId], { stdio: ['ignore', fd, 'ignore'], windowsHide: true, env: env ? { ...process.env, ...env } : undefined });
    const timer = setTimeout(() => child.kill(), 30000);
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? readFileSync(file, 'utf8') : null));
    child.on('close', () => clearTimeout(timer));
  }).finally(() => {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  });
}

/**
 * Measured 2026-09-22: an export straight after the turn missed the last
 * message in 2 of 4 runs, so it is retried until every message of the turn is
 * complete. Still incomplete after the retries leaves the usage null (unknown),
 * never the undercounted ACP figure.
 */
async function opencodeTurnUsage(sessionId: string, sinceMs: number, cli = 'opencode', env?: Record<string, string>): Promise<Usage | null> {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 500));
    const exported = await opencodeExport(sessionId, cli, env);
    if (exported === null) continue;
    try {
      const usage = opencodeExportUsage(exported, sinceMs);
      if (usage) return usage;
    } catch { /* a partial write: read again */ }
  }
  return null;
}

const ADAPTERS: Partial<Record<Family, ProviderAdapter>> = {
  claude: claudeAdapter('claude'),
  // Without a model the CLI would send its own Claude default to Z.AI.
  glm: claudeAdapter('glm', { env: glmEnv, defaultModel: 'glm-5.3', costUsd: false }),
  codex: codexAdapter,
  grok: acpAdapter('grok', {
    command: 'grok',
    args: (spec) => [
      // The operator's ~/.grok/config.toml sets permission_mode = always-approve,
      // so read-only must name its mode: default asks, and orch answers by tool kind.
      ...(spec.access === 'full' ? ['--permission-mode', 'bypassPermissions'] : ['--permission-mode', 'default']),
      'agent',
      ...(spec.model ? ['--model', spec.model] : []),
      ...(spec.effort ? ['--reasoning-effort', spec.effort] : []),
      'stdio',
    ],
    configOptions: false,
  }),
  // kimi `default` asks for every tool (orch answers by kind); opencode `plan` disallows edit tools.
  kimi: acpAdapter('kimi', { command: 'kimi', args: () => ['acp'], configOptions: true, modes: { 'read-only': 'default', full: 'yolo' } }),
  opencode: acpAdapter('opencode', { command: 'opencode', args: () => ['acp'], configOptions: true, modes: { 'read-only': 'plan', full: 'build' }, turnUsage: opencodeTurnUsage }),
  qwen: acpAdapter('qwen', {
    command: 'qwen',
    args: (spec) => nativeCoderArgs('qwen', spec, ['--acp', '--auth-type', 'openai', '--approval-mode', 'yolo']),
    env: (spec) => qwenEnv(spec.model),
    configOptions: false,
    streamedMessageUsage: true,
    deferredToolInput: true,
  }),
  mimo: acpAdapter('mimo', {
    command: 'mimo',
    args: (spec) => nativeCoderArgs('mimo', spec, ['acp', '--pure']),
    env: (spec) => mimoEnv(spec.model),
    model: (spec) => {
      const model = spec.model?.includes('/') ? spec.model : `xiaomi/${spec.model ?? 'mimo-v2.6-pro'}`;
      // MiMo exposes reasoning variants as model ids, not thought_level options.
      return spec.effort && model.split('/').length === 2 ? `${model}/${spec.effort}` : model;
    },
    configOptions: true,
    modes: { 'read-only': 'plan', full: 'build' },
    deferredToolInput: true,
    // The OpenCode-compatible export aggregates the whole turn. Failed or
    // incomplete assistant records leave usage unknown, never a placeholder zero.
    turnUsage: (sessionId, sinceMs) => opencodeTurnUsage(sessionId, sinceMs, 'mimo', { MIMOCODE_HOME: nativeCliHome('mimo') }),
  }),
};

/** Whether a family has this harness; native qwen/mimo additionally require a landable role with full access at launch. */
export function hasAdapter(family: Family, harness: Harness): boolean {
  return harness === 'pi' ? family in PI_ROUTES : family in ADAPTERS;
}

/** Each family's accepted `effort` strings (task 2275 M1b, plan 16302: the effort list is data beside the routes), so the roles.json loader can refuse what the provider layer would misrun. Every value is an effort the compiled role matrix already runs on that family (ops/orchestrator/src/profiles.ts MATRIX; each cell's comment is its decision). `null` (effort omitted) is accepted for every family: pi.ts then sends the route's default effort when it has one (codex's route carries defaultEffort), and sends no --thinking flag for a route without one. mimo's special form included: its efforts are model-id suffixes (see the mimo adapter's `model`), and Pi's MiMo catalog has no thinkingLevelMap, so it tops out at high (MATRIX bughunter.mimo). qwen accepts high and max but its route clamps both to xhigh (MATRIX reviewer and coder comments). opencode runs only with no effort (MATRIX scout.opencode, decision #12038). */
export const FAMILY_EFFORTS: Readonly<Record<Family, readonly string[]>> = Object.freeze({
  claude: Object.freeze(['high']),
  glm: Object.freeze(['low', 'high', 'max']),
  codex: Object.freeze(['medium', 'high', 'max']),
  grok: Object.freeze(['low', 'medium', 'high']),
  kimi: Object.freeze(['high']),
  opencode: Object.freeze([]),
  qwen: Object.freeze(['low', 'medium', 'high', 'max']),
  mimo: Object.freeze(['low', 'medium', 'high']),
});

/**
 * Pi for every family that has a route (operator decision 2026-09-22, memory
 * #10485, after an A/B stand: 1.8-7x fewer tokens, same correctness) — except
 * claude: its Pi smoke failed with "out of extra usage" (Anthropic bills the
 * Max OAuth from Pi as extra usage, memory #11848), so claude worker seats run
 * native Claude Code again (operator decision #11849, 2026-09-24); `harness:
 * 'pi'` still reaches its route explicitly.
 */
export function defaultHarness(family: Family): Harness {
  return family === 'claude' ? 'native' : family in PI_ROUTES ? 'pi' : 'native';
}

export function adapterFor(family: Family, harness: Harness = defaultHarness(family)): ProviderAdapter {
  if (harness === 'pi') {
    const route = PI_ROUTES[family];
    if (!route) throw new Error(`${family} has no Pi route`);
    return piAdapter(family, route);
  }
  const adapter = ADAPTERS[family];
  if (!adapter) throw new Error(`${family} has no native adapter; use harness 'pi'`);
  return adapter;
}
