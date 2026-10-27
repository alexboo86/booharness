---
name: premortem
description: Assume a hard-to-undo decision already failed and find out why, before it is taken. Use before a deploy, a migration, a deletion, a purchase, a contract, or any step that cannot be walked back.
---

# Premortem

Stand after the failure, not before it. A risk list written from before it reads as optimism.

- Say what "it failed" means in the operator's own terms, and the moment after which it cannot be undone.
- Write the failure backwards: the post-incident sentence first, then the chain that produced it.
- Rank causes by what is cheap to falsify NOW, and falsify the top one before the decision, not after.
- A cause needs a mechanism: "breaks on X" is a cause, "could be abused" is a note.
- The author of a decision cannot premortem it - hand it to a fresh reader (an independent reviewer commissioned by the lead, or a scout). Give them the decision, constraints and failure boundary, not the author's conclusion.

Report ONE verdict - go, go with a named guard, or stop - and the evidence that would change it.

Adapted in part from addyosmani/agent-skills (MIT), read 2026-09-23.
