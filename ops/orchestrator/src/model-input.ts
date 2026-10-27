// Which role-matrix models accept image input (task 2385). The bits are copied
// from the pinned Pi catalog's `input` field: true when that field includes
// "image", with explicit evidence below for models not in that catalog yet.
// A model neither table holds is null — never guessed. The table
// is data, not a read of profiles.ts, so a parallel edit of the matrix does not
// collide with this file; the test fails until a new matrix model is added here.
//
// glm-5.3 is text-only on every catalog provider, including zai (the glm route).
// glm-5.3-flash includes "image" on zai and opencode-go. Radius lists it as text
// only; orch does not launch radius.

const IMAGE_INPUT: Record<string, boolean> = {
  'claude-opus-5-5': true,
  'claude-sonnet-5': true,
  'claude-sonnet-5-5': true,
  'glm-5.3': false,
  'glm-5.3-flash': true,
  'gpt-6-luna': true,
  'gpt-6.1-sol': true,
  'grok-4.7': true,
  'k3': true,
  'k3-256k': true,
  'mimo-v2.6-flash': true,
  'mimo-v2.6-pro': true,
  'qwen3.8-flash': true,
  'qwen3.8-max': true,
};

/** Matrix models awaiting builtin catalog support; the catalog test requires removal once present. */
export const MODELS_OUTSIDE_PINNED_CATALOG: Record<string, { image: boolean; reason: string }> = {
  'k3.1-pro': {
    image: true,
    reason: 'Pi 1.4.0 builtin catalog lacks it; Pi gets it from `pi update --models` (models store: input text+image, 1M context), 2026-10-24',
  },
};

/** True when the model reads images, false when it does not, null when neither table holds it. */
export function imageInput(model: string): boolean | null {
  if (Object.hasOwn(IMAGE_INPUT, model)) return IMAGE_INPUT[model];
  if (Object.hasOwn(MODELS_OUTSIDE_PINNED_CATALOG, model)) return MODELS_OUTSIDE_PINNED_CATALOG[model].image;
  return null;
}
