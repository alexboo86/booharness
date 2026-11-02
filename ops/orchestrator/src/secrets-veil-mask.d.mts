/**
 * Types for secrets-veil-mask.mjs (task 3459 L3). Mirrors the vendored
 * ops/claude-mods/secrets-veil/src/mask.ts and src/types.ts signatures this
 * consumer uses; the vendored sources stay out of the orchestrator tsconfig
 * (see the bridge's header).
 */

/** Config for the high-entropy token layer. */
export interface VeilEntropyConfig {
  minLength: number;
  thresholdBitsPerChar: number;
}

/** One table entry: an exact named value, or a shape pattern prefix. */
export type VeilMaskTableEntry =
  | { type: 'env'; name: string; value: string; pattern: string }
  | { type: 'pattern'; pattern: string };

/** The armed mask table. */
export interface VeilMaskTable {
  entries: readonly VeilMaskTableEntry[];
  entropy?: VeilEntropyConfig | null;
}

/** One masked span, in original-text coordinates. */
export interface VeilMaskSpan {
  start: number;
  end: number;
  value: string;
  name?: string;
}

/** The mask result: masked text plus the spans it covered. */
export interface VeilMaskResult {
  text: string;
  spans: VeilMaskSpan[];
}

export const DEFAULT_PATTERNS: readonly string[];

export function buildTable(
  envNames: readonly string[],
  envValues: Record<string, string>,
  patterns: readonly string[],
  options?: { entropy?: boolean }
): VeilMaskTable;

export function mask(text: string, table: VeilMaskTable): VeilMaskResult;
