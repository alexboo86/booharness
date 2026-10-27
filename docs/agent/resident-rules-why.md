# Why the resident rules are shaped the way they are

> Part of the agent contract. Root — [CLAUDE.md](../../CLAUDE.md).
> **Read when:** a one-line resident rule in `CLAUDE.md` or `ops/bootstrap/agent-instructions.md`
> needs its measurement, date, run id or "why" — the contract diet of 2026-09-14
> (memory #8161/#8163/#8168) moved that narrative here so the rule itself could
> stay one line without losing the evidence behind it.

## Tests — why the blanket ban became a narrow tool

Memory reference **#14201**, measured 2026-10-04: the blanket test ban coincided
with about **4 percent fewer tokens per coder seat**, but **no speed-up**.
The before/after comparison does not establish causality. Operator decision
**#14209** then restored tests in a narrow form, which **#14235** below withdrew
the next day: one existing covering test file instead of a suite, and new tests
only for a bug reproduction before fixing it, invariant logic, or a cheaper check;
one test file per change; no UI appearance, text/config tests, implementation-copy
mocks or coverage goal. Existing assertion changes still require the operator's
word; the curated money/data set stays the CI and pre-deploy gate and operator-owned.

2026-10-05, decision **#14235**: agents may write and run tests again, with test-audit and the narrowest covering check; existing assertion changes still need the operator's word, reviewers/bughunters edit nothing, and the curated money/data gate stays CI/pre-deploy and operator-owned. Deleted tests, `test:*` scripts and CI steps are not restored.

2026-10-05, decision **#14245**: a stale assertion, one whose pinned behaviour was changed on purpose by a change the commit names, may change without the operator's word (PRIME 7); the four other test skills removed with the ban return.

## Legal copy — why `review` and `block` land where they do

`npm run check:legal-copy` is a ratchet over the RF launch legal memo
(`output/pdf/booharness-rf-final-legal-report-2026-08-30.pdf`). It reads the
TSX/JSON of the web apps AND the SQL seeds under `web/supabase/migrations`
with `--` comments blanked, because the storefront text moved into
`plans.features` on 2026-08-22 and a seed migration is where
«Доступ к материалам навсегда» is actually written.

A crypto price line, a promised return, an absolute «не подлежит возврату», a
percentage of учеников with a result (`typical-result-claim`) are `block`.
«Академия», «рассрочка», «доступ навсегда», a recommended starting deposit
(`deposit-advice`), «инвестиционный советник» and «повышение квалификации» are
`review` — the last two because the memo allows them inside a licensed model
and forbids them outside it: legal in ONE model of the product and not in the
other, so `scripts/legal-copy-ledger.json` (not in this kit) must say which model was chosen and
by whom.

The ledger ONLY SHRINKS: a new phrase fails, and so does an excuse that
outlived its string. A `block` entry needs a `plan` and is reprinted on every
green run — a blocker is scheduled, never accepted.

`npm run check:commit` runs the check on EVERY commit and it reads the WHOLE
tree — neither the run nor the scan is decided by a pathspec, because deciding
either lexically was `pathspec-fail-open`, the one defect class Svod confirmed
three rounds running (and the ledger itself lives outside `web/`, so a trigger
scoped to `web/` would have let a gutted ledger through).

GREEN MEANS NOTHING NEW APPEARED, never that the copy is lawful — the ratchet
judges known phrasings and nothing else, and what no regex can judge is
printed by `npm run check:legal-copy -- --gaps`.

## The Svod member subject boundary — the measurement behind it

On grok this was not theoretical: `grok inspect` in a member worktree listed
the subject's whole `.agents/skills` as available (105 entries, sourced
`project`), and the subject's `CLAUDE.md` arrived as project instructions —
measured 2026-08-11 against run `019fed40`, where the reviewed repository's
own contract text was in the member's context.

Since `a13c327be` a grok member runs on a sealed, session-scoped `GROK_HOME`
whose config disables the Claude/Cursor skill-compat layers and ignores the
subject root outright: measured with `grok inspect --json`, skills sourced
`project` fell 65 → 0. Credentials are not copied — the live auth file is
handed over by path, so an operator re-login is visible immediately.

The subject's `CLAUDE.md` and `AGENTS.md` still reach a grok member as project
instructions — measured in the same run, `projectInstructions` stayed 2 → 2.
Grok reads them independently of the compat cells and of the skills ignore,
and no launch-level flag takes them away. For THIS repository the operator
accepted that (2026-08-11): the subject is our own tree, its contract says
roughly what a member should do anyway, and the boundary paragraph in
`ops/bootstrap/agent-instructions.md` held in every measured round.

Claude and GLM members are cut off from the whole layer by the launch itself
(`--setting-sources user`), mechanically, not by policy — which is why they
stay the safe seat choice for a foreign repository until a real mechanism
exists for grok.

## `rtk read` — why it is the counted reader

Measured 2026-08-17 across four live rounds on this machine: the same codex
seat read every document it was given in all four rounds and was credited
with having read its skills in only the one where it happened to reach for
`cat` in a way the harness could see as a read; the others used a reader the
counting mechanism could not distinguish from not reading at all. `rtk read
<path>` (several paths in one call) is the reader the measurement is named
against for exactly that reason — it is legible to the same instrumentation
that counts a skill as read.

