#!/usr/bin/env bash
# ============================================================================
# provision-worktree.sh — SessionStart hook
# ----------------------------------------------------------------------------
# WHY: a worktree can be created two ways, and the app-native one
# (.claude/worktrees/<name>) bypasses `start-worktree.sh` entirely. Whatever a
# worktree needs that is NOT tracked by git therefore has to be provisioned
# here, creation-path-agnostic, at session start. Idempotent, fail-open (never
# blocks a session), quiet unless it actually does work.
#
# CODE INTELLIGENCE IS ONE OF THOSE THINGS AGAIN. Until 2026-08-13 the first and
# largest block of this file copied an index from the main checkout, because an
# un-provisioned worktree silently answered from the MAIN checkout's index, on
# the wrong branch. Between 2026-08-13 and 2026-09-19 that block was gone:
# `probe` and `ast-grep` read the tree they are pointed at and keep nothing.
# `codegraph` replaced probe on 2026-09-19 and it DOES keep an index, in
# `.codegraph/` beside the checkout - so the wrong-branch answer is possible
# again and is prevented below, by building this worktree's own index.
# ============================================================================
set -uo pipefail

# cwd is the session working dir (SessionStart runs there). Resolve the worktree top.
top="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0   # not a git repo → nothing to do
common="$(git rev-parse --git-common-dir 2>/dev/null)" || exit 0
gitdir="$(git rev-parse --git-dir 2>/dev/null)" || exit 0

# A LINKED worktree has git-dir != common-dir (git-dir under <main>/.git/worktrees/<name>).
# The main checkout has git-dir == common-dir (== "<main>/.git"). Only provision linked ones.
if [ "$(cd "$gitdir" && pwd)" = "$(cd "$common" && pwd)" ]; then
    exit 0   # main checkout — nothing here provisions it
fi

# Main checkout path = first entry of `git worktree list`.
main="$(git worktree list 2>/dev/null | head -1 | awk '{print $1}')"
[ -n "$main" ] || exit 0

# Tracked harness files belong to this worktree's commit. Copying main's hooks,
# scripts or routing here left tracked modifications on older bases; skip-worktree
# hid them from status but seat_land still included the copied bytes. Keep only
# per-checkout ignored provisioning below. Seats use their committed harness and
# the machine-installed memoryctl executable on PATH.

# --- project-scope skills for THIS worktree ---------------------------------------------------
# Claude Code resolves `<cwd>/.claude/skills` beside the working tree, and since 30ac68b7b that is
# where the claude family's skills live: a shared home let the OTHER checkout's session write
# through the link into this canon. The installer refuses to write the HOME scope from a worktree
# and always will - those links are machine-wide and would outlive the directory - but the PROJECT
# scope is local to this worktree, gitignored, and dies with it.
#
# Without this block a lead in a worktree has NO project skills and reads whatever stale copy the
# machine still carries. Measured 2026-08-18: a session here was handed a skill carrying the
# PREVIOUS generation, five Windows paths and the launch rule the fix had just removed - minutes
# after the canon was corrected and reinstalled. Almost every session is a worktree session.
#
# Fail-open and quiet like everything else here.
# Legacy bases tracked .claude/skills. The installer retires/relinks entries there;
# preserve that committed tree rather than treating it as an ignored link cache.
if [ -z "$(git -C "$top" ls-files -- .claude/skills 2>/dev/null)" ] \
    && [ -f "$main/ops/bootstrap/install-harness.mjs" ] && command -v node >/dev/null 2>&1; then
    # Run it EVERY session, not only on an empty directory. `installSkills` skips
    # what is already linked, so this is idempotent and cheap - and the empty
    # test missed the case that actually bites: a PARTIAL directory. One skill
    # left behind by a failed run, or one placed by hand, made the whole worktree
    # look provisioned while the other sixty-nine were absent, and the lead went
    # on reading the machine's copies. Print only when something changed.
    before=$(ls -A "$top/.claude/skills" 2>/dev/null | wc -l | tr -d ' ')
    if node "$main/ops/bootstrap/install-harness.mjs" --only skills --repo "$top" >/dev/null 2>&1; then
        after=$(ls -A "$top/.claude/skills" 2>/dev/null | wc -l | tr -d ' ')
        [ "$after" != "$before" ] && echo "[provision-worktree] project skills linked for this worktree ($before -> $after)"
    else
        echo "[provision-worktree] project skills NOT linked - a lead session here reads the machine's stale copies; run: node ops/bootstrap/install-harness.mjs --only skills --repo \"$top\"" >&2
    fi
fi

# --- codegraph index for THIS worktree ---------------------------------------------------------
# Without it `codegraph` answers from `.codegraph/` of whatever checkout it finds,
# which is the main one, on another branch - the exact failure the 2026-08-13
# removal note above describes. The index is per-checkout state, never committed
# (codegraph writes its own .codegraph/.gitignore), so it cannot be synced from
# main like a tracked file: it has to be built here.
#
# Background and fail-open: a first index of this tree measured 7.5 s of parsing
# on 2026-09-19, but a session must not wait on it, and a missing index is a
# slower answer rather than a wrong one - the tools that do not need it (rg,
# ast-grep) are unaffected.
if command -v codegraph >/dev/null 2>&1 && [ ! -d "$top/.codegraph" ]; then
    ( cd "$top" && codegraph init --yes . >/dev/null 2>&1 ) &
    echo "[provision-worktree] codegraph index building in the background for this worktree"
fi

# --- rtk project filters for THIS worktree -----------------------------------------------------
# rtk pins trust per file PATH + sha256, so `.rtk/filters.toml` in a worktree is untrusted even when
# it is byte-identical to the main checkout's and silently does nothing. Measured 2026-09-22: every
# Paseo worktree of the native-parity track printed "2 untrusted custom filter(s) not applied".
# Only a byte-identical copy is trusted here: the installer already trusted and verified the main
# checkout's file (installRtkFilters); a branch that changed its filters needs the installer's
# verify pass, not a blind trust.
if command -v rtk >/dev/null 2>&1 && [ -f "$top/.rtk/filters.toml" ] \
    && cmp -s "$top/.rtk/filters.toml" "$main/.rtk/filters.toml" \
    && rtk trust --list 2>/dev/null | grep -qF "$main/.rtk/filters.toml" \
    && ! rtk trust --list 2>/dev/null | grep -qF "$top/.rtk/filters.toml"; then
    ( cd "$top" && rtk trust -y >/dev/null 2>&1 ) \
        && echo "[provision-worktree] rtk project filters trusted for this worktree"
fi

exit 0
