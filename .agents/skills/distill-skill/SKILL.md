---
name: distill-skill
description: Use after a confirmed successful repeatable task to distill the workflow into a Claude Code native skill candidate and, with operator approval, an active git-synced skill.
lead_only: true
---

# Distill Skill

## When To Use

Use this only after a task is confirmed successful and likely to repeat.

Do not use for:
- trivial one-off fixes
- speculative ideas
- unresolved or unverified work
- broad preferences without exact steps
- temporary workarounds or fallback behavior

Claude Code skills are native `<dir>/SKILL.md` files with YAML frontmatter. The `description` is the trigger. Do not add embeddings, vector databases, GEPA, DSPy, ranking services, or extra machinery.

## Procedure

1. Confirm the source task is actually done.
   - Identify the concrete problem pattern.
   - Capture the proof that the solution worked.
   - Reject the distillation if the task was not verified.

2. Create a candidate file first:
   `.claude/skill-candidates/YYYY-MM-DD-<slug>.md`

3. Use this exact candidate shape:

```markdown
# <Human readable title>

problem_pattern:
<What recurring problem this solves. Be specific.>

trigger_conditions:
- <2-5 user phrasings or task shapes that should trigger this>
- <...>

successful_steps:
1. <Exact ordered step>
2. <Exact ordered step>
3. <Exact ordered step>

verification:
<Commands, logs, screenshots, tests, or operator confirmation that proved success.>

anti_patterns:
- <What not to do>
- <Known bad shortcut or false fix>

source_task_refs:
- <handoff, ticket, commit, PR, log path, or conversation reference>
```

4. Distill the candidate into a native skill draft.
   - Target path: `.agents/skills/<slug>/SKILL.md`
   - Keep the skill at or below 200 lines.
   - Include YAML frontmatter with only:
     - `name`
     - `description`
   - Make `description` specific enough to be the trigger.
   - Body must include:
     - when-to-use
     - exact steps
     - verification
     - failure modes
   - Drafting may be delegated to a cheap subagent, but the lead owns review.

5. Ask the operator before activation.
   - Never silently create an active skill under `.agents/skills/<slug>/SKILL.md`.
   - If approval is missing, leave only the candidate and/or proposed draft content.
   - After approval, create the active skill exactly at the target path.

6. Log the distillation.
   Append one line to `.claude/skill-distillation.log`:

```text
YYYY-MM-DDTHH:MM:SSZ	<slug>	<candidate-path>	<active-skill-path-or-draft-only>	<source-task-ref>
```

## Verification

Before calling the distillation complete:

1. Candidate exists in `.claude/skill-candidates/`.
2. Candidate contains all required fields.
3. Active skill was created only after explicit operator approval.
4. Active skill has valid `name` and `description` frontmatter.
5. Active skill is no more than 200 lines.
6. No embedding, vector DB, GEPA, DSPy, or auto-activation machinery was added.
7. Distillation log has one new line.

## Failure Modes

- If the task was not verified, do not distill it.
- If the trigger description is vague, rewrite it before activation.
- If the skill exceeds 200 lines, compress it to the essential workflow.
- If two existing skills cover the same trigger, update or merge instead of creating a duplicate.
- If operator approval is unclear, stop before writing to `.agents/skills/`.
