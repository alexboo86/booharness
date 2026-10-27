// One way to run git from a Node script, with the redirecting environment removed.
//
// git reads GIT_DIR, GIT_WORK_TREE and their relatives BEFORE it reads `cwd` or
// `-C`, so with any of them exported a call that names a directory answers for a
// different repository. Svod's Rust side learned this the expensive way: three
// reviewers independently found that its writer-acceptance checks - `rev-parse`,
// `status --porcelain`, `merge-base --is-ancestor` - inherited those variables,
// which meant a member's commit could be accepted or rejected against a tree
// nobody named. The answer there was a single scrubbed constructor.
//
// The same hole is worse in this directory, because the scripts here ARE the
// guards: `check-commit-safety` decides whether a commit may proceed,
// `check-push-safety` decides whether refs may be published, `check-deletion-refs`
// decides whether a deletion is safe. A guard that inspects the wrong repository
// does not fail - it approves.
//
// So there is one helper, and every script uses it.

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CANON_DIR = join(REPO, '.agents', 'skills');

/**
 * The canon the machine's runtime links are SUPPOSED to point at.
 *
 * Not this checkout: the links are machine-wide and absolute, and
 * `install-harness.mjs` refuses to write them from anywhere but the main
 * checkout. Judged against a worktree's own path — or against a Svod member's
 * read root, which is a worktree too — every correct link looks foreign and
 * every canon skill looks undelivered. Measured 2026-08-06: `574 skill-delivery
 * problem(s)` from a run's snapshot on a machine whose seven runtimes were
 * linked perfectly, reported as a defect by three reviewers in one round, and
 * believed by nobody after the first time — which is the real cost of a sensor
 * that cries wolf.
 *
 * Git answers the question directly: a linked worktree has its own `--git-dir`
 * under the common directory, and only the main checkout has the two equal.
 */
export function installerCanonDir(repo = REPO) {
  try {
    const read = (args) =>
      execFileSync('git', ['-C', repo, 'rev-parse', '--path-format=absolute', ...args], {
        encoding: 'utf8',
        env: scrubbedGitEnv(),
      }).trim();
    const commonDir = read(['--git-common-dir']);
    const gitDir = read(['--git-dir']);
    if (!commonDir) return CANON_DIR;
    if (resolve(gitDir).toLowerCase() === resolve(commonDir).toLowerCase()) return CANON_DIR;
    return join(dirname(commonDir), '.agents', 'skills');
  } catch {
    // Not a repository, or no git: the machine's installer root is unknowable
    // from here, so the caller is told rather than shown invented drift.
    return null;
  }
}

/**
 * Is the support-lead skill profile installed in this scope?
 *
 * `--support-lead` is an argv flag the installer does NOT persist (it is read
 * once at install-harness.mjs ctx build and used only to widen `leadSkills`),
 * so the only record an install leaves is on disk: a managed link — one that
 * resolves INTO this scope's canon — carrying a supportLeadSkills name in a
 * lead runtime directory. One such link means the profile was installed and
 * every lead runtime of the scope was promised the whole set; none means it
 * was not, and the absence of all three is clean rather than unjudgeable.
 */
export function supportLeadInstalled(leadDirs, canonDir, supportSkills, fs = { existsSync, realpathSync }) {
  for (const dir of leadDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of supportSkills) {
      try {
        if (resolve(fs.realpathSync(join(dir, name))).toLowerCase() === resolve(join(canonDir, name)).toLowerCase()) {
          return true;
        }
      } catch {
        // Missing, dangling or unreadable: none of them is proof of an install.
      }
    }
  }
  return false;
}

/**
 * Variables git consults before it looks at the working directory.
 *
 * The first four redirect the repository outright. `GIT_CONFIG_*` do not move the
 * repository but change what git decides once it is there - a probe showed
 * `GIT_CONFIG_NOSYSTEM=1` making `filter.lfs.required` disappear from the answer.
 */
export const GIT_REDIRECTING_VARIABLES = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_NOSYSTEM',
]);

// These two keys only stop background housekeeping and never change what git
// answers or where it looks. Preserve the fixture shield from task 2372.
export const HOUSEKEEPING_CONFIG_KEYS = Object.freeze(['maintenance.auto', 'gc.auto']);

/**
 * The environment a git child should get: this process's, minus the redirections.
 * @param {NodeJS.ProcessEnv} [base]
 */
export function scrubbedGitEnv(base = process.env) {
  const env = { ...base };
  for (const name of GIT_REDIRECTING_VARIABLES) delete env[name];
  const count = Number(base.GIT_CONFIG_COUNT ?? 0);
  const housekeeping = [];
  for (const name of Object.keys(base)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_/.test(name)) delete env[name];
    const match = /^GIT_CONFIG_KEY_(0|[1-9]\d*)$/.exec(name);
    if (!match || !Number.isSafeInteger(count) || Number(match[1]) >= count) continue;
    const key = base[name];
    if (HOUSEKEEPING_CONFIG_KEYS.includes(key?.toLowerCase() ?? '')) {
      housekeeping.push({
        index: Number(match[1]),
        key,
        value: base[`GIT_CONFIG_VALUE_${match[1]}`],
      });
    }
  }
  housekeeping.sort((a, b) => a.index - b.index);
  housekeeping.forEach(({ key, value }, index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  if (housekeeping.length) env.GIT_CONFIG_COUNT = String(housekeeping.length);
  return env;
}

/**
 * Run git and return its stdout, trimmed.
 *
 * Options are passed through, so a caller that needs `maxBuffer` or a different
 * encoding keeps them; only `env` is decided here.
 * @param {string[]} args
 * @param {{ cwd?: string, encoding?: BufferEncoding, maxBuffer?: number, stdio?: unknown, input?: string }} [options]
 */
export function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    ...options,
    env: scrubbedGitEnv(options.env),
  });
}
