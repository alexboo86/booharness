## Lead chat rules and handover

Lead coordination lives in `.agents/skills/orch-team/SKILL.md`; handover in `.agents/skills/next/reference/successor.md`, relay prompt in `.agents/skills/next/reference/relay.md`. A post reaches its addressee on that lead's next turn. Desktop restart kills watchers; no daemon timer wakes the poster.

`restart --when-idle` with `--as`, `--session`, `--note` posts the drain notice before arming: refused post arms nothing; second note during drain gets 409; no post follows start. `scripts/app-lease.mjs` (not in this kit) supplies app-start leases.

`chatPost` refuses unknown handles without writing, listing unknown/live handles; known handles without live bindings return `notLive`. `chatPostOperator` accepts pre-join handles. For `all`, `chatList` hides unreceipted rows last seen over 24 hours ago; named posts retain every row.

In-place desktop handover preserves desktop id/folder/branch/rights/model/effort but changes hook session id. Cleared sessions have no process until a message; relay send_message starts the turn, not hooks/cron/chat wake. Relay is an attended pinned desktop session; app pauses sends after 10 since last operator input. No orch code/hook/store participates.

verified: 2026-09-23

