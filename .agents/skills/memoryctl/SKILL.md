---
name: memoryctl
description: Contract for the memoryctl memory store over BOTH routes — the CLI and the `memory` MCP tool — covering hot digest, lessons, search, append, handoff, tasks, and the flags each subcommand does NOT take. Load whenever you are about to use memory beyond `hot`/`lessons`, when a call was refused (HTTP 400 or a bare usage dump), or before writing handoffs/tasks/lessons by hand.
---

# memoryctl field guide

The kit uses one local memoryd writer at `http://127.0.0.1:7717`. Configure backup destinations explicitly; never start a second writer or improvise a substitute. See [docs/agent/memory.md](../../../docs/agent/memory.md).
Judgment (merge/supersede/reject) belongs to the **admit** skill — this file is
only the mechanics so you don't learn the contract by paying for refusals.

## Two routes, one store, the same gates

- **CLI `memoryctl`** — on PATH. Everything below is written in its terms.
- **MCP tool `memory`** — ONE tool, `{action, args}`:
  `hot` · `lessons {path}` · `search {query, kind?, limit?}` ·
  `get {id|uuid, follow?}` ·
  `append {kind, title, body, links?, overturns?}` ·
  `supersede {id, title, body, long?}` ·
  `handoff {title, body, tasks[]|no_open_work, closes?[]}` ·
  `task_create {title, priority, next?, domain?}` · `task_list {status?}` · `task_done {id, evidence}`.

Same service, same refusals, same tails gate — a `handoff` without declared
tails is a 400 on both. Use whichever your runtime actually has: if the tool is
in your list, prefer it (no shell, no quoting); otherwise the CLI. Do not reach
for the CLI to work around an MCP refusal — it is the same gate and will refuse
identically.

The PreToolUse hook that delivers a file's lessons on edit is installed on every
runtime (claude/glm via `~/.claude/settings.json`, grok via
`~/.grok/hooks/<prefix>.json`, codex and kimi in their `config.toml`). Under
Paseo (ACP) that hook's output is not guaranteed to reach grok or kimi (task
#1212, design in progress), so the seat asks `memoryctl lessons --path` itself
rather than waiting for delivery.

## The daily four (already in your bootstrap instructions)

```sh
memoryctl hot                          # optional on-demand digest; not injected at session start
memoryctl lessons --path <repo/file>   # BEFORE editing that file
memoryctl append --kind <kind> --title "<t>" --body-file <f>   # durable fact
memoryctl handoff ...                  # end of a work chunk — see the gate below
```

## The refusal playbook (the expensive part)

A refusal from memoryctl is a CONTRACT message, not a transient error. The
400 body names the exact missing piece — read it, supply it, retry once.
Never re-issue the same call unchanged, and never work around the gate
(e.g. rewording the same handoff into a second append): the gate exists
because prose tails get forgotten and tasks don't.

Measured 2026-07-31: an agent got `handoff refused: declare this session's
tails: --task <id> ... or --no-open-work`, then wrote the SAME handoff body
twice while fumbling. The refusal already contained the whole fix.

Since 2026-08-02 a lesson-links refusal names EVERY problem at once and ends
with `— required shape: {...}`. So one round trip is enough: fix all the named
fields together. Do not re-send to discover the next one — there is no next
one. (Before that change the check returned only the first problem, and the
transcripts hold three consecutive 400s on a single append.)

**A bare usage dump is also a refusal.** When memoryctl prints its whole usage
block instead of a 400 body, an OPTION does not exist on that subcommand — the
message is telling you the grammar, not complaining about a value. Read the
usage line for the subcommand you called and drop the flag it does not list.

## handoff — the tails gate

```sh
memoryctl handoff --title "<outcome + what remains>" --body-file <tmp-file> \
  --task <id> [--task <id2>]      # every open tail this session leaves
# or, when truly nothing is open:
memoryctl handoff --title "<...>" --body-file <tmp-file> --no-open-work
```

Work this session FINISHED is closed by the same write, not by a second
command afterwards:

```sh
memoryctl handoff --title "<...>" --body-file <tmp-file> \
  --closes <id> [--closes <id2>]   # finished — closed in this transaction
  --task <id>                      # or --no-open-work
```

