/**
 * Task 3459 L3: the runtime bridge to the vendored secrets-veil mask (ops/claude-mods/secrets-veil,
 * VENDOR.json-pinned). The mask is REUSED, never copied: this file re-exports it and changes
 * nothing under the vendored tree.
 *
 * Why a .mjs bridge: the vendored mask.ts carries `import type ... from "./types"` with a
 * type-only extensionless specifier (its own tsconfig resolves it with "moduleResolution":
 * "bundler"). Under the orchestrator's NodeNext tsconfig that file errors TS2835, and the
 * vendored tree must not change, so mask.ts cannot join a checked TS program. Runtime loaders
 * do not have the problem: node erases the type-only import at load, and jiti (what Pi loads
 * extensions with) resolves it. Both loaders were probed through this exact chain.
 */
export { buildTable, mask, DEFAULT_PATTERNS } from '../../claude-mods/secrets-veil/src/mask.ts';
