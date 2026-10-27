// Stand-only pins for pi-dynamic-context-pruning. One source for the arm,
// the verified installer and readiness. Not a stock seat loadout.
import { readFileSync } from 'node:fs';

export const CONTEXT_PRUNING_PINS = JSON.parse(readFileSync(new URL('./context-pruning.json', import.meta.url), 'utf8'));
export const CONTEXT_PRUNING_PACKAGE = `${CONTEXT_PRUNING_PINS.package}@${CONTEXT_PRUNING_PINS.version}`;
export const CONTEXT_PRUNING_INTEGRITY = CONTEXT_PRUNING_PINS.integrity;
