---
name: verify-and-stop
description: Prove existing work meets acceptance conditions without expanding scope. Use for validation-only tasks, completion checks, focused gate runs, and last-mile proof.
---

# Verify and stop

Translate acceptance conditions into smallest sufficient proof set.

- Reuse still-current results with matching repository state.
- Run focused checks before wider gates.
- Distinguish pass, fail, unavailable, and blocked exactly.
- Classify each finding against the contract and evidence; an unverified claim is a note, not a blocker.
- Do not edit product code unless verification request includes fixes.
- Do not add polish, cleanup, or unrelated checks after criteria pass.

Stop immediately when acceptance proof is complete. Report commands, results, and unresolved risk only.

Adapted in part from addyosmani/agent-skills (MIT), read 2026-09-23.
