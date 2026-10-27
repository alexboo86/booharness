## Coder-retained survival

`pick-stats` reports landed-line survival through `survivalShare` (`ops/orchestrator/src/retained.ts`): countable patch lines from `refs/orch/landed/<seat>` (else base..tip), multiset-intersected with landing additions, still present in the same HEAD path. Lines are trimmed, 4+ characters with a letter/digit. `git cat-file --batch` blobs use byte offsets; missing paths get one pathspec-free `git diff -M --name-status <landing> HEAD` remap, else 0. Landings under 7 days are `young`, unmeasured; family means require n >= 8. This CLI-only report keeps git off prompt paths.

verified: 2026-09-23
