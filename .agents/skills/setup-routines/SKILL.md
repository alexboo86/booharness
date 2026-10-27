---
name: setup-routines
description: Offer the harness's shipped routine definitions to the user and create the chosen scheduled tasks with the scheduler tool of this app. Use on install, or whenever the user asks for the recurring runs (weekly reviews, daily memory consolidation).
lead_only: true
---

# Set up routines

The harness ships routine definitions as data: one markdown file per routine under
`ops/routines/`, with front matter (id, title, cron, summary) and the prompt as the body.
A scheduled task is created only by the scheduler tool of THIS app; no script can create
one. This skill is the bridge between the shipped data and the app's scheduler.

1. In the project checkout run `node scripts/routines.mjs list`. It fails when a definition
   is invalid — report the fault and stop; never repair a definition on your own authority.
2. Show the user the whole list: for each routine its title, its cron, its summary and its
   id. Explain each cron in plain words ("every Monday at 09:00, local time").
3. Ask the user which routines to create. The user may choose none; an unanswered question
   is not consent.
4. For each id the user chose: read `ops/routines/<id>.md`; the body after the front matter
   is the prompt. Create the scheduled task with this app's own scheduler tool: task name =
   the id, schedule = the cron from the front matter (five fields, local time), prompt = the
   body. Do not rewrite the prompt, and do not invent a schedule the file does not carry.
5. Before creating, check the app's existing scheduled tasks. Skip an id that already exists
   and say so; a routine is never duplicated and never replaced. This skill creates a routine
   and does nothing else: it never edits, reschedules or deletes a routine — also one that it
   created in this run. A user who wants a change makes it in the scheduler of the app.

6. Permission mode: the app saves a new task in the creating session's mode only when that
   session runs in Auto or Bypass, and no tool can change it later. Run this skill from a
   Bypass session. When a create result does not say the task was saved in Bypass, tell the
   user that this task will stop at a permission prompt and that they must set it to Bypass
   once (Scheduled → the task → permission mode). On 2026-10-20 half the routines were
   found in manual mode and the operator fixed them by hand.

Report which routines were created, which were skipped as existing, and which the user
declined. Nothing else is written: no file, no memory entry, no orch seat.
