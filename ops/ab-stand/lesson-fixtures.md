# Lesson usefulness replay fixtures (task 1883, slice A)

Operator #13055 approves these local reproductions as stand scores, not a test
suite. No existing tests or stand cells are run by the validation command.

```sh
node ops/ab-stand/lesson-validate.mjs /tmp
node ops/ab-stand/lesson-probe.mjs 12737 /absolute/path/to/seat/result
```

Each retained `lesson-<id>` fixture pins its author's turn-1 base and original
prompt. The appended stand override forbids writing/running tests, commits and
memory writes; `owned` excludes historical test paths. The usage replay also
forbids live provider/token calls. Original prompts and review evidence came
from `output/lesson-ab-author-briefs-20260930.jsonl` and
`output/lesson-ab-candidates-20260930.jsonl` in the operator's main checkout;
they are not runtime dependencies.

The `probe` field selects a trusted runner from this stand, **not** code added to
the seat's result. A subprocess has a disposable HOME, a 50-second deadline and
injected local collaborators. It outputs separate `acceptance` and
`mistakeAbsent` booleans plus input/verdict observations. Hook events always
include `session_id`; without it the hook allows everything. Shell strings are
sent only to the hook; they are never executed and never create commits.
Usage uses a fake credential and injected request, context uses injected skill
routing, and Pi uses event handlers without invoking a registered network tool.

Scoring requires both booleans to be exactly true, no probe error, a changed
`mustChange`, and no changes outside `owned`. Missing/error/timeout probes score
zero, not an edit-only success. The result row preserves the probe observations.
Legacy TAP and edit-only scoring remain unchanged. Matrix tasks, budget identity,
pilots and arms are unchanged.

## Historical proof

The validation command makes a detached worktree under its supplied scratch
parent, links already-installed dependencies (no install/network), and removes
the worktree in `finally`. The surviving author refs contain only their base,
not the reviewed uncommitted output. Reconstructions in `lesson-validate.mjs`
restore only the mechanism quoted by each reviewer; they do **not** claim to
recover the complete original coder diff.

| Lesson | Reviewed mechanism reconstructed | Landed corrected commit |
| --- | --- | --- |
| 12805 | `test` guard without operand-count bound | `ef1a8b434` |
| 12713 | bare `&` omitted from operator splitting | `4ce85ad05` |
| 12737 | unbounded `limit - remaining` | `83c3da362` |
| 12562 | unconditional relative path even for missing local skill | `b2d8ee56f` |
| 12703 | first-prompt window closes at `turn_end` | `b8536622a` |

These five must produce mistake-present/score 0 on the reconstruction and
acceptance-met + mistake-absent/score 1 on the corrected commit. The usage
acceptance also exercises injected kick cadence and timeout retry; the Pi
acceptance checks skill routing, original-content preservation and once-only
prompt boundaries. The local missing-skill context uses an empty checkout root
to reproduce the reviewer's missing historical skill without a second worktree.

## Dropped candidate: 12845

Both reviewer-glm-0cc635 bypasses are reproduced: non-adjacent heredoc delimiter
with a compound command after the closer, and the wrong delimiter taken from a
here-string. The reconstruction of that decision path is built on the prior
parser at `ef1a8b434`; it is not a byte-exact recovered author tree.

The landed replacement `c13c63e6f` blocks both, but intentionally refuses
`npm run check:commit -- a && # c` followed by `git commit`. The original brief
requires allowing that shape. Operator decision **#12868** explicitly abandoned
the author's parser and accepted false denials with an exact-shape allowlist.
Thus the old acceptance contract cannot yield a clean score (0 on both trees).
The candidate remains visible in validation output as `retained:false`, but is
absent from `fixtures.json`. It is not a product defect or an A/B fixture.

The spare 12799 has no reviewer mistake in the supplied candidates data, so is
not substituted. Five new ids bring the corpus from 8 to 13. Per lesson #13063,
the lead must update the frozen fixture-count pin in
`scripts/test-ab-stand.mjs` (not in this kit); this coder seat may neither edit nor run that suite.
