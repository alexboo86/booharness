#!/bin/bash
# ================================================================
# new-session.sh — start an isolated session in its OWN worktree
# ================================================================
# The default entrypoint for any new task. A hook cannot cd a running session
# (Windows footgun), so this is the born-isolated path: it creates the worktree
# and prints the exact command to start the agent IN that worktree. Run this
# FIRST, then cd / launch the agent in ../wt-<task>.
#
# Usage:  bash .claude/scripts/new-session.sh <task-name> [base-branch]
#
# It delegates worktree creation to start-worktree.sh (which now handles an
# existing local/remote feat/<task> branch for cross-machine resume), then
# prints copy-paste next steps. It does NOT auto-cd (auto-cd is a footgun).
# ================================================================
set -euo pipefail
task="${1:-}"
base="${2:-master}"
if [[ -z "$task" ]]; then
    echo "usage: new-session.sh <task-name> [base-branch]" >&2
    echo "  creates ../wt-<task> on branch feat/<task> and tells you how to start there." >&2
    exit 1
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
parent="$(dirname "$repo")"
wt="$parent/wt-${task}"

bash "$repo/.claude/scripts/start-worktree.sh" "$task" "$base"

cat <<EOF

────────────────────────────────────────────────────────────
  Your isolated session lives in:  $wt   (branch feat/${task})
  Start work there:

    cd "$wt"
    # then launch your agent (claude / codex / kimi) FROM that dir,
    # or open a new terminal whose working dir is $wt

  The main checkout ($repo) is integration-only: file edits there are
  blocked by main-tree-guard.sh. Commit with explicit pathspec:
    git commit -m "..." -- <paths>
  When done:  git -C "$repo" worktree remove "$wt"
────────────────────────────────────────────────────────────
EOF
