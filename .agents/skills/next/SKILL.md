---
name: next
description: Checkpoint and hand over to a top-level lead with fresh context. Claude desktop uses the handover mod first, then clear-and-relay if the tool is absent, a spawn_task chip, or an authorized scheduled run. Codex desktop creates a new chat only on an explicit user request for that successor (decision 15403). Use when the operator types /next, asks to continue in a fresh session, or the lead-context hook reaches the handover limit (decision 11903); a hook alone does not authorize Codex chat creation.
lead_only: true
argument-hint: "What the next session should focus on (optional)"
---

# /next — close this session, open the next

Five steps in one turn: commit, handoff, successor, go quiet, report. Run them in order. A
gate that fails STOPS the sequence — it is never worked around, and a step that
was skipped is named in the report rather than implied.

If the operator passed an argument, it is what the next session should focus on:
it steers the handoff title, the successor's next step, and nothing else.

**Codex desktop authorization (decision #15403):** user-invoked `/next` can
request the new task described by the successor prompt. A context-limit hook
alone cannot authorize `create_thread`; checkpoint and provide continuation
text instead. Editing this skill is NOT permission to launch a successor.

## Standing authorization, and exactly what it covers

The operator authorized `/next` to commit WITHOUT a confirmation round
(2026-08-21, the session that built this skill). This is a NAMED exception to
PRIME 7 and to «никаких коммитов без разрешения», and it covers one thing: the
round trip asking "may I commit?". Everything else those rules say still binds:

- **explicit pathspec always.** `git add -A`, `git add .`, `git add -u`, a bare
  `git commit` and `--amend` remain forbidden here as everywhere else;
- **`npm run check:commit -- <paths>` runs first and its failure is terminal;**
- **`git push` is not part of `/next`.** A push publishes refs, may carry another
  session's unpublished commits, and keeps its own approval plus
  `npm run check:push` / `PUSH_ACK=<sha> git push`;
- **landing a worktree is not part of `/next`** — that is `land-worktree`.

A later reader who reads the auto-commit as a defect should read this section
first: it is a recorded decision, not drift.

## 0. Snapshot

```bash
git branch --show-current && git rev-parse --short HEAD && git status --porcelain && git diff --stat
```

Then subtract what is not yours to commit:

```bash
git ls-files -v | rtk grep '^S'
```

Provisioning no longer syncs harness files or sets `skip-worktree` (task 1577);
a `^S` path is a leftover from an older provisioner and is NEVER in the
pathspec. Any dirty path whose provenance you cannot explain is also excluded,
and the exclusion is stated in the report — never cleaned, never committed blind.

## 1. Verify, unless this session already did

If no verification ran since the last edit, run the adopted project's documented checks for the changed components. Select the runner and manifests from that repository, not the harness. Include its lint, boundary and generated-file checks when applicable. If this exact tree was already verified, state the command and result without rerunning it.

A commit that ships a failing typecheck is the one thing the missing confirmation
round used to catch. This step replaces it.

## 2. Commit

If there is dirty work that is not ready to commit — the operator decided the
batch waits for review, or `check:commit` cannot pass until an external step
(for example a service deploy) — skip this step. Name the reason and the
expected next step in the report. Do not bypass the gate and do not commit
against that decision.

1. **Message.** Conventional commit, subject in the repository's existing style.
   The type states what the change IS.
2. **Knowledge (work contract 8).** If a domain-owned source file changed and
   the work reproduced a reusable contrast, capture the lesson:

   ```sh
   node scripts/memory/capture-lesson.mjs <domain> "<title>" \
     --anchor <file:symbol> --trigger "<when>" --rule "<rule>" --why "<root cause>" --evidence "<commit/test>"
   ```

3. **Stage the pathspec first** (contract rule 11) — and it is not ceremony:

   ```sh
   git add -- <paths>
   ```

   `check-commit-safety` compares an UNSCOPED `git status` against a scoped one,
   and git collapses an untracked directory to `dir/` in the unscoped view while
   the scoped view names `dir/file`. A brand-new file in a brand-new directory
   therefore reads as "the tree changed while this check ran" on a tree that
   never moved — reproduced twice on 2026-08-21 with
   `.agents/skills/next/SKILL.md`, and gone the moment the path was staged.
   Staging first is the order the sensor was written for; do not re-run the gate
   hoping the message changes.

4. **Gate.**

   ```sh
   npm run check:commit -- <paths> [--message "<msg>"]
   ```

   Non-zero exit stops `/next` here. Report the failing sensor's own words and
   what it asks for. Do not re-run it with different arguments to make it pass.
5. **Commit.**

   ```sh
   git commit -m "<msg>" -- <paths>
   ```

   Remember `-- <paths>` takes content from the WORKING TREE, not the index: a
   hunk-level stage is annulled by it. In a shared tree read `git diff <file>`
   first — another session's hunks go through `git apply --cached` and a commit
   from the index, not through this path.
6. Record the new SHA: `git rev-parse --short HEAD`.

## 3. Handoff

The [`handoff`](../handoff/SKILL.md) skill cannot be reached from inside `/next`:
it carries `disable-model-invocation`, and the Skill tool refuses it with
"reserved for explicit user invocation" — measured 2026-08-21, on the request
that produced this section. `/next` therefore writes the handoff itself, to the
same contract.

Before writing the handoff, answer for the lessons this session was delivered. The session id is
the SessionStart `session_id` line, not a `get_session` desktop id. `node
ops/orchestrator/src/main.ts lead-lessons --session <id>` lists them; record one
`--applied <lessonId>=true|false --why "<one sentence>"` for every row delivered `full` (true when
the work followed it, false when it did not bear on the work — task 2684). An `indexed` row is not
answerable — skip it; it is not refused work. The CLI reads the store file directly, so the step
is skipped only when there are no rows or the store file cannot be read.

1. **Settle this session's tasks before creating any.** The tasks it was
   handed and the ones it touched: `memoryctl task show --id <id>` each.
   - Finished — it goes into the handoff as `--closes <id>`; the handoff is the
     evidence. The commit you just made is usually what finished it.
   - Withdrawn by a decision — `memoryctl append --kind decision ... --closes <id>`
     closes it as `cancelled`.
   - Still open — it stays a tail (`--task <id>`). Name how many handoffs
     already carried it (`handoffs` in `task show`, `×N` in `hot`) in the report;
     carrying is never refused, but the number is the operator's to see.

   Only THEN create, and only for a reproduced defect or work the operator
   agreed to:

   ```sh
   memoryctl task create --title "<tail>" --priority P0|P1 --next "<step>"
   ```

   A follow-up wish, "watch it for 24h", "publish commit X" or one row per
   review finding is not a task — say it in the handoff body. Measured
   2026-09-14: tails created "FIRST, without asking" halved the closure rate
   from the day this command landed, and 56 of 61 P0 checked that day were
   already done, obsolete or duplicated (memory #8116). Only P0 and P1 exist;
   P0 is data loss, production down or security.

2. **Write the document to the scratchpad, never into the workspace.** Summarise
   the conversation so a fresh agent can continue: what landed, what was decided
   and why, what is open. Reference plans, commits and diffs by path or SHA
   rather than restating them, include a "suggested skills" section, and redact
   anything sensitive.

3. **Persist it.**

   ```sh
   memoryctl handoff --title "<outcome and remaining work>" --body-file "<file>" --task <id>
   # ...or, when nothing is open:
   memoryctl handoff --title "<...>" --body-file "<file>" --no-open-work
   ```

   `--task` is repeatable. The service refuses a handoff declaring neither, and
   that refusal is the point: prose tails get forgotten, tasks do not. `handoff`
   takes NO `--links` — a track goes in as a body marker on its own line:
   `<!-- track: <slug> | status: active|paused|blocked|done | next: <step> -->`.

4. **Verify, and report both identifiers.**

   ```sh
   memoryctl search "<distinct title terms>" --kind handoff --limit 3
   ```

   The created tasks and the handoff id/uuid go into the report — a task the
   operator never saw is a task he cannot overrule. Never edit `MEMORY.md` or its
   registry files by hand. If `memoryctl` is unreachable, keep the file, report
   the exact error, and say plainly that the handoff is not durable yet.

## 4. Successor

Follow [the successor protocol](reference/successor.md). Never start a
successor as a child agent or a seat: it must be a top-level lead.

In Codex desktop, use [the new-chat branch](reference/successor.md#codex-desktop-app-new-chat)
only on an explicit user request. It does not clear this session or use a relay.

Its paths in the Claude desktop app, in this order (operator decisions #17572,
#17492 and #15290): in place through the handover mod; if
`mcp__handover__run` is absent, in place through [the relay](reference/relay.md);
then the chip; then the routine. For the mod route, write and verify the handoff,
do step 5.1, give the report, call
`mcp__handover__run {text: <successor prompt>, clear: true}`, and end the turn
with no more text. The mod runs `/clear` after the turn and submits the prompt
as the first turn. For the relay route, step 5.1 comes before the relay request,
the report comes before `clear_session`, and nothing follows the clear.
Follow the order the protocol gives.
A successor started through the routine gets bypass permissions, model `claude-opus-5-5` and effort `xhigh` (operator #15196): set them on the new session and read them back with `get_session`.

## 5. Go quiet

After the handover this session owns nothing, so nothing may wake it. Operator,
2026-09-25: a lead that had handed over kept waking on its background waits and
told him "I already handed over" again and again.

1. **Before the report**, stop everything this session started that can call it
   back: every background shell still running (orch `wait` commands, loops,
   monitors) and its scheduled wakes. In Claude, use `TaskStop` and
   `CronDelete` (a `/loop` on an interval included); in Codex, use the exposed
   cancellation tools for this session's waiters, not the inherited seats or
   their turns. If stopping a waiter would cancel a seat, do not dispatch until
   ownership can be transferred safely. A self-paced `/loop` cannot run in a lead session:
   `ScheduleWakeup` is on the deny list (decision 15075). An orch seat keeps working without its
   waiter: the handoff names each pending turn id, and the successor runs
   `node ops/orchestrator/src/main.ts wait <turn>` itself.
2. **After the report**, a wake-up (a task notification, a cross-session
   message) gets no message to the operator. If it carries something the
   successor lacks, forward it once through an available authorized channel
   (`SendMessage` in Claude; joined orch chat in Codex), without assuming
   desktop messaging exists; otherwise end the turn with no text. Never repeat the report or restate
   that the track was handed over.

In place through the mod, point 1 runs before the report and the handover tool
call; through the relay, it runs before the relay request. Point 2 does not
apply to either: the cleared session is the successor, and the message that
wakes it is its prompt.

## Report (in Russian, contract rule 10)

One compact block, no table:

```text
Коммит:  <sha> <subject>  · pathspec: <n> путей · исключено: <path — почему>
Гейты:   check:commit <exit> · typecheck <exit/ошибок> · <что не гонялось и почему>
Урок:    <lesson id> | нет: <причина>
Хендоф:  <id> / <uuid>
Задачи:  <id> P<n> — <заголовок>
Преемник: эта же сессия через handover mod — вызов с clear: true после отчёта | эта же сессия через реле <relay session_id>, задержка <n> с | чип <task_id> | сессия <session_id> из scheduled task <taskId> | Codex threadId <id> — создан / запуск подтверждён wait_threads | продолжение для новой сессии | НЕ создан: <причина>
```

## Failure modes

- `check:commit` failed → stop, report its words, change nothing.
- Work exists but is not ready to commit (operator: wait for review; or the gate
  cannot pass until an external step) → skip the commit, name the reason and the
  expected step; never bypass `check:commit`.
- Nothing to commit → skip step 2, say so, and still do the handoff and the
  successor. An empty commit is never created to keep the shape of the sequence.
- A dirty path of unknown provenance → exclude it and name it. Never clean or
  commit another session's file.
- `memoryctl` unreachable → keep the handoff temp file, report the exact error,
  state that the handoff is NOT durable, and print the continuation prompt
  with the file's path. Create no chip, claim no successor and never clear
  the session: a successor needs a verified durable handoff.
- Codex tools absent, project unverified, or creation/wait fails → preserve the
  verified handoff and self-contained continuation text; report the exact
  failure and any returned threadId. Do not claim a fake or confirmed-started
  successor, retry an uncertain creation blindly, clear, or archive this session.
- In Claude, the handover tool is absent → use the relay route. No relay session,
  or the relay request is refused → do not clear. Take the
  chip, or the routine with the operator away, and name the refusal's words in
  the report.
- The lesson gate refuses → capture the lesson or supply a real reason. Retyping
  the commit type to dodge it is a defect, not a fix.
