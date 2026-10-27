// Shared role authorization data; no daemon or provider dependencies.
export const TEST_FILE_GLOBS = [
  '**/*.test.*',
  '**/*.spec.*',
  'scripts/test-*.mjs',
  '**/__tests__/**',
  '**/tests/**',
  '**/tests.rs',
  '**/*_tests.rs',
  '**/test-*.mjs',
  '**/test-*.py',
  '**/test_*.py',
] as const;
export const CAPTURE_OUTPUT_GLOBS = ['captures/**'] as const;
export const FIXTURE_GLOBS = ['**/fixtures/**'] as const;
export const TESTER_WRITE_SCOPE = [...TEST_FILE_GLOBS, ...FIXTURE_GLOBS, ...CAPTURE_OUTPUT_GLOBS] as const;
export const DESIGNER_WRITE_SCOPE = ['src/**/*.tsx', 'src/**/*.css', 'web/apps/**'] as const;
export const COPYWRITER_WRITE_SCOPE = ['web/apps/**', 'src/locales/**'] as const;

export const ROLE_POLICY = {
  coder: { access: 'full', worktree: 'branch', sealed: false },
  reviewer: { access: 'full', worktree: 'detached', sealed: false, review: true },
  scout: { access: 'read-only', worktree: 'none', sealed: true },
  critic: { access: 'read-only', worktree: 'none', sealed: true },
  researcher: { access: 'read-only', worktree: 'none', sealed: true },
  debater: { access: 'read-only', worktree: 'none', sealed: true, turns: 2 },
  bughunter: { access: 'full', worktree: 'detached', sealed: false },
  tester: { access: 'full', worktree: 'branch', sealed: false, writeScope: TESTER_WRITE_SCOPE },
  designer: { access: 'full', worktree: 'branch', sealed: false, writeScope: DESIGNER_WRITE_SCOPE },
  copywriter: { access: 'full', worktree: 'branch', sealed: false, writeScope: COPYWRITER_WRITE_SCOPE },
  legal: { access: 'full', worktree: 'detached', sealed: false, review: true },
  security: { access: 'full', worktree: 'detached', sealed: false, review: true },
} as const satisfies Record<string, { access: 'full' | 'read-only'; worktree: 'branch' | 'detached' | 'none'; sealed: boolean; turns?: number; review?: boolean; writeScope?: readonly string[] }>;
export type SeatRole = keyof typeof ROLE_POLICY;

/** The seat owns a writable branch the lead can land. Unknown roles do not. */
export function landable(role: string): boolean {
  return role in ROLE_POLICY && ROLE_POLICY[role as SeatRole].worktree === 'branch';
}

/** Quote a host-local script path using the managed SSH shell convention. */
export function quoteShellPath(file: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `"${file}"` : `'${file.replaceAll("'", "'\\''")}'`;
}
