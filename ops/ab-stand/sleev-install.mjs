// Stand-only pins and readiness for the sleev arm (ops/ab-stand/sleev.json).
// One source for the arm, the installer and readiness. Not a stock seat loadout.
// sleev is a CLI plus local gateway (proprietary, Sleev Labs Inc), not a Pi
// package: it installs into the arm's root npm prefix and Pi reaches the
// gateway through agent/models.json, which sleev itself edits under
// PI_CODING_AGENT_DIR. Guest mode is the account-free local mode.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const SLEEV_PINS = JSON.parse(readFileSync(new URL('./sleev.json', import.meta.url), 'utf8'));
export const SLEEV_PACKAGE = `${SLEEV_PINS.wrapper.package}@${SLEEV_PINS.wrapper.version}`;
export const SLEEV_PLATFORM_PACKAGE = `${SLEEV_PINS.platform.package}@${SLEEV_PINS.platform.version}`;
export const SLEEV_WRAPPER_INTEGRITY = SLEEV_PINS.wrapper.integrity;
export const SLEEV_PLATFORM_INTEGRITY = SLEEV_PINS.platform.integrity;
export const SLEEV_BINARY_SHA256 = SLEEV_PINS.binarySha256;
// Baked into both the install-time setup call and standEnv for sleev seats
// (ops/orchestrator/src/stand.ts repeats the literals; keep them identical):
// stable channel, text charts, and update checks failing closed against an
// unreachable local endpoint. Guest mode keeps api.sleev.ai reachable.
export const SLEEV_STAND_ENV = {
  SLEEV_CHANNEL: 'stable',
  SLEEV_TUI_GRAPHICS: 'text',
  SLEEV_NPM_REGISTRY: SLEEV_PINS.updateOffUrl,
  UPDATES_BASE_URL: SLEEV_PINS.updateOffUrl,
};

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** A live gateway answers `sleev gateway status` with JSON (observed from 1.8.5 on 2026-10-01):
 *  running and healthy true, the pinned version, a pid and a loopback address. */
export function sleevGatewayStatusOk(text) {
  let status;
  try { status = JSON.parse(String(text ?? '')); } catch { return false; }
  return status?.running === true && status.healthy === true && status.version === SLEEV_PINS.wrapper.version &&
    Number.isInteger(status.pid) && /^http:\/\/127\.0\.0\.1:\d+$/.test(String(status.address ?? ''));
}

/** Smoke proof: only a live, pinned sleev gateway produces this status text; an absent CLI or a stopped gateway does not. */
export function requireSleevGatewayProof(arm, statusText) {
  if (arm !== 'sleev') return;
  if (!sleevGatewayStatusOk(statusText)) throw new Error(`sleev: sleev gateway status did not report the pinned running gateway: ${JSON.stringify(String(statusText ?? '').slice(0, 200))}`);
}

/** Readiness for the sleev arm: every integrity pin recorded in install.json is re-checked here (never dead data). */
export function sleevMissingRequires(dir, deps = {}) {
  const missing = [];
  const installed = readJson(path.join(dir, 'install.json'));
  if (installed?.npm !== SLEEV_PACKAGE || installed.integrity !== SLEEV_WRAPPER_INTEGRITY || installed.platformIntegrity !== SLEEV_PLATFORM_INTEGRITY || installed.binarySha256 !== SLEEV_BINARY_SHA256) missing.push(`sleev: pinned wrapper/platform integrity absent in install.json in ${dir}`);
  if (readJson(path.join(dir, 'npm', 'node_modules', 'sleev', 'package.json'))?.version !== SLEEV_PINS.wrapper.version ||
    readJson(path.join(dir, 'npm', 'node_modules', SLEEV_PINS.platform.package, 'package.json'))?.version !== SLEEV_PINS.platform.version) missing.push(`sleev ${SLEEV_PACKAGE} + ${SLEEV_PLATFORM_PACKAGE} absent in ${dir}/npm`);
  const binary = path.join(dir, 'npm', 'node_modules', SLEEV_PINS.platform.package, 'bin', 'sleev');
  if (!existsSync(binary) || createHash('sha256').update(readFileSync(binary)).digest('hex') !== SLEEV_BINARY_SHA256) missing.push(`sleev: gateway binary absent or not the pinned bytes in ${dir}`);
  // npm must not have fetched any other sleev-* platform package from the registry.
  const modules = path.join(dir, 'npm', 'node_modules');
  if (existsSync(modules)) {
    const stray = readdirSync(modules, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith('sleev-') && entry.name !== SLEEV_PINS.platform.package).map((entry) => entry.name);
    if (stray.length) missing.push(`sleev: unverified sleev platform packages installed from the registry: ${stray.join(', ')}`);
  }
  // Check the provider orch's qwen pilot actually selects, not unrelated JSON text.
  const provider = readJson(path.join(dir, 'agent', 'models.json'))?.providers?.['qwen-token-plan-individual'];
  let gateway;
  try { gateway = new URL(provider?.baseUrl); } catch { /* Absent or invalid is not ready. */ }
  if (gateway?.protocol !== 'http:' || gateway.hostname !== '127.0.0.1' ||
    provider?.headers?.['sleev-provider'] !== 'bailian-token-plan' || provider.headers['sleev-harness'] !== 'pi') {
    missing.push(`sleev: agent/models.json has no Qwen pilot sleev provider on 127.0.0.1 in ${dir}`);
  }
  // Guest setup ran inside the arm home: the gateway LaunchAgent plist lives there.
  const launchAgents = path.join(dir, 'home', 'Library', 'LaunchAgents');
  const plists = existsSync(launchAgents) ? readdirSync(launchAgents).filter((file) => file.endsWith('.plist') && /sleev/i.test(readFileSync(path.join(launchAgents, file), 'utf8'))) : [];
  if (!plists.length) missing.push(`sleev: no gateway LaunchAgent plist in the arm home (${launchAgents})`);
  if (!deps.skipDeliveryProof) {
    const proof = readJson(path.join(dir, 'delivery.json'));
    if (!sleevGatewayStatusOk(proof?.gatewayStatus)) missing.push(`sleev: gateway status proof absent; run smoke.mjs --arm sleev`);
  }
  return missing;
}
