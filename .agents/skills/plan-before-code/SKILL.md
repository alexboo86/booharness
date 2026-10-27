---
name: plan-before-code
description: Decide the shape and the size of a change before writing it. Use for any non-trivial edit, a new mechanism, a refactor, or work whose scope is not obvious from the request.
---

# Plan before code

Name the cause and the smallest change that removes it, before the first line.

- State what breaks today and what is true once it is fixed.
- Walk the ladder: needed at all, already here, standard library, platform, an installed dependency, one line, then the minimum that works.
- Name what the change touches and what must keep holding afterwards.
- Name the touched module ids with `node scripts/module-registry.mjs --out <file>` or `docs/contracts/module-index.md`. Read each contract's Public API and Invariants. State which invariant the change keeps or changes. A Public API change updates its contract in the same commit.
- Name the assumption whose falsification would change the plan.
- Ask the plan its blind spots: who may do this and what if they may not; empty, one and maximum; a dependency down; two actors at once; related data left consistent; invalid or duplicate input; whether it can be undone; the volume it must hold.
- Decide the size BEFORE writing: a larger design is the operator's money, so say its price out loud.
- Stop planning when the next step is obvious and its proof is named.

A lead's plan goes to a [plan critic](../plan-critic/SKILL.md) before the first coder only when a wrong plan costs more than one correction turn; the five cases are in [orch-team](../orch-team/SKILL.md), "The loop" (operator #15067). Every other plan has the reviewer of the diff as its check.

Report the plan and the check that decides it. Write no code the plan does not require.

Adapted in part from addyosmani/agent-skills (MIT), read 2026-09-23; the blind-spot list from Habr 1085648 (Mindbox), read 2026-10-01.
