// Stand-only pins and index placement for gitnexus. Not a stock seat loadout.
// Package behavior used here (data, not instructions): `gitnexus mcp` serves the
// registry under GITNEXUS_HOME; GITNEXUS_STORAGE_ROOT keeps each checkout's index
// out of the repository; `analyze --index-only` skips AGENTS.md, CLAUDE.md and skills.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GITNEXUS_PINS = JSON.parse(readFileSync(new URL('./gitnexus.json', import.meta.url), 'utf8'));
export const GITNEXUS_PACKAGE = `${GITNEXUS_PINS.package}@${GITNEXUS_PINS.version}`;
export const GITNEXUS_INTEGRITY = GITNEXUS_PINS.integrity;
/** This checkout. Smoke queries it; pilot cells pass their own checkout. */
export const GITNEXUS_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Copy the committed dependency tree; refuse absent or stale locks before npm runs. */
export function prepareGitnexusLock(prefix) {
  const file = new URL('./gitnexus.lock.json', import.meta.url);
  if (!existsSync(file)) throw new Error('gitnexus: committed gitnexus.lock.json is missing');
  const bytes = readFileSync(file);
  const lock = JSON.parse(bytes);
  const manifest = lock.packages?.[''];
  const top = lock.packages?.[`node_modules/${GITNEXUS_PINS.package}`];
  if (lock.lockfileVersion !== 3 || manifest?.dependencies?.[GITNEXUS_PINS.package] !== GITNEXUS_PINS.version || Object.keys(manifest.dependencies).length !== 1 || top?.version !== GITNEXUS_PINS.version || top?.integrity !== GITNEXUS_INTEGRITY) {
    throw new Error('gitnexus: committed lock does not match the package version and integrity pin');
  }
  writeFileSync(path.join(prefix, 'package.json'), `${JSON.stringify({ ...manifest, private: true }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(path.join(prefix, 'package-lock.json'), bytes, { mode: 0o600 });
}

export function gitnexusEnv(armDir) {
  return {
    GITNEXUS_HOME: path.join(armDir, 'gitnexus'),
    GITNEXUS_STORAGE_ROOT: path.join(armDir, 'gitnexus', 'storage'),
    GITNEXUS_MCP_READ_ONLY: '1',
    GITNEXUS_NO_UPDATE_NOTIFIER: '1',
  };
}

export function gitnexusMcpServer(armDir, command) {
  return {
    command,
    args: ['mcp'],
    inheritEnv: false,
    lifecycle: 'lazy',
    env: { SEAT_POLICY_ROLE: '${SEAT_POLICY_ROLE}', ...gitnexusEnv(armDir) },
  };
}

/** Integrity and arm-local index env. Version is refused by requires.npm. */
export function gitnexusReadinessProblems(armDir, installed, mcp) {
  const problems = [];
  if (installed?.integrity !== GITNEXUS_INTEGRITY) problems.push(`gitnexus: pinned integrity absent in ${armDir}`);
  const server = mcp?.mcpServers?.gitnexus;
  const expected = gitnexusEnv(armDir);
  const storage = server?.env?.GITNEXUS_STORAGE_ROOT;
  if (server?.args?.[0] !== 'mcp' || server?.env?.GITNEXUS_HOME !== expected.GITNEXUS_HOME || storage !== expected.GITNEXUS_STORAGE_ROOT || server?.env?.GITNEXUS_MCP_READ_ONLY !== '1' || server?.env?.GITNEXUS_NO_UPDATE_NOTIFIER !== '1' || typeof storage !== 'string' || !storage.startsWith(`${armDir}${path.sep}`)) {
    problems.push(`gitnexus: MCP server or arm-local index env absent in ${armDir}`);
  }
  return problems;
}

function gitStatus(repo) {
  return execFileSync('git', ['-C', repo, 'status', '--short', '--untracked-files=all'], { encoding: 'utf8' });
}

/** Index `repoPath` under the arm state directory. Refuses a repository mutation. */
export function indexGitnexus(repoPath, armDir) {
  const repo = path.resolve(repoPath);
  const bin = path.join(armDir, 'npm', 'node_modules', '.bin', 'gitnexus');
  if (!existsSync(bin)) throw new Error(`gitnexus executable missing in ${armDir}`);
  const envPaths = gitnexusEnv(armDir);
  const escaped = path.relative(repo, envPaths.GITNEXUS_STORAGE_ROOT);
  if (escaped === '' || (!escaped.startsWith('..') && !path.isAbsolute(escaped))) throw new Error(`gitnexus storage root is inside the repository: ${envPaths.GITNEXUS_STORAGE_ROOT}`);
  mkdirSync(envPaths.GITNEXUS_HOME, { recursive: true, mode: 0o700 });
  mkdirSync(envPaths.GITNEXUS_STORAGE_ROOT, { recursive: true, mode: 0o700 });
  const before = gitStatus(repo);
  execFileSync(bin, ['analyze', repo, '--index-only'], {
    cwd: repo,
    env: { ...process.env, ...envPaths, HOME: path.join(armDir, 'home') },
    stdio: 'inherit',
    timeout: 30 * 60_000,
  });
  if (gitStatus(repo) !== before) throw new Error(`gitnexus analyze changed the repository; index must stay in ${envPaths.GITNEXUS_STORAGE_ROOT}`);
  if (!existsSync(envPaths.GITNEXUS_STORAGE_ROOT)) throw new Error(`gitnexus index missing under ${envPaths.GITNEXUS_STORAGE_ROOT}`);
}

/** A real query against this repository names standEnv. Package presence is not delivery. */
export function requireGitnexusQueryProof(arm, toolResult) {
  if (arm !== 'gitnexus') return;
  if (!/standEnv/.test(toolResult?.content?.[0]?.text ?? '')) throw new Error('gitnexus: query result did not mention standEnv from this repository');
}
