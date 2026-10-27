// Stand-only pins for PyPI jcodemunch-mcp. One source for the arm installer
// and readiness. Not a stock seat loadout. Do not run `jcodemunch-mcp init`:
// it writes client configs and can write into the project.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const JCODEMUNCH_PINS = JSON.parse(readFileSync(new URL('./jcodemunch.json', import.meta.url), 'utf8'));
export const JCODEMUNCH_PACKAGE = `${JCODEMUNCH_PINS.package}==${JCODEMUNCH_PINS.version}`;
export const JCODEMUNCH_INTEGRITY = `sha256-${JCODEMUNCH_PINS.sha256}`;
export const JCODEMUNCH_PYTHON = JCODEMUNCH_PACKAGE;
// Pi's MCP gateway qualifies a server tool as <server>_<tool>, as serena_find_symbol.
export const JCODEMUNCH_TOOL = 'jcodemunch_index_folder';
const WHEEL_ORIGIN = 'https://files.pythonhosted.org/';

function assertRealDir(dir) {
  if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())) throw new Error(`unsafe jcodemunch path: ${dir}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Download the pinned wheel and prove its bytes before uv sees them. */
export async function verifiedWheel(cacheDir, log) {
  const pins = JCODEMUNCH_PINS;
  const metadataResponse = await fetch(pins.registry, { signal: AbortSignal.timeout(60_000) });
  if (!metadataResponse.ok) throw new Error(`jcodemunch registry metadata: HTTP ${metadataResponse.status}`);
  const metadata = await metadataResponse.json();
  const file = (metadata.urls ?? []).find((entry) => entry.packagetype === 'bdist_wheel' && entry.filename === pins.wheel);
  if (!file || file.digests?.sha256 !== pins.sha256 || file.url !== pins.url || !file.url.startsWith(WHEEL_ORIGIN)) {
    throw new Error('jcodemunch: registry wheel URL or sha256 differs from the audited pin');
  }
  const response = await fetch(file.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`jcodemunch wheel: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== pins.sha256) throw new Error(`jcodemunch: wheel sha256 mismatch: ${sha256}`);
  assertRealDir(cacheDir);
  const wheel = path.join(cacheDir, pins.wheel);
  if (existsSync(wheel) && lstatSync(wheel).isSymbolicLink()) throw new Error(`jcodemunch: refusing to write through a link: ${wheel}`);
  writeFileSync(wheel, bytes, { mode: 0o600 });
  chmodSync(wheel, 0o600);
  log?.(`jcodemunch: verified ${JCODEMUNCH_INTEGRITY}`);
  return wheel;
}

export async function installJcodemunch({ dir, root, run, privateDir, log }) {
  const requirements = fileURLToPath(new URL('./jcodemunch.requirements.txt', import.meta.url));
  const topLevel = readFileSync(requirements, 'utf8').split(/\r?\n/).filter((line) => line.startsWith(`${JCODEMUNCH_PINS.package}==`));
  if (topLevel.length !== 1 || topLevel[0].split(/\s/)[0] !== JCODEMUNCH_PACKAGE) throw new Error(`jcodemunch: ${requirements} must pin ${JCODEMUNCH_PACKAGE}`);
  // Same pinned CPython as serena: the stand is macOS arm64, and the wheel is py3-none-any.
  const python = path.join(root, 'python', 'cpython-3.12-macos-aarch64-none', 'bin', 'python3.12');
  if (!existsSync(python)) run('uv', ['python', 'install', '3.12'], dir);
  const venv = path.join(dir, 'venv');
  const venvPython = path.join(venv, 'bin', 'python');
  if (!existsSync(venvPython)) run('uv', ['venv', '--python', '3.12', venv], dir);
  await verifiedWheel(path.join(dir, 'cache'), log);
  run('uv', ['pip', 'install', '--python', venvPython, '--require-hashes', '--no-deps', '-r', requirements], dir);
  const metadata = path.join(venv, 'lib', 'python3.12', 'site-packages', `${JCODEMUNCH_PINS.distribution}-${JCODEMUNCH_PINS.version}.dist-info`, 'METADATA');
  if (!existsSync(metadata) || !readFileSync(metadata, 'utf8').includes(`Version: ${JCODEMUNCH_PINS.version}\n`)) {
    throw new Error(`${JCODEMUNCH_PACKAGE} missing after uv pip install`);
  }
  if (!existsSync(path.join(venv, 'bin', 'jcodemunch-mcp'))) throw new Error('jcodemunch-mcp executable missing after uv pip install');
  privateDir(path.join(dir, 'code-index'));
}

