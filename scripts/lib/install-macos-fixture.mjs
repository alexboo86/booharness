import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';


export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const INSTALLER = path.join(REPO, 'ops', 'bootstrap', 'install-harness.mjs');
export const RESOLVER = path.join(REPO, 'ops', 'bootstrap', 'resolve-runtime-path.mjs');
export const SETUP_SH = path.join(REPO, 'ops', 'setup-machine.sh');

export const SECRET_TOKEN = 'harness-secret-TOKEN-7f3c9a1e';

export const HOME_PREFIXES = [
  '.agents',
  '.paseo',
  '.claude',
  '.claude.json',
  '.codex',
  // The opencode scout's runtime config; `installOpencode` owns it so the Mac
  // gets the same file the Windows box does (operator, 2026-09-20).
  '.config',
  '.grok',
  '.kimi-code',
  '.glm-worker-config',
  '.glm-lead-config',
  '.zcode',
  // Pi worker seats' MCP (pi-mcp-adapter reads ~/.pi/agent/mcp.json; orch phase 1).
  '.pi',
  '.local',
  '.zshenv',
  // rtk's user config (task 2783): `dirs::config_dir()` + rtk, so
  // ~/Library/Application Support/rtk on macOS and %APPDATA%\rtk on Windows.
  'Library',
  'AppData',
];

export function walkFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const st = lstatSync(current);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      for (const name of readdirSync(current)) stack.push(path.join(current, name));
      continue;
    }
    out.push(current);
  }
  return out.sort();
}

export function snapshot(root) {
  const files = {};
  for (const file of walkFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const st = lstatSync(file);
    if (st.isSymbolicLink()) {
      files[rel] = `symlink:${realpathSync(file)}`;
      continue;
    }
    files[rel] = createHash('sha256').update(readFileSync(file)).digest('hex');
  }
  return files;
}

// `repoParts` places the fixture checkout somewhere other than <root>/repo.
// `isWorktree` asks git first and falls back to the PATH SHAPE when there is no
// git dir - which is exactly this fixture's case - so a repo under
// `.claude/worktrees/` is a worktree to the installer without a real git
// worktree to build.
export function layout(options = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'harness-install-')));
  const repo = path.join(root, ...(options.repoParts ?? ['repo']));
  const home = path.join(root, 'home');
  mkdirSync(path.join(repo, 'ops', 'bootstrap'), { recursive: true });
  mkdirSync(path.join(repo, '.agents', 'skills', 'demo-skill'), { recursive: true });
  const skillMap = JSON.parse(readFileSync(path.join(REPO, '.agents', 'domains', '_skill-map.json'), 'utf8'));
  mkdirSync(path.join(repo, '.agents', 'domains'), { recursive: true });
  copyFileSync(path.join(REPO, '.agents', 'domains', '_skill-map.json'), path.join(repo, '.agents', 'domains', '_skill-map.json'));
  for (const name of skillMap.leadInstalledSkills) {
    mkdirSync(path.join(repo, '.agents', 'skills', name), { recursive: true });
    writeFileSync(path.join(repo, '.agents', 'skills', name, 'SKILL.md'), `# ${name}\n`);
  }
  mkdirSync(home, { recursive: true });
  // Every fixture HOME, not only the ones that plant providers: the installer
  // resolves `node` for the memoryctl MCP server before it writes a single
  // config, so a test that skips plantRequiredProviders died just as dead.
  plantNode(home);
  plantCodegraph(home);
  for (const relative of ['ops/bootstrap/mcp-role-gate.mjs', 'ops/bootstrap/secret-bindings.mjs', 'ops/orchestrator/mcp-by-role.json']) {
    const target = path.join(repo, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(REPO, relative), target);
  }

  copyFileSync(
    path.join(REPO, 'ops', 'bootstrap', 'harness.config.json'),
    path.join(repo, 'ops', 'bootstrap', 'harness.config.json'),
  );
  copyFileSync(
    path.join(REPO, 'ops', 'bootstrap', 'mcp-servers.json'),
    path.join(repo, 'ops', 'bootstrap', 'mcp-servers.json'),
  );
  copyFileSync(
    path.join(REPO, 'ops', 'bootstrap', 'mcp-servers.operator.json'),
    path.join(repo, 'ops', 'bootstrap', 'mcp-servers.operator.json'),
  );
  copyFileSync(
    path.join(REPO, 'ops', 'bootstrap', 'agent-instructions.md'),
    path.join(repo, 'ops', 'bootstrap', 'agent-instructions.md'),
  );
  copyFileSync(
    path.join(REPO, 'ops', 'bootstrap', 'permissions.json'),
    path.join(repo, 'ops', 'bootstrap', 'permissions.json'),
  );
  copyFileSync(
    path.join(REPO, 'ops', 'bootstrap', 'codex-trust.json'),
    path.join(repo, 'ops', 'bootstrap', 'codex-trust.json'),
  );
  // The rtk filter source the installer trusts from the checkout under test.
  mkdirSync(path.join(repo, '.rtk'), { recursive: true });
  copyFileSync(
    path.join(REPO, '.rtk', 'filters.toml'),
    path.join(repo, '.rtk', 'filters.toml'),
  );
  for (const hook of [
    'session-start.mjs',
    'session-inject-once.mjs',
    'domain-lessons-hook.mjs',
    'code-intel-order-hook.mjs',
    'subagent-route-hook.mjs',
    'codex-rtk-hook.mjs',
  ]) {
    copyFileSync(
      path.join(REPO, 'ops', 'bootstrap', hook),
      path.join(repo, 'ops', 'bootstrap', hook),
    );
  }
  writeFileSync(
    path.join(repo, '.agents', 'skills', 'demo-skill', 'SKILL.md'),
    '---\nname: demo-skill\n---\n# Demo\n',
  );

  const ssot = JSON.parse(readFileSync(path.join(repo, 'ops', 'bootstrap', 'mcp-servers.json'), 'utf8'));
  for (const server of Object.values(ssot.servers)) {
    if (!server.requires_file) continue;
    const target = server.requires_file.replaceAll('{repo}', repo);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'export {}\n');
  }
  mkdirSync(path.join(repo, 'scripts', 'memory'), { recursive: true });
  writeFileSync(path.join(repo, 'scripts', 'memory', 'mcp-server.mjs'), 'export {}\n');

  const secrets = path.join(root, 'secrets.env');
  writeFileSync(
    secrets,
    [
      ...Object.values(ssot.servers).flatMap((server) => (server.env_from_secrets ?? [])
        .filter(({ secret }) => secret.endsWith('_BASE_URL'))
        .map(({ secret }, index) => `${secret}=http://host-${index + 1}.invalid`)),
      `WATCHDOG_API_TOKEN=${SECRET_TOKEN}`,
      'TELEGRAM_BOT_TOKEN=token',
      'TELEGRAM_CHAT_ID=chat',
    ].join('\n'),
  );

  return { root, repo, home, secrets };
}

