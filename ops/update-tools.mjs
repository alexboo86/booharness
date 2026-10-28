#!/usr/bin/env node
//
// ops/update-tools.mjs — keeps the agent toolset current, mechanically.
//
// Runs daily from launchd on the Mac (`--install-schedule` writes the plist),
// from Task Scheduler on Windows (`--install-schedule` writes the
// <prefix>-update-tools job) and from the user crontab on Linux
// (`--install-schedule` rewrites exactly one tagged line), updates every tool
// the harness depends on WHERE IT ACTUALLY LIVES, and leaves one durable memory
// entry so the next agent session knows what moved under it.
//
// PROVENANCE IS DISCOVERED, NEVER ASSUMED. Measured 2026-08-22 on the operator's
// mac: codegraph, ast-grep, claude and codex all resolve through /opt/homebrew/bin,
// which reads like Homebrew and is not — that is the npm global prefix of a
// Homebrew-installed node, and `brew list ast-grep` is empty. An updater that
// guessed "brew upgrade" would have installed nothing; one that guessed a second
// npm prefix would have put a rival binary on PATH, and a member's launcher
// REFUSES to launch when a code-intel tool sits in a directory a member needs
// (formerly `svod/src/code_index.rs, refuse_unshadowed_on`, Svod-era; the same
// invariant now belongs to Paseo). So every tool below declares
// how it updates, and the script verifies the binary it touched is the binary
// that answers on PATH.
//
// NOT IN SCOPE: product dependencies (npm/cargo). Auto-bumping those turns a
// green build red overnight with nobody at the keyboard, and the operator ruled
// them out on 2026-08-22. This file updates the HARNESS, not the product.
//
// THE BOOTSTRAP TWIN: ops/setup-machine.sh (step 2) installs @colbymchenry/codegraph
// and @ast-grep/cli with the same `npm install -g`. That is deliberate — it runs
// once on a fresh clone, this runs every day — but the PACKAGE NAMES now live in
// two files, and lesson 3275 is about exactly what happens when a twin of an
// install step drifts from its original: the retired copy keeps installing a set
// nobody maintains. Change one, change the other in the same commit.
//
// Usage:
//   node ops/update-tools.mjs                  # check + update + record
//   node ops/update-tools.mjs --check          # report only, change nothing
//                                          # (also flags a plist whose WorkingDirectory
//                                          # or script path does not exist)
//   node ops/update-tools.mjs --no-memory      # skip the memory entry
//   node ops/update-tools.mjs --install-schedule   # write + load the daily job
//                                          # (launchd plist / Task Scheduler job /
//                                          #  one tagged crontab line on Linux)
//   node ops/update-tools.mjs --remove-schedule
//
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync,
  statSync, readdirSync, copyFileSync, chmodSync, renameSync, realpathSync,
} from 'node:fs';
import { homedir, tmpdir, platform, arch } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../scripts/lib/is-main.mjs';

import { scrubbedGitEnv } from '../scripts/git-env.mjs';
import { canonicalSearchDirs, requiredCliNames } from '../scripts/lib/runtime-search.mjs';
import { harnessLabel, readHarnessConfig } from '../scripts/lib/harness-config.mjs';

// This copy of the script. The launchd job must NOT use it as WorkingDirectory:
// a worktree is deleted, and launchd then fails with EX_CONFIG (78) /
// MODULE_NOT_FOUND. The scheduled checkout is resolveMainCheckout() — the
// parent of `git rev-parse --path-format=absolute --git-common-dir`.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = readHarnessConfig({ repoRoot: REPO }).names.prefix;
const STATE_DIR = path.join(homedir(), '.local', 'state', 'harness-updates');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOG_FILE = path.join(STATE_DIR, 'update.log');
const PLIST_ID = harnessLabel({ prefix: PREFIX, name: 'update-tools' });
const PLIST = path.join(homedir(), 'Library', 'LaunchAgents', `${PLIST_ID}.plist`);
// The win32 twin of PLIST_ID. Never any other task name: PaseoDaemon is the
// operator's live daemon, and a scheduler call that names it would be a
// fixture written into production.
const TASK_NAME = `${PREFIX}-update-tools`;
const MEMORY_KEY = 'harness-tool-updates';
const MEMORY_TITLE = 'Состояние агентского инструментария: версии и последние обновления';

const ARGS = new Set(process.argv.slice(2));
const CHECK_ONLY = ARGS.has('--check');
const NO_MEMORY = ARGS.has('--no-memory');

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

// Every child gets stdin from a string or nothing, never the terminal. A daily
// job that inherits a closed stdin and meets a y/n prompt does not fail — it
// HANGS, and a hung launchd job is invisible until someone goes looking. The
// timeout is the second half of that guarantee.
// Windows stores the variable as `Path`, and an env block carrying both
// spellings answers the child unpredictably. Delete every spelling first,
// then write ours once. Every child of this script — run() and the installer
// check below — goes out with this env, so none of them ever resolves a
// command differently from any other.
function childEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.toLowerCase() === 'path') delete env[name];
  }
  env.PATH = canonicalPath();
  return env;
}

