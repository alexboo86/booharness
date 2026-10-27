// Sensor for contract rule 11a: `git commit -- <paths>` reads those paths from the
// WORKING TREE, not the index.
//
// The rule is prose, and prose lost: on 2026-07-25 a package.json carrying both an
// npm-script addition and a neighbouring session's eslint bump was hunk-staged carefully
// and then committed with a pathspec, which discarded the staging and shipped a manifest
// disagreeing with its lock file. The shared worktree makes that the normal case.
//
// What this detects is the hazard itself, not the intent: a staged path that ALSO has
// unstaged changes. Commit that path by pathspec and the unstaged part goes in silently.
//
// Exit 1 when the hazard is present. Two safe ways out, both printed:
//   - stage the rest of the file, if all of it is yours
//   - commit from the INDEX (`git commit` with no pathspec), which honours the staging
//
// Run before every commit: `npm run check:commit`

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';
import { scrubbedGitEnv } from './git-env.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const runningAsMain = isMain(import.meta.url);

/**
 * Parse `git status --porcelain=v1 -z` into per-path index/worktree states.
 * NUL-delimited so paths with spaces or quotes survive; renames carry a second path.
 * @param {string} raw
 * @returns {Array<{ index: string, worktree: string, path: string }>}
 */
export function parseStatus(raw) {
  const out = [];
  const parts = String(raw).split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const index = entry[0];
    const worktree = entry[1];
    const path = entry.slice(3);
    // A rename/copy entry is followed by its source path, which is not a separate file.
    if (index === 'R' || index === 'C') i++;
    out.push({ index, worktree, path });
  }
  return out;
}

// Git owns pathspec matching, including rename destinations.
export function resolvePathspec(pathspec, { rootDir = REPO } = {}) {
  const raw = execFileSync('git', ['status', '--porcelain=v1', '-z', '--', ...pathspec], {
    cwd: rootDir,
    encoding: 'utf8',
    env: scrubbedGitEnv(),
  });
  return new Set(parseStatus(raw).map((entry) => entry.path));
}

/**
 * Classify the working tree against the paths a commit is about to name.
 *
 * `partial` — staged AND still modified: committing it by pathspec silently adds the
 * unstaged part. `unstagedOnly` — modified with nothing staged: naming THAT in a pathspec
 * commits work that was never staged, so it never passed the status/diff review rule 11
 * requires. A reviewer found the second case reported OK, because the first version only
 * looked at what was staged and a pathspec can name anything.
 *
 * Unmerged entries ('U' on either side, or the DD/AA both-sides cases) are conflicts and
 * are reported apart: committing one by pathspec is a different mistake.
 *
 * @param {ReturnType<typeof parseStatus>} entries
 * @param {string[]} [pathspec] paths the commit will name; when given, the hazard is
 *   any NAMED path with worktree modifications, staged or not.
 */
export function classify(entries, scopedPaths = null) {
  // The scope is decided by GIT, never parsed here.
  //
  // Two rounds paid for that sentence. First this compared a pathspec as a
  // literal string, so `git commit -- src` - which commits everything under
  // `src` - matched nothing and the guard approved the very partial stage it
  // exists to refuse. The fix then expanded directory prefixes by hand and was
  // itself found half-right in the next round: a leading `./`, `:(exclude)`,
  // `:(icase)` and Windows case each produced the same false OK, measured four
  // ways by four seats. Pathspec is a language with magic prefixes, exclusions
  // and case rules; re-implementing it is how a guard keeps approving.
  //
  // `scopedPaths` is therefore the set of repository paths git itself matched
  // (`git status -- <pathspec>`), or null for "no scope given". An array is taken
  // as the same set already resolved, which is what the tests hand it.
  const named =
    scopedPaths === null || scopedPaths === undefined
      ? null
      : scopedPaths instanceof Set
        ? scopedPaths
        : new Set(scopedPaths);
  const scoped = named !== null && named.size > 0;
  const partial = [];
  const unstagedOnly = [];
  const unmerged = [];
  let staged = 0;
  for (const e of entries) {
    const bothSides = e.index === e.worktree && (e.index === 'A' || e.index === 'D' || e.index === 'U');
    if (e.index === 'U' || e.worktree === 'U' || bothSides) {
      unmerged.push(e.path);
      continue;
    }
    const isStaged = e.index !== ' ' && e.index !== '?';
    const dirtyWorktree = e.worktree !== ' ' && e.worktree !== '?';
    if (isStaged) staged++;
    if (scoped && !named.has(e.path)) continue;
    if (isStaged && dirtyWorktree) partial.push(e.path);
    else if (!isStaged && dirtyWorktree) unstagedOnly.push(e.path);
  }
  return { partial, unstagedOnly, unmerged, staged, scoped };
}