The handoff is linked from every task it closes, so it is the evidence for
the closure. A task cannot be both `--task` and `--closes`. Measured
2026-08-01: fifty-two open tasks, ten of them long-finished work whose only
trace was a handoff saying so — closing was a separate command, and a
separate command at the end of a session is a command nobody runs.

`handoff` takes NO `--links`. Only `append` and `supersede` do. A track goes in
through the body marker instead — or through `append --kind handoff --links`,
which hits the same tails gate:

```sh
# in the body file, on its own line:
<!-- track: <slug> | status: active|paused|blocked|done | next: <step> -->
```

Measured 2026-08-02: `handoff --title .. --body .. --links '{"track":..}'` cost
two refusals in a row — the first read as if `--body` were wrong, and the
option that did not exist was `--links`.

Both `memoryctl handoff` and `memoryctl append --kind handoff` hit the same
gate: no tails declared → HTTP 400. Close what finished (`--closes`) and carry
what is still open (`--task`) before creating anything; a new task is for a
reproduced defect or work the operator agreed to:

```sh
memoryctl task create --title "<tail>" --priority P0|P1 --next "<concrete step>"
```

then the handoff names the task ids. One handoff per work chunk: if the first
append failed, fix the reason and retry THAT call — do not write a second,
slightly different handoff (dedup is content-hash based; near-duplicates
pollute search results).

Handoff claims carry `[observed]` only when reproduced, verified, or read from primary command output, file:line or live data; otherwise `[hypothesis]`, promoted only by a recorded check, never by restating it.

## tasks

```sh
memoryctl task list [--status <s>] [--priority <p>] [--track <slug>]
                    [--domain <id|none>] [--closed-since <ms>] [--compact]
                    # open tails (also visible in `hot`); --compact prints one
                    # line per task: #id status priority domain track title
memoryctl task create --title .. --priority .. --next .. [--domain <id|none>]
memoryctl task update --id <N> [--domain <id|none>]   # a routing id, or none to clear; filing is not progress
memoryctl task done --id <N> --evidence "<sha | memory#id | proof>"   # REQUIRED proof
memoryctl append --kind decision --title .. --body .. --closes <N>   # a decision withdraws it: cancelled
```

