---
name: handoff
description: Compact the current conversation and persist a durable handoff through memoryctl.
lead_only: true
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work.

Include a "suggested skills" section in the document, which suggests skills that the agent should invoke.

Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

## Persist

1. Save the document to the OS temporary directory, not the workspace.
2. Persist that file through the standalone memory service:

   ```sh
   memoryctl handoff --title "<concise outcome and remaining work>" --body-file "<temp-file>" \
     --task <id>            # repeatable — the tails this session leaves open
   # ...or, when nothing is left open:
   memoryctl handoff --title "<...>" --body-file "<temp-file>" --no-open-work
   ```

   The service refuses a handoff that declares neither. Settle the session's
   tasks first: finished ones go in as `--closes <id>` (the handoff is the
   evidence), open ones stay `--task <id>`. Create a new task only for a
   reproduced defect or work the operator agreed to —
   `memoryctl task create --title "<tail>" --priority P0|P1 --next "<step>"` —
   and name it. A follow-up wish belongs in the body, not in a row (memory
   #8116: 56 of 61 P0 checked on 2026-09-14 were done, obsolete or duplicated).

3. Verify the new record:

   ```sh
   memoryctl search "<distinct title terms>" --kind handoff --limit 3
   ```

Completion requires a confirmed `memoryctl` handoff ID and UUID. Return both to the user and link the temp file as a secondary artifact.

Never edit `MEMORY.md` or its registry files directly. If `memoryctl` is unavailable or persistence fails, keep the temp file, report the exact error, and state that the handoff is not durable yet.
