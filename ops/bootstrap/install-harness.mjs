#!/usr/bin/env node
// ONE harness installer for every platform. Node is everywhere; a .sh twin of
// the PowerShell scripts is exactly the drift this file exists to stop.
//
// Installs, into a declared HOME only:
//   MCP configs from ops/bootstrap/mcp-servers.json (+ operator SSOT)
//   the codex seat's trusted-project roots (codex-trust.json, from this directory)
//   skills as directory symlinks (never a junction / mklink / cmd.exe)
//   session hooks (JSON runtimes + kimi append + codex pending)
//   shared agent-instructions.md blocks
//   a canonical PATH file (and, on Darwin, a managed ~/.zshenv block)
//
// Secrets come from a gitignored env file and land in user-home runtime
// configs. They are never written into a committed SSOT or registry.
//
//   node ops/bootstrap/install-harness.mjs
//   node ops/bootstrap/install-harness.mjs --home <dir> --skip-code-intel
//
// A missing required provider is a refusal, not a silent success.

import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../../scripts/lib/is-main.mjs';
import { effectiveLeadSkills, harnessPaths, readHarnessConfig } from '../../scripts/lib/harness-config.mjs';
import { inspectSkillEntry, skillKey } from './skill-entry.mjs';
import { writePermissionSettings } from './permissions-target.mjs';
import { installRtkExcludes } from './rtk-config-target.mjs';
import { runPyToolsStep } from './install-py-tools.mjs';
import { buildJsonConfig, jsonEntry, publishConfigs, serverBelongs } from './mcp-config-target.mjs';
import { git } from '../../scripts/git-env.mjs';
import {
  canonicalSearchDirs,
  posixSearchPath,
  resolveOnPath,
  resolveProviders,
} from './resolve-runtime-path.mjs';
import { assertPermissionCanon, selectPermissionRules } from './permissions-lib.mjs';
import { loadSecrets, resolveSecretEnv } from './secret-bindings.mjs';
import { installLeadHooks } from './lead-hooks.mjs';
import { parseArgs, USAGE } from './install-harness-args.mjs';
import { replaceMarked } from './marked-blocks.mjs';
import { installGitHooks } from './install-git-hooks.mjs';
import { acquireInstallLock } from './install-lock.mjs';
import { persistWindowsUserPath } from './windows-user-path.mjs';
import { orchDependencies, refreshPiModels, shippedSets } from './orch-dependencies.mjs';
import { createRequire } from 'node:module';

const CLAUDE_PLUGIN_MARKETPLACES = Object.freeze([
  'anthropics/claude-plugins-official',
]);
// `superpowers@claude-plugins-official` left this list on 2026-08-18.
//
// It was here for one reason: the profile's mandatory method skills were its
// documents, so a machine without the plugin could not launch a round at all.
// That dependency is gone - the mandated set is five compact documents under
// `.agents/skills/`, three vendored from caveman with provenance and two of our
// own, and `skill_roots` in both tracked registries carries only the repository
// tree. Measured before the removal: SkillsBench (arXiv 2602.12670) pays +19.0
// points for a compact set of two or three and only +10.1 for four or more,
// and +0.7 for comprehensive prose; the five documents this plugin supplied
// were 44 635 bytes against about 3 500 now.
//
// Nothing stops a lead installing it for itself - the marketplace above is
// still registered. What is gone is the harness DEPENDING on it.
// Caveman left the managed harness by operator decision 15303 (2026-10-08).
// Our adapted method skills remain in the repository; no plugin supplies them.
const CLAUDE_PLUGINS = Object.freeze([]);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(HERE, '../..');
const ON_DEMAND_OPERATOR = new Set(['operator-support']);
// Runtime homes are ONE per machine, and this machine runs two checkouts.
//
// Every link below is absolute and lands in a shared home, so both checkouts
// used to read - and WRITE THROUGH - the same canon. Measured 2026-08-18: a
// session working in `harness-project` reverted
// the mac-check copy of the harness-project skill (retired 2026-09-23) four times in two and a
// half hours, each time restoring five retired plugin ids, because its
// `~/.claude/skills/harness-project` is a link into the OTHER checkout. The
// same shape was measured for hooks on 2026-08-16 and answered there by
// repointing; skills cannot be repointed, because both checkouts need theirs at
// the same time.
//
// So the lead runtime that actually reads a project takes its skills from the
// PROJECT: Claude Code resolves `./.claude/skills/` beside the working tree, so
// a session in each checkout sees its own canon and writes into its own file.
//
// `glm-lead` left the home list on 2026-08-18 for the same reason and with no
// project entry of its own: `.claude/scripts/glm-lead.sh` launches CLAUDE CODE
// with `CLAUDE_CONFIG_DIR=~/.glm-lead-config`, and a config directory does not
// move project resolution - the binary resolves `.claude/skills/<name>/SKILL.md`
// beside the working tree either way. So `~/.glm-lead-config/skills` was a
// SECOND machine-global copy of a canon that already differs per checkout, and
// the one destination below serves both runtimes. Two entries pointing at it
// are not an option: `verify_team_lead_install` refuses duplicate destinations.
//
// `zcode` stays here because it is NOT Claude Code - it is the GLM desktop GUI,
// a different product with its own hook protocol, and whether it resolves any
// project-scoped skills directory is UNMEASURED (the binary is not installed on
// this machine, so the question cannot be answered by reading strings the way
// the claude one was). Leaving it home-scoped keeps it reading the checkout that
// installed last, which is a known and recorded defect rather than a new one.
const PROJECT_SKILL_TARGETS = [['.claude', 'skills']];
const LEAD_SKILL_MAP = path.join('.agents', 'domains', '_skill-map.json');
const RETIRED_LEAD_SKILL = (name) => name.startsWith('paseo');
const SKILL_TARGETS = [
  ['.codex', 'skills'],
  ['.grok', 'skills'],
  ['.kimi-code', 'skills'],
  ['.glm-worker-config', 'skills'],
  ['.zcode', 'skills'],
];
const INSTRUCTION_TARGETS = [
  ['.claude', 'CLAUDE.md'],
  ['.codex', 'AGENTS.md'],
  ['.grok', 'AGENTS.md'],
  ['.kimi-code', 'AGENTS.md'],
  ['.glm-worker-config', 'CLAUDE.md'],
  ['.zcode', 'AGENTS.md'],
  ['.glm-lead-config', 'CLAUDE.md'],
];
const JSON_HOOK_TARGETS = [
  { runtime: 'claude', rel: ['.claude', 'settings.json'] },
  { runtime: 'glm', rel: ['.glm-worker-config', 'settings.json'] },
  { runtime: 'glm-lead', rel: ['.glm-lead-config', 'settings.json'] },
];
const CODE_INTEL_LEADS = new Set(['claude', 'glm-lead', 'zcode']);
function markers(ctx) {
  const prefix = readHarnessConfig({ repoRoot: ctx.repo }).names.prefix;
  // A changed prefix leaves the old block and appends a new one; no migration.
  return {
    instructions: [`<!-- BEGIN ${prefix}-bootstrap: shared agent tooling (generated) -->`, `<!-- END ${prefix}-bootstrap -->`],
    rtkText: [`<!-- BEGIN ${prefix}-rtk-text: ~/.codex/RTK.md (generated) -->`, `<!-- END ${prefix}-rtk-text -->`],
    zshenv: [`# BEGIN ${prefix}-harness-path`, `# END ${prefix}-harness-path`],
    codexTrust: [`# BEGIN ${prefix}-codex-trust`, `# END ${prefix}-codex-trust`],
  };
}

function posix(value) {
  return String(value).split(path.sep).join('/');
}

function writeUtf8(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, { encoding: 'utf8' });
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function expand(value, repo) {
  if (typeof value !== 'string') return value;
  return value.replaceAll('{repo}', repo);
}

function secretValue(secrets, name) {
  if (Object.prototype.hasOwnProperty.call(secrets, name) && secrets[name]) return secrets[name];
  if (process.env[name]) return process.env[name];
  return null;
}