Handing an identifier to `probe`'s default BM25 stemmer asks a natural
language ranker to guess what you already know exactly, and that is where the
first query is lost — measured 2026-08-13 on this tree: a non-English query
drops hit rate from 83% to 8% on `probe` and from 25% to 8% on the (since
removed) index. Write the query in English.

## Mandatory skills for the lead — why "on honour" needed saying at all

Measured 2026-08-09 across 330 runs: 219 skill calls in 38,525 tool calls
(0.57%), a skill opened in 68 of 1,239 places (5.5%), 10 distinct skills of 65
installed actually invoked. The lesson was not "agents ignore skills" — it was
that the contract text itself, at the time, told a Claude-family lead the
opposite of what the trigger table meant, and a plugin's own claim to be
mandatory was explicitly overridden. The current phrasing (trigger-based,
matching the Instrument triggers table) replaced that; the fix reinstalled
into all seven runtimes and is guarded by `svod/tests/codex_adapter.rs`.

## Shell — the zsh word-splitting measurement

Measured 2026-09-11: a `--id` list passed as one unquoted string to a script
expecting an array emptied the filter and promoted 44 lessons nobody had
vetted. zsh does not split an unquoted `$VAR` into words the way bash does;
the fix is always `"${LIST[@]}"`, never a bare `$LIST`.

## RTK chain vs pipeline — the measurement

Measured 2026-08-13: `ls -la ops/bootstrap` gives 27 lines and `rtk ls -la
ops/bootstrap` gives 24 — routing a middle link of a pipeline feeds the next
stage DIFFERENT data, because `rtk` rewrites the stream rather than only
shortening the view shown to the caller. That is why a `;`/`&&` chain needs
`rtk` on every link, while a pipeline only needs it on the last stage (whose
output alone reaches the caller).

RTK enforcement has been warn-only since the 2026-07-31 deep-research
decision, pinned by `scripts/check-hook-topology.mjs`, with a counter at
`~/.local/state/rtk-guard/warnings.jsonl`; retrying a command against a deny
is forbidden regardless.

## Why the method set is skills, not a plugin

Six compact documents under `.agents/skills/` carry the lead's mandatory
method set (`enumerate-cases`, `plan-before-code`, `investigate-first`,
`surgical-patch`, `verify-and-stop`, `premortem`) rather than a plugin —
what a plugin cost, and why this replaced it, is recorded in
[docs/agent/environment.md](environment.md).

## The 2026-09-14 rewrite — numbering map and what moved where

The contract was rewritten from a blank page when Svod left the pipeline for
Paseo (operator decision, memory #8215). Rules referenced by number in older
handoffs and lessons map as follows: PRIME 11a → PRIME 11; PRIME 12 and
Operator 14 (Svod as orchestration authority) → the Harness section; Operator
13 → 4; 15a → 6; 16 + 16a → 7 + 8; 17 → 9; "BOARD", "no Serena / no
CodeGraph" and "Svod member contract" rows are gone with Svod. The measurements
that backed those rows stay above for history.

Three facts measured or decided on 2026-09-14 that the new rules stand on:
the Paseo claude provider launches with `settingSources: ["user","project",
"local"]`, so the subject's `CLAUDE.md` and `.claude/skills` reach every
claude seat (source: `packages/server/src/server/agent/providers/claude/agent.ts`
at Paseo v0.8.0) — hence "the subject boundary is prose today"; the memory
service on the NAS answers the client in ~0.3 s over the LAN (`memoryctl
search`, measured from the Mac) and the content probe passes against the
transferred database; and the code-search research found nothing that
answers Rust+TypeScript references without the per-worktree index cost that
removed codegraph and Serena — `probe` + `rtk` + `ast-grep` + the compiler stay.

## Code intel — why codegraph does not replace ast-grep or rg

Measured 2026-09-19 (memory #9838): codegraph replaced probe. Re-measured 2026-10-03 on
codegraph 1.6.2 (task 2035): it finds 72 of 79 project-trait impls but none of 214
std/external-trait impls, so it does not replace ast-grep for an exhaustive shape query. On a
known literal it cost 3183 tokens against 78 for `rg` (cl100k_base; the old tokenizer and the
exact rg command were not recorded).

## orch family pick and claude seats — moved from the contract (task 2809 D2)

The role matrix (`ops/orchestrator/src/profiles.ts`) picks the family with the most headroom
against a linear pace through its budget window (its longest quota window: week or month;
shorter windows only throttle); the lead's family (except for a coder seat) and the author's
step aside. claude takes no scout seat, a plan-critic seat unless a claude seat drafted the plan
(Sonnet 5.5, also under a claude lead; operator #13875), and a reviewer seat (Sonnet 5.5) only
when the change's author is another family (operator #13728). orch refuses the other cases at
`seat_create`. Coder and reviewer worktrees are provisioned from
`ops/orchestrator/worktree-setup.json`.
