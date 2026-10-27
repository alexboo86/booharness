## Role statistics by family

Family selection uses pace ranking. `role-stats [--since 7d]
[--json]` reads the store and prints role/family/model/effort rows: seats, rated seats,
turns, mean outcome, tokens per turn, median seconds and failure/no-report share.
Unrated turns count but do not enter the mean. Without `--write-tiers`, it writes nothing
(`ops/orchestrator/src/main.ts`, `ops/orchestrator/src/role-stats.ts`).

`role-stats --since 7d --write-tiers` is the sole writer of `<stateDir>/role-quality.json`.
A cell is role/wallet/model/effort; missing model/effort means no cell. Qualification
requires 20 rated seats; a judged role needs five qualified cells. A qualified cell in a
judged role is WEAK at failure share >= 0.15, or mean strictly below nearest-rank P25
and at least 0.05 below the median; others are NORMAL. The file stores
`{version, writtenAt, since, cells, manual}`. Atomic temp/rename rewrites cells, preserves
manual and prints tier transitions. Manual keys are `<role>/<wallet>/<model>/<effort>`.
`tierOf` never throws: manual wins; absent cells are NORMAL; missing, unparseable or
older-than-14-day files return NORMAL with one warning
(`ops/orchestrator/src/role-quality.ts`).

`pickInputs` reads tiers synchronously with active count A before seat insertion
(`ops/orchestrator/src/seats-prompt.ts`). `pickFamily` ranks NORMAL before WEAK among
families at/behind pace; ahead-of-pace headroom ordering is unchanged. Tiers never alter
eligibility/emergency choice or admit paused/failed/throttled/spent families. Empty tiers
mean NORMAL. A matrix cell with no effort is queried as `none`, naming no written cell;
an explicit model override still ranks by each family's matrix cell. Pick notes show
tiers, WEAK metrics and the reader warning (`ops/orchestrator/src/profiles.ts`).

Behind-pace spread score is min(need, `NEED_SPREAD_CAP`)/(1+A), capped at 3. Equal score
prefers higher raw need then earlier chain. Bucket membership (need >= 1) and printed
need stay raw. Tests: `scripts/test-orch-role-quality.mjs`,
`scripts/test-orch-seat-pick-tier.mjs`, `scripts/test-orch-seat-pick-spread.mjs`.

verified: 2026-10-11

