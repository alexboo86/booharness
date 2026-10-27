#!/usr/bin/env node
// Checkout-local installation only: no runtime settings or other HOME writes.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../../scripts/git-env.mjs';
import { isMain } from '../../scripts/lib/is-main.mjs';
import { readHarnessConfig } from '../../scripts/lib/harness-config.mjs';

const GITHOOK_SHIM = fileURLToPath(new URL('./githook-shim.sh', import.meta.url));

/**
 * Install worktree-aware shims in the git common hooks directory.
 * Migrate only our legacy local core.hooksPath; refuse other wiring or foreign
 * hooks before writing anything. Shared by the full installer and runtime sync.
 */
export function installGitHooks(ctx) {
  let inside = false;
  try {
    inside = git(['-C', ctx.repo, 'rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    // Not a git checkout at all - the installer's own test fixture is a plain
    // directory, and wiring git there is neither possible nor owed.
    inside = false;
  }
  if (!inside) {
    return { runtime: 'git', path: 'hooks', state: 'skipped_not_a_git_checkout' };
  }
  const guardDir = path.join(ctx.repo, '.githooks');
  if (!existsSync(guardDir)) {
    throw new Error(
      `${ctx.repo} is a git checkout without .githooks - the guards the contract names ` +
        '(pre-commit, commit-msg, post-commit, post-merge, pre-push) are tracked there. Restore the directory, then re-run.',
    );
  }
  // Every scope git reads (system, global, local, worktree, includes): a
  // value left in any of them makes git skip the common-dir shims, so the
  // guards would be silently off while this step reported them installed.
  const hooksPathEntries = () => {
    let out = '';
    try {
      out = git(['-C', ctx.repo, 'config', '--show-scope', '--show-origin', '--get-all', 'core.hooksPath']);
    } catch {
      return []; // Unset everywhere: exit 1 is the answer, not a failure.
    }
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [scope, origin, ...value] = line.split('\t');
        return { scope, origin, value: value.join('\t') };
      });
  };
  const refuseHooksPath = (entries) => {
    if (!entries.length) return;
    const named = entries.map((e) => `'${e.value}' (${e.scope}, ${e.origin})`).join('; ');
    throw new Error(
      `core.hooksPath for ${ctx.repo} is set: ${named}. Git would never run the shims in the common ` +
        'hooks directory: unset it yourself in the scope named (`git config --<scope> --unset core.hooksPath`, ' +
        'or edit the file named), then re-run the installer.',
    );
  };
  // The previous installer's own value is migrated; every other one is refused
  // before anything is written.
  const isLegacy = (e) => e.scope === 'local' && e.value === '.githooks';
  const before = hooksPathEntries();
  const legacy = before.some(isLegacy);
  refuseHooksPath(before.filter((e) => !isLegacy(e)));
  const common = git(['-C', ctx.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  const hookDir = path.join(common, 'hooks');
  const prefix = readHarnessConfig({ repoRoot: fileURLToPath(new URL('../..', import.meta.url)) }).names.prefix;
  const GITHOOK_SHIM_MARKER = `# ${prefix}-githook-shim:`;
  const shim = readFileSync(GITHOOK_SHIM, 'utf8').replace('# harness-githook-shim:', GITHOOK_SHIM_MARKER);
  const names = readdirSync(guardDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
  const plan = names.map((name) => {
    const file = path.join(hookDir, name);
    let have = null;
    try {
      have = readFileSync(file, 'utf8');
    } catch {
      // Absent: written below.
    }
    if (have !== null && !have.includes(GITHOOK_SHIM_MARKER)) {
      throw new Error(
        `${file} is a git hook the harness did not write. Refusing to overwrite it: move it into ` +
          `.githooks/${name} or delete it yourself, then re-run the installer.`,
      );
    }
    // Windows has no execute bit to compare; Git for Windows runs the hook through sh.
    const fresh = have === shim && (process.platform === 'win32' || (statSync(file).mode & 0o111) === 0o111);
    return { name, file, fresh };
  });
  mkdirSync(hookDir, { recursive: true });
  const written = [];
  for (const { name, file, fresh } of plan) {
    if (fresh) continue;
    writeFileSync(file, shim);
    chmodSync(file, 0o755);
    written.push(name);
  }
  if (legacy) git(['-C', ctx.repo, 'config', '--local', '--unset-all', 'core.hooksPath']);
  // Proof, not assumption: nothing may be left anywhere once the shims are in.
  refuseHooksPath(hooksPathEntries());
  const state = legacy ? 'migrated_from_hooks_path' : written.length ? 'installed' : 'already_installed';
  return { runtime: 'git', path: hookDir, state, hooks: names, written };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith('-')) {
    console.error('usage: node install-git-hooks.mjs <checkout>');
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(installGitHooks({ repo: path.resolve(args[0]) })));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
