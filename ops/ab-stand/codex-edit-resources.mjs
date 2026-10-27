#!/usr/bin/env node
// Read-only resource readiness: use the same Pi package filter implementation
// as the seats. Never import toolkit extensions or install missing packages.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CODEX_EDIT_DIRECTORY, CODEX_EDIT_PACKAGE } from './arms.mjs';
import { requirePiRuntime } from './pi-runtime.mjs';

const dir = process.argv[2];
const cwd = process.argv[3] ?? dir;
if (!dir || !path.isAbsolute(dir) || !path.isAbsolute(cwd)) throw new Error('usage: codex-edit-resources.mjs <absolute arm dir> [absolute cwd]');
process.env.PI_OFFLINE = '1';
process.env.PI_TELEMETRY = '0';
const piRoot = requirePiRuntime().packageRoot;
const { DefaultPackageManager } = await import(pathToFileURL(path.join(piRoot, 'dist/core/package-manager.js')).href);
const { SettingsManager } = await import(pathToFileURL(path.join(piRoot, 'dist/core/settings-manager.js')).href);
const agentDir = path.join(dir, 'agent');
const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir) });
const resources = await manager.resolve(async () => 'error');
const toolkitRoot = path.dirname(path.dirname(path.join(dir, CODEX_EDIT_DIRECTORY)));
const expected = path.join(dir, CODEX_EDIT_DIRECTORY, 'index.ts');
const proof = {};
for (const type of ['extensions', 'skills', 'prompts', 'themes']) {
  const toolkit = resources[type].filter((entry) => entry.path.startsWith(`${toolkitRoot}${path.sep}`) || entry.metadata.packageRoot === toolkitRoot || entry.metadata.source.startsWith('npm:@maxiaochao/pi-toolkit'));
  const enabled = toolkit.filter((entry) => entry.enabled);
  if (type === 'extensions' ? enabled.length !== 1 || enabled[0].path !== expected : enabled.length !== 0) {
    throw new Error(`codex-edit: Pi enabled unexpected toolkit ${type}: ${JSON.stringify(enabled.map((entry) => entry.path))}`);
  }
  proof[type] = toolkit.map(({ path: resourcePath, enabled }) => ({ path: path.relative(toolkitRoot, resourcePath), enabled }));
}
console.log(JSON.stringify({ package: CODEX_EDIT_PACKAGE, ...proof }));
