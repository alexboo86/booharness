import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { canonicalSearchDirs, resolveOnPath } from './resolve-runtime-path.mjs';
import { readInstallSettings } from '../../scripts/lib/harness-config.mjs';

export function maybeInstallCodeIntel(ctx) {
  if (ctx.skipCodeIntel) return { skipped: true };
  const { stateDirFor } = createRequire(import.meta.url)('../orchestrator/src/config.ts');
  const stateDir = process.env.ORCH_STATE_DIR ? path.resolve(process.env.ORCH_STATE_DIR) : stateDirFor(ctx.home);
  const { file: settingsFile, document } = readInstallSettings(stateDir);
  const { 'instruments.install': install = true } = document.values;
  if (typeof install !== 'boolean') throw new Error(`${settingsFile}: instruments.install must be boolean`);
  if (!install) return { skipped: true, reason: 'instruments.install is off' };
  // Windows npm.cmd is not an argv transport: run the shipped npm CLI with
  // Node, never a shell. Keep the existing platform selection unchanged.
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const [file, argv] = process.platform === 'win32' && existsSync(npmCli)
    ? [process.execPath, [npmCli, 'install', '--global', '@colbymchenry/codegraph', '@ast-grep/cli']]
    : ['npm', ['install', '--global', '@colbymchenry/codegraph', '@ast-grep/cli']];
  const result = spawnSync(file, argv, { encoding: 'utf8', shell: false });
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
 * its crates, and `~/.cargo/bin` is on every canonical search path already.
 * The build takes minutes, so it runs ONLY when `rg` cannot be resolved.
 */
export function installRipgrep() {
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

function installPlaywright(ctx) {
  if (ctx.platform !== process.platform) {
    return { skipped: true, reason: 'Playwright must be installed on the target platform' };
  }
  // Use the root lockfile's CLI, not npx's potentially unpinned download.
  const cli = path.join(ctx.repo, 'node_modules', 'playwright-core', 'cli.js');
  if (!existsSync(cli)) throw new Error(`Playwright CLI is missing: ${cli}; run npm ci in the repo root`);
  const env = {
    ...process.env, HOME: ctx.home, USERPROFILE: ctx.home,
    XDG_CACHE_HOME: path.join(ctx.home, '.cache'),
    LOCALAPPDATA: path.join(ctx.home, 'AppData', 'Local'),
  };
  // Always use Playwright's per-user cache, including for an explicit --home.
  delete env.PLAYWRIGHT_BROWSERS_PATH;
  const result = spawnSync(process.execPath, [cli, 'install', 'chromium'], {
    cwd: ctx.repo, env, encoding: 'utf8', timeout: 300_000, windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Playwright chromium install failed: ${result.stderr || result.error?.message || result.stdout}`);
  }
  // Playwright itself checks completion markers and skips cached revisions.
  return { state: 'ready' };
}

/** Browser downloads are optional: offline installs report a remedy and continue. */
export function runPlaywrightStep(ctx, report) {
  if (ctx.only && ctx.only !== 'playwright') return;
  try {
    report.playwright = installPlaywright(ctx);
  } catch (error) {
    report.playwright = {
      state: 'failed', reason: error.message,
      remedy: 'node ops/bootstrap/install-harness.mjs --only playwright',
    };
  }
}
