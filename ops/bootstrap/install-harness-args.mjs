// Argument validation must finish before the installer resolves or writes a runtime home.
const FLAGS = [
  'help', 'operator-profile', 'support-profile', 'support-lead', 'skip-code-intel',
  'skip-skills', 'skip-orchestrator', 'allow-worktree-root', 'no-require-providers',
];
const OPTIONS = ['repo', 'home', 'secrets-file', 'platform', 'only'];
const STEPS = [
  'code-intel', 'instructions', 'skills', 'codex', 'mcp', 'hooks', 'permissions',
  'rtk-filters', 'rtk-excludes', 'pi-rtk', 'lead-rtk', 'opencode', 'path', 'orchestrator', 'plugins', 'py-tools',
];
export const USAGE = [
  'Usage: node ops/bootstrap/install-harness.mjs [flags] [options]',
  `Flags: ${FLAGS.map((name) => `--${name}`).join(', ')}`,
  `Options: ${OPTIONS.map((name) => `--${name} <value>`).join(', ')}, --system-dirs [<colon-separated dirs>]`,
  `Steps for --only: ${STEPS.join(', ')}`,
].join('\n');

export function parseArgs(argv) {
  const flags = new Set();
  const opts = {};
  const refuse = (message) => {
    const error = new Error(`${message}\n${USAGE}`);
    error.exitCode = 2;
    throw error;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const key = arg.startsWith('--') ? arg.slice(2) : '';
    if (FLAGS.includes(key)) {
      flags.add(key);
    } else if (OPTIONS.includes(key) || key === 'system-dirs') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        if (key !== 'system-dirs') refuse(`${arg} requires a value`);
        flags.add(key);
      } else {
        if (!next && key !== 'system-dirs') refuse(`${arg} requires a nonempty value`);
        if (key === 'only' && !STEPS.includes(next)) refuse(`Unknown --only step: ${next}`);
        opts[key] = next;
        flags.delete(key);
        i += 1;
      }
    } else {
      refuse(`Unknown argument: ${arg}`);
    }
  }
  return { flags, opts };
}
