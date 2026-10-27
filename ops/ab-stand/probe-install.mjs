// Stand-only pins and installer for the probe MCP arm. Not a stock seat loadout.
// postinstall extracts a bundled binary or downloads one from GitHub; this installer
// skips that script and places the pinned aarch64-apple-darwin binary itself.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { verifiedTarball } from './codex-edit-install.mjs';

export const PROBE_PINS = JSON.parse(readFileSync(new URL('./probe.json', import.meta.url), 'utf8'));
export const PROBE_PACKAGE = `${PROBE_PINS.package}@${PROBE_PINS.version}`;
export const PROBE_INTEGRITY = PROBE_PINS.integrity;
export const PROBE_BINARY_SHA256 = PROBE_PINS.binary.sha256;
export const PROBE_MCP_ARGS = ['mcp', '--timeout', '90'];

export function probePackageRoot(dir) {
  return path.join(dir, 'npm', 'node_modules', '@probelabs/probe');
}
export function probeBinaryPath(dir) {
  return path.join(probePackageRoot(dir), 'bin', 'probe-binary');
}
export function probeCommand(dir) {
  return path.join(dir, 'npm', 'node_modules', '.bin', 'probe');
}
function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** Copy the committed dependency tree; refuse absent or stale locks before npm runs. */
export function prepareProbeLock(prefix) {
  const file = new URL('./probe.lock.json', import.meta.url);
  if (!existsSync(file)) throw new Error('probe: committed probe.lock.json is missing');
  const bytes = readFileSync(file);
  const lock = JSON.parse(bytes);
  const manifest = lock.packages?.[''];
  const top = lock.packages?.[`node_modules/${PROBE_PINS.package}`];
  if (lock.lockfileVersion !== 3 || manifest?.dependencies?.[PROBE_PINS.package] !== PROBE_PINS.version || Object.keys(manifest.dependencies).length !== 1 || top?.version !== PROBE_PINS.version || top?.integrity !== PROBE_INTEGRITY) {
    throw new Error('probe: committed lock does not match the package version and integrity pin');
  }
  writeFileSync(path.join(prefix, 'package.json'), `${JSON.stringify({ ...manifest, private: true }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(path.join(prefix, 'package-lock.json'), bytes, { mode: 0o600 });
}

/** Extract the bundled macOS arm64 binary and refuse any other bytes. Never downloads. */
export function placePinnedBinary(packageRoot) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(`probe: pinned binary is aarch64-apple-darwin; this host is ${process.platform} ${process.arch}`);
  }
  const archive = path.join(packageRoot, 'bin', 'binaries', PROBE_PINS.binary.archive);
  if (!existsSync(archive)) throw new Error(`probe: bundled binary archive absent (${archive}); refusing a GitHub download`);
  const staging = path.join(packageRoot, 'bin', '.probe-extract');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    execFileSync('tar', ['-xzf', archive, '-C', staging], { timeout: 60_000 });
    const extracted = path.resolve(staging, PROBE_PINS.binary.member);
    const root = path.resolve(staging);
    if (extracted !== root && !extracted.startsWith(`${root}${path.sep}`)) throw new Error('probe: binary path escapes staging');
    if (!existsSync(extracted)) throw new Error(`probe: bundled member ${PROBE_PINS.binary.member} absent`);
    const hash = createHash('sha256').update(readFileSync(extracted)).digest('hex');
    if (hash !== PROBE_BINARY_SHA256) throw new Error(`probe: binary sha256 ${hash} is not the pin`);
    const dest = path.join(packageRoot, 'bin', 'probe-binary');
    copyFileSync(extracted, dest);
    chmodSync(dest, 0o755);
    if (createHash('sha256').update(readFileSync(dest)).digest('hex') !== PROBE_BINARY_SHA256) throw new Error('probe: placed binary hash mismatch');
    return dest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function installProbe({ dir, env, run, privateDir }) {
  const prefix = path.join(dir, 'npm');
  privateDir(prefix);
  prepareProbeLock(prefix);
  // Keep the independent top-level tarball verification; ci also enforces the lock's integrity.
  await verifiedTarball(path.join(dir, 'cache'), (line) => console.log(`stand install: ${line}`), PROBE_PINS);
  // Arm npm prefix, not the Pi package prefix, so the adapter caret cannot be re-resolved here.
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--prefix', prefix], dir, env);
  const version = readJson(path.join(probePackageRoot(dir), 'package.json'))?.version;
  if (version !== PROBE_PINS.version) throw new Error(`probe: installed ${version ?? 'nothing'}, want ${PROBE_PINS.version}`);
  const binary = placePinnedBinary(probePackageRoot(dir));
  const command = probeCommand(dir);
  if (!existsSync(command)) throw new Error('probe executable missing after npm install');
  return {
    command, args: [...PROBE_MCP_ARGS], inheritEnv: false, lifecycle: 'lazy',
    env: {
      SEAT_POLICY_ROLE: '${SEAT_POLICY_ROLE}',
      HOME: path.join(dir, 'home'),
      XDG_CACHE_HOME: path.join(dir, 'cache'),
      // inheritEnv:false leaves the child without PATH; bin/probe is #!/usr/bin/env node.
      PATH: path.dirname(process.execPath),
      PROBE_PATH: binary,
    },
  };
}

export function probeReady(dir) {
  const missing = [];
  const version = readJson(path.join(probePackageRoot(dir), 'package.json'))?.version;
  if (version !== PROBE_PINS.version) missing.push(`probe: version ${version ?? 'absent'} is not ${PROBE_PINS.version} in ${dir}`);
  const binary = probeBinaryPath(dir);
  if (!existsSync(binary)) missing.push(`probe: pinned binary absent in ${dir}`);
  else if (createHash('sha256').update(readFileSync(binary)).digest('hex') !== PROBE_BINARY_SHA256) missing.push(`probe: binary sha256 mismatch in ${dir}`);
  const server = readJson(path.join(dir, 'agent', 'mcp-adapter.json'))?.mcpServers?.probe;
  if (path.resolve(server?.command ?? '') !== path.resolve(probeCommand(dir)) || JSON.stringify(server?.args) !== JSON.stringify(PROBE_MCP_ARGS) || path.resolve(server?.env?.PROBE_PATH ?? '') !== path.resolve(binary)) {
    missing.push(`probe: MCP server is not the pinned probe mcp entry in ${dir}`);
  }
  return missing;
}

// The mcp gateway records `args` as the model sent it: object or JSON string.
function searchedPath(args) {
  for (const raw of [args, args?.arguments, args?.args]) {
    let value = raw;
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
    if (typeof value?.path === 'string') return value.path;
  }
  return null;
}

/** Smoke proof: one probe search_code call hit this repository, not the disposable fixture. */
export function requireProbeSearchProof(arm, messages, repo) {
  if (arm !== 'probe') return;
  const root = path.resolve(repo);
  const calls = (messages ?? []).flatMap((message) => message.role === 'assistant' ? (message.content ?? []).filter((entry) => entry.type === 'toolCall') : []);
  const results = new Map((messages ?? []).filter((message) => message.role === 'toolResult').map((message) => [message.toolCallId, message]));
  const hit = calls.some((entry) => {
    const args = entry.arguments ?? {};
    const tool = entry.name === 'mcp' ? args.tool : entry.name;
    // The gateway may omit `server` when the tool name is already server-prefixed;
    // the unprefixed search_code is only accepted with an explicit probe server.
    const server = entry.name === 'mcp' ? (args.server ?? (tool === 'probe_search_code' ? 'probe' : null)) : (tool === 'search_code' || tool === 'probe_search_code' ? 'probe' : null);
    if (!((tool === 'search_code' || tool === 'probe_search_code') && server === 'probe')) return false;
    const result = results.get(entry.id);
    const text = result?.content?.[0]?.text ?? '';
    const searched = searchedPath(args);
    return result?.isError === false && typeof searched === 'string' && path.resolve(searched) === root && /standDirectory/.test(text) && /arms\.mjs/.test(text);
  });
  if (!hit) throw new Error(`probe: search_code did not succeed against this repository (${root}); the call must target that path and return standDirectory in arms.mjs`);
}

export function stampProbeInstall(record) {
  return { ...record, npm: PROBE_PACKAGE, integrity: PROBE_INTEGRITY, binarySha256: PROBE_BINARY_SHA256 };
}
