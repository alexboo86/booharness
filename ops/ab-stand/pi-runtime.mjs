// Resolve the runtime of this script's checkout, never the arm cwd or PATH.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { piRuntimeLayout } from '../orchestrator/src/providers/pi.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));

export function requirePiRuntime() {
  const layout = piRuntimeLayout(repo, process.platform);
  const packageRoot = path.dirname(layout.installed);
  let manifest;
  try { manifest = JSON.parse(readFileSync(layout.installed, 'utf8')); } catch { /* repair below */ }
  const cli = typeof manifest?.bin?.pi === 'string' ? path.join(packageRoot, manifest.bin.pi) : null;
  if (!existsSync(layout.command) || !cli || !existsSync(cli)) {
    throw new Error(`stand: pinned Pi install absent or incomplete at ${packageRoot}; repair with: npm ci --prefix ops/pi-runtime`);
  }
  let pin;
  try { pin = JSON.parse(readFileSync(path.join(repo, 'ops', 'pi-runtime', 'package.json'), 'utf8')).dependencies?.['@earendil-works/pi-coding-agent']; } catch { /* repair below */ }
  if (typeof pin !== 'string' || pin.length === 0) {
    throw new Error('stand: checkout ops/pi-runtime/package.json has no @earendil-works/pi-coding-agent pin; repair with: npm ci --prefix ops/pi-runtime');
  }
  const version = typeof manifest.version === 'string' ? manifest.version : null;
  if (version !== pin) {
    throw new Error(`stand: Pi installed ${version ?? 'unreadable'}, pin ${pin}; repair with: npm ci --prefix ops/pi-runtime`);
  }
  // Node cannot execFile/spawn a .cmd shim without a shell. Use the package's
  // declared entry on win32, avoiding shell quoting and PATH lookup altogether.
  return { packageRoot, command: process.platform === 'win32' ? process.execPath : layout.command, args: process.platform === 'win32' ? [cli] : [] };
}