Closing by hand without `--evidence` is refused with the ready command
(operator 2026-09-14); a handoff's `--closes` and a decision's `--closes` are
their own evidence. `closes` on any other kind is refused. Nothing closes a task
by itself: a sha in the task's text records progress as often as completion
(0 of 15 live tasks, memory #8134).

## lessons

- Reading: `memoryctl lessons --path <repo-relative-file>` (there is NO
  `--domain` flag; the store resolves the domain from the path).
- Writing: NOT raw append — use
  `node scripts/memory/capture-lesson.mjs <domain> "<title>" --anchor <file:symbol> --trigger .. --rule .. --why .. --evidence ..`
  so the lesson passes the capture gates and lands with structured links as
  `status=active` at once: no quarantine, no promotion step (decision #12333).
- Lessons must be brief, precise and clear: suggested targets title ~40, rule ~110, why ~120, evidence ~70 are advice, not refusal thresholds. Code-point ceilings are title ≤120, rule ≤300, trigger/why/evidence ≤400.
  `--long "<reason>"` allows a field over its ceiling and stores the reason with the lesson; without it, the ceiling refuses. Supersede checks changed fields; retirement exempts only its title prefix, not body edits or duplicates. With no changed field, `--long` is ignored. A refusal names field, length/ceiling and the required `--long` reason.
- `RETIRED:` / `MERGED-INTO:` lessons are history, not rules.

## search before you write

`memoryctl search "<short topic and exact identifiers>" --limit 10`.
English is canonical for new working prose; operator replies remain Russian.
Existing entries keep their original wording. Preserve originals and literal evidence;
do not rewrite retrieved bodies on every read or prescribe bilingual queries as policy.
Search before every append: merge into the existing entry (supersede) instead
of creating entry N+1. After writing, smoke-test retrieval: search the way a
future agent would ask; the entry must surface in top-5.

A new rule that REPLACES an older one closes it in the same write, whatever the
older one's kind: `memoryctl append --kind decision ... --overturns <id>`. A
decision/feedback/reference/project write answers with `related` - the live rules
that look like it - so read that list before you move on: a decision that
contradicts a live pinned feedback without closing it leaves both alive, and hot
keeps serving the dead one (#1147 did, for two weeks).

## reading is three steps, and they are not interchangeable

`hot` says what matters NOW. `search` says WHERE something is written — it
answers a bare array of `{id, kind, title, snippet, date, age_days}`, never the
text, so a decision taken off a snippet is a decision taken off 24 tokens. `get`
reads that entry whole. Skipping the third step is the mistake that costs
re-work: the snippet looked like it said enough.

Choose the retrieval route before broadening the query:

- Use the stored topic wording and exact code/product identifiers. Keep the
  query short and separate from the brief; do not rewrite whole retrieved
  bodies on every read. English is canonical for new prose; existing records
  remain unchanged. Mixed-language scores are diagnostic evidence only.
- Known ID from a handoff: `get <id> --follow latest`, not a text search for
  the number. An audit of the old version uses plain `get <id>`.
- An identifier you hold whose entry you do not (a seat id such as
  `coder-kimi-226cc8`, a sha of 7 to 40 characters, `task 1953`, `#13916`):
  type it into a plain search as it is, without quotes. Since 2026-10-03
  (task 2026) the entries that contain that exact token come first; before it
  a bare identifier missed (hit@5 .07, .02 and .48 on the live service, 1 after).
  A turn suffix (`.1`) is ignored. `#N` finds the entries that MENTION that id;
  the entry itself is `get N`.
- Current policy/state: include its topic and exact names, then `get`
  the candidate and check date, kind and replacement links. Use `kind` only
  when the source kind is known: older operator rules can be feedback, and
  completion evidence can be handoff. A blind decision filter hid valid
  authority in the 2026-09-18 fresh-agent smoke. A historical handoff alone
  cannot settle current policy.
- Knowledge needed for an edit: `lessons --path` before semantic archaeology.
- No useful hit: reformulate once with stored title words or exact identifiers.
  More generic English words are not automatically more recall. State the
  miss; do not treat the first lexical match as an answer.

These routes improve delivery; they do not prove that the whole retrieval
system is accurate. Benchmark gold IDs must be reviewed when policy changes,
and an equivalent current answer is not a failure just because its ID differs.

**Every hit carries its date — read it.** A handoff is a snapshot of ITS day,
not of today: quoting a fortnight-old handoff as the state of a server is the
failure the operator named on 2026-09-11. Production state comes from the
`mcp__booharness__*` tools first; memory tells you what was true WHEN.

The default search leaves out `report` entries (per-attempt Paseo deliveries) and
live entries whose title marks them as history (`MERGED-INTO:`, `RETIRED:`,
`ОТМЕНЕНО:`, `ARCHIVED:`); an explicit `--kind` answers everything of that kind. Words like
"последний / сейчас / latest / current" in the query rank newer entries higher.
Explicit FTS5 syntax (quotes, `*`, `OR`, `NEAR`) runs as written.

For "what is the CURRENT X" - server state, the latest deploy, where a track
stands - the lexical ranking tops out; `node scripts/memory/deep-search.mjs
"<question>"` lets a cheap model re-rank the top 30 by title, date and snippet
(Jev by default, median 1.5 s; `--via terra`, ~14 s, has equal accuracy and
`--via grok`, ~30 s, is a little more accurate; a Jev failure exits 1 with no
other route). Then `get` the
winner, and still check live production state with `mcp__booharness__*`.

```sh
memoryctl search "<rus phrase + english token>" --limit 10
memoryctl get <id>          # the whole body; --json for a machine
```

## reading an id that was written down earlier

An id in a lesson's evidence, a handoff or a Paseo brief names the row that was
live when it was written; every rewrite since made it a dead end.

- `memoryctl get <id> --follow latest` — read the live head instead, and it
  prints `followed: #old -> #new` so the redirect is never silent.
- `memoryctl get <id> --follow full_history` — the lineage root to leaf (one
  line per version, `>` marks the one asked for), plus that version's body.
- No `--follow` — the raw row, which is what an audit wants.

`search` is unaffected: superseded rows leave the FTS index, so search has only
ever answered with live entries.

## Notes

- Windows: memoryctl is a bash script + `memoryctl.cmd`; spawn it via
  `cmd.exe /d /s /c memoryctl.cmd ...` from non-shell contexts (Node/Rust).
- Every command fails safe: if the service is down, say so and move on —
  memory must never block the actual work.
