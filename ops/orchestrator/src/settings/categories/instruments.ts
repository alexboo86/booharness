import { INSTRUMENT_KEYS } from '../../shared.entry.ts';
import { defineSetting } from '../registry.ts';

export function registerInstruments(): void {
  for (const instrument of INSTRUMENT_KEYS) defineSetting({
    key: `instruments.${instrument}`, label: `Use ${instrument}`, category: 'instruments', group: 'tools',
    tier: 'basic', control: 'switch', class: 'user', scope: 'install', type: 'bool', default: true, apply: 'next-seat',
    help: 'Allow new seats to use this tool; default on keeps it available. A seat may turn it off for itself, but cannot turn it on when it is off here.',
    reads: 'ops/orchestrator/src/seats-create.ts:219 (configuredInstruments); default true from ops/orchestrator/src/instruments.ts:33 (ALL_ON).',
  });
  defineSetting({
    key: 'instruments.own', label: 'Additional command tools', category: 'instruments', group: 'tools',
    tier: 'advanced', control: 'list', class: 'operator-only', scope: 'install', type: 'command-list', default: [], apply: 'live',
    help: 'List up to 64 unique name/command pairs to tell seats about tools on their machine, without running them; default empty lists only built-in tools. Use bare command names, with no paths, arguments or shell syntax.',
    reads: 'ops/orchestrator/src/seats.ts:81 (ownInstrumentContext); default empty: ops/orchestrator/src/context.ts:141 advertises built-in instruments only.',
  });
  defineSetting({
    key: 'instruments.install', label: 'Install code tools', category: 'instruments', group: 'tools',
    tier: 'advanced', control: 'switch', class: 'operator-only', scope: 'install', type: 'bool', default: true, apply: 'live',
    help: 'Allow the installer to install codegraph, ast-grep and ripgrep; default on keeps this step enabled unless explicitly skipped. Off neither removes existing tools nor disables RTK.',
    reads: 'ops/bootstrap/install-native-tools.mjs:8 (maybeInstallCodeIntel, extracted from install-harness.mjs); default true: line 16 installs unless --skip-code-intel is given.',
  });
}