// The installer writes every hook command through `posix()`
// (install-harness.mjs:713), so a fixture that plants a NATIVE path measures
// something the installer never writes. On Windows it also breaks the file it
// plants: `C:\Users\...` inside a double-quoted TOML string makes `\U` an
// escape, the legacy line no longer parses as the same hook, and the installer
// appends a section instead of repointing the old one.
export const asPosix = (value) => value.split(path.sep).join('/');

export function plantProvider(home, name, body = '#!/usr/bin/env node\nprocess.exit(0);\n') {
  const dir = path.join(home, `.${name === 'kimi' ? 'kimi-code' : name}`, 'bin');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, body);
  try {
    chmodSync(file, 0o755);
  } catch {
    // Windows has no execute bit to set; existence is what the resolver reads.
  }
  return file;
}

export function claudePluginStubSource({ log } = {}) {
  // Node, not sh: the installer must actually spawn this file on Windows too.
  // The log is how a case proves CALLS, not that the installer wrote a receipt
  // of its own. Idempotent registry bytes keep "second install is a zero diff".
  return `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const home = process.env.HOME || process.env.USERPROFILE;
const argv = process.argv.slice(2);
${log ? `fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.appendFileSync(path.join(home, '.claude', 'plugin-stub.log'), argv.join(' ') + '\\n');` : ''}
const pluginsDir = path.join(home, '.claude', 'plugins');
const registry = path.join(pluginsDir, 'installed_plugins.json');
const known = path.join(pluginsDir, 'known_marketplaces.json');
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
if (argv[0] === 'plugin' && argv[1] === 'marketplace' && argv[2] === 'add') {
  fs.mkdirSync(pluginsDir, { recursive: true });
  const data = readJson(known, {});
  data[argv[3]] = { source: argv[3] };
  fs.writeFileSync(known, JSON.stringify(data, null, 2));
  process.exit(0);
}
if (argv[0] === 'plugin' && argv[1] === 'install') {
  fs.mkdirSync(pluginsDir, { recursive: true });
  const data = readJson(registry, { plugins: {} });
  data.plugins[argv[2]] = {
    installPath: path.join(pluginsDir, 'cache', argv[2].replace('@', path.sep)),
  };
  fs.writeFileSync(registry, JSON.stringify(data, null, 2));
  process.exit(0);
}
process.exit(0);
`;
}