function isWorktree(repo) {
  try {
    const common = git(['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    const gitDir = git(['-C', repo, 'rev-parse', '--path-format=absolute', '--git-dir']).trim();
    return path.resolve(common) !== path.resolve(gitDir);
  } catch {
    const norm = posix(repo);
    return /\/\.claude\/worktrees\//.test(norm);
  }
}

function tomlValue(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function resolveServerEnv(server, secrets, repo) {
  const env = {};
  if (server.env_static) {
    for (const [key, value] of Object.entries(server.env_static)) env[key] = expand(value, repo);
  }
  const secretEnv = resolveSecretEnv(server, (name) => secretValue(secrets, name));
  return secretEnv === null ? null : { ...env, ...secretEnv };
}

function selectServers({ ssot, operatorSsot, secrets, repo, operatorProfile, supportProfile, pathOptions = {}, off = [], hint = (text) => text }) {
  const turnedOff = new Set(off);
  const selected = new Map();
  const skipped = [];
  const installable = [];
  for (const [id, spec] of Object.entries(ssot.servers || {})) installable.push([id, spec]);
  if (operatorProfile && operatorSsot) {
    for (const [id, spec] of Object.entries(operatorSsot.servers || {})) {
      if (!ON_DEMAND_OPERATOR.has(id) || supportProfile) installable.push([id, spec]);
    }
  } else if (supportProfile && operatorSsot) {
    for (const [id, spec] of Object.entries(operatorSsot.servers || {})) {
      if (ON_DEMAND_OPERATOR.has(id)) installable.push([id, spec]);
    }
  }

  for (const [id, spec] of installable) {
    if (spec.disabled) continue;
    if (turnedOff.has(id)) {
      skipped.push({ server: id, reason: 'turned off by mcp.off in harness.config.json' });
      continue;
    }
    if (spec.url) {
      let bearer = null;
      if (spec.bearer_from_secret) {
        bearer = secretValue(secrets, spec.bearer_from_secret);
        if (!bearer) {
          if (spec.required) throw new Error(`MCP server '${id}' needs the secret ${spec.bearer_from_secret}`);
          skipped.push({ server: id, reason: hint(spec.install_hint) || `secret ${spec.bearer_from_secret} missing` });
          continue;
        }
      }
      selected.set(id, {
        spec,
        command: null,
        args: [],
        env: {},
        url: String(spec.url),
        bearer,
        jsonOnly: Boolean(spec.json_runtimes_only),
      });
      continue;
    }
    if (!spec.command) {
      skipped.push({ server: id, reason: 'no command defined' });
      continue;
    }
    const env = resolveServerEnv(spec, secrets, repo);
    if (env == null) {
      if (spec.skip_if_secrets_missing || !spec.required) {
        skipped.push({ server: id, reason: hint(spec.install_hint) || 'secrets missing' });
        continue;
      }
      throw new Error(`Required MCP server '${id}' is missing its secrets`);
    }
    if (spec.requires_file) {
      const requiredFile = expand(spec.requires_file, repo);
      if (!existsSync(requiredFile)) {
        if (spec.required) throw new Error(`MCP server '${id}' needs ${requiredFile}, which is not there. ${hint(spec.install_hint) || ''}`);
        skipped.push({ server: id, reason: hint(spec.install_hint) || 'file missing' });
        continue;
      }
    }
    let serverCommand = expand(spec.command, repo);
    const args = (spec.args || []).map((arg) => expand(arg, repo));
    // Windows npm shims are shell scripts, not executable images. Kimi spawns
    // MCP servers without a shell: run the installed codegraph entry with node.
    if (serverCommand === 'codegraph' && (pathOptions.platform || process.platform) === 'win32') {
      const entry = resolveServerCommand(
        'node_modules/@colbymchenry/codegraph/npm-shim.js', id, spec, pathOptions,
      );
      if (!entry) {
        skipped.push({ server: id, reason: 'codegraph npm entry is not on the canonical search path' });
        continue;
      }
      serverCommand = 'node';
      args.unshift(entry);
    }
    const command = resolveServerCommand(serverCommand, id, spec, pathOptions);
    if (command == null) {
      skipped.push({ server: id, reason: `command ${spec.command} is not on this machine's PATH` });
      continue;
    }
    selected.set(id, {
      spec,
      command,
      args,
      env,
      url: null,
      bearer: null,
      jsonOnly: false,
    });
  }
  return { selected, skipped };
}

// Preserve existing PATH-based CLI entries. Windows codegraph is translated to
// node + its npm entry above; POSIX rendering and ast-grep stay unchanged.
const PATH_SERVER_COMMANDS = new Set(['codegraph', 'ast-grep']);

/// An MCP server's command as an ABSOLUTE path, resolved on this machine.
///
/// The SSOT is committed and machine-independent, so it says `node` and cannot
/// say where node is. That was harmless while every runtime read the run's
/// generated registry, which carries the absolute path - and it is not harmless
/// for kimi, the one provider that starts its servers from its own native
/// configuration instead. Measured 2026-08-19 by the launch handshake, on the
/// first run against the definition a seat actually starts: `cannot start
/// brightdata-web (node): No such file or directory (os error 2)`. A kimi
/// member's declared PATH is `~/.local/bin:~/.cargo/bin:/usr/bin:/bin:
/// ~/.kimi-code/bin`, PATH is not in its `inherit_environment`, and bare `node`
/// resolves nowhere on it - so memoryctl, booharness and brightdata-web could not
/// start for a kimi seat at all, while the roster said it had all three.
///
/// `null` means the command is nowhere on this machine, which is the same shape
/// as a missing secret and gets the same treatment from the caller: a required
/// server throws, an optional one is skipped rather than written dead.
function resolveServerCommand(command, id, spec, options = {}) {
  if (!command) return command;
  if (path.isAbsolute(command)) return command;
  if (PATH_SERVER_COMMANDS.has(command)) return command;
  // The CANONICAL search path, never `process.env.PATH`. The installer resolves
  // provider binaries that way already, and a test pins the property: the same
  // install must come out identical under an empty PATH, a login PATH and an
  // interactive one. A resolver that read the ambient PATH would make what
  // lands in a member's config depend on which shell happened to run the
  // installer.
  const resolved = resolveOnPath(command, canonicalSearchDirs(options), options);
  if (resolved) return resolved;
  if (spec.required) {
    throw new Error(
      `Required MCP server '${id}' names command '${command}', which is nowhere on the canonical ` +
        `search path (${canonicalSearchDirs(options).join(path.delimiter)}). Install it, or make ` +
        `the SSOT name something that exists.`,
    );
  }
  return null;
}

// Pi worker seats (orch, operator decision 2026-09-22, memory #10477) reach MCP
// through pi-mcp-adapter, audited that day: `inheritEnv: false` keeps the seat's
// environment (and any TYPESAFE_API_KEY) out of the stdio children, the role gate
// still gets SEAT_POLICY_ROLE by explicit interpolation, and the settings keep
// the adapter off Jev/Typesafe and off other clients' MCP configs.
const PI_MCP_SETTINGS = { hostConfigDiscovery: 'off', jev: false, scriptMode: true };
// The one-tool servers every seat role reaches are real Pi tools, listed with
// their description in the system prompt (task 1436, operator 2026-09-23):
// behind the `mcp` proxy a seat had to search for codegraph before it could
// know it existed, and the first live board showed codegraph at 0. The
// many-tool servers (booharness, brightdata-web) stay behind the proxy.
const PI_DIRECT_TOOLS = { codegraph: ['codegraph_explore'], memoryctl: ['memory'] };

// pi-mcp-adapter hashes the interpolated env of each entry into the shared
// mcp-cache.json (task 1918): an entry carrying '${SEAT_POLICY_ROLE}' hashes
// differently per role, the single cache line thrashes, and a failed bootstrap
// connect leaves the direct tool absent for the whole session. A server every
// seat role allows renders without the interpolation (the role gate answers an
// unset role as allowed); a server some role lacks keeps it.
function roleUniversalServers(roleTable) {
  const lists = Object.values(JSON.parse(readFileSync(roleTable, 'utf8')));
  return new Set(lists[0].filter((id) => lists.every((list) => list.includes(id))));
}

function piEntry(entry, id, universal = new Set()) {
  const rendered = jsonEntry(entry);
  if (entry.url) return rendered;
  const env = { ...(rendered.env || {}) };
  if (!universal.has(id)) env.SEAT_POLICY_ROLE = '${SEAT_POLICY_ROLE}';
  return {
    ...rendered,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    inheritEnv: false,
    lifecycle: 'lazy',
    ...(PI_DIRECT_TOOLS[id] ? { directTools: PI_DIRECT_TOOLS[id] } : {}),
  };
}

// One TOML section header's server id, for the three key spellings TOML
// allows - bare, basic-quoted "..." and literal-quoted '...' - or null when
// the key cannot be decoded. The id may carry a sub-table path (.env), which
// belongs to the same section, and the header may carry whitespace and a #
// comment after the closing bracket: a MANAGED server under such a header must
// be recognized, or the old table stays while the installer appends its own
// and the file declares one table twice, which is not TOML at all. Null keeps
// the line untouched: a wrong match would delete a user's own section. Not a
// TOML parser - an undecodable key (a bad escape) is left alone.
function tomlServerId(line) {
  const header = line.match(/^\s*\[+\s*mcp_servers\.(.+?)\s*\]+\s*(?:#.*)?$/);
  if (!header) return null;
  const key = header[1];
  const basic = key.match(/^"((?:[^"\\]|\\.)*)"(?:\..*)?$/);
  if (basic) {
    try { return JSON.parse(`"${basic[1]}"`); } catch { return null; }
  }
  const literal = key.match(/^'([^']*)'(?:\..*)?$/);
  if (literal) return literal[1];
  const bare = key.match(/^([A-Za-z0-9_-]+)(?:\..*)?$/);
  return bare ? bare[1] : null;
}

function buildTomlConfig(file, runtime, { selected, operatorIds, retiredIds, preserve }) {
  const existing = readText(file);
  const lines = existing == null ? [] : existing.split(/\r?\n/);
  const managed = new Set([...selected.keys(), ...operatorIds, ...retiredIds]);
  const out = [];
  let dropping = false;
  for (const line of lines) {
    const id = tomlServerId(line);
    if (id !== null) {
      dropping = managed.has(id);
    } else if (/^\s*\[/.test(line)) {
      dropping = false;
    }
    if (!dropping) out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();

  const written = [];
  for (const [id, entry] of selected) {
    if (entry.jsonOnly) continue;
    if (!serverBelongs(entry.spec, runtime)) continue;
    written.push(id);
    out.push('');
    out.push(`[mcp_servers.${id}]`);
    if (entry.url) {
      out.push(`url = ${tomlValue(entry.url)}`);
      continue;
    }
    out.push(`command = ${tomlValue(entry.command)}`);
    out.push(`args = [${entry.args.map((arg) => tomlValue(arg)).join(', ')}]`);
    if (runtime === 'codex') out.push('env_vars = ["SEAT_POLICY_ROLE"]');
    const keys = Object.keys(entry.env);
    if (keys.length > 0) {
      out.push('');
      out.push(`[mcp_servers.${id}.env]`);
      for (const key of keys) out.push(`${key} = ${tomlValue(entry.env[key])}`);
    }
  }
  for (const id of preserve) {
    if (written.includes(id) || operatorIds.includes(id) || retiredIds.includes(id)) continue;
  }
  return { path: file, runtime, servers: written, content: `${out.join('\n').replace(/\s*$/, '')}\n` };
}

/**
 * The codex seat's trusted-project roots, from the repository rather than
 * from one machine's HOME - the permissions.json scheme applied to a setting
 * that lived only on the operator's boxes.
 *
 * Its absence is the "Not inside a trusted directory" refusal, a dead end on
 * a fresh machine until somebody hand-edits ~/.codex/config.toml.
 *
 * The trust path is a MACHINE value: codex-trust.json carries a placeholder,
 * the installer resolves it against the checkout being installed, and nothing
 * donor-shaped is ever transcribed. Runs before the MCP pass because that
 * pass re-appends its own sections at end-of-file: writing here first keeps
 * a second install byte-identical to the first.
 */
function installCodex(ctx) {
  const [BEGIN_CODEX_TRUST, END_CODEX_TRUST] = markers(ctx).codexTrust;
  const codexHome = path.join(ctx.home, '.codex');
  const trustSource = path.join(ctx.repo, 'ops', 'bootstrap', 'codex-trust.json');
  if (!existsSync(trustSource)) {
    throw new Error(`codex trust source is missing: ${trustSource}`);
  }
  const canon = JSON.parse(readFileSync(trustSource, 'utf8'));
  const roots = (canon.trust || [])
    .filter((entry) => !entry.platforms || entry.platforms.includes(ctx.platform))
    .map((entry) => expandCodexTrustRoot(entry.root, ctx));
  if (roots.length === 0) {
    throw new Error(`codex trust canon declares no root for ${ctx.platform}: ${trustSource}`);
  }

  const file = path.join(codexHome, 'config.toml');
  const existing = readText(file);
  const block = [
    BEGIN_CODEX_TRUST,
    '# Trusted codex project roots, computed per machine from',
    '# ops/bootstrap/codex-trust.json. Edit the canon and re-run the installer;',
    '# edits between these markers are overwritten. Operator entries outside',
    '# the markers are kept byte for byte.',
    ...roots.flatMap((root) => ['', `[projects.${tomlValue(root)}]`, 'trust_level = "trusted"']),
    END_CODEX_TRUST,
  ].join('\n');
  const replaced = replaceMarked(existing, BEGIN_CODEX_TRUST, END_CODEX_TRUST, block, { file });
  writeUtf8(file, absorbCodexTrustEntries(replaced, roots));
  return { trust: { file, roots } };
}

/** Resolve a canon placeholder to a machine path, or refuse loudly. */
function expandCodexTrustRoot(root, ctx) {
  if (root === '{repo}') return path.resolve(ctx.repo);
  throw new Error(
    `codex trust canon names an unknown root '${root}': computed values are {repo} - fix ops/bootstrap/codex-trust.json`,
  );
}

// Preserve every prefix's trust block; absorb only unmarked current-root tables.
function absorbCodexTrustEntries(text, roots) {
  const managed = new Set(roots);
  const header = /^\s*\[+\s*projects\.(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\s*\]+/;
  const out = [];
  let dropping = false;
  let marked;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const opening = line.trim().match(/^# BEGIN ([a-z][a-z0-9-]*)-codex-trust$/);
    if (!marked && opening) {
      marked = `# END ${opening[1]}-codex-trust`;
      dropping = false;
    }
    if (marked) {
      out.push(line);
      if (line.trim() === marked) marked = undefined;
      continue;
    }
    const match = line.match(header);
    if (match) {
      const key = match[1] ?? JSON.parse(`"${match[2]}"`);
      dropping = managed.has(key);
    } else if (/^\s*\[/.test(line)) {
      dropping = false;
    }
    if (!dropping || /^\s*(?:#|$)/.test(line)) out.push(line);
  }
  return out.join('');
}

/**
 * grok's own home, resolved the same way for its hooks and its folder trust.
 *
 * `$GROK_HOME` wins when the caller did NOT declare one, exactly as grok's own
 * documentation says, so a sealed member home does not get the operator's files
 * by accident. An EXPLICIT `--home` is a declaration and wins over the ambient
 * variable.
 */
function grokRuntimeHome(ctx) {
  return ctx.homeExplicit
    ? path.join(ctx.home, '.grok')
    : process.env.GROK_HOME || path.join(ctx.home, '.grok');
}

const TRUSTED_FOLDER_HEADER = /^\s*\[folders\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\]\s*$/;

/**
 * Write grok's folder-trust decision where its interactive prompt would.
 *
 * Measured 2026-09-17 on Windows against grok 1.0.34 with all four servers in
 * `~/.grok/config.toml`: with no `trusted_folders.toml`, a session in this
 * checkout logs `folder untrusted: skipping repo-local (project-scoped) MCP
 * server` for codegraph, memoryctl, booharness and brightdata-web, and then starts
 * with NO MCP server at all — the user-level copies carry the same four names
 * and lose the merge to the entries that were just dropped. The seat says
 * nothing about it; asked, it answers that it sees none. The mac answered that
 * prompt by hand long ago and has served all four since. A Paseo seat never
 * sees a prompt, so the decision belongs to the installer.
 *
 * The key is a TOML string, and on Windows that means every backslash doubled:
 * a lone `\T` is an invalid escape, grok swallows the parse error, and the seat
 * is silently back to no servers — measured, not reasoned.
 *
 * An entry already in the file is left alone: trust is the operator's decision
 * to make in either direction, and a re-run must not overwrite it.
 */
function installGrokFolderTrust(ctx) {
  const file = path.join(grokRuntimeHome(ctx), 'trusted_folders.toml');
  const repo = path.resolve(ctx.repo);
  const same = (a, b) => (ctx.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const existing = readText(file);
  for (const line of (existing ?? '').split(/\r?\n/)) {
    const match = line.match(TRUSTED_FOLDER_HEADER);
    if (!match) continue;
    const folder = match[2] ?? JSON.parse(`"${match[1]}"`);
    if (same(path.resolve(folder), repo)) return { path: file, state: 'already_installed', folder: repo };
  }
  const block = `[folders.${tomlValue(repo)}]\ntrusted = true\ndecided_at = ${Math.floor(Date.now() / 1000)}\n`;
  const head = existing == null || existing.trim() === '' ? '' : `${existing.replace(/\s+$/, '')}\n\n`;
  writeUtf8(file, `${head}${block}`);
  return {
    path: file,
    state: existing == null ? 'installed' : 'extended',
    folder: repo,
    note: 'an untrusted folder makes grok drop every project-scoped MCP server and start with none',
  };
}

function installMcp(ctx) {
  const secretsFile = ctx.secretsFile ?? harnessPaths({
    prefix: readHarnessConfig({ repoRoot: ctx.repo }).names.prefix,
    home: ctx.home,
  }).secretsFile;
  const ssotPath = path.join(ctx.repo, 'ops', 'bootstrap', 'mcp-servers.json');
  const operatorPath = path.join(ctx.repo, 'ops', 'bootstrap', 'mcp-servers.operator.json');
  if (!existsSync(ssotPath)) throw new Error(`MCP SSOT is missing: ${ssotPath}`);
  const ssot = JSON.parse(readFileSync(ssotPath, 'utf8'));
  const operatorSsot = existsSync(operatorPath) ? JSON.parse(readFileSync(operatorPath, 'utf8')) : null;
  if (ctx.operatorProfile && !operatorSsot) throw new Error(`--operator-profile was given but ${operatorPath} does not exist`);
  const secrets = loadSecrets(secretsFile);
  const gate = path.join(ctx.repo, 'ops', 'bootstrap', 'mcp-role-gate.mjs');
  const roleTable = path.join(ctx.repo, 'ops', 'orchestrator', 'mcp-by-role.json');
  if (!existsSync(gate) || !existsSync(roleTable)) throw new Error('MCP role gate or role table is missing from this checkout');
  const config = readHarnessConfig({ repoRoot: ctx.repo });
  const off = config.mcp?.off ?? [];
  const { selected, skipped } = selectServers({
    ssot,
    operatorSsot,
    secrets, hint: (text) => text?.replaceAll('~/.claude/<prefix>-secrets.env', () => (secretsFile.startsWith(ctx.home + path.sep) ? `~${posix(secretsFile.slice(ctx.home.length))}` : secretsFile)),
    repo: ctx.repo,
    // The canonical search path this install is resolving against - the same
    // one the provider binaries were found on, so an MCP command and a provider
    // command can never be resolved against two different worlds.
    pathOptions: { home: ctx.home, platform: ctx.platform, systemDirs: ctx.systemDirs },
    operatorProfile: ctx.operatorProfile,
    supportProfile: ctx.supportProfile,
    off,
  });
  const preserve = ssot.preserve_existing || [];
  const { stateDir } = harnessPaths({ prefix: config.names.prefix, home: ctx.home });
  const piUniversal = roleUniversalServers(roleTable);
  const gateNode = resolveServerCommand('node', 'mcp-role-gate', { required: true }, {
    home: ctx.home, platform: ctx.platform, systemDirs: ctx.systemDirs,
  });
  for (const [id, entry] of selected) {
    if (entry.url) continue; // opt-in operator HTTP entries have no stdio child
    entry.args = [gate, id, '--', entry.command, ...entry.args];
    entry.command = gateNode;
  }
  const operatorIds = operatorSsot ? Object.keys(operatorSsot.servers || {}) : [];
  // mcp.off ids ride the active-removal list with the retired ones: a section
  // is dropped by id (buildTomlConfig's managed set, the JSON present filter),
  // and a now-off id is in neither, so without this an earlier run's entry
  // survives the TOML runtimes and any keep-mode runtime the manifest cannot
  // prove ownership of - the same unmanaged-leftover defect `retired` fixed.
  const retiredIds = [...(ssot.retired || []), 'semble', ...off];
  const args = { selected, preserve, operatorIds, retiredIds,
    keep: config.install?.userEntries === 'keep', manifestPath: path.join(stateDir, 'installed-entries.json') };
  const plans = [
    buildJsonConfig(path.join(ctx.repo, '.mcp.json'), 'claude(project)', args),
    buildJsonConfig(path.join(ctx.home, '.claude.json'), 'claude(global)+zcode', args),
    buildJsonConfig(path.join(ctx.home, '.glm-lead-config', '.claude.json'), 'glm(lead)', args),
    buildJsonConfig(path.join(ctx.home, '.kimi-code', 'mcp.json'), 'kimi', args),
    buildJsonConfig(path.join(ctx.home, '.glm-worker-config', '.mcp.json'), 'glm', args),
    buildTomlConfig(path.join(ctx.home, '.codex', 'config.toml'), 'codex', args),
    buildTomlConfig(path.join(ctx.home, '.grok', 'config.toml'), 'grok', args),
    buildJsonConfig(path.join(ctx.home, '.pi', 'agent', 'mcp-adapter.json'), 'pi', args, { render: (entry, id) => piEntry(entry, id, piUniversal), settings: PI_MCP_SETTINGS, legacyFile: path.join(ctx.home, '.pi', 'agent', 'mcp.json') }),
  ];
  publishConfigs(plans);
  return {
    selected: [...selected.keys()],
    skipped,
    written: plans.map((plan) => ({ runtime: plan.runtime, path: plan.path, servers: plan.servers })),
    // Delivery, not configuration: without this grok reads the config above and
    // then throws the servers away.
    grokFolderTrust: installGrokFolderTrust(ctx),
  };
}

function canonSkills(canon) {
  if (!existsSync(canon)) throw new Error(`Canonical skills directory is missing: ${canon}`);
  return readdirSync(canon, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(canon, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}


function installSkills(ctx) {
  // A worktree gets its PROJECT scope and never the home one.
  //
  // The two scopes fail differently from here, and the old blanket refusal
  // treated them as one. A HOME link written from a worktree is absolute into a
  // directory that disappears with the worktree, and it poisons a machine-wide
  // path every other checkout reads — that stays refused. A PROJECT link lands
  // in the worktree's own `.claude/skills`, points at the worktree's own
  // `.agents/skills`, is gitignored, and dies with it: nothing outside can see
  // it, so nothing outside can be hurt by it.
  //
  // Refusing both left a lead in a worktree with NO skills at all, and the gap
  // was filled by whatever stale copy still sat in the home. Measured
  // 2026-08-18: a lead session in `.claude/worktrees/…` was handed a home skill
  // carrying the PREVIOUS generation and five Windows paths, minutes after the
  // canon had been fixed and reinstalled — the skill said "every lead runtime
  // is a target", which is exactly the rule that commit removed. Almost every
  // session is a worktree session, so this is the common case and not the
  // exotic one.
  const worktree = isWorktree(ctx.repo);
  const homeScopeAllowed = !worktree || ctx.allowWorktreeRoot;
  const canon = path.join(ctx.repo, '.agents', 'skills');
  const skills = canonSkills(canon);
  const skillMap = JSON.parse(readFileSync(path.join(ctx.repo, LEAD_SKILL_MAP), 'utf8'));
  const leadSkills = new Set([
    ...effectiveLeadSkills({ map: skillMap, lead: ctx.config?.skills?.lead }),
    ...(ctx.supportLead ? skillMap.supportLeadSkills : []),
  ]);
  for (const name of leadSkills) {
    if (!skills.includes(name)) throw new Error(`Lead skill ${name} is missing from ${canon}`);
  }
  const off = new Set((ctx.config?.skills?.off ?? []).map(skillKey));
  const skillNames = new Set(skills.map(skillKey).filter((name) => !off.has(name)));
  if (skills.length === 0) throw new Error(`No skills with a SKILL.md found under ${canon}`);
  const report = [];
  const roots = [
    ...(homeScopeAllowed
      ? [
          ...SKILL_TARGETS.map((parts) => ({ parts, root: path.join(ctx.home, ...parts), scope: 'home' })),
          { parts: ['.claude', 'skills'], root: path.join(ctx.home, '.claude', 'skills'), scope: 'home', retiredOnly: true },
        ]
      : []),
    ...PROJECT_SKILL_TARGETS.map((parts) => ({
      parts,
      root: path.join(ctx.repo, ...parts),
      scope: 'project',
    })),
  ];
  for (const { parts, root: destRoot, scope, retiredOnly } of roots) {
    const leadTarget = parts[0] === '.claude' || parts[0] === '.codex';
    mkdirSync(destRoot, { recursive: true });
    let linked = 0;
    const skipped = [];
    const replaced = [];
    for (const name of skills) {
      if (retiredOnly || off.has(skillKey(name)) || (leadTarget && !leadSkills.has(name))) continue;
      const dest = path.join(destRoot, name);
      const source = path.join(canon, name);
      let entry = inspectSkillEntry(dest, canon);
      if (entry.kind === 'real') {
        skipped.push(name);
        continue;
      }
      // Foreign or unreadable links are reported by the sweep below, even
      // when their names collide with a current canon skill.
      if (entry.kind === 'foreign' || entry.kind === 'unknown') continue;
      if (entry.kind === 'managed') unlinkSync(dest);
      try {
        symlinkSync(source, dest, 'dir');
      } catch (error) {
        throw new Error(
          `cannot create directory symlink at ${dest}: ${error.message}. ` +
            'Refusing a Windows reparse fallback; enable Developer Mode or install from a POSIX host.',
        );
      }
      linked += 1;
    }
    const removed = [];
    const preserved = [];
    for (const name of readdirSync(destRoot).sort()) {
      if (retiredOnly && !RETIRED_LEAD_SKILL(name) && !off.has(skillKey(name))) continue;
      const dest = path.join(destRoot, name);
      const entry = inspectSkillEntry(dest, canon);
      if (leadTarget && RETIRED_LEAD_SKILL(name)) {
        if (entry.kind === 'real') {
          const backup = path.join(path.dirname(destRoot), '.skills-replaced-by-harness', `${name}-${Date.now()}`);
          mkdirSync(path.dirname(backup), { recursive: true });
          renameSync(dest, backup);
          replaced.push({ name, backup });
        } else if (entry.kind !== 'missing' && entry.kind !== 'unknown') {
          unlinkSync(dest);
          removed.push(name);
        } else if (entry.kind === 'unknown') {
          preserved.push({ name, reason: entry.reason });
        }
        continue;
      }
      if (entry.kind === 'foreign' || entry.kind === 'unknown') {
        preserved.push({ name, target: entry.target, reason: entry.reason });
        continue;
      }
      if (entry.kind !== 'managed') continue;
      let stale = !skillNames.has(skillKey(entry.skill)) || (leadTarget && !leadSkills.has(entry.skill));
      if (!stale) {
        try {
          statSync(dest);
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') stale = true;
          else preserved.push({ name, target: entry.target, reason: error.message });
        }
      }
      if (stale) {
        // unlink removes the link/reparse point itself, never its directory.
        unlinkSync(dest);
        removed.push(name);
      }
    }
    report.push({
      runtime: parts[0],
      scope,
      path: destRoot,
      linked,
      skipped_real: skipped,
      replaced,
      removed_count: removed.length,
      removed,
      preserved_links: preserved,
    });
  }
  return {
    skills: skills.length,
    targets: report,
    ...(homeScopeAllowed
      ? {}
      : {
          home_scope_skipped:
            'installed from a worktree: the home scope is machine-wide and is not written from here',
        }),
  };
}

function hookCommand(repo, script, extra = '') {
  const command = `node "${posix(path.join(repo, 'ops', 'bootstrap', script))}"${extra ? ` ${extra}` : ''}`;
  return command;
}

/**
 * Install the hook, and REPOINT it when it already exists at another path.
 *
 * The needle is a script NAME, so a hook installed from a different checkout
 * matches it and used to be reported `already_installed` with its old absolute
 * command untouched. The command is an absolute path into a working tree: when
 * the tree that installed it goes away, every hook in every runtime dies at
 * once, silently, and the installer keeps saying `already_installed`.
 *
 * Measured 2026-08-16: `.claude`, both glm homes and kimi all still pointed at
 * `~/Developer/mac-check` after the harness had been installed from
 * `~/Developer/harness-project`, because the needle matched and nothing
 * compared the rest of the string.
 *
 * So a matched entry is rewritten to this run's command and reported as
 * `repointed` — a state of its own, because "it was already there" and "it was
 * there pointing somewhere else" are different facts and the second one is the
 * one worth reading.
 */
function ensureHook(hooks, event, matcher, commandNeedle, command) {
  if (!Array.isArray(hooks[event])) hooks[event] = [];
  // Ownership is proved by the whole command (task 2396): this run's command,
  // or the harness form of the same script from any checkout. A name inside
  // somebody's command proves nothing: `node /personal/my-session-start.mjs`
  // was rewritten to the harness command. A user's hook stays and the harness
  // entry is added beside it.
  const carries = (hook) => {
    const value = String(hook?.command ?? '');
    return value === command || harnessHookScript(value) === commandNeedle;
  };
  // EVERY entry of this event, not the first that matches.
  //
  // Returning at the first left a second copy pointing at a dead checkout: it
  // fired beside the good one, was neither repointed nor reported, and six
  // seats across rounds r4 and r5 named it. Deduplicating rather than
  // repointing both, because two entries with the same command make the runtime
  // run the hook TWICE - the state the one-representation rule exists to
  // prevent.
  const owning = hooks[event].filter((entry) => (entry.hooks || []).some(carries));
  if (owning.length === 0) {
    hooks[event].push({
      matcher: matcher ?? '',
      hooks: [{ type: 'command', command }],
    });
    return 'installed';
  }

  const [keep, ...duplicates] = owning;
  let repointed = false;
  // The matcher is part of the DEFINITION, and codex records trust as a hash of
  // the whole entry - so rewriting it stops the hook firing exactly as rewriting
  // the command does. Reported as `already_installed`, this dropped
  // `needs_trust` from the summary and left the operator with a hook that had
  // silently gone quiet.
  //
  // An entry that also holds somebody else's hook keeps its matcher: the rewrite
  // made a user's command run for other tools (an `Edit` entry became
  // `Read|Edit|Write|NotebookEdit`, task 2396). The harness hook leaves that
  // entry for an entry of its own with the harness matcher.
  const wrongMatcher = matcher !== undefined && keep.matcher !== matcher;
  const moves = wrongMatcher && keep.hooks.some((hook) => !carries(hook));
  if (wrongMatcher && !moves) {
    keep.matcher = matcher;
    repointed = true;
  }
  // ONE carrying hook stays: two old commands in the same entry were both
  // repointed to the same command, and the runtime ran the hook twice.
  let carried;
  keep.hooks = keep.hooks.filter((hook) => {
    if (!carries(hook)) return true;
    if (carried) {
      repointed = true;
      return false;
    }
    carried = hook;
    if (String(hook.command) !== command) {
      hook.command = command;
      repointed = true;
    }
    return !moves;
  });
  if (moves) {
    hooks[event].push({ matcher, hooks: [carried] });
    repointed = true;
  }
  // A duplicate entry loses OUR hook and keeps everything else it carried;
  // somebody else's hook in the same entry is not ours to remove. An entry left
  // with nothing goes, the way `stripOwnedHooks` drops the entry it emptied.
  for (const entry of duplicates) {
    entry.hooks = (entry.hooks || []).filter((hook) => !carries(hook));
    repointed = true;
  }
  hooks[event] = hooks[event].filter(
    (entry) => !duplicates.includes(entry) || (entry.hooks || []).length > 0,
  );
  return repointed ? 'repointed' : 'already_installed';
}

// The hook that Paseo wrote into a lead home, one for each of five events (read
// from the operator's settings backup); `<Event>` is one word.
const PASEO_HOOK = /^if \[ -n "\$PASEO_TERMINAL_ID" \]; then "\$\{PASEO_HOOK_CLI:-paseo\}" hooks claude [A-Za-z]+; fi$/;

// Shell composition: the command carries a second part, so no rule may judge it
// by its first words. It is a user's command and stays whole.
const composedCommand = (command) => /[;&|<>`\r\n]|\$\(/.test(command);

// The program a command runs: the first word, or the word after an interpreter.
function commandProgram(command) {
  const [first = '', second = ''] = command.trim().split(/\s+/);
  return ['node', 'sh', 'bash'].includes(first) ? second : first;
}

// Retired integrations are removed at the individual command level, never by
// deleting an operator-owned event or matcher that may contain other hooks.
// Paseo and orca are other tools, so their hooks are the user's entries: under
// `install.userEntries: keep` nothing goes. Under `replace` the sweep removes
// Paseo's exact form (one known whole line), and of the commands with no shell
// composition: one that starts with the words `paseo hooks`, and one whose
// program is in a directory `/.orca/agent-hooks/`. A name that only holds the
// text (`node /personal/acme-PASEO_TERMINAL_ID.mjs`), an orca path in a later
// argument and a composed command stay (task 2396).
function stripRetiredLeadHooks(hooks, keep) {
  let removed = 0;
  if (keep) return removed;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    hooks[event] = entries.flatMap((entry) => {
      if (!Array.isArray(entry.hooks)) return [entry];
      const kept = entry.hooks.filter((hook) => {
        const command = String(hook.command || '');
        const retired = PASEO_HOOK.test(command) || (!composedCommand(command) &&
          (/^paseo\s+hooks(?:\s|$)/.test(command) || commandProgram(command).includes('/.orca/agent-hooks/')));
        if (retired) removed += 1;
        return !retired;
      });
      // An entry this sweep did not change stays, an empty one included.
      if (kept.length === entry.hooks.length) return [entry];
      return kept.length ? [{ ...entry, hooks: kept }] : [];
    });
  }
  return removed;
}

// The plain arguments this installer ever wrote after a hook script (history of
// `hookCommand`): the runtime that reads the answer, or the curator's mode.
const HARNESS_HOOK_ARGS = ['claude', 'codex', 'grok', 'kimi', 'precompact', 'deliver'];
const HARNESS_HOOK_COMMAND = new RegExp(
  '^node "[^"$`\\\\\\r\\n]*/ops/bootstrap/([^"/$`\\\\\\r\\n]+)"(?: (?:' + HARNESS_HOOK_ARGS.join('|') + '))?$',
);

/**
 * The script name of a hook command in the form this installer writes,
 * `node "<checkout>/ops/bootstrap/<script>"` with at most one of the arguments
 * above, else null.
 *
 * This is the proof of ownership for a sweep and for `ensureHook` (task 2396).
 * A match of a name anywhere in the command removed or rewrote a user's own
 * hook: `node /personal/acme-prompt-guard.mjs` matched `-prompt-guard.mjs`.
 * The checkout is not compared: an older install can be from another checkout.
 * Nothing else may follow the script: a command with shell composition (`&&`,
 * `;`, `|`, a redirection, `$(`, a backtick, a newline) carries a user's part
 * and stays whole. An unquoted path and a backslash path are forms that no
 * writer made, so they are a user's too.
 */
function harnessHookScript(command) {
  const value = String(command ?? '');
  const match = composedCommand(value) ? null : HARNESS_HOOK_COMMAND.exec(value);
  return match ? match[1] : null;
}

// Removes from one event the hooks that `owned` proves are the harness's own.
// An entry goes only when the sweep emptied it; an entry the sweep did not
// change stays as the user wrote it, an empty `hooks` list included.
function stripOwnedHooks(hooks, event, owned) {
  if (!Array.isArray(hooks[event])) return false;
  let removed = false;
  hooks[event] = hooks[event].flatMap((entry) => {
    if (!Array.isArray(entry?.hooks)) return [entry];
    const kept = entry.hooks.filter((hook) => !owned(String(hook?.command || '')));
    if (kept.length === entry.hooks.length) return [entry];
    removed = true;
    return kept.length ? [{ ...entry, hooks: kept }] : [];
  });
  return removed;
}

/**
 * The retired UserPromptSubmit prompt hook (operator decision 2026-07-31).
 *
 * The harness wrote one form, from 2026-07-31 to 2026-08-01
 * (`install-session-hooks.ps1`): `node "<checkout>/ops/bootstrap/codegraph-prompt-guard.mjs"`.
 * It replaced the code-index tool's own entry, the exact command
 * `codegraph prompt-hook`, which the same decision retired. A guard file with
 * this install's prefix in the same directory is the harness's own too.
 */
function stripPromptHooks(hooks, prefix) {
  const scripts = ['codegraph-prompt-guard.mjs', `${prefix}-prompt-guard.mjs`];
  const removed = stripOwnedHooks(hooks, 'UserPromptSubmit', (command) =>
    scripts.includes(harnessHookScript(command)) || /^codegraph(?:\.exe)?\s+prompt-hook$/.test(command.trim()));
  return removed ? 'removed_prompt_hook' : 'no_prompt_hook';
}

/**
 * The session-budget Stop hook is RETIRED (operator decision 2026-09-14).
 *
 * It held the lead once per context line and asked for a handoff (measured
 * 2026-09-11: requests above 300k of context carried 72% of the lead's cost).
 * `ensureHook` only adds or repoints, so without this strip an entry installed
 * before the retirement would sit in every `settings.json` of every machine
 * for ever — the same failure shape as the prompt-hook above, with the same
 * answer: the installer removes its own retired wiring on every run, in lead
 * and member homes alike.
 */
function stripSessionBudgetHook(hooks) {
  const removed = stripOwnedHooks(hooks, 'Stop', (command) => harnessHookScript(command) === 'session-budget.mjs');
  return removed ? 'removed_session_budget' : 'no_session_budget';
}

// Decision #19248 lifted the lead screenshot ban: strip the deleted hook's entry an older
// installer wrote (`ensureHook` only adds); a hook not in the harness form stays whole.
function stripLeadCaptureHook(hooks) {
  const removed = stripOwnedHooks(hooks, 'PreToolUse', (command) => harnessHookScript(command) === 'lead-capture-hook.mjs');
  return removed ? 'removed_lead_capture' : 'no_lead_capture';
}

/// The old rtk WARN hook stays retired. Kimi now uses the shared RTK hook's
/// deny transport: a live 0.43.0 probe confirmed it ignores `updatedInput`.
///
/// It could never rewrite anything for kimi, which applies no `updatedInput`,
/// so the hook let every command through, printed a nudge on stderr and logged
/// a would-have-denied line to a counter. Measured 2026-08-19: SEVEN lines in
/// nineteen days, against a PreToolUse hook on every Bash call of every
/// session. And the nudge did not move behaviour either - task 711 recorded one
/// kimi seat at 78 shell calls against 1 rtk in a single round, with the hook
/// installed and warning the whole time.
///
/// grok was retired together with kimi on the belief it could not rewrite
/// either. That belief was wrong - grok DOES apply a PreToolUse `updatedInput`
/// (its own hooks documentation, re-measured 2026-09-14), so grok now gets the
/// REWRITE hook from `grokHooks` above. The WARN hook stays retired for both.
///
/// `codex-rtk-hook.mjs` STAYS and is a different mechanism: codex and grok DO
/// apply a rewrite, so that hook changes the command instead of commenting on
/// it.
///
/// Operator task #1212 explicitly accepts the retry cost for kimi: the reason
/// carries the rewritten command. Codex/grok keep their silent rewrite transport.
/// Hook scripts this installer once wired into kimi's TOML and must now report
/// as debris.
///
/// kimi's `config.toml` belongs to the operator and this installer only appends
/// to it, so removing a section from `kimiSections` leaves the old block in
/// place - pointing, after the script is deleted, at a file that is not there.
/// The MCP half of this file learned the same lesson the expensive way and
/// keeps a `retired` list for exactly this reason.
const KIMI_RETIRED_HOOKS = ['rtk-guard-hook.mjs'];

function kimiSections(repo) {
  return [
    { id: 'session-digest', needles: ['session-inject-once.mjs'], text: `[[hooks]]\nevent = "UserPromptSubmit"\ncommand = '${hookCommand(repo, 'session-inject-once.mjs')}'\ntimeout = 60` },
    { id: 'lessons-forget', needles: ['session-start.mjs'], text: `[[hooks]]\nevent = "PreCompact"\ncommand = '${hookCommand(repo, 'session-start.mjs')}'\ntimeout = 60` },
    // The needles for the hooks that carry a runtime argument DEMAND it: only
    // the kimi branch of the script answers in the shape kimi reads. A bare
    // basename let a stale claude-branch line count as wired and the installer
    // said already_installed over a dead hook (measured 2026-09-14, live
    // acceptance). session-digest / lessons-forget take no argument, so their
    // needles stay the bare script name. code-intel-order carries the argument
    // too (reviewer-glm r3): same needle rule, no known dead line. Both TOML
    // quote forms count as wired: `…hook.mjs" kimi` (single-quoted line) and
    // `…hook.mjs\\" kimi` (older double-quoted line with escaped quotes).
    { id: 'domain-lessons', needles: ['domain-lessons-hook.mjs" kimi', 'domain-lessons-hook.mjs\\" kimi'], text: `[[hooks]]\nevent = "PreToolUse"\nmatcher = "Edit|Write|NotebookEdit"\ncommand = '${hookCommand(repo, 'domain-lessons-hook.mjs', 'kimi')}'\ntimeout = 60` },
    { id: 'rtk-routing', needles: ['codex-rtk-hook.mjs" kimi', 'codex-rtk-hook.mjs\\" kimi'], text: `[[hooks]]\nevent = "PreToolUse"\nmatcher = "Bash"\ncommand = '${hookCommand(repo, 'codex-rtk-hook.mjs', 'kimi')}'\ntimeout = 60` },
    { id: 'code-intel-order', needles: ['code-intel-order-hook.mjs" kimi', 'code-intel-order-hook.mjs\\" kimi'], text: `[[hooks]]\nevent = "PreToolUse"\nmatcher = "Bash|Read|Grep|Glob|mcp__codegraph__.*"\ncommand = '${hookCommand(repo, 'code-intel-order-hook.mjs', 'kimi')}'\ntimeout = 60` },
  ];
}

/**
 * Hooks for grok, in the form and the place its own documentation names.
 *
 * `https://docs.x.ai/build/features/hooks` (read 2026-08-16): personal hooks
 * live in `~/.grok/hooks/*.json`, in the same three-level shape claude uses, and
 * grok maps claude's tool names (Bash, Read, Edit) onto its own automatically.
 * This installer reported grok as `unsupported_no_hook_mechanism` and the
 * project contract said grok "cannot be gated, by design" — both were true once
 * and are not true now. A whole seat was running with no rtk routing and no
 * lesson delivery on a belief nobody had re-checked.
 *
 * One caveat the docs are explicit about and this file cannot fix: everything
 * except an explicit deny (JSON decision or exit code 2) is FAIL-OPEN. A
 * grok hook that times out or crashes does not block; the failure is recorded in
 * the session and the tool call proceeds. Lessons refuse the first edit so
 * their reason reaches the model BEFORE it edits; the rtk hook still APPLIES a PreToolUse
 * `updatedInput`, so the rewrite below changes the command itself. That was
 * believed impossible until 2026-09-14 ("grok applies no updatedInput", the
 * reason the warn hook was retired for grok too on 2026-08-19); the lead
 * re-measured it against grok's own hooks doc by feeding `codex-rtk-hook.mjs`
 * grok's event shape — `{"toolName":"run_terminal_command","toolInput":
 * {"command":"git status"}}` came back as `updatedInput {"command":"rtk git
 * status"}`. The matcher says `Bash`: grok maps Claude's tool names onto its
 * own (`Bash` -> `run_terminal_command`) and keeps the original name matching.
 *
 * Two hooks were once DELIBERATELY ABSENT here, on the other half of the same
 * documentation sentence: grok ALSO reads `.claude/settings.json`, mapping
 * claude's tool names onto its own, so writing domain-lessons and
 * code-intel-order here again loaded each one TWICE — measured with `grok
 * inspect --json`, six of our hooks where four were meant, two of them carrying
 * `claude` as their runtime argument.
 *
 * That route is now OFF and the omission became a gap (task 589). The compat
 * cells are disabled on purpose — `[compat.claude] hooks = false` in
 * `~/.grok/config.toml`, part of the sealed grok home that keeps a member from
 * reading the subject's own skill layer — and `grok inspect --json` reports the
 * three claude-sourced hooks as `disabled: true, compatibilityStatus:
 * "disabled"`. Measured 2026-08-18: a grok LEAD ran with session-start and rtk
 * routing and nothing else, so it was told no domain lesson before an edit and
 * never made to open the code search before grepping. Both are written natively
 * here now, each carrying `grok` as its runtime argument rather than `claude` —
 * the mode decides the OUTPUT SHAPE, and only the grok branch of
 * `code-intel-order-hook.mjs` can refuse (`{"decision":"deny"}` plus exit 2).
 *
 * If the compat cells are ever turned back on, these two arrive twice. That is
 * the trade taken knowingly: a duplicate hook is noise, an absent one is a seat
 * running without the method.
 */
function grokHooks(repo) {
  return {
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: hookCommand(repo, 'session-start.mjs'), timeout: 60 }] },
      ],
      PreToolUse: [
        {
          matcher: 'Edit|Write|NotebookEdit',
          hooks: [{ type: 'command', command: hookCommand(repo, 'domain-lessons-hook.mjs', 'grok'), timeout: 60 }],
        },
        {
          matcher: 'Bash|Read|Grep|Glob|mcp__codegraph__.*',
          hooks: [{ type: 'command', command: hookCommand(repo, 'code-intel-order-hook.mjs', 'grok'), timeout: 60 }],
        },
        // The RTK rewrite: one script serves codex and grok, because the hook
        // reads `tool_input ?? toolInput` and answers in the
        // `hookSpecificOutput.updatedInput` shape both runtimes apply.
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: hookCommand(repo, 'codex-rtk-hook.mjs'), timeout: 60 }],
        },
      ],
    },
  };
}

// A [[hooks]] table this installer wrote, found by the command value in either
// quote form, is replaced when its event, matcher or timeout is not the one
// kimiSections writes now. The command needle alone used to call that block
// wired, so a stale matcher stayed forever. A block whose command is not ours
// — the operator's own hook, a Lumio entry — is copied byte for byte, and a
// header comment after ]] still counts as the table it belongs to.
function tomlScalar(raw) {
  const value = String(raw).trim();
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

function kimiAssignment(block, key) {
  const line = block.split(/\r?\n/).find((row) => new RegExp(`^\\s*${key}\\s*=`).test(row));
  if (!line) return null;
  return tomlScalar(line.replace(new RegExp(`^\\s*${key}\\s*=\\s*`), ''));
}

function kimiCommandValues(block) {
  return block.split(/\r?\n/)
    .filter((row) => /^\s*command\s*=/.test(row))
    .map((row) => tomlScalar(row.replace(/^\s*command\s*=\s*/, '')));
}

function kimiBlockContentEnd(slice) {
  const lines = slice.split('\n');
  let last = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (/^\s*\[\[hooks\]\]/.test(line) || /^\s*[A-Za-z0-9_-]+\s*=/.test(line)) last = i;
  }
  let end = 0;
  for (let i = 0; i <= last; i++) {
    end += lines[i].length;
    if (i < lines.length - 1 || slice.endsWith('\n')) end += 1;
  }
  return end;
}

function rewriteOwnedKimiBlocks(content, sections) {
  const wanted = sections.map((section) => ({
    text: section.text,
    command: kimiAssignment(section.text, 'command'),
    event: kimiAssignment(section.text, 'event'),
    matcher: kimiAssignment(section.text, 'matcher'),
    timeout: kimiAssignment(section.text, 'timeout'),
  }));
  const header = /^[ \t]*\[\[hooks\]\][ \t]*(?:#.*)?\r?$/gm;
  const starts = [];
  let match;
  while ((match = header.exec(content)) !== null) starts.push(match.index);
  if (starts.length === 0) return content;
  let out = '';
  let cursor = 0;
  for (const start of starts) {
    const nl = content.indexOf('\n', start);
    const afterHeader = nl === -1 ? content.length : nl + 1;
    const rest = content.slice(afterHeader);
    const other = rest.search(/^[ \t]*\[/m);
    const sliceEnd = other === -1 ? content.length : afterHeader + other;
    const slice = content.slice(start, sliceEnd);
    const blockEnd = start + kimiBlockContentEnd(slice);
    const block = content.slice(start, blockEnd);
    out += content.slice(cursor, start);
    const commands = kimiCommandValues(block);
    const owned = commands.length === 1 ? wanted.find((section) => section.command === commands[0] && section.command != null) : null;
    const differs = owned && (
      kimiAssignment(block, 'event') !== owned.event
      || kimiAssignment(block, 'matcher') !== owned.matcher
      || kimiAssignment(block, 'timeout') !== owned.timeout
    );
    if (differs) {
      out += block.endsWith('\n') || blockEnd < content.length ? `${owned.text}\n` : owned.text;
    } else {
      out += block;
    }
    cursor = blockEnd;
  }
  out += content.slice(cursor);
  return out;
}

// rtk hook codex and codex-rtk-hook.mjs both rewrite tool_input.command to an
// rtk-prefixed command on a Bash PreToolUse (measured: git status -> rtk git
// status from each, rtk 0.51.0). A bare `rtk hook codex` in that group is the
// duplicate. Anything else — another matcher, an argument, a foreign command —
// stays. The group goes only when this sweep emptied it.
function stripBareRtkCodexHook(hooks) {
  if (!Array.isArray(hooks?.PreToolUse)) return 0;
  let removed = 0;
  hooks.PreToolUse = hooks.PreToolUse.flatMap((entry) => {
    if (entry?.matcher !== 'Bash' || !Array.isArray(entry.hooks)) return [entry];
    const kept = entry.hooks.filter((hook) => {
      if (String(hook?.command ?? '') !== 'rtk hook codex') return true;
      removed += 1;
      return false;
    });
    if (kept.length === entry.hooks.length) return [entry];
    return kept.length ? [{ ...entry, hooks: kept }] : [];
  });
  return removed;
}

function sectionWired(content, section) {
  return section.needles.some((needle) => content.includes(needle));
}

function installHooks(ctx) {
  const config = readHarnessConfig({ repoRoot: ctx.repo });
  const projectPrefix = config.names.prefix;
  const keepUserEntries = config.install?.userEntries === 'keep';
  if (isWorktree(ctx.repo) && !ctx.allowWorktreeRoot) {
    throw new Error(
      `Refusing to install session hooks from a worktree: ${ctx.repo}\n` +
        'The hook command is an absolute path. Install from the main checkout, or pass --allow-worktree-root.',
    );
  }
  const report = [installGitHooks(ctx)];
  for (const target of JSON_HOOK_TARGETS) {
    const file = path.join(ctx.home, ...target.rel);
    mkdirSync(path.dirname(file), { recursive: true });
    const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8') || '{}') : {};
    if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
    const promptHook = stripPromptHooks(settings.hooks, projectPrefix);
    const retiredHooks = CODE_INTEL_LEADS.has(target.runtime) ? stripRetiredLeadHooks(settings.hooks, keepUserEntries) : 'not_lead';
    const session = ensureHook(
      settings.hooks,
      'SessionStart',
      '',
      'session-start.mjs',
      hookCommand(ctx.repo, 'session-start.mjs'),
    );
    // A lead's Read carries its domain's knowledge page (task 1642); a member
    // home (glm worker) keeps the edit-only matcher and pays no node spawn per read.
    const lessons = ensureHook(
      settings.hooks,
      'PreToolUse',
      CODE_INTEL_LEADS.has(target.runtime) ? 'Read|Edit|Write|NotebookEdit' : 'Edit|Write|NotebookEdit',
      'domain-lessons-hook.mjs',
      hookCommand(ctx.repo, 'domain-lessons-hook.mjs'),
    );
    // The rtk routing guard. kimi and codex get theirs from their own section
    // builders below; the claude-family runtimes take rtk's built-in processor,
    // and until now nothing installed it — a fresh machine ran every heavy
    // command unrouted while the contract said otherwise, and nothing said so.
    const rtkRouting = ensureHook(
      settings.hooks,
      'PreToolUse',
      'Bash',
      'rtk hook claude',
      'rtk hook claude',
    );
    let codeIntel = 'skipped_member_runtime';
    let subagentRoute = 'skipped_member_runtime';
    if (CODE_INTEL_LEADS.has(target.runtime)) {
      codeIntel = ensureHook(
        settings.hooks,
        'PreToolUse',
        // Agent|Task: the scout hint names an orch scout seat at a subagent call (2026-09-11, decision #12069).
        'Bash|Read|Grep|Glob|Agent|Task|mcp__codegraph__.*',
        'code-intel-order-hook.mjs',
        hookCommand(ctx.repo, 'code-intel-order-hook.mjs', 'claude'),
      );
      // Refuse a built-in subagent that would inherit the parent's Claude model.
      // Grok maps Task → spawn_subagent (~/.grok/docs/user-guide/10-hooks.md) and
      // is left unwired: that tool is not the operator's Claude quota.
      subagentRoute = ensureHook(
        settings.hooks,
        'PreToolUse',
        'Agent|Task',
        'subagent-route-hook.mjs',
        hookCommand(ctx.repo, 'subagent-route-hook.mjs'),
      );
    } else {
      stripOwnedHooks(settings.hooks, 'PreToolUse', (command) =>
        ['code-intel-order-hook.mjs', 'subagent-route-hook.mjs'].includes(harnessHookScript(command)));
    }
    // The decision curator (2026-09-11): the lead's context is where an
    // operator decision lives until someone writes it down, and compaction is
    // where it is lost. PreCompact detaches a scout run and never blocks;
    // SessionStart(compact) hands its proposals back. Leads only, like the
    // code-intel order: a member's context belongs to its own round.
    let curator = 'skipped_member_runtime';
    if (CODE_INTEL_LEADS.has(target.runtime)) {
      curator = [
        ensureHook(settings.hooks, 'PreCompact', '', 'decision-curator.mjs', hookCommand(ctx.repo, 'decision-curator.mjs', 'precompact')),
        ensureHook(settings.hooks, 'SessionStart', 'compact', 'decision-curator.mjs', hookCommand(ctx.repo, 'decision-curator.mjs', 'deliver')),
      ].join('/');
    }
    // Lead context reminders and chat (plan 14640 D5); both scripts skip seats.
    const leadHooks = CODE_INTEL_LEADS.has(target.runtime)
      ? installLeadHooks(settings.hooks, ctx.repo, '', ensureHook, hookCommand, harnessHookScript)
      : { lead_context: 'skipped_member_runtime', lead_chat_prompt: 'skipped_member_runtime', lead_task_router: 'skipped_member_runtime', lead_chat_tools: 'skipped_member_runtime' };
    let leadWorktree = 'skipped_not_claude';
    if (target.runtime === 'claude') {
      // Task 2126: advise the Enter/edit+commit/ExitWorktree keep/self-land cycle.
      // The hook passes orch seats by ORCH_SEAT_ID / SEAT_POLICY_ROLE.
      leadWorktree = ensureHook(
        settings.hooks,
        'PreToolUse',
        'EnterWorktree',
        'lead-worktree-hook.mjs',
        hookCommand(ctx.repo, 'lead-worktree-hook.mjs'),
      );
    }
    // Task 1999, decision #14007: a native seat may not rewrite the stash
    // stack every worktree of this repository shares. The claude runtime's
    // settings.json only: a glm seat reads that same file while glm.env names
    // no CLAUDE_CONFIG_DIR (measured 2026-10-04; check-hook-topology.mjs pins
    // it). The hook itself exits 0 before any import when no seat env is set,
    // so a lead pays nothing and no other runtime is wired here.
    let seatStash = 'skipped_not_claude';
    if (target.runtime === 'claude') {
      seatStash = ensureHook(
        settings.hooks,
        'PreToolUse',
        'Bash',
        'seat-stash-hook.mjs',
        hookCommand(ctx.repo, 'seat-stash-hook.mjs'),
      );
    }
    // Decisions #14075/#14077: recursive forced deletion is refused by a hook,
    // not a permissions.deny rule — the desktop app keeps its terminal
    // approval card while any shell rule sits in deny or ask, and a rule
    // cannot see mcp__terminal__run_in_terminal. Leads and seats alike; the
    // hook has no lead early exit.
    let shellDelete = 'skipped_not_claude';
    if (target.runtime === 'claude') {
      shellDelete = ensureHook(
        settings.hooks,
        'PreToolUse',
        'Bash|mcp__terminal__run_in_terminal',
        'shell-delete-hook.mjs',
        hookCommand(ctx.repo, 'shell-delete-hook.mjs'),
      );
    }
    const budgetRemoval = stripSessionBudgetHook(settings.hooks);
    const captureRemoval = stripLeadCaptureHook(settings.hooks);
    writeUtf8(file, `${JSON.stringify(settings, null, 2)}\n`);
    report.push({ runtime: target.runtime, path: file, state: session, prompt_hook: promptHook, domain_lessons: lessons, rtk_routing: rtkRouting, code_intel_order: codeIntel, subagent_route: subagentRoute, decision_curator: curator, ...leadHooks, lead_capture: captureRemoval, lead_worktree: leadWorktree, seat_stash: seatStash, shell_delete: shellDelete, session_budget: budgetRemoval, retired_hooks: retiredHooks });
  }

  const kimiFile = path.join(ctx.home, '.kimi-code', 'config.toml');
  // Task 2414, decision 17877: only the kimi CLI itself executes the [[hooks]]
  // below — a Pi kimi seat reads ~/.pi/agent and no kimi TOML. With no kimi
  // binary under this HOME the file has no reader at all, and writing it merely
  // tripped check-hook-topology's retired-parser skip, leaving the doctor's
  // hooks row "not checked" on a fresh kit install (rehearsal coder-codex-3c3d1d.1).
  // An operator's existing file stays untouched: the whole block, reports
  // included, is skipped.
  const kimiCli = resolveOnPath('kimi', canonicalSearchDirs({ home: ctx.home, platform: ctx.platform, systemDirs: ctx.systemDirs }), { platform: ctx.platform });
  if (!kimiCli) {
    report.push({
      runtime: 'kimi',
      path: kimiFile,
      state: 'skipped_no_cli',
      reason: 'no kimi CLI under this HOME: only the kimi CLI reads this TOML (a Pi kimi seat reads ~/.pi/agent), so nothing is written and an existing file stays untouched',
    });
  } else {
    mkdirSync(path.dirname(kimiFile), { recursive: true });
    if (!existsSync(kimiFile)) writeUtf8(kimiFile, '');
    let kimi = readFileSync(kimiFile, 'utf8');
    // Migrate our exact generated command, without adding a duplicate hook or
    // rewriting operator-owned TOML. Like ensureHook, a definition change is a
    // repoint, not already_installed. Foreign checkout commands stay reported below.
    // Both quote styles this file ever wrote are matched: an older installer
    // rendered the command double-quoted with escaped inner quotes, and that line
    // survived every later install because only the single-quoted form was
    // repointed — kimi kept running the claude branch while the report said
    // already_installed over the dead hook (measured 2026-09-14, live acceptance).
    const kimiBefore = kimi;
    const kimiWiredLessons = `command = '${hookCommand(ctx.repo, 'domain-lessons-hook.mjs', 'kimi')}'`;
    for (const kimiLegacyLessons of [
      `command = '${hookCommand(ctx.repo, 'domain-lessons-hook.mjs')}'`,
      `command = "${hookCommand(ctx.repo, 'domain-lessons-hook.mjs').replaceAll('"', '\\"')}"`,
    ]) {
      kimi = kimi.replaceAll(kimiLegacyLessons, kimiWiredLessons);
    }
    kimi = rewriteOwnedKimiBlocks(kimi, kimiSections(ctx.repo));
    const kimiRepointed = kimi !== kimiBefore;
    if (kimiRepointed) writeUtf8(kimiFile, kimi);
    const kimiMissing = kimiSections(ctx.repo).filter((section) => !sectionWired(kimi, section));
    if (kimiMissing.length) {
      const prefix = kimi.endsWith('\n') || kimi.length === 0 ? '\n' : '\n\n';
      const block = `${prefix}# --- booharness session hooks (ops/bootstrap/install-harness.mjs) ---\n${kimiMissing.map((section) => section.text).join('\n\n')}\n`;
      appendFileSync(kimiFile, block, { encoding: 'utf8' });
      kimi = readFileSync(kimiFile, 'utf8');
      report.push({ runtime: 'kimi', path: kimiFile, state: 'installed', installed_hooks: kimiMissing.map((section) => section.id), ...(kimiRepointed ? { domain_lessons: 'repointed' } : {}) });
    } else {
      report.push({ runtime: 'kimi', path: kimiFile, state: kimiRepointed ? 'repointed' : 'already_installed' });
    }
    // Apart from our exact legacy command migration above, kimi's operator TOML
    // is append-only — a hook pointing at a checkout that is not this one cannot be
    // rewritten here the way the JSON runtimes are repointed. It is REPORTED
    // instead, by path, because the alternative is what actually happened: the
    // hooks kept naming `~/Developer/mac-check` long after the harness moved, and
    // every run said `already_installed`.
    // A hook this installer RETIRED still sits in the operator's TOML, because the
    // file is only ever appended to. Reported by path with the exact fix, on the
    // same rule as a foreign checkout below - deleting the SSOT entry is not
    // enough, and the MCP side of this file already records what that costs: a
    // server removed from the source stayed in the TOML runtimes for ever and a
    // member kept receiving it. A retired hook is worse than a stale server: its
    // script is DELETED, so every Bash call of every kimi session now runs a
    // command whose file is not there.
    const kimiRetired = KIMI_RETIRED_HOOKS.filter((script) => kimi.includes(script));
    if (kimiRetired.length) {
      report.push({
        runtime: 'kimi',
        path: kimiFile,
        state: 'retired_hook_still_wired',
        hooks: kimiRetired,
        fix: `this file is operator-owned and is only appended to; delete the [[hooks]] block(s) naming ${kimiRetired.join(', ')} from ${kimiFile} - the script no longer exists`,
      });
    }
    const kimiForeign = [
      ...new Set(
        (kimi.match(/[^"']*\/ops\/bootstrap\/[A-Za-z0-9._-]+/g) || [])
          .map((hit) => hit.slice(0, hit.indexOf('/ops/bootstrap/')))
          .filter((root) => root !== posix(ctx.repo)),
      ),
    ];
    if (kimiForeign.length) {
      report.push({
        runtime: 'kimi',
        path: kimiFile,
        state: 'points_at_another_checkout',
        roots: kimiForeign,
        fix: `this file is operator-owned and is only appended to; edit the hook commands in ${kimiFile} to name ${posix(ctx.repo)}`,
      });
    }
  }

  // Codex reads its hooks from `hooks.json`, and ONLY from there.
  //
  // This installer wrote a pending TOML block for the operator to merge into
  // `config.toml`, and then reported `already_installed` once it found the text
  // there. Both halves were wrong about the same thing: `config.toml` is not the
  // surface codex executes, so the text sat inert and the installer called it
  // done. Measured 2026-08-16 on this machine — `config.toml` carried all four
  // `[[hooks.*]]` sections, while every entry of codex's own trust ledger
  // (`[hooks.state]`, seven of them) keyed a path inside `hooks.json` and NONE
  // keyed `config.toml`; the GUI's hook panel showed "No hooks found" beside a
  // config the installer had just called current. The operator saw the truth and
  // the report did not.
  //
  // `hooks.json` carries other products' entries (Xirp, Superset), so this
  // merges by command needle exactly as the claude-family targets do, and never
  // rewrites what it did not put there.
  //
  // A newly written entry is UNTRUSTED until codex records its hash: the run
  // that installs one says so, because a hook codex has not trusted does not
  // fire and nothing else would tell anybody.
  const codexHooksFile = path.join(ctx.home, '.codex', 'hooks.json');
  mkdirSync(path.dirname(codexHooksFile), { recursive: true });
  const codexDocument = existsSync(codexHooksFile)
    ? JSON.parse(readFileSync(codexHooksFile, 'utf8') || '{}')
    : {};
  if (!codexDocument.hooks || typeof codexDocument.hooks !== 'object') codexDocument.hooks = {};
  const codexRetiredHooks = stripRetiredLeadHooks(codexDocument.hooks, keepUserEntries);
  const codexStates = {
    session_digest: ensureHook(
      codexDocument.hooks,
      'SessionStart',
      '.*',
      'session-start.mjs',
      hookCommand(ctx.repo, 'session-start.mjs'),
    ),
    domain_lessons: ensureHook(
      codexDocument.hooks,
      'PreToolUse',
      '^(apply_patch|Edit|Write|NotebookEdit)$',
      'domain-lessons-hook.mjs',
      hookCommand(ctx.repo, 'domain-lessons-hook.mjs'),
    ),
    rtk_routing: ensureHook(
      codexDocument.hooks,
      'PreToolUse',
      '^(shell|Bash)$',
      'codex-rtk-hook.mjs',
      hookCommand(ctx.repo, 'codex-rtk-hook.mjs'),
    ),
    code_intel_order: ensureHook(
      codexDocument.hooks,
      'PreToolUse',
      '^(shell|Bash|Read|Grep|Glob|search_code|extract_code)$',
      'code-intel-order-hook.mjs',
      hookCommand(ctx.repo, 'code-intel-order-hook.mjs', 'codex'),
    ),
    ...installLeadHooks(codexDocument.hooks, ctx.repo, '.*', ensureHook, hookCommand, harnessHookScript),
  };
  const removedRtkCodex = stripBareRtkCodexHook(codexDocument.hooks);
  if (removedRtkCodex) {
    process.stderr.write('removed bare rtk hook codex from the Bash PreToolUse group\n');
  }
  writeUtf8(codexHooksFile, `${JSON.stringify(codexDocument, null, 2)}\n`);
  // `repointed` counts as much as `installed`, and missing that is what a
  // reviewer caught in round `mac-migration-r2`: codex records trust against the
  // hook's HASH, so rewriting a hook's command invalidates its trust exactly as
  // writing a new one does. Filtering on `installed` alone reported a repointed
  // hook as `already_installed` with no word about trust — leaving a hook that
  // codex will not fire and an operator with no reason to go and accept it.
  const codexInstalled = Object.entries(codexStates)
    .filter(([, state]) => state === 'installed' || state === 'repointed')
    .map(([id]) => id);
  const pending = path.join(ctx.home, '.codex', 'codex-hooks.pending.toml');
  if (existsSync(pending)) unlinkSync(pending);
  report.push({
    runtime: 'codex',
    path: codexHooksFile,
    state: codexInstalled.length ? 'installed' : 'already_installed',
    ...codexStates,
    retired_hooks: codexRetiredHooks,
    ...(removedRtkCodex ? { removed_rtk_hook_codex: removedRtkCodex } : {}),
    ...(codexInstalled.length
      ? { needs_trust: 'codex records a trusted_hash per hook entry; a newly written hook does not fire until codex trusts it — open a codex session (or its Hooks panel) once and accept them' }
      : {}),
  });

  // grok's own file, under its own home.
  //
  // `$GROK_HOME` wins when the caller did NOT declare one, exactly as grok's own
  // documentation says, so a sealed member home does not get the operator's
  // hooks by accident. An EXPLICIT `--home` is a declaration and wins over the
  // ambient variable: silently writing somewhere else is how the same installer
  // both promised a home and used another. Measured 2026-08-18: with GROK_HOME
  // set to anything, `node --test scripts/test-install-macos.mjs` exited 1 on
  // `grok hooks file was not written` - the test is red from ANY grok seat,
  // because the seat exports the variable for itself.
  const grokFile = path.join(grokRuntimeHome(ctx), 'hooks', `${projectPrefix}.json`);
  mkdirSync(path.dirname(grokFile), { recursive: true });
  const grokWanted = `${JSON.stringify(grokHooks(ctx.repo), null, 2)}\n`;
  const grokBefore = existsSync(grokFile) ? readFileSync(grokFile, 'utf8') : null;
  if (grokBefore !== grokWanted) {
    writeUtf8(grokFile, grokWanted);
    report.push({
      runtime: 'grok',
      path: grokFile,
      state: grokBefore === null ? 'installed' : 'repointed',
      note: 'grok gained hooks in its own file; PreToolUse is the only blocking event and every failure mode is fail-open',
    });
  } else {
    report.push({ runtime: 'grok', path: grokFile, state: 'already_installed' });
  }
  return report;
}

const PLATFORM_BLOCK = /[ \t]*<!-- platform:([a-z0-9]+) -->\n([\s\S]*?)[ \t]*<!-- \/platform:\1 -->\n?/g;

/**
 * Keep only the blocks addressed to the platform being installed for.
 *
 * The instruction file is ONE file for seven runtimes, and most of it is
 * platform-free. The shell section is not: telling a Mac agent to reach for Git
 * Bash and to mind PowerShell quoting is not merely noise, it is instruction to
 * do the wrong thing on a machine whose whole point is one native shell. A
 * block whose platform nobody claims stays — an unknown marker must not delete
 * text silently.
 */
function selectPlatformBlocks(body, platform) {
  const known = new Set(['win32', 'darwin', 'linux']);
  return body.replace(PLATFORM_BLOCK, (whole, name, inner) => {
    if (!known.has(name)) return whole;
    return name === platform ? inner.replace(/\s*$/, '\n') : '';
  });
}

// One instruction file is installed into seven runtime homes, and until
// 2026-09-18 all seven got the same bytes. That is wrong whenever a runtime
// CANNOT do what the shared text tells it to. Measured that day: grok's
// `run_terminal_command` splits on whitespace and passes quotes through as
// characters, so `probe search "<phrase>"`, `ast-grep -p '<pattern>'` and
// `node -e '<code>'` — all three mandated by the contract — fail there, and the
// seat reads whole files instead. Same shape as the platform blocks, which exist
// for the same reason: a Windows Shell section reaching a Mac told it to do the
// wrong thing.
const RUNTIME_BLOCK = /[ \t]*<!-- runtime:([a-z0-9-]+) -->\n([\s\S]*?)[ \t]*<!-- \/runtime:\1 -->\n?/g;

/**
 * Keep only the blocks addressed to the runtime being installed for. The runtime
 * name is the home directory without its dot: `grok`, `claude`, `kimi-code`,
 * `glm-worker-config`, ... An UNKNOWN name is left standing, exactly as
 * selectPlatformBlocks does: silently deleting text is worse than an extra
 * paragraph, and a typo must be visible rather than swallowed.
 */
function selectRuntimeBlocks(body, runtime) {
  const known = new Set(INSTRUCTION_TARGETS.map(([dir]) => dir.slice(1)));
  return body.replace(RUNTIME_BLOCK, (whole, name, inner) => {
    if (!known.has(name)) return whole;
    return name === runtime ? inner.replace(/\s*$/, '\n') : '';
  });
}

const REPLY_LANGUAGE_TOKEN = '{{LEAD_REPLY_LANGUAGE}}';

// The source names the reply language with a token so one config key can change
// it. An absent key renders Russian, the sentence of today. A token that
// survives into a block is a missed substitution: refuse the write.
function renderReplyLanguage(body, language) {
  const rendered = body.split(REPLY_LANGUAGE_TOKEN).join(language);
  const leftover = rendered.match(/\{\{[A-Za-z0-9_]+\}\}/);
  if (leftover) throw new Error(`instruction block still contains ${leftover[0]}`);
  return rendered;
}

function readInstructionUserText(ctx, value) {
  if (value === undefined) return undefined;
  const file = path.isAbsolute(value) ? value
    : value.startsWith('~/') ? path.join(ctx.home, value.slice(2))
      : path.resolve(ctx.repo, value);
  let fd;
  try {
    if (!statSync(file).isFile()) throw new Error('not a regular file');
    // Inspect and read the same descriptor. Nonblocking open also avoids waiting
    // on a FIFO if the path is replaced between stat and open.
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const entry = fstatSync(fd);
    if (!entry.isFile()) throw new Error('not a regular file');
    if (entry.size > 16384) throw new Error('larger than 16384 bytes');
    // Bound the read even if another writer grows the file after fstat.
    const bytes = Buffer.alloc(16385);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > 16384) throw new Error('larger than 16384 bytes');
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
    } catch {
      throw new Error('not valid UTF-8');
    }
    if (/<!--[ \t]+(?:BEGIN|END)[ \t]+[^\s<>]+-bootstrap(?::[^\r\n]*|[ \t]*)-->/.test(text)) {
      throw new Error('contains a bootstrap BEGIN or END marker');
    }
    return text;
  } catch (error) {
    throw new Error(`Cannot read lead.userTextFile ${file}: ${error.message}`, { cause: error });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function installInstructions(ctx) {
  const [BEGIN_INSTRUCTIONS, END_INSTRUCTIONS] = markers(ctx).instructions;
  const lead = readHarnessConfig({ repoRoot: ctx.repo }).lead;
  const language = lead?.replyLanguage ?? 'Russian';
  const source = path.join(ctx.repo, 'ops', 'bootstrap', 'agent-instructions.md');
  if (!existsSync(source)) throw new Error(`Instruction source is missing: ${source}`);
  const forPlatform = selectPlatformBlocks(renderReplyLanguage(readFileSync(source, 'utf8'), language), ctx.platform);
  const userText = readInstructionUserText(ctx, lead?.userTextFile);
  const report = [];
  for (const [dir, name] of INSTRUCTION_TARGETS) {
    const runtime = dir.slice(1);
    // Per TARGET, not once: a runtime block must survive in its own file and
    // vanish from the other six.
    const selected = selectRuntimeBlocks(forPlatform, runtime).replace(/\s*$/, '');
    const body = userText === undefined ? selected : `${selected}\n\n${userText}`;
    const block = [
      BEGIN_INSTRUCTIONS,
      '<!-- Source: ops/bootstrap/agent-instructions.md - edit there, then re-run',
      '     ops/bootstrap/install-harness.mjs. Edits here are overwritten. -->',
      '',
      body,
      END_INSTRUCTIONS,
    ].join('\n');
    const file = path.join(ctx.home, dir, name);
    const existing = readText(file);
    writeUtf8(file, replaceMarked(existing, BEGIN_INSTRUCTIONS, END_INSTRUCTIONS, block));
    report.push({ runtime, path: file });
  }
  return report;
}

/**
 * The lead's permission lists, from the repository rather than from one machine.
 *
 * Until this existed the lists lived only in the operator's own settings.json:
 * a second machine started with ZERO allowed rules, so every read and every
 * `git status` stopped to ask. `platforms` drops the entries that mean nothing
 * on the target — a PowerShell rule on a Mac is noise that hides the real list,
 * and `bash /c/Users/*` guards a Git Bash home that does not exist there.
 * `machine` is evaluated against THIS home: an ssh Host alias is installed
 * only when ~/.ssh/config defines it. platforms is not that question.
 */
function installPermissions(ctx) {
  const source = path.join(ctx.repo, 'ops', 'bootstrap', 'permissions.json');
  if (!existsSync(source)) throw new Error(`Permission source is missing: ${source}`);
  const canon = JSON.parse(readFileSync(source, 'utf8'));
  assertPermissionCanon(canon);
  const { allow, deny } = selectPermissionRules(canon, ctx);
  const file = path.join(ctx.home, '.claude', 'settings.json');
  const installed = writePermissionSettings({ repoRoot: ctx.repo, home: ctx.home, file, allow, deny });
  return { file, allow: installed.allow.length, deny: installed.deny.length };
}

/**
 * Make this checkout's `.rtk/filters.toml` ACTIVE, and gate it on its inline
 * tests.
 *
 * rtk 0.49 refuses to apply a project-local TOML filter until it is trusted,
 * and trust is pinned per file path + sha256 (observed in
 * `%LOCALAPPDATA%\rtk\trusted_filters.json`; `rtk trust --list`). An untrusted
 * filter is not an error anywhere the operator looks: `rtk hook claude` just
 * answers "No rewrite" and `rtk gain` carries a one-line "untrusted custom
 * filter(s) not applied" nobody reads. So after every edit of the filter
 * source — and once per checkout, because a worktree is a different path —
 * the trust must be renewed, or the source silently does nothing. That is an
 * install step, not an operator memory (the hand-made-config lesson, same
 * shape: a config without a source never reaches the second machine).
 *
 * `rtk verify --filter <name>` runs the inline [[tests.<name>]] fixtures, so
 * a filter whose tests fail — or that declares no tests at all — refuses the
 * install instead of shipping a rewrite that eats output nobody checked.
 *
 * Order: trust FIRST, then verify, then REVOKE on failure. Verify-first is not
 * an option — measured 2026-09-21: `rtk verify` on an untrusted file answers
 * "WARNING: untrusted project filters skipped in verify" and then reports a
 * passing count anyway (a broken expectation still says 3/3 passed), so the
 * tests only run once the file is trusted. Trusting before proving is then
 * only safe if a failed verify takes the trust back: without the revoke, a
 * filter whose tests fail stays trusted and live, silently rewriting output
 * nobody checked (reproduced by reviewer-astra 5653060f).
 */
function installRtkFilters(ctx) {
  let names = [];
  try {
    names = [...readFileSync(path.join(ctx.repo, '.rtk', 'filters.toml'), 'utf8')
      .matchAll(/^\s*\[filters\.([A-Za-z0-9_-]+)\]/gm)].map((match) => match[1]);
  } catch {
    return { skipped: true, reason: 'no .rtk/filters.toml in this checkout' };
  }
  if (names.length === 0) return { skipped: true, reason: '.rtk/filters.toml declares no filters' };
  const bin = resolveOnPath(
    'rtk',
    canonicalSearchDirs({ home: ctx.home, platform: ctx.platform, systemDirs: ctx.systemDirs }),
    { platform: ctx.platform },
  );
  if (!bin) return { skipped: true, reason: 'rtk not found under this HOME', filters: names };

  // rtk resolves `.rtk/filters.toml` from its CWD, so every spawn runs inside
  // the checkout being installed.
  const run = (args) => runProviderCli(bin, args, { ...process.env }, { cwd: ctx.repo, timeout: 60_000 });
  const trust = run(['trust', '-y']);
  if (trust.status !== 0) {
    throw new Error(
      `rtk trust -y failed (exit ${trust.status}): ${(trust.stderr || trust.stdout || '').trim().slice(0, 300)} — ` +
        `run \`rtk trust\` inside ${ctx.repo} and read the parse error above.`,
    );
  }
  const failed = [];
  for (const name of names) {
    const check = run(['verify', '--filter', name]);
    const said = `${check.stdout || ''}${check.stderr || ''}`;
    if (check.status !== 0 || !/\d+\/\d+ tests passed/.test(said)) failed.push(name);
  }
  if (failed.length > 0) {
    // The trust was granted to run the tests; a failure must take it back, or
    // the failing sha stays trusted and live. Best-effort: an untrust that
    // itself fails must not mask the test failure below.
    try {
      run(['untrust']);
    } catch {
      // runProviderCli throws only on spawn errors, not on exit codes.
    }
    throw new Error(
      `rtk filter inline tests failed: ${failed.join(', ')} — run \`rtk verify\` inside ${ctx.repo}. ` +
        'A filter that eats output nobody checked is a refused install, not a warning. ' +
        'The trust granted for the test run has been revoked.',
    );
  }
  return { skipped: false, bin, filters: names, tests: 'passed' };
}

/**
 * rtk's own Pi extension, `~/.pi/agent/extensions/rtk.ts` (task 1436, operator
 * 2026-09-23): on every Pi bash call it asks `rtk rewrite`, so exactly the
 * commands in rtk's registry go through rtk and nothing else (#10523). The file
 * is rtk's, written by rtk itself, so an rtk upgrade and a re-install keep the
 * two in step; Pi discovers it on its own, orch seats included.
 */
function installLeadRtk(ctx) {
  const [BEGIN_RTK_TEXT, END_RTK_TEXT] = markers(ctx).rtkText;
  const bin = resolveOnPath(
    'rtk',
    canonicalSearchDirs({ home: ctx.home, platform: ctx.platform, systemDirs: ctx.systemDirs }),
    { platform: ctx.platform },
  );
  if (!bin) return { skipped: true, reason: 'rtk not found under this HOME' };
  const env = { ...process.env, HOME: ctx.home, USERPROFILE: ctx.home, CODEX_HOME: path.join(ctx.home, '.codex') };
  const steps = [
    { args: ['init', '-g', '--auto-patch'], file: path.join(ctx.home, '.claude', 'RTK.md'), instructions: path.join(ctx.home, '.claude', 'CLAUDE.md'), reference: '@RTK.md' },
    // rtk 0.49 refuses --codex with --auto-patch: Codex init patches AGENTS.md automatically.
    { args: ['init', '-g', '--codex'], file: path.join(ctx.home, '.codex', 'RTK.md'), instructions: path.join(ctx.home, '.codex', 'AGENTS.md'), reference: `@${path.join(ctx.home, '.codex', 'RTK.md')}` },
  ];
  for (const step of steps) {
    const run = runProviderCli(bin, step.args, env, { cwd: ctx.home, timeout: 60_000 });
    if (run.status !== 0 || !existsSync(step.file) || !readText(step.instructions)?.includes(step.reference)) {
      throw new Error(`rtk ${step.args.join(' ')} failed (exit ${run.status}): ${(run.stderr || run.stdout || '').trim().slice(0, 300)} — missing ${step.file} or instruction reference`);
    }
  }
  // After the Codex step: inline the text of the RTK.md rtk wrote in THIS
  // install into AGENTS.md, in a block of its own. The `@` line of rtk stays
  // where rtk put it - rtk owns it and the check above reads it (decision
  // 10538) - and replaceMarked replaces the block in place on a second
  // install instead of adding one more. The text is checked BEFORE the write,
  // at the trust boundary: a marker inside it would split the block and leave a
  // tail plus one more end marker outside it on each later install, and empty
  // text would drop the earlier text without a sign. Both refuse the install
  // and leave AGENTS.md untouched.
  const codexRtk = path.join(ctx.home, '.codex', 'RTK.md');
  const codexAgents = path.join(ctx.home, '.codex', 'AGENTS.md');
  const rtkRaw = readText(codexRtk) ?? '';
  for (const marker of [BEGIN_RTK_TEXT, END_RTK_TEXT]) {
    if (rtkRaw.includes(marker)) {
      throw new Error(
        `refusing to inline ${codexRtk} into AGENTS.md: its text holds the block marker ${marker} — AGENTS.md is left unchanged`,
      );
    }
  }
  const rtkText = rtkRaw.replace(/\s*$/, '');
  if (!rtkText) {
    throw new Error(
      `refusing to inline ${codexRtk} into AGENTS.md: the file is empty or white space only — AGENTS.md is left unchanged`,
    );
  }
  const block = [BEGIN_RTK_TEXT, rtkText, END_RTK_TEXT].join('\n');
  writeUtf8(codexAgents, replaceMarked(readText(codexAgents), BEGIN_RTK_TEXT, END_RTK_TEXT, block));
  return { skipped: false, bin, files: steps.map((step) => step.file) };
}

function installPiRtk(ctx) {
  const bin = resolveOnPath(
    'rtk',
    canonicalSearchDirs({ home: ctx.home, platform: ctx.platform, systemDirs: ctx.systemDirs }),
    { platform: ctx.platform },
  );
  if (!bin) return { skipped: true, reason: 'rtk not found under this HOME' };
  const file = path.join(ctx.home, '.pi', 'agent', 'extensions', 'rtk.ts');
  const run = runProviderCli(bin, ['init', '-g', '--agent', 'pi', '--hook-only', '--auto-patch'], {
    ...process.env, HOME: ctx.home, USERPROFILE: ctx.home,
  }, { cwd: ctx.home, timeout: 60_000 });
  if (run.status !== 0 || !existsSync(file)) {
    throw new Error(
      `rtk init -g --agent pi failed (exit ${run.status}): ${(run.stderr || run.stdout || '').trim().slice(0, 300)} — ` +
        `Pi seats would run every shell command without rtk. Run it by hand and read the error.`,
    );
  }
  return { skipped: false, bin, extension: file };
}

/**
 * Write the opencode scout's runtime configuration where its CLI reads it.
 *
 * The seat was stood up by hand on 2026-09-19 (decision #9840) with a bash
 * allowlist — `"*": "deny"` plus rg, ls, cat and git log|show|diff. That file
 * had no source in this repository, so the Mac never received it and any
 * re-install would have dropped it; and the allowlist contradicted the same
 * decision, which says the seat NEEDS tools ("чтение файлов, поиск, кодовая
 * навигация"). codegraph, ast-grep and memoryctl were all denied by it, while
 * the `scout-opencode` profile's own notes promised exactly those three.
 *
 * Operator decision 2026-09-20: full parity with the grok scout — the shell is
 * open, and read-only is held by the ROLE in the brief, the same way it is for
 * grok (which runs `--always-approve`). `edit: deny` stays because it costs
 * nothing and still refuses the edit tool outright.
 *
 * Unknown top-level keys are preserved: this file is also where an operator
 * would put a provider or model override by hand.
 */
function installOpencode(ctx) {
  const file = path.join(ctx.home, '.config', 'opencode', 'opencode.json');
  const existing = readText(file);
  let config = {};
  if (existing && existing.trim() !== '') {
    try {
      config = JSON.parse(existing);
    } catch (error) {
      return { file, state: 'unparseable', error: error.message };
    }
  }
  const before = JSON.stringify(config);
  config.$schema = 'https://opencode.ai/config.json';
  config.autoupdate = false;
  config.model = 'opencode-go/glm-5.3-flash';
  config.small_model = 'opencode-go/glm-5.3-flash';
  // The allowlist WAS the read-only guarantee, and removing it is the point of
  // the 2026-09-20 decision: a scout that cannot run codegraph, ast-grep or
  // memoryctl is not a scout. Delete the key rather than widening it, so a
  // stale narrow copy cannot survive a re-install.
  const permission = { ...(config.permission || {}) };
  delete permission.bash;
  permission.edit = 'deny';
  // `ask` is a hang, not a guard: nobody answers a prompt in a seat, and with an
  // open shell the seat can `curl` the same page regardless.
  permission.webfetch = 'allow';
  // The same holds for paths outside the seat's checkout, whose default is
  // `ask`. All 17 prompts in the opencode log of 2026-09-21 were this one —
  // TEMP, ~/.paseo (plugins, other worktrees), ~/.config/opencode, the npm
  // prefix, the app's logs, Paseo's install directory — and each parked the
  // seat until the lead answered it. A narrower list only moves the
  // hang to the next directory. Writing stays refused: `edit` covers the
  // edit, write and patch tools wherever the path is.
  permission.external_directory = { '*': 'allow' };
  config.permission = permission;
  if (JSON.stringify(config) === before) return { file, state: 'already_installed' };
  writeUtf8(file, `${JSON.stringify(config, null, 2)}\n`);
  return { file, state: existing == null ? 'installed' : 'updated', shell: 'unrestricted (grok parity)' };
}

function installPath(ctx) {
  const [BEGIN_ZSHENV, END_ZSHENV] = markers(ctx).zshenv;
  const options = { home: ctx.home, platform: ctx.platform, systemDirs: ctx.systemDirs, repoRoot: ctx.repo };
  const dirs = canonicalSearchDirs(options);
  const rendered = ctx.platform === 'win32'
    ? dirs.join(';')
    : dirs.map((dir) => posix(dir)).join(':');
  const { stateDir } = harnessPaths({ home: ctx.home, prefix: readHarnessConfig({ repoRoot: ctx.repo }).names.prefix });
  writeUtf8(path.join(stateDir, 'canonical-path'), `${rendered}\n`);
  if (ctx.platform === 'darwin' || ctx.platform === 'linux') {
    const exportLine = `export PATH="${posixSearchPath(options)}:$PATH"`;
    const block = `${BEGIN_ZSHENV}\n${exportLine}\n${END_ZSHENV}`;
    const zshenv = path.join(ctx.home, '.zshenv');
    writeUtf8(zshenv, replaceMarked(readText(zshenv), BEGIN_ZSHENV, END_ZSHENV, block));
  }
  const resolved = resolveProviders(options);
  if (ctx.platform === 'win32') resolved.userPath = persistWindowsUserPath(ctx);
  return resolved;
}

function resolveClaudeForInstall(ctx) {
  // Prefer the claude that belongs to THIS --home. Machine-wide dirs
  // (/opt/homebrew/bin) are absolute, so resolveProviders would pick the
  // brew binary on a Mac and the planted stub on Windows — the live-CLI
  // 4.4s failure the plugin case is written to catch.
  const homeBin = path.join(ctx.home, '.claude', 'bin');
  const fromHome = resolveOnPath('claude', [homeBin], { platform: ctx.platform });
  if (fromHome) return fromHome;
  return resolveProviders({ home: ctx.home, platform: ctx.platform, systemDirs: ctx.systemDirs }).found.claude || null;
}

function runProviderCli(bin, args, env, options = {}) {
  // Windows cannot exec a shebang file. The planted stub and some real installs
  // are node scripts without an extension, so those run under this node. A
  // NATIVE claude does not: on 2026-09-16 the second machine had
  // %USERPROFILE%\.local\bin\claude.exe, node was handed the PE image and
  // answered `SyntaxError: Invalid or unexpected token` at byte one, which the
  // installer reported as a refused plugin marketplace. An .exe runs itself.
  // Same dispatch for rtk: a real rtk is a PE on Windows and a binary on the
  // Mac, and the fixture plants an extensionless node stub.
  const extension = path.extname(bin).toLowerCase();
  if (process.platform === 'win32' && extension === '.cmd') {
    // cmd expands these environment references once, inside quotes. Literal
    // percent signs in a HOME path must not become another variable expansion;
    // delayed expansion is off so exclamation marks survive too.
    if ([bin, ...args].some((value) => /["\r\n]/.test(value))) {
      throw new Error('Cannot safely pass a quote or newline to a Windows command wrapper');
    }
    const commandEnv = { ...env, HARNESS_PROVIDER_BIN: bin };
    const references = args.map((value, index) => {
      commandEnv[`HARNESS_PROVIDER_ARG_${index}`] = value;
      return `"%HARNESS_PROVIDER_ARG_${index}%"`;
    });
    const cmd = process.env.ComSpec || path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    return spawnSync(cmd, ['/d', '/s', '/v:off', '/c', `""%HARNESS_PROVIDER_BIN%" ${references.join(' ')}"`], {
      encoding: 'utf8', timeout: 30_000, shell: false, ...options,
      env: commandEnv, windowsVerbatimArguments: true, windowsHide: true,
    });
  }
  const native = process.platform === 'win32' && extension === '.exe';
  const viaNode = process.platform === 'win32' && !native;
  const command = viaNode ? process.execPath : bin;
  const argv = viaNode ? [bin, ...args] : args;
  return spawnSync(command, argv, {
    encoding: 'utf8',
    env,
    timeout: 30_000,
    shell: false,
    ...options,
  });
}

function pluginRegistryMentions(registry, name) {
  return JSON.stringify(registry).includes(name);
}

function gitDirectory() {
  const resolved = resolveOnPath('git', canonicalSearchDirs(), {});
  if (resolved) return path.dirname(resolved);
  // Ask the system where git is rather than guessing a Program Files path.
  const probe = process.platform === 'win32'
    ? spawnSync('where', ['git'], { encoding: 'utf8' })
    : spawnSync('command', ['-v', 'git'], { encoding: 'utf8', shell: true });
  if (probe.status !== 0) return null;
  const first = String(probe.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return first ? path.dirname(first) : null;
}

// A plugin's skills are namespaced, so a plugin skill named like a canon skill
// is not a conflict any runtime resolves — it is a SECOND entry beside ours that
// the model may pick instead, and it carries none of this project's rules.
// Measured 2026-09-18: caveman 2.7.0 shipped `investigate-first`,
// `surgical-patch` and `verify-and-stop` under those exact names, and
// `~/.claude.json` skillUsage recorded the model calling
// `caveman:investigate-first` and `caveman:surgical-patch` rather than ours.
// Quarantine rather than delete: a plugin update puts the directory back, and
// this runs again on the next install instead of being a one-time hand edit.
const PLUGIN_SKILL_QUARANTINE = '.skills-removed-by-harness';

/** The skill's own declared name; the directory name is only a fallback. */
function declaredSkillName(file) {
  const block = readFileSync(file, 'utf8').slice(0, 4096).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const named = block?.[1].match(/^name:[ \t]*(\S.*?)[ \t]*$/m);
  return named ? named[1] : null;
}

/** Every `skills/` directory under a plugin cache, at any depth. */
function pluginSkillRoots(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // no plugin cache on this machine yet
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === PLUGIN_SKILL_QUARANTINE) continue;
    const child = path.join(dir, entry.name);
    if (entry.name === 'skills') out.push(child);
    else pluginSkillRoots(child, out);
  }
  return out;
}

function quarantineCollidingPluginSkills(ctx) {
  const canonDir = path.join(ctx.repo, '.agents', 'skills');
  if (!existsSync(canonDir)) return { checked: 0, moved: [] };
  const canon = new Set(
    readdirSync(canonDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(canonDir, entry.name, 'SKILL.md')))
      .map((entry) => declaredSkillName(path.join(canonDir, entry.name, 'SKILL.md')) || entry.name),
  );
  const cache = path.join(ctx.home, '.claude', 'plugins', 'cache');
  const moved = [];
  let checked = 0;
  for (const root of pluginSkillRoots(cache)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(root, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      checked += 1;
      const name = declaredSkillName(skillFile) || entry.name;
      if (!canon.has(name)) continue;
      const quarantine = path.join(path.dirname(root), PLUGIN_SKILL_QUARANTINE);
      mkdirSync(quarantine, { recursive: true });
      const target = path.join(quarantine, entry.name);
      // A previous quarantine of the same skill is a stale copy of what the
      // plugin update just reinstalled: replace it rather than fail the rename.
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      renameSync(path.join(root, entry.name), target);
      moved.push(`${name} <- ${path.relative(cache, root).split(path.sep).join('/')}`);
    }
  }
  return { checked, moved };
}

function installPlugins(ctx) {
  // Disable at USER scope before contacting the CLI: removing cache files alone
  // lets an enabled plugin return at the next marketplace synchronization.
  // A file that is not JSON stops the step with its path in the message and
  // keeps its bytes: the operator repairs it, the installer never guesses.
  const parseNamed = (file, text) => {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`${file} is not JSON, left as it is: ${error.message}`);
    }
  };
  const settingsPath = path.join(ctx.home, '.claude', 'settings.json');
  const settings = parseNamed(settingsPath, readText(settingsPath) || '{}');
  const before = JSON.stringify(settings);
  settings.enabledPlugins = { ...settings.enabledPlugins, 'caveman@caveman': false };
  if (settings.extraKnownMarketplaces) delete settings.extraKnownMarketplaces.caveman;
  if (JSON.stringify(settings) !== before) writeUtf8(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  // installed_plugins v2 stores all scopes in one array under the plugin key.
  // Remove that registration, preserving every unrelated plugin and metadata.
  for (const [file, nested, key] of [
    ['installed_plugins.json', 'plugins', 'caveman@caveman'],
    ['known_marketplaces.json', null, 'caveman'],
  ]) {
    const target = path.join(ctx.home, '.claude', 'plugins', file);
    const text = readText(target);
    if (text == null) continue;
    const registry = parseNamed(target, text);
    const entries = nested ? registry[nested] : registry;
    if (entries && Object.hasOwn(entries, key)) {
      delete entries[key];
      writeUtf8(target, `${JSON.stringify(registry, null, 2)}\n`);
    }
  }
  const claude = resolveClaudeForInstall(ctx);
  if (!claude) {
    return { skipped: true, reason: 'claude CLI not found under this HOME' };
  }
  const env = {
    ...process.env,
    HOME: ctx.home,
    USERPROFILE: ctx.home,
    // The CLI's own directory, plus the directory of the node running THIS
    // installer. A provider CLI is not always a native binary: on macOS codex
    // ships as a node script, and a claude that is a wrapper dies with exit 127
    // (env: node: No such file or directory) when its interpreter is not on
    // PATH. process.env.PATH is not the answer — the suite runs the installer
    // with an empty PATH on purpose, and the real sealed install narrows it too.
    // ... and git, because `claude plugin marketplace add` CLONES a repository:
    // without it the call dies with `Command 'git' not found or is in an unsafe
    // location`. On unix git sits in /usr/bin, which is already on the canonical
    // list, so the hole only opens on Windows — where it is resolved, never
    // hardcoded: a custom Git install directory is normal there.
    PATH: [path.dirname(claude), path.dirname(process.execPath), gitDirectory()]
      .filter(Boolean)
      .join(path.delimiter),
  };
  const ran = [];
  for (const source of CLAUDE_PLUGIN_MARKETPLACES) {
    const args = ['plugin', 'marketplace', 'add', source];
    const result = runProviderCli(claude, args, env);
    if (result.status !== 0) {
      throw new Error(
        `claude ${args.join(' ')} failed (exit ${result.status}): ${result.stderr || result.stdout}. ` +
          'The marketplace is required; a missing marketplace is a refused install, not a skip.',
      );
    }
    ran.push(args.join(' '));
  }
  for (const spec of CLAUDE_PLUGINS) {
    const args = ['plugin', 'install', spec, '--scope', 'user'];
    const result = runProviderCli(claude, args, env);
    if (result.status !== 0) {
      throw new Error(
        `claude ${args.join(' ')} failed (exit ${result.status}): ${result.stderr || result.stdout}. ` +
          'This install exits without them rather than starting the harness incomplete.',
      );
    }
    ran.push(args.join(' '));
  }
  // With no managed plugins, verify the marketplace CLI's receipt instead.
  const registryPath = path.join(ctx.home, '.claude', 'plugins',
    CLAUDE_PLUGINS.length ? 'installed_plugins.json' : 'known_marketplaces.json');
  if (!existsSync(registryPath)) {
    throw new Error(
      `claude plugin command exited 0 but ${registryPath} is missing. ` +
        'A stub that returns success without writing the registry is a defect.',
    );
  }
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const expected = CLAUDE_PLUGINS.length ? CLAUDE_PLUGINS : CLAUDE_PLUGIN_MARKETPLACES;
  const missing = expected.filter((spec) => !pluginRegistryMentions(
    registry, CLAUDE_PLUGINS.length ? spec.split('@')[0] : spec.split('/').at(-1),
  ));
  if (missing.length) {
    throw new Error(
      `plugin registry at ${registryPath} does not name ${missing.join(', ')}. ` +
        `Re-run: ${missing.map((spec) => `claude plugin ${CLAUDE_PLUGINS.length ? 'install' : 'marketplace add'} ${spec}`).join(' && ')}`,
    );
  }
  return { skipped: false, claude, ran, registry: registryPath, canonCollisions: quarantineCollidingPluginSkills(ctx) };
}

function maybeInstallCodeIntel(ctx) {
  if (ctx.skipCodeIntel) return { skipped: true };
  // `npm` by name does not exist as an executable image on Windows: it is
  // npm.cmd, and Node refuses to spawn a .cmd without a shell (the 2024 argument
  // -injection fix), so this came back as `exit null` — spawn failed before npm
  // ever ran. A shell is not the answer either; cmd.exe is not an argv transport.
  // npm is a node script, so run it the way it really is: this node, plus the
  // npm-cli.js that ships beside it.
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const [file, argv] = process.platform === 'win32' && existsSync(npmCli)
    ? [process.execPath, [npmCli, 'install', '--global', '@colbymchenry/codegraph', '@ast-grep/cli']]
    : ['npm', ['install', '--global', '@colbymchenry/codegraph', '@ast-grep/cli']];
  const result = spawnSync(file, argv, {
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`Failed to install codegraph and ast-grep (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  return { skipped: false, ripgrep: installRipgrep() };
}

/**
 * ripgrep is the contract's FIRST instrument for a known literal and the engine
 * behind `rtk rg`, and it does not ship through npm — which is why it was the
 * one mandatory tool nothing installed and nothing checked. Measured 2026-09-18
 * on this Windows machine: `rtk rg` answered `Failed to resolve 'rg' via PATH
 * ... program not found` and `rtk grep` silently degraded to Git Bash grep,
 * while every runtime's rules file told the seat to search with it. Seats read
 * whole files instead — grok's own day log showed 408 `read_file` against 0
 * searches.
 *
 * cargo is the route: this is a Rust repository, both machines already build
 * `<project-specific>`, and `~/.cargo/bin` is on every canonical search path already.
 * The build takes minutes, so it runs ONLY when `rg` cannot be resolved.
 */
function installRipgrep() {
  if (resolveOnPath('rg', canonicalSearchDirs(), {})) return 'already_installed';
  const cargo = resolveOnPath('cargo', canonicalSearchDirs(), {});
  if (!cargo) {
    throw new Error(
      'ripgrep is missing and cargo is not on the canonical search path. ' +
        'CLAUDE.md names `rg` as the first code-intel instrument and `rtk rg` cannot run without it: ' +
        'install a Rust toolchain, or install ripgrep by hand into ~/.cargo/bin, then re-run.',
    );
  }
  const result = spawnSync(cargo, ['install', 'ripgrep', '--locked'], { encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    throw new Error(`cargo install ripgrep failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  return 'installed';
}

/**
 * orch, the local orchestration daemon (ops/orchestrator), as a per-user
 * service: a LaunchAgent on macOS, a logon task on Windows. Delegated to its
 * own installer so `node ops/orchestrator/install.mjs --dry|--uninstall` stays
 * the one place that knows the service shape.
 *
 * orch is `required: false` in the MCP SSOT, so nothing here fails the whole
 * install: every refusal is `skipped` with its reason and a hint.
 *
 * A linked worktree is refused like the home-scope skills step: the service is
 * machine-wide, and a worktree would repoint com.booharness.orch at a path that
 * dies with it.
 *
 * launchctl and schtasks act on the REAL login session whatever HOME says, so
 * a declared --home (every test fixture) or a foreign --platform writes the
 * service file and never activates it.
 */
const orchHint = (dir) => `npm ci --omit=dev --prefix ${dir}, then re-run the installer with --only orchestrator`;

/**
 * orch's glm provider secret lives in `<state dir>/providers.json` (0600);
 * `ops/orchestrator/src/providers/index.ts:glmEnv` reads only that file. The
 * first install after the move migrates it from the retired Paseo location
 * (`~/.paseo/config.json`, `agents.providers.glm.env`). An existing target is
 * authoritative and never overwritten; the secret is never printed (the report
 * carries a state word only) and the file is never committed (it lives under
 * HOME, not the repo).
 */
function migrateOrchProviders(ctx) {
  if (ctx.skipOrchestrator) return { skipped: true, reason: '--skip-orchestrator' };
  const target = path.join(ctx.home, '.local', 'state', 'orch', 'providers.json');
  const dir = path.dirname(target);
  const components = [path.resolve(ctx.home)];
  for (const part of ['.local', 'state', 'orch']) components.push(path.join(components.at(-1), part));
  const ensureSafeDir = (create) => {
    for (const component of components) {
      let entry;
      try {
        entry = lstatSync(component);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!create) continue;
        try { mkdirSync(component, { mode: 0o700 }); } catch (mkdirError) {
          if (mkdirError.code !== 'EEXIST') throw mkdirError;
        }
        entry = lstatSync(component);
      }
      if (!entry.isDirectory()) throw new Error(`refusing non-directory orch provider path component: ${component}`);
    }
  };
  // Validate even when the target already exists: lstat(target) alone would
  // follow a symlink in HOME/.local/state/orch and trust its destination.
  ensureSafeDir(false);
  // existsSync follows links and treats a dangling link as absent. Never follow
  // any existing entry when deciding whether this secret may be installed.
  try {
    if (lstatSync(target).isFile()) return { state: 'present' };
    throw new Error(`refusing non-regular orch provider config: ${target}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const source = path.join(ctx.home, '.paseo', 'config.json');
  let env;
  try {
    env = JSON.parse(readFileSync(source, 'utf8'))?.agents?.providers?.glm?.env;
  } catch {
    return { state: 'no-source', reason: `${source} is absent or unreadable` };
  }
  if (!env?.ANTHROPIC_BASE_URL || !env?.ANTHROPIC_AUTH_TOKEN) {
    return { state: 'no-source', reason: `${source} carries no agents.providers.glm.env with ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN` };
  }
  ensureSafeDir(true);
  const expectedDir = path.join(realpathSync(path.resolve(ctx.home)), '.local', 'state', 'orch');
  const temp = path.join(dir, `.providers-${randomUUID()}.tmp`);
  let fd;
  let tempCreated = false;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    tempCreated = true;
    // A restrictive umask is allowed, but the completed credential has exactly
    // owner read/write permissions on POSIX before it can become visible.
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify({ glm: { env } }, null, 2)}\n`);
    if (process.platform !== 'win32' && (fstatSync(fd).mode & 0o777) !== 0o600) {
      throw new Error(`orch provider config must have mode 0600: ${target}`);
    }
    closeSync(fd);
    fd = undefined;
    // Recheck after writing: a replaced parent must not redirect the link.
    ensureSafeDir(false);
    if (realpathSync(dir) !== expectedDir) {
      throw new Error(`refusing redirected orch provider directory: ${dir}`);
    }
    // Unlike rename, link fails if the destination appeared during the write.
    // In particular it cannot follow or replace a dangling/existing symlink.
    linkSync(temp, target);
    if (process.platform !== 'win32' && (lstatSync(target).mode & 0o777) !== 0o600) {
      throw new Error(`orch provider config must have mode 0600: ${target}`);
    }
    return { state: 'migrated' };
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (tempCreated) {
      try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

function installOrchestrator(ctx) {
  if (ctx.skipOrchestrator) return { skipped: true, reason: '--skip-orchestrator' };
  const workdir = path.join(ctx.repo, 'ops', 'orchestrator');
  const script = path.join(workdir, 'install.mjs');
  if (!existsSync(script)) {
    return { skipped: true, reason: `orch installer is missing from this checkout: ${script}` };
  }
  if (isWorktree(ctx.repo) && !ctx.allowWorktreeRoot) {
    return {
      skipped: true,
      reason: 'linked worktree: the orch service is machine-wide and would point at a transient path',
      hint: 'run the installer from the main checkout',
    };
  }
  const briefLanguage = ctx.config?.lead?.briefLanguage;
  // Every orch command loads the root set too; without either the service is not installed.
  // The daemon and the native seats do not load the pinned Pi: its failure is reported and the service is installed.
  let dependencies;
  const dependencySets = {};
  for (const set of shippedSets(ctx.repo)) {
    const dir = path.join(ctx.repo, set.dir);
    const result = orchDependencies(ctx, dir, { set });
    if (result.state === 'missing') {
      const failure = { reason: result.reason, hint: orchHint(set.dir) };
      if (set.orch) return { skipped: true, ...failure };
      dependencySets[set.name] = { state: 'missing', ...failure };
    } else if (dir === workdir) dependencies = result;
    else if (result.state !== 'present') {
      dependencySets[set.name] = {
        state: result.state,
        ...(set.name === 'pi-runtime' && result.state === 'installed' ? { models: refreshPiModels(ctx, dir) } : {}),
      };
    }
  }
  const activate = !ctx.homeExplicit && ctx.platform === process.platform;
  const args = [script, '--json', '--home', ctx.home, '--repo', ctx.repo, '--platform', ctx.platform];
  if (!activate) args.push('--no-activate');
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    return {
      skipped: true,
      reason: `orch install failed (exit ${result.status}): ${(result.stderr || result.stdout || '').trim()}`,
      hint: 'node ops/orchestrator/install.mjs --dry shows what it would do',
      dependencies: dependencies.state,
    };
  }
  const { content, ...report } = JSON.parse(result.stdout);
  if (briefLanguage !== undefined) {
    // Node >= 24 (already required by orch) strips this TS module synchronously.
    // Lazy loading keeps absent-key installs free of language-file access.
    try {
      if (!['strip', 'transform'].includes(process.features.typescript)) {
        throw new Error(`TypeScript type stripping is unavailable in Node ${process.version}; orch needs Node >= 24 with type stripping enabled`);
      }
      const { writeLanguageMode } = createRequire(import.meta.url)('../orchestrator/src/language.ts');
      writeLanguageMode(report.stateDir, briefLanguage);
    } catch (error) {
      throw new Error(
        `Cannot write brief language ${path.join(report.stateDir, 'language.json')}: ${error.message}. ` +
        `Earlier install steps are done (including the orch service install); the mode is NOT set. ` +
        `To set it, run: node ops/orchestrator/src/main.ts language ${briefLanguage}`,
        { cause: error },
      );
    }
  }
  return { skipped: false, dependencies: dependencies.state, ...(Object.keys(dependencySets).length ? { dependencySets } : {}), ...report };
}

function main() {
  const { flags, opts } = parseArgs(process.argv.slice(2));
  if (flags.has('help')) return process.stdout.write(`${USAGE}\n`);
  const repo = path.resolve(opts.repo || DEFAULT_REPO);
  // Validate a present file before even acquiring the home lock: code-intel
  // can install global packages, and config-independent steps must refuse too.
  // A missing file still leaves validation to the steps that need it (#16151).
  const configFile = path.join(repo, 'ops', 'bootstrap', 'harness.config.json');
  let configPresent = false;
  try { lstatSync(configFile); configPresent = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = configPresent ? readHarnessConfig({ repoRoot: repo }) : undefined;
  const home = path.resolve(opts.home || process.env.HARNESS_HOME || process.env.HOME || process.env.USERPROFILE || os.homedir());
  const ctx = {
    repo,
    config,
    home,
    secretsFile: opts['secrets-file'],
    platform: opts.platform || process.platform,
    // The same test seam `resolve-runtime-path.mjs` already carries, threaded
    // through the installer. `--home` does NOT isolate a fixture: the machine
    // directories are absolute, so on an operator Mac a brew- or /usr/local-
    // installed binary wins over the one planted under the throwaway HOME.
    // A bare `--system-dirs` is an
    // empty list (full isolation); with a value it is `:`-separated.
    systemDirs: flags.has('system-dirs')
      ? []
      : opts['system-dirs'] !== undefined
        ? String(opts['system-dirs']).split(':').filter(Boolean)
        : undefined,
    operatorProfile: flags.has('operator-profile'),
    supportProfile: flags.has('support-profile'),
    supportLead: flags.has('support-lead'),
    skipCodeIntel: flags.has('skip-code-intel'),
    skipSkills: flags.has('skip-skills'),
    skipOrchestrator: flags.has('skip-orchestrator'),
    allowWorktreeRoot: flags.has('allow-worktree-root'),
    // A declared home is a decision; an inherited one is a default.
    homeExplicit: Boolean(opts.home),
    requireProviders: !flags.has('no-require-providers'),
    only: opts.only || null,
  };

  const want = (name) => !ctx.only || ctx.only === name;
  const releaseLock = acquireInstallLock(ctx);
  try {
  const report = { ok: true, home, repo };
  runPyToolsStep(ctx, report);
  if (want('code-intel')) report.codeIntel = maybeInstallCodeIntel(ctx);
  if (want('instructions')) report.instructions = installInstructions(ctx);
  if (want('skills') && !ctx.skipSkills) report.skills = installSkills(ctx);
  if (want('codex')) report.codex = installCodex(ctx);
  if (want('mcp')) report.mcp = installMcp(ctx);
  if (want('hooks')) report.hooks = installHooks(ctx);
  if (want('permissions')) report.permissions = installPermissions(ctx);
  if (want('rtk-filters')) report.rtkFilters = installRtkFilters(ctx);
  if (want('rtk-excludes')) report.rtkExcludes = installRtkExcludes(ctx);
  if (want('pi-rtk')) report.piRtk = installPiRtk(ctx);
  // After instruction rendering, so rtk's Codex reference survives every re-render.
  if (want('lead-rtk')) report.leadRtk = installLeadRtk(ctx);
  if (want('opencode')) report.opencode = installOpencode(ctx);
  if (want('path')) report.path = installPath(ctx);
  if (want('orchestrator')) report.orchProviders = migrateOrchProviders(ctx);
  if (want('orchestrator')) {
    report.orchestrator = installOrchestrator(ctx);
    const mode = config?.lead?.briefLanguage;
    if (mode !== undefined && report.orchestrator.skipped) {
      const reason = report.orchestrator.reason;
      report.orchestrator.briefLanguage = { mode, applied: false, reason };
      process.stderr.write(`Warning: lead.briefLanguage '${mode}' was not applied: ${reason.replace(/\s+/g, ' ')}\n`);
    }
  }

  if (want('plugins') && (!ctx.requireProviders || (report.path?.missing ?? []).length === 0)) {
    report.plugins = installPlugins(ctx);
  }

  // Printed AFTER the plugin steps, not before them. Until 2026-09-18 the report
  // went out first, so `plugins` was computed and thrown away: an installer that
  // refuses a marketplace said so on stderr while its JSON claimed a clean run.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (ctx.requireProviders && want('path')) {
    const resolved = report.path;
    if (resolved.missing.length > 0) {
      process.stderr.write(
        `required provider(s) not found: ${resolved.missing.join(', ')}. ` +
          `Configs were written; the missing seats will not launch. ` +
          `Searched: ${resolved.searchDirs.join(path.delimiter)}\n`,
      );
      process.exit(1);
    }
  }
  } finally { releaseLock(); }
}

// Exported for the tests that pin what each state MEANS. Reviewers had to
// re-extract this function's body into a throwaway module to measure it, which
// is a measurement of a copy rather than of the installer.
export { ensureHook, harnessHookScript, resolveServerCommand, PATH_SERVER_COMMANDS, KIMI_RETIRED_HOOKS, piEntry, roleUniversalServers, inspectSkillEntry, skillKey };

const isMainModule = isMain(import.meta.url);
if (isMainModule) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(error.exitCode ?? 1);
  }
}
