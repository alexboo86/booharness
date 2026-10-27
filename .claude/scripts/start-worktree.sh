#!/bin/bash
# ================================================================
# start-worktree.sh — isolate a session into its own git worktree
# ================================================================
# Each parallel session (Claude / Codex / Kimi / spawned chip) should work in
# its OWN worktree on its OWN branch so they never share one git index — which
# is what lets a bare `git commit` sweep another session's staged files
# (incident 2026-06-23, commit 8d3c0308c).
#
# Usage:  bash ~/.claude/scripts/start-worktree.sh <task-name> [base-branch]
#   <task-name>   short kebab slug → branch feat/<task>, dir ../wt-<task>
#   [base-branch] default: master
#
# This does NOT cd for you (auto-cd is a Windows footgun). It prints the cd line.
# ================================================================
set -euo pipefail

# link_shared_deps <source-repo> <worktree> — symlink heavy, gitignored build deps
# configured by the source repository so a fresh coder worktree is
# build-ready without a full `npm ci` / cargo rebuild. Guarded: skip a dep whose source is
# absent (e.g. no Rust build yet); idempotent — skip a dst that already exists (a prior link
# or a real dir the worktree owns), never clobber it. Shared dirs must be gitignored, so a symlink
# never pollutes the branch checkout.
STARTWT_CONFIG_READER="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/lib/harness-config.mjs"
link_shared_deps() {
    local sroot="$1" wroot="$2" rel src dst rels
    rels="$(node --input-type=module - "$STARTWT_CONFIG_READER" "$sroot" <<'JS'
import { pathToFileURL } from 'node:url';
const { projectConfig } = await import(pathToFileURL(process.argv[2]));
console.log(projectConfig({ repoRoot: process.argv[3] }).sharedBuildDirs.join('\n'));
JS
    )" || return $?
    while IFS= read -r rel; do
        [[ -n "$rel" ]] || continue
        src="$sroot/$rel"; dst="$wroot/$rel"
        [[ -e "$src" ]] || continue                 # nothing to share
        [[ -e "$dst" || -L "$dst" ]] && continue     # worktree already has its own / a prior link
        mkdir -p "$(dirname "$dst")"
        ln -s "$src" "$dst" && echo "✓ shared $rel (symlink → main checkout, gitignored)"
    done <<< "$rels"
}

# Library mode: `STARTWT_LIB=1 source start-worktree.sh` exposes the helpers above for unit
# tests and returns BEFORE any provisioning side effect. Only reached when sourced.
if [[ "${STARTWT_LIB:-0}" = 1 ]]; then
    return 0 2>/dev/null || exit 0
fi

task="${1:-}"
base="${2:-master}"
if [[ -z "$task" ]]; then
    echo "usage: start-worktree.sh <task-name> [base-branch]" >&2
    exit 1
fi
repo="$(git rev-parse --show-toplevel)"
parent="$(dirname "$repo")"
wt="$parent/wt-${task}"
if [[ -e "$wt" ]]; then
    echo "ERROR: $wt already exists. Pick another task name or remove it." >&2
    exit 1
fi
git -C "$repo" fetch origin "$base" 2>/dev/null || echo "(fetch skipped — offline?)" >&2
branch="feat/${task}"
# Cross-machine resume: if the branch already exists (locally or on origin),
# CHECK IT OUT into the worktree instead of erroring on -b (duplicate branch).
if git -C "$repo" show-ref --verify --quiet "refs/heads/${branch}"; then
    echo "(branch ${branch} exists locally → checking it out)" >&2
    git -C "$repo" worktree add "$wt" "${branch}"
elif git -C "$repo" ls-remote --exit-code --heads origin "${branch}" >/dev/null 2>&1; then
    echo "(branch ${branch} exists on origin → tracking it)" >&2
    git -C "$repo" fetch origin "${branch}" 2>/dev/null || true
    git -C "$repo" worktree add "$wt" -b "${branch}" --track "origin/${branch}"
else
    git -C "$repo" worktree add "$wt" -b "${branch}" "$base"
fi
# Harness parity: the worktree checkout carries the hooks/scripts/lessons committed on ITS base
# commit, which drift behind the main tree (incident 2026-07-06: stale Windows CLAUDE_STATE_DIR
# path in a worktree's skill-gate.sh burned ~9 min + ~15 tool calls of infra debugging; and
# skill-gate auto-inject serves lessons.md — a stale copy would inject stale gotchas).
# Sync only files TRACKED in the main repo (working-tree versions) — never untracked/ignored
# local scratch (Codex review finding #8) — and mark synced tracked files skip-worktree in the
# worktree so they cannot be staged/committed from the branch (GLM review finding #2); they land
# from master.
synced=0
while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    f="$repo/$rel"; tgt="$wt/$rel"
    [[ -f "$f" ]] || continue
    if ! cmp -s "$f" "$tgt" 2>/dev/null; then
        mkdir -p "$(dirname "$tgt")" && cp -f "$f" "$tgt" && synced=$((synced+1))
        git -C "$wt" ls-files --error-unmatch "$rel" >/dev/null 2>&1 \
            && git -C "$wt" update-index --skip-worktree "$rel" 2>/dev/null || true
    fi
done < <(git -C "$repo" ls-files .claude/hooks .claude/scripts '.agents/skills/*/lessons.md' docs/agent/domain-routing.generated.json)
[[ "$synced" -gt 0 ]] && echo "✓ harness parity: $synced tracked harness file(s) synced from main tree (skip-worktree set — they land from master, not this branch)"

# Share configured heavy build deps from the main checkout so the coder
# worktree builds without a fresh npm ci / cargo rebuild. Guarded + idempotent (see helper).
link_shared_deps "$repo" "$wt"

echo ""
echo "✓ Worktree ready: $wt   (branch feat/${task} from ${base})"
echo "  Next:  cd \"$wt\""
echo "  Commit with explicit pathspec:  git commit -m \"...\" -- <paths>"
echo "  When done:  git -C \"$repo\" worktree remove \"$wt\""
