import { defineSetting } from '../registry.ts';
import type { Family } from '../../providers/index.ts';

// A complete schema-default table: adding a provider family requires its settings defaults.
// Keep the import type-only: the provider runtime reads role files on import.
const CODER_CAP_DEFAULTS: Record<Family, number> = {
  claude: 5, glm: 10, codex: 10, grok: 5, kimi: 5, opencode: 5, qwen: 5, mimo: 5,
};
export const SETTINGS_FAMILIES = Object.keys(CODER_CAP_DEFAULTS) as Family[];

/** Today's behavior: no limit. seats-create.ts:218 (createSeat) has no global cap; http.ts:288 lists open seats without a limit. */
export function registerSeats(): void {
  defineSetting({
    key: 'seats.maxOpen', label: 'Maximum open seats', category: 'seats', group: 'seats',
    tier: 'basic', control: 'number', class: 'user', scope: 'install', type: 'int',
    default: null, nullable: true, bounds: { min: 1 }, apply: 'next-seat',
    help: 'Limit the total number of open seats; default null keeps new seats unrestricted by a total count.',
    reads: 'seats-create.ts:218 createSeat; default null preserves the absence of a global open-seat cap.',
  });
  for (const family of SETTINGS_FAMILIES) {
    defineSetting({
      key: `seats.coderCap.${family}`, label: `${family} working coder limit`, category: 'seats', group: 'seats',
      tier: 'advanced', control: 'number', class: 'user', scope: 'install', type: 'int',
      default: CODER_CAP_DEFAULTS[family], bounds: { min: 1 }, apply: 'next-seat',
      help: `Skip this family in automatic selection when it has this many working coders; default ${CODER_CAP_DEFAULTS[family]} keeps its current limit. Requests naming a family bypass this limit; if all families reach their limits, selection still uses the best choice.`,
      reads: 'profiles.ts:389-392 coderCap; codex and glm default to 10, all other families to 5.',
    });
  }
}
