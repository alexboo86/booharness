## The duplicate-constants step of the commit gate

`scripts/check-commit.mjs` runs `scripts/check-duplicate-constants.mjs` unconditionally: duplicates relate files, and path triggers could miss baseline-only commits. The scan uses tracked files' working-tree text, not staged text; unstaged duplicates can refuse a commit. `GUARD_REPO` redirects the scan. The summary remedy includes `Import the constant, move it to a shared module`. There is no override flag. Syntax errors in tracked files warn rather than refuse.

Coverage: `scripts/test-check-commit.mjs`.

verified: 2026-10-14 (task 2479; reviewer-glm-fcd58a.1 read the gate step; the test run on the Mac)