/** Isolated MCP registration. Index and cache stay under the arm, never the repository. */
export function jcodemunchMcp(dir) {
  return {
    command: path.join(dir, 'venv', 'bin', 'jcodemunch-mcp'),
    args: ['serve', '--transport', 'stdio', '--watcher', 'false'],
    inheritEnv: false,
    lifecycle: 'lazy',
    env: {
      SEAT_POLICY_ROLE: '${SEAT_POLICY_ROLE}',
      HOME: path.join(dir, 'home'),
      CODE_INDEX_PATH: path.join(dir, 'code-index'),
      XDG_CACHE_HOME: path.join(dir, 'cache'),
      JCODEMUNCH_SHARE_SAVINGS: '0',
      JCODEMUNCH_USE_AI_SUMMARIES: '0',
      JCODEMUNCH_PERF_TELEMETRY: '0',
      JCODEMUNCH_ALLOW_REMOTE_SUMMARIZER: '0',
      JCODEMUNCH_ALLOW_PAID_SUMMARIES: '0',
    },
  };
}

function insideArm(dir, value) {
  if (typeof value !== 'string' || value === '') return false;
  const root = path.resolve(dir);
  const resolved = path.resolve(value);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

/** Readiness: exact installed version, recorded wheel pin, index and cache inside the arm. */
export function jcodemunchMissing(dir, installed, mcp) {
  const missing = [];
  if (installed?.integrity !== JCODEMUNCH_INTEGRITY || installed?.python !== JCODEMUNCH_PYTHON) missing.push(`jcodemunch: pinned wheel integrity absent in ${dir}`);
  const metadata = path.join(dir, 'venv', 'lib', 'python3.12', 'site-packages', `${JCODEMUNCH_PINS.distribution}-${JCODEMUNCH_PINS.version}.dist-info`, 'METADATA');
  let body = '';
  try { body = readFileSync(metadata, 'utf8'); } catch { /* absent */ }
  if (!body.includes(`Version: ${JCODEMUNCH_PINS.version}\n`)) missing.push(`jcodemunch: Python package ${JCODEMUNCH_PACKAGE} absent in ${dir}`);
  const env = mcp?.mcpServers?.jcodemunch?.env ?? {};
  if (!insideArm(dir, env.CODE_INDEX_PATH) || !insideArm(dir, env.XDG_CACHE_HOME) || !insideArm(dir, env.HOME)) missing.push(`jcodemunch: index and cache must stay inside ${dir}`);
  if (env.JCODEMUNCH_SHARE_SAVINGS !== '0') missing.push(`jcodemunch: savings counter not opted out in ${dir}`);
  let proof = null;
  try { proof = JSON.parse(readFileSync(path.join(dir, 'delivery.json'), 'utf8')); } catch { /* smoke not run */ }
  if (proof?.indexTarget !== 'ops/ab-stand') missing.push(`jcodemunch: index_folder against this repository not observed; run smoke.mjs --arm jcodemunch`);
  return missing;
}

/** Smoke proof: one index_folder call succeeded and named this repository, not the smoke fixture. */
export function requireJcodemunchIndexProof(arm, text, repoRoot) {
  if (arm !== 'jcodemunch') return;
  const body = String(text ?? '').replaceAll('\\\\', '/').replaceAll('\\', '/');
  if (!/"success"\s*:\s*true/.test(body) || !body.includes('/ops/ab-stand') || body.includes('smoke-fixture')) {
    throw new Error(`jcodemunch: index_folder did not succeed against this repository (${String(repoRoot ?? '')}/ops/ab-stand)`);
  }
}
