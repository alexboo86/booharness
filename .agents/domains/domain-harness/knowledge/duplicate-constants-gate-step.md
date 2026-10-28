## The duplicate-constants step of the commit gate

`scripts/check-commit.mjs` (not in this kit) runs `scripts/check-duplicate-constants.mjs` (not in this kit) when a commit entry (from the commit tree, not the pathspec) is under src/ or web/, a root resolver config, the baseline `scripts/duplicate-constants-baseline.json` (not in this kit), or the gate and its imports (operator #20673, task 3227). The scan uses tracked files' working-tree text, not staged text; unstaged duplicates can refuse a commit. `GUARD_REPO` redirects the scan. The summary remedy includes `Import the constant, move it to a shared module`. There is no override flag. Syntax errors in tracked files warn rather than refuse.

Coverage: `scripts/test-check-commit.mjs` (not in this kit).

verified: 2026-10-14 (task 2479; reviewer-glm-fcd58a.1 read the gate step; the test run on the Mac)
