import { defineSetting } from '../registry.ts';

export function registerGates(): void {
  defineSetting({
    key: 'gates.complexityEnabled', label: 'Complexity gate', category: 'gates', group: 'safety',
    tier: 'advanced', control: 'switch', class: 'operator-only', scope: 'project', type: 'bool',
    default: true, apply: 'live',
    help: 'Refuse new or growing functions above cyclomatic complexity 10. The default, on, keeps this check.',
    reads: 'scripts/check-complexity-growth.mjs:12 (configuredEvaluation); at base 64bee52bde1c:188 evaluate ran unconditionally.',
  });
}
