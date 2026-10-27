import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHarnessConfig } from './harness-config.mjs';

export const REQUIRED_PROVIDERS = Object.freeze(['claude']);
export const FAMILY_CLI_NAMES = Object.freeze({
  claude: Object.freeze(['claude']),
  glm: Object.freeze(['claude']),
  codex: Object.freeze([]),
  grok: Object.freeze([]),
  kimi: Object.freeze([]),
  opencode: Object.freeze([]),
  qwen: Object.freeze([]),
  mimo: Object.freeze([]),
});
const PROVIDER_HOME_DIR = Object.freeze({
  claude: '.claude', codex: '.codex', kimi: '.kimi-code', grok: '.grok',
});
const UNIX_SYSTEM_DIRS = Object.freeze(['/opt/homebrew/bin', '/usr/local/bin', '/pkg/env/global/bin']);
const UNIX_TRAILING_DIRS = Object.freeze(['/usr/bin', '/bin']);

export function canonicalSearchDirs(options = {}) {
  const home = options.home || process.env.HARNESS_HOME || process.env.HOME || process.env.USERPROFILE || os.homedir();
  const platform = options.platform || process.platform;
  const vendorBins = Object.values(PROVIDER_HOME_DIR).map((dir) => path.join(home, dir, 'bin'));
  if (platform === 'win32') {
    const nodeDir = options.nodeDir || path.dirname(process.execPath);
    return [
      path.join(home, '.local', 'bin'),
      path.join(home, '.cargo', 'bin'),
      ...vendorBins,
      path.join(home, 'AppData', 'Roaming', 'npm'),
      ...(nodeDir ? [nodeDir] : []),
    ];
  }
  const systemDirs = options.systemDirs || UNIX_SYSTEM_DIRS;
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.cargo', 'bin'),
    ...systemDirs,
    ...vendorBins,
    ...(options.systemDirs ? [] : UNIX_TRAILING_DIRS),
  ];
}

export function requiredCliNames(options = {}) {
  const repoRoot = options.repoRoot
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const enabled = readHarnessConfig({ repoRoot }).families?.enabled;
  if (!enabled) return REQUIRED_PROVIDERS;
  const names = [];
  const seen = new Set();
  for (const family of enabled) {
    const clis = FAMILY_CLI_NAMES[family];
    if (!clis) throw new Error(`no CLI map for family ${JSON.stringify(family)}`);
    for (const cli of clis) {
      if (seen.has(cli)) continue;
      seen.add(cli);
      names.push(cli);
    }
  }
  return names;
}
