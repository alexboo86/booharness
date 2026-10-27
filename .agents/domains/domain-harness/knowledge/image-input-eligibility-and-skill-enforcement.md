## Image-input eligibility and skill enforcement

`ops/orchestrator/src/model-input.ts` maps MATRIX models to `imageInput(model)`: true, false, or null (unknown, not false), from the pinned Pi provider catalog. `glm-5.3` is text-only; `glm-5.3-flash` accepts images on zai/opencode-go.

Optional `seat_create.images: true` applies explicitly or through role-default `requires: input:image` (none currently). `createSeat` in `ops/orchestrator/src/seats-create.ts` filters false-image models synchronously with independence before pick; emergency/coder cap cannot restore them. Explicit unsupported family/model or emptied field refuses naming images/model; unknown models pass with unknown capability in `picked`. Remaining budget exhaustion gives budget refusal. Data stores true only; absent means false. `ops/orchestrator/src/seats-verify.ts` replacement inherits it; request_id retry cannot change it. Per-create map reads treat absent/malformed as no default requirement.

Because briefs follow create, `seatContext` in `ops/orchestrator/src/context.ts` checks default/routed skills after routing on every build/retry. An input:image skill with a false-image model throws before prompting, keeps seat open, names skill/model/recreation with images. `seatModel` in `ops/orchestrator/src/seats-scope.ts` resolves native seats' matrix model too. Capable/unknown models proceed; `ops/orchestrator/src/seats.ts` stores images:true for replacement filtering. No image skill means no change; absent/malformed map or throwing router does not fail here. No seat_prompt refusal.

verified: 2026-09-23
