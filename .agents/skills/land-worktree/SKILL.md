---
name: land-worktree
description: Safely merge a completed worktree branch back to master and close its session. Use before landing any feat/* or claude/* worktree, when resolving its integration conflicts, or when removing a completed worktree and branch.
lead_only: true
---

# Land and close a worktree

Require the ticket/task key, worktree path, branch name, and intended HEAD. The lead lands its own
work (operator #14534): the operator is not asked to run the fast-forward. Pushing `master` to the
NAS `origin` is the LAN sync and part of landing; a push anywhere else and any deploy need separate
explicit operator approval.

## EnterWorktree isolates the session: exit before landing

A session the app started in a worktree commits on its session branch from its own cwd and lands
with `git -C`:

```bash
[ "$(git -C <main checkout> rev-parse --abbrev-ref HEAD)" = master ] && git -C <main checkout> merge --ff-only <sha>
git -C <main checkout> push origin master
```

Two guards of the Claude desktop app decide what else it may do (task 2126, observed 2026-10-06):

- The Edit and Write tools are refused for a file under another app worktree
  (`.claude/worktrees/<other>/`: "belongs to a different worktree"). To edit there, call
  `EnterWorktree {path}`. Bash and `git -C <path>` are not refused, and a worktree outside
  `.claude/worktrees/` (an orch task worktree) is writable.
- Once a session has called `EnterWorktree`, its git outside that worktree is refused ("a
  worktree-isolated session's git operations must target its own worktree"; `git -C <main
  checkout>` is refused as "redirects git to the shared checkout"). Permission mode is not the
  cause. `ExitWorktree {action: "keep"}` lifts it: the worktree and its branch stay.

The cycle: `EnterWorktree {path}` only to edit and commit in that worktree,
`ExitWorktree {action: "keep"}` before any git outside it, then the two lines above. A lead that
takes the other branch into its own session branch (`git merge --ff-only <sha>` from its own cwd)
needs neither. `ops/bootstrap/lead-worktree-hook.mjs` prints the cycle when a top-level Claude
session calls `EnterWorktree`; orch seats are unaffected.

Inside the entered worktree, run `npm run check:commit -- <paths>` alone, then commit with one bare
`/usr/bin/git commit -m "..." -- <paths>` line, and use `/usr/bin/git` for every other git step:
plain `git` is rewritten to `rtk git` and refused by the isolation check, and a `cd` prefix or a
heredoc commit is refused by the commit-shape hook (2026-10-19, task 2654: three refusals).

## 1. Prove the work is not already landed

Run before modifying either checkout:

```bash
git log --all --oneline --fixed-strings --grep="$ticket"
git branch -a --contains <each-matching-commit>
git worktree list --porcelain
sed -n '1,240p' .team/current.md
```

Compare matching commits and live worktree assignments, not just branch names. If the same fix is
landed or active elsewhere, stop before merging or deleting anything and report both provenances.

## 2. Audit provenance in the worktree

```bash
git -C "$worktree" status --porcelain
git -C "$worktree" branch --show-current
git -C "$worktree" rev-parse HEAD
git -C "$worktree" log -1 --oneline --decorate
```

Require a clean worktree, or explain every dirty file with owner, cause, and intended disposition.
Provisioning no longer overlays harness files onto a worktree (task 1577), so a dirty
`.claude/hooks/**`, `.claude/scripts/**` or `docs/agent/domain-routing.generated.json` is a real
edit or a leftover from an older provisioner: explain it like any other path, and clear a stale
`skip-worktree` bit (`git ls-files -v | grep '^S'`) before landing, or the edit is dropped. Verify the checked-out branch and HEAD equal the branch and
commit selected for landing. Never absorb unrelated dirty files.

## 3. Integrate current master into the branch

Fetch first, then update inside the feature worktree:

```bash
git fetch origin
git -C "$worktree" merge origin/master
```

Use rebase only for an unpublished, single-owner branch; never rewrite shared history. Resolve all
conflicts in the worktree branch, not on master. From `$worktree`, get all markers in one pass:

```bash
git grep -n '^<<<<<<< '
```

Treat grep exit 1 with no output as “no markers.” Re-run it after resolution. Re-verify meaningful
resolutions (the adopted project's verification command, lint, plus the conditional checks the touched
paths trigger), commit only their paths after approval, then refresh the intended HEAD.

Merge only with a clean index: `git diff --cached --quiet && git merge ...`. A refused merge can
leave the worktree clean and the staged paths gone (2026-10-13: 41 staged paths, recovered from the
unreachable WIP object). Commit staged work alone first, and never chain a merge after a pipe such
as `| tail -1` or `wc -l`: the chain merges even when the guard printed a problem.

## 4. Preview the landing on master

Require the master checkout to be clean and current. Record `pre_merge_head=$(git rev-parse HEAD)`.
Preview without touching the index:

```bash
git merge-tree "$(git merge-base master "$branch")" master "$branch"
git diff --stat master..."$branch"
git log --oneline master.."$branch"
```

Inspect the full file list, deletions, generated files, and conflict output. If master moved after
the branch sync, return to step 3; do not resolve integration conflicts on master.

## 5. Land, then verify

Prefer `git merge --ff-only "$branch"` after the branch contains current master. This preserves the
already-reviewed commits and avoids creating a merge commit that Git cannot make with a pathspec.
If a non-fast-forward merge commit is required, stop and request operator approval for the explicit
commit-policy exception; do not silently use a bare `git commit`.

Verify the landed range on master with `<pre_merge_head>..HEAD` as the changed range: diff inventory
of the range, the adopted project's verification command, lint, the conditional checks the touched paths
trigger (module boundaries, cargo check per touched crate), generated-file inspection, and the
line-by-line dirty-file audit. If landing requires regeneration or a corrective edit, verify it and
commit only after approval:

```bash
git status --porcelain
git diff --stat
git commit -m "<ticket>: <summary>" -- <exact-paths>
```

Never create an empty post-merge commit. Require a clean, fully explained final status.

## 6. Operator gates

- After the fast-forward push `master` to the NAS `origin` only. Stop before a push to `github` or
  any other remote: it needs explicit operator approval and `npm run check:push`.
- Never deploy from the worktree branch. Deployment is a separate approved workflow from master.
- Do not delete provenance while verification, visual confirmation, or approval is pending.

## 7. Clean up only after confirmation

Confirm the intended commit is reachable from master, then remove the worktree and branch:

```bash
git merge-base --is-ancestor <intended-head> master
git worktree remove "$worktree"
git branch -d "$branch"
git worktree list
```

For a squash or other approved non-ancestral landing, verify equivalent patch provenance explicitly
before cleanup; never force-delete merely to make the command pass.

## Verification

Report dedup evidence, worktree HEAD/status, sync result, one-shot conflict scan, merge preview,
landed-range verification evidence, final master status, and cleanup commands. Paste counts and exit results.

## Failure modes

- Stop on duplicate dispatch, ambiguous HEAD, unknown dirty files, or a moving master.
- Stop on unresolved markers, failed landed-range verification, or unexplained generated output; stop before
  a GitHub push or a deploy without approval and never force-remove a worktree or force-delete its branch.
- A refusal that names a worktree-isolated session: `ExitWorktree {action: "keep"}`, then land; never ask
  the operator to run the fast-forward.
