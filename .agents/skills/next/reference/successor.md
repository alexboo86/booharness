# One successor path

Persist a fresh memory handoff with its open tasks (or `--no-open-work`) and
this standalone body marker:

```text
<!-- track: <slug> | status: active | next: <step> -->
```

Use a 1–64 character slug containing letters, digits, dot, underscore or
hyphen. Verify the returned handoff ID by reading its durable body before
any dispatch. In Claude, wait for running orch seats to finish (their digests
are the delivery). In Codex, seats may instead be inherited: explicitly pass
each inherited seat and pending orch turn ID in the handoff and prompt;
never cancel inherited seats. Start no more work or seats.

The successor prompt stands alone: the verified handoff ID to read with
`memoryctl get <id>`, repository and working directory, open task IDs, operator
decision IDs, inherited seat/pending orch turn IDs, and the first concrete
work step. In Claude only, obtain this session's id with `get_session self`
and include the Claude archive step below (except for handover in place).
In Codex use the predecessor's actual thread ID only if available, never
`get_session` or a Claude archive instruction. An orch lead's prompt holds the
board line as its first numbered step, or its second after the memory read of a
handover in place (orch-team, decisions #10530, #17572 and #17608):
in Claude desktop, "Do not open the web board: the orch pane is the operator's
view and he opens it with /orch-board." Codex leads keep opening
http://127.0.0.1:7760/ in the app's browser. A successor executes
the prompt's numbered steps literally, and a rule left only in the skill's
prose was skipped (operator, 2026-09-30).

After the board check, the prompt orders the successor to **join the lead chat under
the track's handle**, using the `chat_join` line SessionStart prints with the
successor's own session id, not the predecessor's. Name the track handle in
the prompt. This supersedes the predecessor's binding and inherits the
handle's receipts; a superseded predecessor cannot reclaim that handle until
the operator releases it on the board.
Follow [orch-team](../../orch-team/SKILL.md)'s lead-chat rules: coordinate there,
address only who must act, `wake: true` only for "act now", no acknowledgement
posts and no narration of lead traffic to the operator; bodies are at most
600 characters.

**In Claude, the successor prompt says:** mods load from
`CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` (decision #17570).
Never link a mod into the per-session `dev-mods` folder: it loads twice.

**In Claude, the prompt orders `EnterWorktree` only for editing in another worktree**
(task 2126): after that tool the desktop app refuses the session's git outside
the entered worktree, the landing on `master` included, until
`ExitWorktree {action: "keep"}`. A prompt that orders it also orders that exit
before landing. A successor that takes the predecessor's branch into its own
session branch needs neither: it stays in the worktree the app started it in
and lands with `git -C <main checkout> merge --ff-only <sha>` and
`git -C <main checkout> push origin master`
([land-worktree](../../land-worktree/SKILL.md)). Name the main checkout, the
predecessor's worktree and its branch in the prompt.

**In Claude, the successor archives its predecessor** (operator, 2026-09-28): after it has
read the handoff, it calls `archive_session` on the predecessor id, but only
when that session is idle (`get_session`: not running) and owns no working
seat the handoff did not pass on. Archiving removes the session's worktree, so
it first saves any uncommitted diff there (`git -C <worktree> diff --binary
HEAD`, staged included) to `output/archived-worktree-patches-<date>/` and names
the file in its first report. Archive, never delete: `unarchive_session`
restores it. Stale leads left open were addressed by mistake and resumed with
old context.

## Claude desktop app, in place

The first path is the handover mod (operator decisions #17572 and #17492).
The desktop session, folder, branch, rights, model and effort stay; the hook
session id changes. With the handoff durable and verified, these are the last
actions of the turn, in this order:

1. Do step 5.1 of `/next`: stop every background shell and delete every cron
   job this session started.
2. Give the operator the `/next` report, naming the handoff and the planned
   handover mod call.
3. Call `mcp__handover__run {text: <successor prompt>, clear: true}` and end the
   turn with no more text. The mod runs `/clear` after the turn and submits
   the prompt as the fresh session's first turn, shown as
   "The handover plugin sent a message".

The prompt says this is the SAME desktop session after a handover in place,
names the verified handoff id and decision #17492, and orders the successor
to read both in memory (`get <id>`, follow latest) before continuing, only when
they agree with the prompt. Decision #17492 gives this mod-submitted prompt
the operator's authority under those conditions; a prompt naming neither
gives none. It grants no new permission to push, deploy, change production
or edit the contract.

For an orch lead, numbered step 1 reads the handoff and the decisions and
stops on a disagreement; step 2 is the board check above; step 3 is
`chat_join` under the track handle with the successor's own startup session
id; then the first concrete work step. The read comes first, so that a
successor takes no handle before the authority check.
Include the mod-loading rule above. Order the first reply to open with the
handover line (handoff id, commit, open tasks), because the clear removes the
report from the screen. No predecessor archive step: this session is its own
successor.

If `mcp__handover__run` is absent, take the relay route below. Never claim a
handover succeeded when the tool refused it; report its exact failure.

## Claude desktop app, in place through the relay

Fallback when the handover tool is absent, for an attended lead
(`echo $CLAUDE_CODE_SESSION_ATTENDED`
prints `1`) while the [relay session](relay.md) runs (operator decision
#15290; probes #15280 and #15284). The lead clears its own session and
continues in it. The desktop session id, the folder, the branch, the rights,
the model and the effort stay, so there is no click and no rights card; the
hook session id changes. An unattended run takes the routine path:
`clear_session` and `send_message` refuse it.

Without the handover mod, a cleared session has no process until a message
arrives. Nothing inside it starts its next turn: no hook, no cron job, no chat
wake. A message that another attended session sends with `send_message`
starts the process and the first turn; the relay is that session.

The handoff is durable and verified first. Then these are the last actions of
the turn, in this order:

1. Find the relay as [relay.md](relay.md) says, and read your own desktop id
   with `get_session self`. No relay: take the next path below.
2. Do step 5.1 of `/next` now: stop every background shell and delete every
   cron job. The clear waits for an idle session (tool text), and a late
   notification would reach a session that holds no context (not probed).
3. Send the relay ONE message with `send_message`. Its first line is
   `RELAY to=<your desktop session id> delay=150`; the rest is the successor
   prompt. `delivered` is a yes: the relay's turn started on it (observed).
   `queued` is a yes too: it waits behind the relay's current turn (tool
   text, not probed). A refusal: do not clear; take the next path below.
4. Give the operator the `/next` report. Keep it short: the turn must end
   before the delay does.
5. Call `clear_session` with `"self"` and end the turn with no more text. The
   clear happens when the turn ends.

The successor prompt for this path says in its first lines that this is the
SAME desktop session after a handover in place, and that the lead wrote the
handoff and cleared the session itself. Its numbered step 1 orders: read the
handoff (`get <id>`, follow latest) and decision #15290 in memory, and
continue only when both agree with this text. For an orch lead, step 2 is the
board check above and step 3 is `chat_join` under the track handle. The next steps name each track
decision it relies on, the track handle for `chat_join` (the line SessionStart
prints holds the new hook session id) and the first concrete step.
It orders the first reply to the operator to open
with the handover line (handoff id, commit, open tasks): the clear takes your
report off the screen. It needs no working directory, no predecessor id and
no archive step, because the session is its own successor.

The authority check is in the prompt and not only here, because the cleared lead sees the
relay's text as a message from another session, not as the operator's typing.
Decision #15290 makes that text his word only when it names the handoff and
that decision, and when the successor has read both in memory and they agree
with the text. A prompt that names neither gives the successor no authority
to continue.

When it does not go as planned:

- The relay's text arrives and you still hold the old conversation: the clear
  did not happen. By the tool text a message that waits to run next, or one
  the operator sends first, drops the queued clear (not probed). Send the
  request again and call `clear_session` again.
- The operator types into the session before the relay's text: his message
  starts the session with no context (probe #15275). Answer him. The relay's
  text arrives as the next message: then do its start steps, and keep his
  request, which outranks the handoff's next step.
- No turn starts and the relay is paused: it asks the operator for a word
  with a push notification and then sends the text.
- No turn starts and the relay is lost: nobody tells the operator. Step 1
  checks the relay just before the clear, so only a relay lost inside the
  delay does this. Your report names the handoff number; he types it into the
  session when the track stays silent.

Measured 2026-10-08 (probe #15284): the request went out with delay 150, the
clear followed about 40 seconds later, and the new process started 13 seconds
after the delay ended, with the relay's text as its first user turn. Rights,
model, effort, folder, branch and tools were unchanged. A lead-chat post sent
to the handle during the gap was read after the new `chat_join`.

## Claude desktop app, operator present

When `mcp__handover__run` is absent and there is no relay, or when the relay
request is refused. When the
`mcp__ccd_session__spawn_task` tool is available (load it through
ToolSearch if it is deferred), create the successor as a chip: call
`spawn_task` with a title naming the track and next step, a tldr saying why,
and the successor prompt. The chip is the successor request; one click by the
operator starts it. Report the chip's `task_id`, never a created session.

## Claude desktop app, operator away

Only when a recorded operator decision authorizes the track to continue
without them (name its memory ID in the prompt) and the scheduled-tasks tools
are available (load `create_scheduled_task` and `run_scheduled_task` through
ToolSearch if they are deferred), start the successor without a click instead
of the chip. A chip next to a running successor would start a second one on
the same handoff with one click; create the chip only if the run is refused.

1. `create_scheduled_task` with a kebab-case `taskId` naming the track and
   date, no `cronExpression` and no `fireAt` (manual only), and the successor
   prompt. A scheduled run is told it is unattended and to take "write"
   actions only when its task file asks for them, so the prompt names the
   authorized writes explicitly (commits under the named decision, orch
   seats, memory writes) and the excluded ones (push, deploy, production).
2. `run_scheduled_task` with that `taskId`. It returns the new session id.
3. Report that session id and the `taskId`.

**An unattended run sends and receives no desktop cross-session message**
(task 2136, reference 14594). `send_message` to it answers "Message not delivered: session
<id> is unattended (a scheduled-task run or dispatched session); messages
can't be delivered there.", and the tool is unavailable inside such a run. The
successor therefore cannot use desktop messaging to report its id to other
leads, send or answer a start line for the shared account, or receive a finding
from another track; it still reads memory, runs orch seats, edits and records.
A track whose next steps need desktop lead-to-lead messages (a signed-in
capture, a contract with another track) takes the chip instead, or its prompt gives the run only the
message-free part. Observed 2026-10-06: the run local_fed53360 stayed running
from 01:14Z to 06:25Z with no seat, no edit and no handoff.

This desktop-message limit is distinct from orch chat: a joined successor can
post and explicitly read there. Do not promise idle chat wake or automatic
injection for an unattended run; those are not established by probe #14696.

Measured 2026-09-23 (task 1437, probe run `orch-successor-probe`): the run is
a new top-level Claude Code session in the main checkout on `master` (not the
lead's worktree), at medium effort, with Bash and `memoryctl` working and no
permission prompt. Leave the task in place while the successor works:
`delete_scheduled_task` archives the sessions the task started, the
successor included. A manual-only task has no schedule, so it is left for the
operator to delete later.

## Codex desktop app, new chat

Operator decision #15403 adds this route; it does not invoke `/next` merely
because this skill is being edited. The tools require an **explicit user
request for a new task**: user-invoked `/next` can request this described
successor, but a context-limit hook alone cannot. Without that request, keep
the handoff and give continuation text; do not create a chat.

1. Persist and read back the durable handoff first. Prepare a self-contained
   prompt naming the repository, working directory, handoff/task/decision IDs
   (including #15403), track handle, inherited seats and pending orch turn IDs.
   Its numbered start steps are: open the orch board; `chat_join` under the
   successor's **own** session ID using its startup line; read the handoff and
   decisions; then perform the named first work step and resume inherited
   waits with `node ops/orchestrator/src/main.ts wait <turn>` as needed.
2. Call `mcp__codex_app__list_projects` first among Codex app tools. Verify the
   returned project's repository/root matches the repository in the handoff;
   a matching display title alone is not evidence. Use only its returned ID.
   If the match is absent, ambiguous or unverifiable, stop and ask the operator
   to select/confirm it; do not guess a project or install tools.
3. Stop the predecessor's background waiters and scheduled wakes (step 5.1),
   without cancelling the inherited seats or their turns. Then dispatch:

   ```text
   mcp__codex_app__create_thread({title, prompt, target: {type: 'project', projectId: <returned id>, environment: {type: 'local'}}})
   ```

   Omit model and thinking options unless the user specified them. Request a
   worktree only if explicitly requested, using the exposed tool schema; do
   not carry Claude `EnterWorktree`/`ExitWorktree` instructions into this route.
   A new chat has fresh history; `fork_thread` is NOT a context reset.
4. Creation is asynchronous. Require the returned `threadId`, not
   `clientThreadId`. Call `mcp__codex_app__wait_threads` for that actual ID
   using the exposed schema, with a finite timeout (at most 60 seconds per
   call, at most two calls). Retain its evidence of a started/running or
   completed successor before saying **started**. An acknowledgement, timeout
   or client ID alone proves no start. Report created-but-unconfirmed when
   creation returned a threadId but the bounded wait did not confirm startup;
   do not blindly dispatch another successor after an uncertain result.
5. On successful creation with a returned threadId, emit the created-thread
   directive: `::created-thread{threadId="<threadId>"}` (even if startup is
   unconfirmed). Report the handoff, threadId and bounded wait result,
   distinguishing creation from startup.
   If a tool is absent or fails, preserve the handoff and continuation prompt,
   report the exact failure and any actual threadId, and invent no successor.
6. No `clear_session`, relay, archive or worktree removal is a creation side
   effect. Codex thread archive is a separate later action using the exposed
   Codex archive tool, only after evidence that the successor read the handoff
   and the predecessor is idle, with no active shared work lost. Verify that
   inherited seats/turns and any uncommitted work remain reachable; if read,
   idle or preservation evidence is unavailable, leave the predecessor open.
   Never substitute Claude `archive_session` or assume its worktree semantics.

## Anywhere else

Outside the Claude and Codex desktop apps, in a child worker, or when the
app's required tools/authorization are unavailable, create no supposed
successor: give the operator the verified handoff ID and self-contained
continuation prompt to start in a top-level lead. Preserve any handoff file
when durability could not be verified, and label it not durable.
