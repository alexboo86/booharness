// Permissions persistence; the installer holds its home lock before calling this.
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { harnessPaths, readHarnessConfig } from '../../scripts/lib/harness-config.mjs';
import { writeOwned } from './owned-entries.mjs';

function readSettings(file, keep) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) {
    if (!keep) return {};
    if (error.code === 'ENOENT') {
      try { lstatSync(file); }
      catch (missing) { if (missing.code === 'ENOENT') return {}; }
    }
    throw new Error(`Cannot read permission settings ${file}: ${error.message}`, { cause: error });
  }
  if (!keep) return text ? JSON.parse(text) : {};
  try {
    const settings = JSON.parse(text);
    const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!isRecord(settings)) throw new TypeError('expected a settings object');
    if (settings.permissions !== undefined) {
      if (!isRecord(settings.permissions)) throw new TypeError('expected a permissions object');
      for (const name of ['allow', 'deny']) {
        const entries = settings.permissions[name];
        if (entries !== undefined && (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string'))) {
          throw new TypeError(`permissions.${name} must be an array of strings`);
        }
      }
    }
    return settings;
  } catch (error) {
    throw new Error(`Invalid permission settings ${file}: ${error.message}`, { cause: error });
  }
}

// The Claude Code mods under ops/claude-mods that the installer registers.
export const CLAUDE_MOD_NAMES = ['orch-board', 'handover', 'collision-guard', 'delay-no-more', 'secrets-veil'];

export function writePermissionSettings({ repoRoot, home, file, allow, deny }) {
  const config = readHarnessConfig({ repoRoot });
  const keep = config.install?.userEntries === 'keep';
  const settings = readSettings(file, keep);
  const modKey = 'env.CLAUDE_CODE_PLUGIN_DIRS';
  const env = settings.env;
  if (env !== undefined && (env === null || typeof env !== 'object' || Array.isArray(env)
    || (env.CLAUDE_CODE_PLUGIN_DIRS !== undefined && typeof env.CLAUDE_CODE_PLUGIN_DIRS !== 'string'))) {
    throw new Error(`Invalid permission settings ${file}: env must be an object and CLAUDE_CODE_PLUGIN_DIRS a string`);
  }
  const writeTarget = ({ [modKey]: modDirs, ...permissions }) => {
    settings.permissions = { ...(settings.permissions || {}), ...(keep ? permissions : { allow, deny }) };
    settings.env = { ...env, CLAUDE_CODE_PLUGIN_DIRS: modDirs.join(path.delimiter) };
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8' });
  };
  const { stateDir } = harnessPaths({ prefix: config.names.prefix, home });
  writeOwned({
    manifestPath: path.join(stateDir, 'installed-entries.json'), targetPath: file,
    lists: {
      ...(keep ? {
        allow: { present: settings.permissions?.allow ?? [], canon: allow },
        deny: { present: settings.permissions?.deny ?? [], canon: deny },
      } : {}),
      // Mod directories always use keep semantics, independently of rule policy.
      [modKey]: {
        present: (env?.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(path.delimiter).filter(Boolean),
        canon: CLAUDE_MOD_NAMES.map(name => path.resolve(repoRoot, 'ops', 'claude-mods', name)),
      },
    },
    writeTarget,
  });
  return { allow: settings.permissions.allow, deny: settings.permissions.deny };
}
