## Runtime role-matrix configuration and team presets

Production matrix reads use `roleMatrix()` in `ops/orchestrator/src/profiles.ts` at call
time, retaining no table/row/cell. `<stateDir>/roles.json` maps role/family to
`{model, effort?}`, cached by path/mtime/size; edits need no restart. Missing file or
unnamed role uses compiled MATRIX; absent critic shares that table's reviewer row.
`parseRoles` validates the whole file: known role/family with adapter or Pi route, exact
cell keys, SAFE model and FAMILY_EFFORTS effort (`ops/orchestrator/src/providers/index.ts`).
Strict read refuses a bad file. `lenientMatrix` tries strict, then last-good table or
MATRIX; absence clears last-good. Existing-seat/accounting readers use lenient. Seat
creation stores `data.matrixModel`; `seatModel` prefers explicit model, stored model,
then lenient matrix (`ops/orchestrator/src/seats-scope.ts`).

One writer behind `setRole`, `unsetRole`, `resetRole` supports CLI `roles show|set|unset|reset`.
It validates the whole changed result, fsyncs a state-directory temp file and renames
under a directory lock. Set copies an effective unnamed row before changing a cell;
unset refuses empty rows; reset removes a row, deleting the file when last. Show marks
file/compiled rows; refusal changes no bytes and exits nonzero. Caller keys become own
properties so `__proto__` reaches validation. Killed writes leave lock/temp: the next
writer refuses after 5 s naming the lock, and the next successful writer removes stale
temp (`ops/orchestrator/src/profiles.ts`, `scripts/test-orch-roles-file.mjs`).

`ops/bootstrap/team-presets.json` holds economy/balanced/strong tiers and known models;
balanced equals compiled MATRIX. `loadTeamPresets` validates family/role/tier/effort
without partial results. `buildMatrix(families,preset)` returns matrix, missing and gaps;
it names every role, including empty rows, preventing compiled families from leaking
into a restricted team. Empty rows make pickFamily refuse. Gaps identify reviewer/critic
family independence failures and debaters with fewer than two distinct models
(`ops/orchestrator/src/team-presets.ts`).

`roles preset <tier> --families <a,b> [--dry-run] [--json]` writes the whole matrix via
`writeRolesMatrix`/`changeRoles`, merging nothing. Dry-run writes nothing; JSON is the
builder result consumed by wizard teams. Invalid preset/flags/families/file or busy
lock writes nothing and exits 2; other roles verbs use exit 1. Roles set warns but
accepts unknown catalogue models; unreadable presets suppress only that warning.
Show prints empty rows as `no family`; JSON remains the doctor's interface
(`ops/orchestrator/src/profiles.ts`, `scripts/test-orch-team-presets.mjs`).

verified: 2026-09-23

