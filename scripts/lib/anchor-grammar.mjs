// ONE path grammar for every reader of knowledge-page anchors
// (scripts/check-knowledge-anchors.mjs, scripts/check-knowledge-history.mjs,
// scripts/fix-knowledge-anchors.mjs). Task 2429: the three private copies
// drifted, and none of them could read a path holding a Next.js dynamic route
// segment (`web/apps/app/app/api/terminal/workspaces/[id]/route.ts:187`), so
// such anchors were never machine-checked. Consumers keep their own lookarounds
// (word/path/backtick boundaries differ per form) and compose the pieces below.
//
// Rules this grammar keeps:
//   - a bracket counts only as a WHOLE segment: `[id]`, `[...slug]`,
//     `[[...slug]]`, each followed by `/`. `a[0].ts` is not a path, and a
//     markdown link `[text](path)` is not a bracket segment;
//   - round brackets stay OUTSIDE the grammar (prose glue): the `(main)`-style
//     route groups of web/apps/app/** double as prose, so a parenthesis
//     difference around an anchor keeps its line judged;
//   - a colon is not a path character: only the optional numeric/symbol tail
//     may hold colons, so history glued before a path
//     (phase-finished-on-day:12/src/foo.ts:1) cannot ride inside it.

/**
 * Plain-segment characters: the set tracked paths with a source basename
 * really use — alphanumerics plus . - _ @ over the git ls-files entries.
 * Re-derive:
 *   git ls-files | grep -E '\.(rs|ts|tsx|mjs|js|json|sql|yml|yaml|py|toml|sh|md)$' | grep -o . | sort -u
 */
export const PLAIN_SEGMENT = '[-\\w.@]+';
/** A Next.js dynamic route segment as a whole segment: [id], [...slug], [[...slug]]. */
export const BRACKET_SEGMENT = '\\[\\[\\.\\.\\.[\\w-]+\\]\\]|\\[(?:\\.\\.\\.)?[\\w-]+\\]';
/** One directory segment. */
export const PATH_SEGMENT = `(?:${BRACKET_SEGMENT}|${PLAIN_SEGMENT})`;
/** A cited line tail: 12, 12-20, 12–20, 12,14, 12..20 and mixes of those. */
export const NUMBER_TAIL = '[0-9]+(?:(?:[-–,]|\\.\\.)[0-9]+)*';
/** Optional qualified identifier; the checker searches its last segment. */
export const SYMBOL_TAIL = '[A-Za-z_$][\\w$]*(?:(?:::|\\.)[A-Za-z_$][\\w$]*)*';
export const ANCHOR_TAIL = `(?:${NUMBER_TAIL}|${SYMBOL_TAIL})`;
export const PATH_END = '(?![\\w/-]|\\.[\\w])';

/** Legacy numbers remain readable during the decision 17183 migration. */
export function anchorPattern(ext) {
  return pathPattern(ext) + `(?::${ANCHOR_TAIL})?` + PATH_END;
}
/**
 * Start boundary of a bare (unbackticked) path: never right after a word
 * character, dot, slash or hyphen, so a match cannot start in the middle of a
 * path. Besides provenance (a citation starts at a path start), this is what
 * keeps long segment runs LINEAR: without it every one of n repeated segments
 * is a match start whose greedy consume-then-backtrack costs O(n), i.e. O(n²)
 * (task 2429 fix: `[id]/`×16000 cost 708 ms in the section-proof rule, 0.6 ms
 * with the boundary). Backticked forms are whole-span anchored instead; the
 * bare history form excludes a backtick rather than a hyphen and keeps its own.
 */
export const PATH_START = '(?<![\\w./-])';

/**
 * LONGEST EXTENSION FIRST. A JS alternation is first-match-wins, not
 * longest-match-wins, so a written order `ts|tsx` makes `ChartPane.tsx:1190`
 * match as `ChartPane.ts` with NO line number, and the anchor is skipped as a
 * prose mention. Measured 2026-09-21 on an in-memory copy of
 * domain-indicators: `.tsx:999999` returned zero problems while the same
 * mutation on a `.ts` anchor returned `beyond EOF`; `js|json` had the same
 * hole. Sorting by length keeps the list editable without re-introducing it.
 */
export function extAlternation(extra = []) {
  return ['rs', 'ts', 'tsx', 'mjs', 'js', 'json', 'sql', 'yml', 'yaml', 'py', 'toml', 'sh', ...extra]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .join('|');
}

/** Extensions of code anchors. */
export const SOURCE_EXT = extAlternation();
/** History also absorbs page and catalogue anchors, without changing source validation. */
export const PAGE_EXT = extAlternation(['md', 'tsv']);
/** Refuse drifting numbers even on Markdown and absolute paths, without widening proof anchors.
 *  Markdown only: a `.tsv:<row>` catalogue anchor stays allowed (task 2403). */
export const NUMERIC_ANCHOR_PATTERN = PATH_START + `(/?${pathPattern(extAlternation(['md']))}):(${NUMBER_TAIL})` + PATH_END;

/**
 * A repo-relative path: (dir/)* basename.ext, all groups non-capturing and no
 * trailing lookahead, so each consumer adds its own boundary assertions and
 * capture group. `ext` is an alternation from extAlternation.
 */
export function pathPattern(ext) {
  return `(?:${PATH_SEGMENT}/)*${PLAIN_SEGMENT}\\.(?:${ext})`;
}