function run(cmd, args, { stdin = '', timeout = 300_000, cwd = REPO } = {}) {
  const plan = launchPlan(cmd);
  if (plan.error) {
    return { ok: false, code: null, out: plan.error, timedOut: false, missing: plan.missing };
  }
  const r = spawnSync(plan.file, [...plan.prefix, ...args], {
    cwd,
    input: stdin,
    encoding: 'utf8',
    timeout,
    env: childEnv(),
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`.trim();
  return {
    ok: r.status === 0 && !r.error,
    code: r.status,
    out,
    // Untrimmed and without stderr: a caller that rewrites what it read (the crontab) needs every byte.
    stdout: r.stdout ?? '',
    timedOut: r.error?.code === 'ETIMEDOUT',
    missing: r.error?.code === 'ENOENT',
  };
}

// win32 only: the list is the installer's canonical one — the same directories
// resolve-runtime-path.mjs trusts for required providers, which honours
// HARNESS_HOME and never reads the ambient PATH (a defect this repo has fixed
// twice already). Reading process.env.PATH here would make the answer depend on
// who launched the updater. The canonical list is about provider tools and
// knows nothing about the OS: tar.exe, curl.exe and schtasks.exe — which this
// updater needs on win32 — live in System32, resolved off SystemRoot and LAST,
// so nothing user-installed is ever shadowed by an OS component.
function canonicalDirs() {
  const dirs = canonicalSearchDirs();
  if (process.platform === 'win32') {
    dirs.push(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'));
  }
  return [...new Set(dirs)];
}

// launchd hands a job a PATH of `/usr/bin:/bin:/usr/sbin:/sbin` and nothing
// else. On darwin this is HEAD's string, byte for byte — the fixed extras
// first, the ambient process.env.PATH appended, deduped — because the Mac
// builds the release and runs launchctl/plutil/shasum/curl/tar/mv out of that
// ambient half (/usr/sbin and /sbin survive ONLY through it). Canonical dirs
// are a WIN32 construction here and nowhere else (reviewer grok, raised by the
// lead 2026-09-17: substituting them on darwin reordered the list and dropped
// the ambient PATH the schedule actually resolves through).
export function canonicalPath(options = {}) {
  const plat = options.platform || process.platform;
  if (plat !== 'win32') {
    const home = options.home || homedir();
    const extra = [
      path.join(home, '.local', 'bin'),
      '/opt/homebrew/bin',
      path.join(home, '.cargo', 'bin'),
      path.join(home, '.grok', 'bin'),
      path.join(home, '.kimi-code', 'bin'),
      '/usr/local/bin',
    ];
    const sep = ':';
    const current = ((options.env || process.env).PATH || '').split(sep).filter(Boolean);
    return [...new Set([...extra, ...current])].join(sep);
  }
  return canonicalDirs().join(path.delimiter);
}

function which(cmd) {
  if (process.platform === 'win32') return resolveToolFile(cmd);
  const r = run('command', ['-v', cmd], { timeout: 10_000 });
  // `command -v` is a shell builtin; spawn it through sh so it exists at all.
  if (r.missing) {
    const viaSh = run('sh', ['-c', `command -v ${cmd}`], { timeout: 10_000 });
    return viaSh.ok ? viaSh.out.split('\n')[0].trim() : null;
  }
  return r.ok ? r.out.split('\n')[0].trim() : null;
}

// ---------------------------------------------------------------------------
// win32: how a command is launched. CreateProcess runs PE images only, so a
// NAME is never enough on Windows — what the file IS decides how it runs.
// ---------------------------------------------------------------------------

// A `.cmd` beats nothing and loses to every `.exe`: a PE image spawns itself,
// and only a tool that exists solely as an npm shim falls through to the
// shim branch of launchPlan. The extensionless files that live beside the
// shims (npm's `probe`, the bash `memoryctl`) are never candidates at all —
// `which` on a Mac answers one of those, and statSync of that answer is what
// crashed this script on Windows (C:\c\Users\..., 2026-09-17).
export function resolveToolFile(cmd, options = {}) {
  const dirs = options.dirs || canonicalDirs();
  for (const suffix of ['.exe', '.cmd']) {
    for (const dir of dirs) {
      const candidate = path.join(dir, `${cmd}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// npm writes one stable shape of shim: its last `%_prog%` line hands a JS
// entry to a node interpreter. Read the entry that shim names instead of
// guessing package layouts — the shim is the thing npm actually installed.
function npmShimEntry(shim) {
  const line = readFileSync(shim, 'utf8').split('\n').filter((l) => l.includes('%_prog%')).pop();
  const rel = line?.match(/"%dp0%[\\/]+(node_modules[\\/][^"]+)"/)?.[1];
  if (!rel) return null;
  const entry = path.join(path.dirname(shim), ...rel.split(/[\\/]/));
  return existsSync(entry) ? entry : null;
}

function npmCliPath(options = {}) {
  const nodeDir = options.nodeDir || path.dirname(process.execPath);
  return path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

// `cmd.exe /d /s /c` carries the memoryctl shim, whose args here are
// compile-time constants (a fixed title, a homedir path) — the case
// scripts/memory/lesson-lib.mjs allows. Everything else avoids cmd.exe: it is
// not an argv transport, and an npm shim is a node script that can simply be
// handed to this node.
export function launchPlan(cmd, options = {}) {
  if ((options.platform || process.platform) !== 'win32') return { file: cmd, prefix: [] };
  const file = resolveToolFile(cmd, options);
  if (!file) {
    const searched = (options.dirs || canonicalDirs()).join(path.delimiter);
    return {
      error: `${cmd} is nowhere on the canonical search path: ${searched}`,
      missing: true,
    };
  }
  if (file.toLowerCase().endsWith('.exe')) return { file, prefix: [] };
  if (cmd === 'npm') {
    // npm is npm.cmd on Windows, and Node refuses to spawn a .cmd without a
    // shell. npm IS a node script — run the npm-cli.js that ships beside this
    // node (ops/bootstrap/windows-bringup.ps1 does the same).
    const npmCli = npmCliPath(options);
    if (!existsSync(npmCli)) return { error: `npm resolved to ${file}, but ${npmCli} does not exist`, missing: false };
    return { file: process.execPath, prefix: [npmCli] };
  }
  if (cmd === 'memoryctl') {
    // memoryctl on Windows is a bash script plus a .cmd shim that starts Git
    // bash; the shim runs as-is through cmd.exe.
    return { file: 'cmd.exe', prefix: ['/d', '/s', '/c', file] };
  }
  const entry = npmShimEntry(file);
  if (!entry) {
    return {
      error: `${file} is neither a PE image nor an npm shim naming an existing JS entry; refusing to route its arguments through cmd.exe`,
      missing: false,
    };
  }
  return { file: process.execPath, prefix: [entry] };
}

// The installed CLIENT — what identity() stamps the mtime of in a report. On
// the Mac `which` answers it directly; on win32 it sits beside the `.cmd` shim
// by the shim's own body (`%~dp0memoryctl`). It is a display stamp ONLY: the
// reinstall DECISION no longer reads any mtime. Two mtime-based versions of
// this decision failed to converge (reviewer kimi 2026-09-17, reproduced
// twice — a directory's mtime is a superset trigger, a file's is
// content-convergent, and the installer copies only when BYTES differ), so
// the decision now comes from the installer's own byte check below.
export function memoryctlClientFile(options = {}) {
  const plat = options.platform || process.platform;
  const shim = options.shim !== undefined
    ? options.shim
    : (plat === 'win32' ? resolveToolFile('memoryctl', options) : which('memoryctl'));
  if (plat !== 'win32') return shim;
  if (!shim) return null;
  const client = path.join(path.dirname(shim), 'memoryctl');
  return existsSync(client) ? client : null;
}

// A version STRING, not a parsed semver. These tools spell their version six
// different ways (`rtk 0.45.0`, `codex-cli 0.149.0`, `2.1.239 (Claude Code)`),
// used for display/change detection. Only pinned release targets are parsed
// below, where the compatibility contract needs major/minor numbers.
function versionOf(tool) {
  if (tool.identity) return tool.identity();
  const r = run(tool.probe[0], tool.probe.slice(1), { timeout: 60_000 });
  if (r.missing) return null;
  return r.out.split('\n')[0].trim() || null;
}

// ---------------------------------------------------------------------------
// the toolset
// ---------------------------------------------------------------------------
//
// `update` is a function so the awkward ones (rtk's GitHub release, memoryctl's
// repo build) sit beside the trivial ones instead of in a special-case branch
// further down.

const TOOLS = [
  {
    id: 'codegraph',
    probe: ['codegraph', '--version'],
    // npm, not the `curl | sh` installer the README offers first: npm is the one
    // channel that is identical on macOS and Windows, and this file is the twin
    // of a PowerShell bring-up. `codegraph upgrade` exists too, but it updates
    // whatever channel installed it, which is not a thing a scheduled job should
    // guess at.
    resolve: () => run('npm', ['view', '@colbymchenry/codegraph', 'version'], { timeout: 60_000 }),
    update: (target) => run('npm', ['install', '-g', `@colbymchenry/codegraph@${target}`], { timeout: 600_000 }),
  },
  {
    id: 'ast-grep',
    probe: ['ast-grep', '--version'],
    update: () => run('npm', ['install', '-g', '@ast-grep/cli@latest'], { timeout: 600_000 }),
  },
  {
    id: 'claude',
    probe: ['claude', '--version'],
    update: () => run('claude', ['update'], { timeout: 600_000 }),
  },
  {
    id: 'rtk',
    probe: ['rtk', '--version'],
    // No self-update subcommand exists (checked against `rtk --help`, 2026-08-22),
    // so this is the only tool the script installs by hand.
    resolve: resolveRtkRelease,
    update: (target) => updateRtkFromRelease(target),
  },
  {
    id: 'memoryctl',
    // memoryctl has no --version, and `status` answers with service JSON whose
    // first line is a bare `{`. Comparing that before and after would compare
    // one brace to another and call every run "current". The reinstall
    // decision therefore comes from the installer's own byte comparison (see
    // updateMemoryctlFromRepo); identity here is only the health bit worth
    // carrying into a report, plus the installed client's mtime as a stamp.
    probe: ['memoryctl', 'status'],
    identity: () => {
      const shim = memoryctlClientFile();
      if (!shim) return null;
      const when = new Date(statSync(shim).mtimeMs).toISOString().replace('T', ' ').slice(0, 16);
      const status = run('memoryctl', ['status'], { timeout: 60_000 });
      const durable = /"durable"\s*:\s*true/.test(status.out) ? 'durable' : 'NOT DURABLE';
      return `client ${when} (${durable})`;
    },
    // Not an upstream release at all: the shim in ~/.local/bin is COPIED from
    // this repository by the installer. Its "update" is therefore a reinstall,
    // and only when the repo's copy is actually newer than the installed one.
    update: () => updateMemoryctlFromRepo(),
  },
];

const PROVIDER_TOOL_IDS = new Set(['claude']);

// A provider CLI is probed and updated only when an enabled family needs it.
// codegraph, ast-grep, rtk and memoryctl stay on every run. Absent
// families.enabled requires only Claude Code; Pi itself stays pinned.
export function activeTools(options = {}) {
  const needed = new Set(requiredCliNames(options));
  return TOOLS.filter((tool) => !PROVIDER_TOOL_IDS.has(tool.id) || needed.has(tool.id));
}

// ---------------------------------------------------------------------------
// rtk: GitHub release, checksum-verified, installed where the current one is
// ---------------------------------------------------------------------------

const RTK_REPO = 'rtk-ai/rtk';

// `platform`/`arch` are parameters, not reads of the real machine, so a test
// can pin the Windows answer on any platform — the same seam
// canonicalSearchDirs exposes.
export function rtkAssetName(plat = platform(), ar = arch()) {
  const a = ar === 'arm64' ? 'aarch64' : 'x86_64';
  if (plat === 'darwin') return `rtk-${a}-apple-darwin.tar.gz`;
  // rtk ships x86_64 Linux as musl only (v0.51.0 and still true at v1.0.1: aarch64 gnu, x86_64 musl; memory 15878).
  if (plat === 'linux') return `rtk-${a}-unknown-linux-${a === 'x86_64' ? 'musl' : 'gnu'}.tar.gz`;
  if (plat === 'win32') return `rtk-${a}-pc-windows-msvc.zip`;
  return null;
}

function resolveRtkRelease() {
  const meta = run('curl', ['-fsSL', '--max-time', '30',
    `https://api.github.com/repos/${RTK_REPO}/releases/latest`], { timeout: 60_000 });
  if (!meta.ok) return { ok: false, out: `could not reach the rtk release API: ${meta.out}` };

  let tag;
  try {
    tag = JSON.parse(meta.out).tag_name;
  } catch {
    return { ok: false, out: 'rtk release API returned something that is not JSON' };
  }
  if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    return { ok: false, out: `rtk release carries no valid stable tag_name: ${tag}` };
  }
  return { ok: true, out: tag.slice(1) };
}

// The file a PATH answer names. A link in a root-owned directory (a host keeps
// only links to user-owned binaries in /usr/local/bin, memory 16674) is
// updated at its file: writing `.new` beside the link fails with EACCES, and
// the move would replace the link with a file there (task 2733).
export function rtkInstallTarget(answer) {
  return realpathSync(answer);
}

function updateRtkFromRelease(version) {
  const onPath = which('rtk');
  if (!onPath) return { ok: false, out: 'rtk is not on PATH; nothing to update in place' };
  const target = rtkInstallTarget(onPath);
  const asset = rtkAssetName();
  if (!asset) return { ok: false, out: `no rtk release asset for ${platform()}/${arch()}` };
  const tag = `v${version}`;
  const base = `https://github.com/${RTK_REPO}/releases/download/${tag}`;
  const work = path.join(tmpdir(), `rtk-update-${process.pid}`);
  mkdirSync(work, { recursive: true });
  try {
    const tarball = path.join(work, asset);
    const dl = run('curl', ['-fsSL', '--max-time', '180', `${base}/${asset}`, '-o', tarball], { timeout: 300_000 });
    if (!dl.ok) return { ok: false, out: `download failed: ${dl.out}` };

    // Same origin as the archive, so this is not a signature — it catches a
    // truncated or corrupted download and makes tampering with the asset alone
    // insufficient. Refuse rather than install unverified: a silently corrupt
    // rtk would break every heavy command on the machine at once.
    const sums = run('curl', ['-fsSL', '--max-time', '60', `${base}/checksums.txt`], { timeout: 120_000 });
    if (!sums.ok) return { ok: false, out: 'checksums.txt is unreachable; refusing to install unverified' };
    const line = sums.out.split('\n').find((l) => l.trim().endsWith(asset));
    if (!line) return { ok: false, out: `checksums.txt lists no entry for ${asset}` };
    const expected = line.trim().split(/\s+/)[0];
    // shasum is not a Windows tool; the hash is Node's own there, so the one
    // check that gates an install has no external dependency on win32.
    const actual = platform() === 'win32'
      ? createHash('sha256').update(readFileSync(tarball)).digest('hex')
      : run('shasum', ['-a', '256', tarball], { timeout: 60_000 }).out.split(/\s+/)[0];
    if (!expected || expected !== actual) {
      return { ok: false, out: `checksum mismatch for ${asset}: expected ${expected}, got ${actual}` };
    }

    // tar.exe ships with Windows 10+ and reads zip; bsdtar picks the format
    // from the file itself, so win32 drops the -z a .tar.gz needs.
    const untar = run('tar', platform() === 'win32'
      ? ['-xf', tarball, '-C', work]
      : ['-xzf', tarball, '-C', work], { timeout: 120_000 });
    if (!untar.ok) return { ok: false, out: `extract failed: ${untar.out}` };

    const binary = platform() === 'win32' ? 'rtk.exe' : 'rtk';
    const found = findFile(work, binary);
    if (!found) return { ok: false, out: `the rtk archive contains no \`${binary}\` binary` };

    // Install ONTO the path that answers today. Writing to a directory of our
    // own choosing would leave the old binary first on PATH and report success
    // while changing nothing.
    copyFileSync(found, `${target}.new`);
    if (platform() === 'win32') {
      // A PE image that is executing is LOCKED by Windows: the rename below
      // lands the moment nothing runs rtk.exe, and until then the new binary
      // waits beside the old one. This run reports the lock instead of
      // pretending it updated; the next daily run retries for free.
      try {
        renameSync(`${target}.new`, target);
      } catch (e) {
        return {
          ok: false,
          out: `rtk.exe is in use (${e.code}); the new binary waits at ${target}.new — `
            + 're-run when no rtk is running, or rename that file by hand',
        };
      }
    } else {
      chmodSync(`${target}.new`, 0o755);
      const moved = run('mv', ['-f', `${target}.new`, target], { timeout: 30_000 });
      if (!moved.ok) return moved;
    }
    return { ok: true, out: `installed ${tag} to ${target}` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// memoryctl: reinstall from this repo, only when the repo is ahead
// ---------------------------------------------------------------------------

function updateMemoryctlFromRepo() {
  const installed = memoryctlClientFile();
  if (!installed) return { ok: false, out: 'memoryctl is not on PATH' };
  return reinstallMemoryctlIfRepoAhead(memoryctlInstallCheck(), () =>
    run('npm', ['run', 'install:memory'], { timeout: 600_000 }));
}

// The installer is asked, read-only: `install-memory.mjs --check` compares
// every target's bytes and answers JSON with per-target state (current/stale/
// absent), exit 1 on drift. A subprocess rather than an import, because the
// installer executes at import top level — importing it here would RUN an
// install. The interpreter is process.execPath: the same node already running
// this updater, so there is no resolution question at all.
export function memoryctlInstallCheck() {
  const script = path.join(REPO, 'ops', 'bootstrap', 'install-memory.mjs');
  const r = spawnSync(process.execPath, [script, '--check'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
    env: childEnv(),
  });
  return { ok: r.status === 0 && !r.error, out: String(r.stdout ?? '') };
}

// Reinstall when any target reports byte drift, skip when every target is
// `current`. Exported with the check result and the reinstall action as
// parameters so a test can answer for the installer; the hasher itself stays
// the installer's and is never reimplemented here. Timestamps are NOT read:
// two mtime-based versions of this decision could not converge (kimi,
// 2026-09-17, reproduced twice — the repo DIRECTORY stays newer than the
// client file forever, while the installer copies only when bytes differ).
export function reinstallMemoryctlIfRepoAhead(installCheck, reinstall) {
  let targets;
  try {
    targets = JSON.parse(installCheck.out).targets ?? [];
  } catch {
    return { ok: false, out: `install-memory --check did not answer JSON: ${tail(installCheck.out, 200)}` };
  }
  // Byte-state rows carry sha256. The permission rows a check can also emit
  // (state dir / db mode) carry none, and a reinstall fixes neither — counting
  // them would arm a reinstall that converges exactly as little.
  const drifted = targets.filter((t) => t.sha256 !== undefined && t.was !== 'current');
  if (!drifted.length) return { ok: true, out: 'installed copy is current', noop: true };

  // The installer owns the launchd job, the service directory and the shim; it
  // is the only correct way to move this one, and it is idempotent by design —
  // which is what makes this converge: after one reinstall every byte row
  // answers `current` and the next run is a no-op.
  return reinstall();
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

// Stable releases only: a malformed or prerelease target is not permission to install.
export function releaseVersion(text) {
  const match = String(text ?? '').match(/^(?:v|rtk\s+|codegraph\s+)?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`not a stable release version: ${text}`);
  return { version: `${match[1]}.${match[2]}.${match[3]}`, major: Number(match[1]), minor: Number(match[2]) };
}

export function breakingAgainstPin(pin, target) {
  const p = releaseVersion(pin);
  const t = releaseVersion(target);
  return p.major !== t.major || (p.major === 0 && p.minor !== t.minor);
}

function checkCodegraphVersion() {
  // The npm launcher can self-download/prune bundles even for --version.
  // A dry run reads the package inventory instead, never executes that launcher.
  const r = run('npm', ['list', '-g', '@colbymchenry/codegraph', '--depth=0', '--json'], { timeout: 60_000 });
  if (!r.ok) throw new Error(`codegraph inventory failed: ${r.out}`);
  return JSON.parse(r.out).dependencies?.['@colbymchenry/codegraph']?.version ?? null;
}

function liveWindowsCodegraph() {
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; @(Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress'],
  { encoding: 'utf8', timeout: 30_000, env: childEnv(), windowsHide: true });
  if (r.status !== 0 || r.error) throw new Error(`process inventory failed: ${r.stderr || r.error?.message}`);
  const rows = JSON.parse(r.stdout || '[]');
  return rows.filter((p) => p.ProcessId !== process.pid &&
    /(?:@colbymchenry[\\/]codegraph(?:-[a-z0-9-]+)?[\\/]|[\\/]\.codegraph[\\/]bundles[\\/])/i.test(p.CommandLine || ''))
    .map((p) => p.ProcessId);
}

function ensureHeldTask(id, pin, target, state) {
  if (NO_MEMORY) return 'memory disabled; held task not recorded';
  state.heldTasks ??= {};
  const key = `${id}@${target}`;
  const title = `${id} harness compatibility ${target}`;
  if (state.heldTasks[key]) {
    if (!Number.isSafeInteger(state.heldTasks[key]) || state.heldTasks[key] <= 0) return 'invalid held task id in state.json';
    const found = run('memoryctl', ['task', 'show', '--id', String(state.heldTasks[key])], { timeout: 60_000 });
    if (!found.ok) return `held task lookup failed: ${tail(found.out, 300)}`;
    try {
      const task = JSON.parse(found.out);
      if (task.title !== title) return `held task #${state.heldTasks[key]} has a different version/title; refusing to reuse it`;
      // Closing the adaptation task does not release the pin. Reuse it even
      // when closed; the report still holds this version until the pin changes.
      return `task #${state.heldTasks[key]} (${task.status})`;
    } catch { return `held task lookup returned invalid JSON: ${tail(found.out, 300)}`; }
  }
  const create = (again = false) => run('memoryctl', ['task', 'create', '--title', title, '--priority', 'P1',
    '--next', `Adapt harness from pin ${pin} to target ${target}, then commit the tool pin`,
    ...(again ? ['--again'] : [])], { timeout: 60_000 });
  let r = create();
  const duplicate = !r.ok && r.out.match(/task #(\d+) says the same thing/);
  let reused = null;
  if (duplicate) {
    const found = run('memoryctl', ['task', 'show', '--id', duplicate[1]], { timeout: 60_000 });
    if (!found.ok) return `held task lookup failed: ${tail(found.out, 300)}`;
    try {
      const task = JSON.parse(found.out);
      if (task.title === title) reused = duplicate[1];
      // The store's word-overlap gate can conflate different version numbers.
      // Only a verified different title permits the explicitly separate task.
      else if (typeof task.title === 'string') r = create(true);
      else return 'held task lookup returned no title; refusing to create another task';
    } catch { return `held task lookup returned invalid JSON: ${tail(found.out, 300)}`; }
  }
  const taskId = reused ?? (r.ok ? r.out.match(/"id"\s*:\s*(\d+)/)?.[1] : null);
  if (!taskId) return `held task write failed: ${tail(r.out, 300)}`;
  state.heldTasks[key] = Number(taskId);
  // Persist immediately: a later tool failure must not lose the dedup identity.
  writeState(state);
  return `task #${taskId}${reused ? ' (same-version duplicate reused)' : ''}`;
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid process pid: ${pid}`);
  try { process.kill(pid, 0); return true; }
  catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}

async function stopCodegraphDaemon(checkout) {
  const lock = path.join(checkout, '.codegraph', 'daemon.pid');
  if (!existsSync(lock)) return 'no main-checkout daemon';
  const info = JSON.parse(readFileSync(lock, 'utf8'));
  if (!alive(info.pid)) return 'main-checkout daemon already stopped';
  // Codegraph's daemon sends this hello on connect. A pidfile alone cannot
  // prove identity after PID reuse; a session's direct serve --mcp has no socket.
  const verified = await new Promise((resolve) => {
    let buffer = '';
    const socket = createConnection(info.socketPath);
    const timer = setTimeout(() => finish(false), 2_000);
    function finish(ok) { clearTimeout(timer); socket.destroy(); resolve(ok); }
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 4096) return finish(false);
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const hello = JSON.parse(buffer.slice(0, newline));
        finish(hello.protocol === 1 && hello.pid === info.pid && hello.codegraph === info.version);
      } catch { finish(false); }
    });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
  });
  if (!verified) throw new Error(`refusing to signal unverified codegraph daemon pid ${info.pid}`);
  process.kill(info.pid, 'SIGTERM');
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (!alive(info.pid)) return `stopped verified daemon pid ${info.pid}`;
  }
  throw new Error(`codegraph daemon pid ${info.pid} did not stop; index not touched`);
}

async function refreshCodegraph() {
  const checkout = resolveMainCheckout();
  if (!checkout) throw new Error('cannot resolve main checkout; codegraph index not refreshed');
  if (!existsSync(path.join(checkout, '.codegraph'))) {
    return `main checkout ${checkout} has no .codegraph/; no index refreshed. Worktree indexes are stale.`;
  }
  const stopped = await stopCodegraphDaemon(checkout);
  // Do not re-create a database owned by a session's direct MCP writer.
  const writer = path.join(checkout, '.codegraph', 'writer.pid');
  if (existsSync(writer)) {
    const info = JSON.parse(readFileSync(writer, 'utf8'));
    if (alive(info.pid)) throw new Error(`live codegraph writer pid ${info.pid}; index not touched`);
  }
  const indexed = run('codegraph', ['index'], { cwd: checkout, timeout: 1_800_000 });
  if (!indexed.ok) throw new Error(`codegraph index failed: ${tail(indexed.out, 400)}`);
  return `${stopped}; indexed main checkout ${checkout}. Worktree indexes are stale.`;
}

async function updatePinnedTool(tool, state) {
  let before = null;
  let after = null;
  let pin;
  let target;
  let detail = '';
  state.deferrals ??= {};
  const consecutive = Number(state.deferrals[tool.id]) || 0;
  try {
    before = CHECK_ONLY && tool.id === 'codegraph' ? checkCodegraphVersion() : versionOf(tool);
    after = before;
    pin = JSON.parse(readFileSync(path.join(REPO, 'ops', 'bootstrap', 'tool-pins.json'), 'utf8'))[tool.id];
    releaseVersion(pin);
    const resolved = tool.resolve();
    if (!resolved.ok) throw new Error(`target resolve failed: ${resolved.out}`);
    target = releaseVersion(resolved.out).version;
    if (breakingAgainstPin(pin, target)) {
      const task = CHECK_ONLY ? 'would create/reuse held task' : ensureHeldTask(tool.id, pin, target, state);
      return { id: tool.id, status: CHECK_ONLY ? 'would-hold' : 'held', before, after: before, pin, target,
        detail: `pin ${pin}, target ${target}; ${task}` };
    }
    if (before === null) return { id: tool.id, status: 'missing', pin, target, before, after: null, detail: 'not installed' };
    const needsInstall = releaseVersion(before).version !== target;
    const needsRefresh = tool.id === 'codegraph' && Boolean(state.codegraphRefreshPending);
    if (tool.id === 'codegraph' && platform() === 'win32' && (needsInstall || needsRefresh)) {
      const pids = liveWindowsCodegraph();
      if (pids.length) {
        const deferrals = consecutive + 1;
        state.deferrals[tool.id] = deferrals;
        if (!CHECK_ONLY) writeState(state);
        return { id: tool.id, status: CHECK_ONLY ? 'would-defer' : 'deferred', before, after: before, pin, target, deferrals,
          detail: `pin ${pin}, target ${target}; live codegraph package pids ${pids.join(', ')}; consecutive deferrals ${deferrals}` };
      }
    }
    // Only a completed live-process check (or a run with no work to defer)
    // resets escalation. Resolve/inventory failures preserve the previous count.
    state.deferrals[tool.id] = 0;
    if (!needsInstall) {
      if (needsRefresh) {
        if (CHECK_ONLY) detail = 'would retry pending main-checkout index refresh; worktree indexes are stale';
        else {
          detail = await refreshCodegraph();
          delete state.codegraphRefreshPending;
          writeState(state);
        }
      }
      return { id: tool.id, status: 'current', before, after, pin, target, detail };
    }
    if (CHECK_ONLY) return { id: tool.id, status: 'checked', before, after: before, pin, target, detail: `would install exact target ${target} (pin ${pin})` };
    const r = tool.update(target);
    after = versionOf(tool);
    // Even a partially failed npm install may have changed the answering CLI.
    // Persist the refresh intent so a failed stop/index is retried tomorrow.
    if (tool.id === 'codegraph' && (before !== after || state.codegraphRefreshPending)) {
      state.codegraphRefreshPending = true;
      writeState(state);
      if (releaseVersion(after).version !== target) {
        throw new Error(`installed codegraph version ${after} does not match target ${target}; index not touched${r.ok ? '' : `; ${r.out}`}`);
      }
      detail = await refreshCodegraph();
      delete state.codegraphRefreshPending;
      writeState(state);
    }
    if (!r.ok) throw new Error(`${r.out}${detail ? `; ${detail}` : ''}`);
    if (releaseVersion(after).version !== target) throw new Error(`installed version ${after} does not match target ${target}`);
    return { id: tool.id, status: before === after ? 'current' : 'updated', before, after, pin, target, detail };
  } catch (e) {
    return { id: tool.id, status: 'failed', before, after, pin, target,
      detail: `${e.message}${tool.id === 'codegraph' && state.codegraphRefreshPending ? '; main-checkout refresh pending. Worktree indexes are stale.' : ''}` };
  }
}

async function updateAll(state) {
  const results = [];
  for (const tool of activeTools()) {
    if (tool.resolve) {
      results.push(await updatePinnedTool(tool, state));
      continue;
    }
    const before = versionOf(tool);
    if (before === null) {
      results.push({ id: tool.id, status: 'missing', before: null, after: null,
        detail: 'not on PATH — install it, or drop it from ops/update-tools.mjs' });
      continue;
    }
    if (CHECK_ONLY) {
      results.push({ id: tool.id, status: 'checked', before, after: before, detail: '' });
      continue;
    }

    const r = tool.update();
    const after = versionOf(tool);
    let status;
    if (!r.ok) status = r.timedOut ? 'timeout' : 'failed';
    else if (before !== after) status = 'updated';
    else status = 'current';

    results.push({
      id: tool.id,
      status,
      before,
      after,
      // A successful no-op prints its whole install log for nothing; a failure
      // is the only case where the text is worth carrying into memory.
      detail: status === 'updated' || status === 'current' ? '' : tail(r.out, 400),
    });
  }
  return results;
}

function tail(text, n) {
  const t = String(text || '').trim();
  return t.length <= n ? t : `…${t.slice(-n)}`;
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

// The scheduler a daily run names in its report: the machine's own mechanism,
// never "launchd" on a Linux host.
function scheduleDescription() {
  return platform() === 'win32'
    ? `Task Scheduler (${TASK_NAME}, раз в сутки)`
    : platform() === 'linux'
      ? `crontab (${crontabTag()}, раз в сутки)`
      : `launchd (${PLIST_ID}, раз в сутки)`;
}

function renderReport(results, stamp) {
  const changed = results.filter((r) => r.status === 'updated');
  const broken = results.filter((r) => ['failed', 'timeout', 'missing', 'held', 'would-hold', 'would-defer'].includes(r.status)
    || (r.status === 'deferred' && r.deferrals >= 3));

  const lines = [];
  lines.push(`Последняя проверка обновлений: ${stamp}.`);
  lines.push('');
  lines.push('## Обновилось в этот прогон');
  lines.push('');
  if (CHECK_ONLY) {
    // Saying "everything was current" here would be a lie of the worst kind:
    // nothing was ATTEMPTED, so nothing is known about whether it was current.
    lines.push('- режим `--check`: обновления не запускались, ниже версии и решения по целевым релизам');
  } else if (changed.length) {
    for (const r of changed) lines.push(`- **${r.id}**: ${r.before} → ${r.after}`);
  } else {
    lines.push('- ничего не обновилось; удержанные, отложенные и неудачные обновления перечислены ниже');
  }
  lines.push('');
  lines.push('## Текущие версии');
  lines.push('');
  for (const r of results) {
    lines.push(`- ${r.id}: ${r.after ?? r.before ?? '—'} (${r.status})${r.pin ? `; pin ${r.pin}, target ${r.target ?? 'unresolved'}` : ''}`);
    if (r.detail && !broken.includes(r)) lines.push(`  ${r.detail}`);
  }
  if (broken.length) {
    lines.push('');
    lines.push('## Требует внимания оператора');
    lines.push('');
    for (const r of broken) {
      lines.push(`- **${r.id}** — ${r.status}${r.detail ? `: ${r.detail}` : ''}`);
    }
  }
  lines.push('');
  const scheduler = scheduleDescription();
  lines.push('Обновляет `ops/update-tools.mjs` по расписанию '
    + `${scheduler}. Лог: ${LOG_FILE}. `
    + 'Зависимости продукта (npm/cargo) в этот механизм НЕ входят по решению оператора от 2026-08-22.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// memory: ONE live entry, superseded each run
// ---------------------------------------------------------------------------
//
// Appending daily would put 365 entries a year into a store whose `hot` digest
// has a byte budget, and they would crowd out the references an agent actually
// needs. The store already models this: a unique index over `key` where
// `superseded_by IS NULL` allows exactly one live entry per key, so the entry is
// created once and superseded forever after.

function readState(file = STATE_FILE) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state, file = STATE_FILE) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

// The id lives in a state file, but a state file can be deleted and the entry
// cannot be created twice under one key. So when the file is gone, ask the store
// itself before assuming this is a first run.
// A search FAILURE is not "no entry": memoryd answers 503 when the query
// embedder is missing or down, and treating that as no-match makes the next
// step append a second entry under a unique key — or, worse, skip the
// supersede of the live one. Abort loudly; the write must never run on an
// unknown store state (build slice B2c, decision #12123).
export function findLiveEntryId(runMemory = (args, options) => run('memoryctl', args, options)) {
  const r = runMemory(['search', MEMORY_TITLE, '--kind', 'reference', '--limit', '5'], { timeout: 60_000 });
  if (!r.ok) {
    throw new Error(`memory search for "${MEMORY_TITLE}" failed — refusing to write on an unknown store state: ${r.out}`);
  }
  const line = r.out.split('\n').find((l) => l.includes(MEMORY_TITLE));
  const id = line?.match(/\b(\d{2,})\b/)?.[1];
  return id ? Number(id) : null;
}

export function recordToMemory(
  body,
  {
    runMemory = (args, options) => run('memoryctl', args, options),
    stateFile = STATE_FILE,
    bodyFile = path.join(STATE_DIR, 'memory-body.md'),
  } = {},
) {
  mkdirSync(path.dirname(bodyFile), { recursive: true });
  writeFileSync(bodyFile, `${body}\n`);

  const state = readState(stateFile);
  let existing = state.memoryId ?? findLiveEntryId(runMemory);

  // `--pinned` is what makes this reach the agents, and it was not optional:
  // measured 2026-08-22, the unpinned entry was live, unique and findable by
  // `search` — and absent from `memoryctl hot`, which showed two references out
  // of 1203 and omitted the rest. An entry nobody reads at session start does
  // not do the job this script exists for.
  const write = (id) => (id
    ? runMemory(['supersede', '--id', String(id),
        '--title', MEMORY_TITLE, '--body-file', bodyFile, '--pinned'], { timeout: 60_000 })
    : runMemory(['append', '--kind', 'reference', '--key', MEMORY_KEY,
        '--title', MEMORY_TITLE, '--body-file', bodyFile, '--pinned'], { timeout: 60_000 }));

  let r = write(existing);
  const recovered = recoverFromRefusal(r, existing, runMemory);
  if (recovered) {
    existing = recovered;
    r = write(existing);
  }

  if (!r.ok) return { ok: false, out: tail(r.out, 300) };
  const id = r.out.match(/"id"\s*:\s*(\d+)/)?.[1];
  if (id) writeState({ ...state, memoryId: Number(id), lastRun: new Date().toISOString() }, stateFile);
  return { ok: true, out: `memory entry ${id ?? existing}` };
}

// The state file goes STALE, not just missing: anyone superseding this entry
// by hand moves the live id and leaves ours pointing at a closed row. Measured
// 2026-08-22 — the run answered
// `409 {"error":"... already superseded","current_id":4333}`.
//
// And the FIRST run on a host with no state file can lose the search too
// (a Linux host, 2026-10-28: the title is Russian and the search is semantic, not a
// key lookup) — the append then answers the store's own key conflict,
// `409 {"error":"live key '...' already belongs to memory entry 20699"}`
// (scripts/memory/store.mjs, getLiveByKey): no current_id, the id rides in
// the message. Both refusals NAME their own fix, which is the memoryctl
// contract's rule, so the recovery below supplies the named id instead of
// repeating the same call — the unique index over `key` allows one live row,
// so a blind append would fail too, and if it did not, it would fork the
// history this entry exists to keep in one place.
function recoverFromRefusal(r, existing, runMemory) {
  if (r.ok) return null;
  const named = r.out.match(/"current_id"\s*:\s*(\d+)/)?.[1]
    ?? r.out.match(/already belongs to memory entry (\d+)/)?.[1];
  const recovered = named ? Number(named) : findLiveEntryId(runMemory);
  return recovered && recovered !== existing ? recovered : null;
}

// ---------------------------------------------------------------------------
// schedule
// ---------------------------------------------------------------------------
//
// launchd, not cron: there is no crontab on this machine, launchd is the native
// mechanism, and the repo already installs one job this way
// (ops/bootstrap/install-memory.mjs → a prefix-named memoryctl plist). Copying an
// established pattern beats inventing a second scheduling story.
//
// Linux hosts are the exception: launchd does not exist there, and the user
// crontab is the mechanism the host already runs (a Linux host has carried a
// dryer-weekly line for years, Linger=yes), so the linux branch below owns
// exactly ONE tagged line of that table instead of a second scheduler story.
//
// StartCalendarInterval rather than StartInterval: a machine that was asleep at
// 04:00 runs the job when it wakes, and a laptop that is never awake at a fixed
// second would otherwise never update at all.

// The durable checkout the daily job must run from. `git-common-dir` is the
// shared `.git` of every worktree; its parent is the main working tree, which
// outlives `git worktree remove`. Refusing `--install-schedule` from a worktree
// would make the job un-installable from the only place agents work.
export function resolveMainCheckout(fromRepo = REPO) {
  const r = spawnSync(
    'git',
    ['-C', fromRepo, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8', timeout: 10_000, env: scrubbedGitEnv() },
  );
  if (r.status !== 0) return null;
  const common = String(r.stdout ?? '').trim();
  if (!common) return null;
  return path.dirname(common);
}

export function plistBody(checkout) {
  const node = process.execPath;
  const script = path.join(checkout, 'ops', 'update-tools.mjs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_ID}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${script}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>4</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
  <key>WorkingDirectory</key><string>${checkout}</string>
</dict>
</plist>
`;
}

// The Windows twin of the plist: schtasks is the native scheduler there. The
// log line launchd provides for free (StandardOutPath) has no schtasks flag,
// so the action wraps the run in cmd.exe — the only component that can
// redirect stdout on Windows — with /d /s /c, the shape that survives cmd's
// quote-stripping with a quoted program, script and log inside.
export function schtasksCreateArgs(checkout, { node = process.execPath, logFile = LOG_FILE } = {}) {
  const script = path.join(checkout, 'ops', 'update-tools.mjs');
  const action = `cmd.exe /d /s /c ""${node}" "${script}" >> "${logFile}" 2>&1"`;
  return ['/Create', '/F', '/SC', 'DAILY', '/ST', '04:30', '/TN', TASK_NAME, '/TR', action];
}

function plistString(xml, key) {
  const match = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return match ? match[1] : null;
}

function plistProgramArguments(xml) {
  const block = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!block) return [];
  return [...block[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
}

export function inspectSchedule(plistPath = PLIST) {
  if (!existsSync(plistPath)) {
    return {
      status: 'missing',
      workingDirectory: null,
      script: null,
      problems: [`plist not installed: ${plistPath}`],
    };
  }
  const xml = readFileSync(plistPath, 'utf8');
  const workingDirectory = plistString(xml, 'WorkingDirectory');
  const args = plistProgramArguments(xml);
  const script = args.find((a) => a.endsWith('update-tools.mjs')) ?? args[1] ?? null;
  const problems = [];
  if (!workingDirectory) problems.push('plist has no WorkingDirectory');
  else if (!existsSync(workingDirectory)) {
    problems.push(`WorkingDirectory does not exist: ${workingDirectory}`);
  }
  if (!script) problems.push('plist has no script path in ProgramArguments');
  else if (!existsSync(script)) problems.push(`script path does not exist: ${script}`);
  return {
    status: problems.length ? 'broken' : 'ok',
    workingDirectory,
    script,
    problems,
  };
}

// The win32 counterpart of inspectSchedule: schtasks /Query is the registry of
// record, and the script path it reports is checked on disk exactly the way
// the plist's ProgramArguments are. `runQuery` is a seam so a test can answer
// for the scheduler on any platform.
export function inspectScheduleTask({ platform: plat = platform(), runQuery } = {}) {
  if (plat !== 'win32') {
    return {
      status: 'missing',
      workingDirectory: null,
      script: null,
      problems: ['Task Scheduler jobs are the win32 mechanism; this machine is not win32'],
    };
  }
  const query = (runQuery
    || (() => run('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST', '/V'], { timeout: 30_000 })))();
  if (!query.ok) {
    return {
      status: 'missing',
      workingDirectory: null,
      script: null,
      problems: [`Task Scheduler task not installed: ${TASK_NAME}`],
    };
  }
  // The task's action names the script inside a quoted command line; pull the
  // token that ends in update-tools.mjs, independent of the localized field
  // names /V would otherwise force us to parse.
  const script = query.out.match(/[^\s"']*update-tools\.mjs/)?.[0] ?? null;
  const problems = [];
  if (!script) problems.push(`task ${TASK_NAME} names no ops/update-tools.mjs in its action`);
  else if (!existsSync(script)) problems.push(`script path does not exist: ${script}`);
  return {
    status: problems.length ? 'broken' : 'ok',
    workingDirectory: null,
    script,
    problems,
  };
}

function renderTaskSchedule(info) {
  const lines = ['## Расписание Task Scheduler', ''];
  if (info.status === 'ok') {
    lines.push(`- ${TASK_NAME}: ок`);
    if (info.script) lines.push(`- script: ${info.script}`);
  } else if (info.status === 'missing') {
    lines.push(`- ${TASK_NAME}: не установлен`);
    for (const p of info.problems) lines.push(`- ${p}`);
  } else {
    lines.push(`- ${TASK_NAME}: СЛОМАН`);
    for (const p of info.problems) lines.push(`- ${p}`);
  }
  return lines.join('\n');
}

// The linux twin of the plist/schtasks pair: the user crontab. Exactly one
// line of that table is ours, tagged `# <PREFIX>-update-tools`, so install
// replaces only ours and leaves every foreign line byte-for-byte — a blind
// rewrite of the table would eat the operator's own lines.
export function crontabTag(prefix = PREFIX) {
  return `${prefix}-update-tools`;
}

// cron hands the command to /bin/sh and turns an unescaped % into a newline:
// each path is one single-quoted word, and its % is escaped for cron.
function cronWord(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`.replaceAll('%', '\\%');
}

export function crontabLine(checkout, { node = process.execPath, logFile = LOG_FILE, prefix = PREFIX } = {}) {
  const script = path.join(checkout, 'ops', 'update-tools.mjs');
  return `30 4 * * * ${cronWord(node)} ${cronWord(script)} >> ${cronWord(logFile)} 2>&1 # ${crontabTag(prefix)}`;
}

// The script path of a tagged line: our quoted word undone, or a bare token in a hand-written line.
function cronScript(line) {
  const quoted = line.match(/'((?:[^']|'\\'')*update-tools\.mjs)'/);
  if (quoted) return quoted[1].replaceAll(`'\\''`, "'").replaceAll('\\%', '%');
  return line.match(/[^\s"']*update-tools\.mjs/)?.[0] ?? null;
}

const defaultCrontabRun = (args, options = {}) => run('crontab', args, { timeout: 30_000, ...options });

// `crontab -l` exit 1 with "no crontab for <user>" is an EMPTY table (a fresh
// host), not a failure; any other refusal means the table is unknown, and a
// write on top of an unknown table could eat foreign lines, so it throws.
export function readCrontabTable(runCrontab = defaultCrontabRun) {
  const r = runCrontab(['-l']);
  if (r.ok) return r.stdout ?? r.out;
  if (/no crontab for/i.test(r.out)) return '';
  throw new Error(`crontab -l refused: ${tail(r.out, 300)}`);
}

function isOurCrontabLine(line) {
  return line.trimEnd().endsWith(`# ${crontabTag()}`);
}

// Split a table into lines keeping every byte except the trailing empty piece
// the final newline produces: comments, blanks and env lines survive verbatim.
function crontabLines(table) {
  if (!table) return [];
  const lines = table.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function installCrontab(checkout, { runCrontab = defaultCrontabRun, node, logFile } = {}) {
  const kept = crontabLines(readCrontabTable(runCrontab)).filter((line) => !isOurCrontabLine(line));
  const table = `${[...kept, crontabLine(checkout, { node, logFile })].join('\n')}\n`;
  return runCrontab(['-'], { stdin: table });
}

export function removeCrontab({ runCrontab = defaultCrontabRun } = {}) {
  const lines = crontabLines(readCrontabTable(runCrontab));
  const kept = lines.filter((line) => !isOurCrontabLine(line));
  if (kept.length === lines.length) return { ok: true, removed: 0 };
  const write = runCrontab(['-'], { stdin: kept.length ? `${kept.join('\n')}\n` : '' });
  return { ok: write.ok, removed: lines.length - kept.length, out: write.out };
}

function crontabMissing() {
  return {
    status: 'missing',
    workingDirectory: null,
    script: null,
    problems: [`crontab line not installed: # ${crontabTag()}`],
  };
}

// A failed `crontab -l` is never an empty table: "no crontab for" is missing,
// any other refusal is broken (reported, so --check exits 1).
function crontabQueryAnswer(query) {
  if (query.ok) return null;
  return /no crontab for/i.test(query.out)
    ? crontabMissing()
    : {
        status: 'broken',
        workingDirectory: null,
        script: null,
        problems: [`crontab -l refused: ${tail(query.out, 300)}`],
      };
}

// The linux counterpart of inspectScheduleTask, same seam shape: `runQuery`
// answers for `crontab -l` so a test never touches a real table.
export function inspectCrontab({ platform: plat = platform(), runQuery } = {}) {
  if (plat !== 'linux') {
    return {
      status: 'missing',
      workingDirectory: null,
      script: null,
      problems: ['the user crontab is the linux mechanism; this machine is not linux'],
    };
  }
  const query = (runQuery || (() => run('crontab', ['-l'], { timeout: 30_000 })))();
  const answer = crontabQueryAnswer(query);
  if (answer) return answer;
  const tagged = query.out.split('\n').filter((l) => isOurCrontabLine(l));
  // A commented-out line of ours is a disabled daily job, not a working schedule.
  const line = tagged.find((l) => !l.trimStart().startsWith('#'));
  if (!line) {
    return tagged.length
      ? { status: 'broken', workingDirectory: null, script: null, problems: [`crontab line # ${crontabTag()} is commented out`] }
      : crontabMissing();
  }
  const script = cronScript(line);
  const problems = [];
  if (!script) problems.push(`crontab line # ${crontabTag()} names no ops/update-tools.mjs`);
  else if (!existsSync(script)) problems.push(`script path does not exist: ${script}`);
  return {
    status: problems.length ? 'broken' : 'ok',
    workingDirectory: null,
    script,
    problems,
  };
}

function renderCrontabSchedule(info) {
  const lines = ['## Расписание crontab', ''];
  if (info.status === 'ok') {
    lines.push(`- ${crontabTag()}: ок`);
    lines.push(`- script: ${info.script}`);
  } else if (info.status === 'missing') {
    lines.push(`- ${crontabTag()}: не установлен`);
    for (const p of info.problems) lines.push(`- ${p}`);
  } else {
    lines.push(`- ${crontabTag()}: СЛОМАН`);
    for (const p of info.problems) lines.push(`- ${p}`);
  }
  return lines.join('\n');
}

function renderSchedule(info) {
  const lines = ['## Расписание launchd', ''];
  if (info.status === 'ok') {
    lines.push(`- ${PLIST_ID}: ок`);
    lines.push(`- WorkingDirectory: ${info.workingDirectory}`);
    lines.push(`- script: ${info.script}`);
  } else if (info.status === 'missing') {
    lines.push(`- ${PLIST_ID}: не установлен`);
    for (const p of info.problems) lines.push(`- ${p}`);
  } else {
    lines.push(`- ${PLIST_ID}: СЛОМАН`);
    for (const p of info.problems) lines.push(`- ${p}`);
  }
  return lines.join('\n');
}

// The mechanism name for the checkout-refusal text, per platform: never
// "launchd" on a Linux host.
function scheduleMechanism() {
  return platform() === 'win32'
    ? 'Task Scheduler job'
    : platform() === 'linux' ? 'crontab line' : 'launchd job';
}

function installSchedule() {
  const checkout = resolveMainCheckout();
  const script = checkout ? path.join(checkout, 'ops', 'update-tools.mjs') : null;
  if (!checkout || !existsSync(checkout) || !script || !existsSync(script)) {
    console.error(
      `cannot resolve the main checkout for the ${scheduleMechanism()} `
      + '(git rev-parse --path-format=absolute --git-common-dir); '
      + `got ${checkout ?? '(none)'}`,
    );
    process.exit(1);
  }
  mkdirSync(STATE_DIR, { recursive: true });

  if (platform() === 'win32') {
    const create = run('schtasks', schtasksCreateArgs(checkout), { timeout: 30_000 });
    if (!create.ok) {
      console.error(`could not create ${TASK_NAME}: ${create.out}`);
      process.exit(1);
    }
    console.log(`installed ${TASK_NAME} → daily at 04:30`);
    console.log(`  task: ${TASK_NAME}`);
    console.log(`  checkout: ${checkout}`);
    console.log(`  log:   ${LOG_FILE}`);
    return;
  }

  if (platform() === 'linux') {
    installLinuxSchedule(checkout);
    return;
  }

  mkdirSync(path.dirname(PLIST), { recursive: true });
  writeFileSync(PLIST, plistBody(checkout));
  run('launchctl', ['bootout', `gui/${process.getuid()}/${PLIST_ID}`], { timeout: 30_000 });
  const load = run('launchctl', ['bootstrap', `gui/${process.getuid()}`, PLIST], { timeout: 30_000 });
  if (!load.ok) {
    console.error(`could not load ${PLIST_ID}: ${load.out}`);
    process.exit(1);
  }
  console.log(`installed ${PLIST_ID} → daily at 04:30`);
  console.log(`  plist: ${PLIST}`);
  console.log(`  checkout: ${checkout}`);
  console.log(`  log:   ${LOG_FILE}`);
  console.log(`  run now: launchctl kickstart -k gui/${process.getuid()}/${PLIST_ID}`);
}

function installLinuxSchedule(checkout) {
  let install;
  try {
    install = installCrontab(checkout);
  } catch (error) {
    console.error(`could not install the crontab line: ${error.message}`);
    process.exit(1);
  }
  if (!install.ok) {
    console.error(`could not install the crontab line: ${install.out}`);
    process.exit(1);
  }
  console.log(`installed ${crontabTag()} → daily at 04:30`);
  console.log(`  line: ${crontabLine(checkout)}`);
  console.log(`  checkout: ${checkout}`);
  console.log(`  log:   ${LOG_FILE}`);
}

function removeSchedule() {
  if (platform() === 'win32') {
    const del = run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { timeout: 30_000 });
    console.log(del.ok ? `removed ${TASK_NAME}` : `${TASK_NAME}: ${del.out}`);
    return;
  }
  if (platform() === 'linux') {
    try {
      const r = removeCrontab();
      if (!r.ok) console.error(`could not remove the crontab line: ${r.out}`);
      else console.log(r.removed ? `removed ${crontabTag()}` : `${crontabTag()}: not installed`);
    } catch (error) {
      console.error(`could not remove the crontab line: ${error.message}`);
    }
    return;
  }
  run('launchctl', ['bootout', `gui/${process.getuid()}/${PLIST_ID}`], { timeout: 30_000 });
  if (existsSync(PLIST)) rmSync(PLIST);
  console.log(`removed ${PLIST_ID}`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
//
// Gated, per lesson 3937: a hook script that calls main() at the top level
// cannot be imported for a unit test without SPAWNING the whole job — the test
// then measures the machine it runs on instead of the function it names.
// Everything above is exported for that reason.

// The --check schedule report: one inspector+renderer pair per platform, and
// the exit code goes red on the broken answer of whichever machine this is.
function printScheduleCheck() {
  const [info, render] = platform() === 'win32'
    ? [inspectScheduleTask(), renderTaskSchedule]
    : platform() === 'linux'
      ? [inspectCrontab(), renderCrontabSchedule]
      : [inspectSchedule(), renderSchedule];
  console.log(render(info));
  console.log('');
  if (info.status === 'broken') process.exitCode = 1;
}

export async function main() {
  if (CHECK_ONLY && (ARGS.has('--install-schedule') || ARGS.has('--remove-schedule'))) {
    throw new Error('--check cannot be combined with schedule mutations');
  }
  if (ARGS.has('--install-schedule')) return installSchedule();
  if (ARGS.has('--remove-schedule')) return removeSchedule();

  if (CHECK_ONLY) printScheduleCheck();

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const state = readState();
  const results = await updateAll(state);
  if (!CHECK_ONLY) writeState(state);
  const report = renderReport(results, stamp);
  console.log(report);

  if (!NO_MEMORY && !CHECK_ONLY) {
    const m = recordToMemory(report);
    console.log(m.ok ? `\nrecorded: ${m.out}` : `\nMEMORY WRITE FAILED: ${m.out}`);
  }

  // A failed update is not a failed SCRIPT — the report is the deliverable, and
  // launchd retrying a job because one vendor's CDN was down helps nobody.
  const missing = results.filter((r) => r.status === 'missing').map((r) => r.id);
  if (missing.length) console.log(`\nnot installed: ${missing.join(', ')}`);
  return results;
}

export { TOOLS, renderReport, tail };

if (isMain(import.meta.url)) main().catch((e) => { console.error(e); process.exitCode = 1; });