// The fixture forces `--platform darwin`, so the installer looks for `node` in
// the unix list: $HOME/.local/bin, $HOME/.cargo/bin, /opt/homebrew/bin,
// /usr/local/bin, /usr/bin, /bin. A Mac host has node in one of those and the
// suite passed by accident; Windows has none of them, so every test that runs
// the installer died on `Required MCP server 'memoryctl' names command 'node'`
// — 21 of the 25 Windows failures were that one cascade, and not one of them
// was about the code under test. The resolver reads EXISTENCE, not content
// (resolve-runtime-path.mjs isCandidate), the same way plantProvider works, so
// a stub is enough and the suite stops depending on the host's node location.
// The codegraph MCP server is `required: true` in the SSOT, and the installer
// resolves every required command BEFORE it writes a single config - so a
// fixture HOME without it fails the install outright, the same way it did for
// node. Planted in `.local/bin`, which is first on the canonical search path.
export function plantCodegraph(home) {
  const dir = path.join(home, '.local', 'bin');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'codegraph');
  writeFileSync(file, '#!/usr/bin/env node\nprocess.exit(0);\n');
  try {
    chmodSync(file, 0o755);
  } catch {
    // Windows has no execute bit to set; existence is what the resolver reads.
  }
  return file;
}

export function plantNode(home) {
  const dir = path.join(home, '.local', 'bin');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'node');
  writeFileSync(file, '#!/usr/bin/env node\nprocess.exit(0);\n');
  try {
    chmodSync(file, 0o755);
  } catch {
    // Windows has no execute bit to set; existence is what the resolver reads.
  }
  return file;
}

export function plantRequiredProviders(home) {
  return {
    claude: plantProvider(home, 'claude', claudePluginStubSource()),
    codex: plantProvider(home, 'codex'),
    kimi: plantProvider(home, 'kimi'),
    grok: plantProvider(home, 'grok'),
  };
}

export function runNode(script, args, env) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
}

// How `provision-worktree.sh` actually calls the installer for a worktree:
// `--only skills --repo <worktree>`. The full run refuses from a worktree (its
// session hooks would carry an absolute path into a directory that dies), so a
// worktree case measured through `install()` measures that refusal and nothing
// else.
export function installSkillsOnly(home, repo) {
  return runNode(
    INSTALLER,
    ['--only', 'skills', '--home', home, '--repo', repo, '--platform', 'darwin'],
    { HOME: home, USERPROFILE: home, PATH: '' },
  );
}

export function install(home, repo, extra = [], env = {}) {
  const args = [
    '--home',
    home,
    '--repo',
    repo,
    '--secrets-file',
    path.join(path.dirname(home), 'secrets.env'),
    '--skip-code-intel',
    '--platform',
    'darwin',
  ];
  if (!extra.includes('--install-skills')) args.push('--skip-skills');
  // The orch service step has its own suite (scripts/test-orch-install.mjs), and
  // a fixture repo carries no ops/orchestrator for it to install.
  if (!extra.includes('--install-orchestrator')) args.push('--skip-orchestrator');
  // Isolate the machine directories unless the case opted out: without this the
  // installer can otherwise resolve machine binaries from a throwaway HOME.
  if (!extra.includes('--system-dirs')) args.push(...ISOLATED);
  args.push(...extra.filter((flag) => flag !== '--install-skills' && flag !== '--install-orchestrator'));
  return runNode(INSTALLER, args, { HOME: home, USERPROFILE: home, PATH: '', ...env });
}

// Pass ISOLATED to a case that measures WHICH binary is found. The machine-wide
// directories are absolute, so a `--home` override does not isolate them: on an
// operator Mac a brew-installed provider wins over the one planted under the
// throwaway HOME, which made this suite green on Windows — where those paths do
// not exist — and red on the very machine it is written for. A case that
// measures the search path ITSELF must NOT pass it: the layers are the subject.
export const ISOLATED = ['--system-dirs', ''];

export function resolve(home, extra = [], env = {}) {
  return runNode(
    RESOLVER,
    ['--home', home, '--platform', 'darwin', ...extra],
    { HOME: home, USERPROFILE: home, PATH: '', ...env },
  );
}

export function said(proc) {
  return `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
}