if (runningAsMain) {
  // Pass the paths the commit will name: `npm run check:commit -- <path>...`. Without
  // them the check can only judge the staged set, and a pathspec may name anything.
  const pathspec = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const git = (args) =>
    execFileSync('git', args, { cwd: REPO, encoding: 'utf8', env: scrubbedGitEnv() });
  const raw = git(['status', '--porcelain=v1', '-z']);
  // The same status asked again WITH the pathspec: git applies its own matching -
  // directory prefixes, a leading `./`, `:(exclude)`, `:(icase)`, case rules - and
  // the answer is the set of paths the commit will actually carry.
  const scopedPaths =
    pathspec.length === 0
      ? null
      : resolvePathspec(pathspec);
  // Two observations of one tree are two moments. A file that turns dirty between
  // them would be inside the scope and outside the hazard - the guard would
  // approve exactly what it exists to refuse. It cannot be made one call (the
  // unscoped view is what counts the staged set), so the two are compared: any
  // named path the second call did not see in the first is a tree that moved
  // under the check, and a check that ran over a moving tree reports nothing.
  if (scopedPaths) {
    // Rename SOURCES count as seen. `git status -z` reports a rename as the
    // destination followed by its source, and `parseStatus` skips the source
    // because it is not a separate file - but a pathspec naming that source is
    // legitimate, and git answers it with the rename entry. Without this the
    // guard called a perfectly still tree "moved" and refused a rename scoped by
    // where it came from, measured by the codex seat of round
    // 20260806T153814078Z.
    const everything = new Set();
    const parts = String(raw).split('\0');
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      if (!entry) continue;
      everything.add(entry.slice(3));
      if (entry[0] === 'R' || entry[0] === 'C') {
        i++;
        if (parts[i]) everything.add(parts[i]);
      }
    }
    const drifted = [...scopedPaths].filter((p) => !everything.has(p));
    if (drifted.length) {
      console.error(
        `FAIL: the tree changed while this check ran — ${drifted.length} path(s) appeared between two reads:`,
      );
      for (const p of drifted) console.error(`  ${p}`);
      console.error('Nothing was judged. Re-run it against a still tree.');
      process.exit(1);
    }
  }
  const { partial, unstagedOnly, unmerged, staged, scoped } = classify(parseStatus(raw), scopedPaths);

  if (unmerged.length) {
    console.error(`FAIL: ${unmerged.length} unmerged path(s) — resolve the conflict before committing:`);
    for (const p of unmerged) console.error(`  ${p}`);
    process.exit(1);
  }

  if (!staged) {
    console.error('FAIL: nothing staged. Stage explicitly with `git add -- <paths>` first.');
    process.exit(1);
  }

  let failed = false;

  if (partial.length) {
    console.error(
      `FAIL: ${partial.length} staged path(s) also carry UNSTAGED changes. ` +
        'Committing these with `git commit -- <paths>` would take the working-tree version ' +
        'and silently include the unstaged part:',
    );
    for (const p of partial) console.error(`  ${p}`);
    console.error('\nCheck `git diff -- <path>` first: in a shared worktree the unstaged part may belong');
    console.error('to another session. Then either');
    console.error('  - stage the rest, if all of it is yours: git add -- <path>');
    console.error('  - or commit from the index, which honours your staging: git commit   (no pathspec)');
    failed = true;
  }

  if (scoped && unstagedOnly.length) {
    console.error(
      `\nFAIL: ${unstagedOnly.length} named path(s) are modified but NOT staged. A pathspec commit ` +
        'takes them from the working tree, so they would be committed without ever passing the ' +
        'stage-then-review step:',
    );
    for (const p of unstagedOnly) console.error(`  ${p}`);
    console.error('\nStage them deliberately, or drop them from the pathspec.');
    failed = true;
  }

  if (failed) process.exit(1);

  if (!scoped) {
    console.warn(
      'WARN: no pathspec given, so only the staged set was judged. A pathspec commit can name a ' +
        'path that is modified but unstaged; pass the paths to check them: ' +
        'npm run check:commit -- <path>...',
    );
  }
  const scope = scoped ? `${pathspec.length} named path(s)` : `${staged} staged path(s)`;
  console.log(`check-commit-safety: OK (${scope}, none carrying unreviewed changes)`);
}
