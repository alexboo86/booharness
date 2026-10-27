#!/bin/sh
# harness-githook-shim: copied into $(git rev-parse --git-common-dir)/hooks under
# every name in .githooks by ops/bootstrap/install-harness.mjs (and
# windows-bringup.ps1). Edit THIS file and re-run the installer; never the copies.
#
# Why not core.hooksPath=.githooks (task 1565): git resolves a relative hooksPath
# per work tree, so a worktree of an orphan or old branch without .githooks ran no
# pre-push at all and an unacknowledged push to github exited 0. An absolute path
# dies silently when the checkout is moved. The common dir is shared by every
# worktree and moves with the repository, so the shims live there.
#
# A gate runs the MAIN checkout's current copy, never the checked-out tree's: an
# old branch carries an old pre-push or an old scripts/check-push-safety.mjs that
# passes what today's gate refuses. With no main copy, pre-push, pre-commit and
# commit-msg fail. post-commit is not a gate but the LAN sync, and origin mirrors
# to github: it runs only the tree's own copy, so an orphan or old-branch
# worktree without one publishes nothing (memory #1113).
name=$(basename "$0")
top=$(git rev-parse --show-toplevel 2>/dev/null)
run() {
  [ -x "$1" ] && exec "$@"
  exec sh "$@"
}
if [ "$name" = "post-commit" ]; then
  [ -n "$top" ] && [ -f "$top/.githooks/post-commit" ] && run "$top/.githooks/post-commit" "$@"
  exit 0
fi
# The main work tree: this tree when its git dir is the common dir, else the
# first entry `git worktree list` gives. With --separate-git-dir git lists the
# git dir itself there, which holds no .githooks, so a linked worktree's gate
# fails instead of guessing a checkout. A bare repository has no main tree.
git_dir=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null)
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
if [ -n "$git_dir" ] && [ "$git_dir" = "$common" ]; then
  main=$top
else
  list=$(git worktree list --porcelain 2>/dev/null)
  main=$(printf '%s\n' "$list" | sed -n '1s/^worktree //p')
  [ "$(printf '%s\n' "$list" | sed -n 2p)" = "bare" ] && main=
fi
[ -n "$main" ] && [ -f "$main/.githooks/$name" ] && run "$main/.githooks/$name" "$@"
[ "$SKIP_GIT_GUARD" = "1" ] && exit 0
echo "$name: no .githooks/$name in the main checkout '$main' - the guard cannot run." >&2
[ "$name" = "pre-push" ] && echo "pre-push: refusing the push (fail closed). Escape: SKIP_GIT_GUARD=1" >&2
[ "$name" != "pre-push" ] && echo "$name: refusing (fail closed). Escape: SKIP_GIT_GUARD=1" >&2
exit 1
