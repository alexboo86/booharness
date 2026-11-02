import { defineSetting } from '../registry.ts';

/**
 * Task 3459 slice C6. Both defaults are today's behaviour: `balanced` is the tier pinned equal
 * to the compiled MATRIX, and no lead start is refused. team-presets.ts stays the one owner of
 * preset data; these keys hold a name and a provider/model list, nothing else.
 */
export function registerPresets(): void {
  defineSetting({
    key: 'presets.team', label: 'Team preset', category: 'presets', group: 'models',
    tier: 'basic', control: 'select', class: 'user', scope: 'install', type: 'enum',
    default: 'balanced',
    options: ['economy', 'balanced', 'strong', 'claude', 'glm', 'codex', 'grok', 'kimi', 'opencode', 'qwen', 'mimo'],
    apply: 'next-seat',
    help: 'Choose the team preset applied by roles preset when no name is given; default balanced keeps the current role-to-model choices. A family name selects a preset using only that family’s provider.',
    reads: 'main.ts roles preset reads it when no tier is named (task 3459 C6); team-presets.ts owns the presets and refuses an unknown name at apply, this list holds names only. Default balanced = today’s tier (ops/bootstrap/team-presets.json:115, pinned equal to profiles.ts MATRIX).',
  });
  defineSetting({
    key: 'leads.models', label: 'Allowed lead models', category: 'leads', group: 'models',
    tier: 'basic', control: 'list', class: 'operator-only', scope: 'install', type: 'list',
    default: null, nullable: true, bounds: { min: 1 },
    // Entries are claude, codex, pi:<family> or pi:<family>:<model>; a bare pi is refused —
    // a gate names what it admits, so name the family. The family alternation is pinned
    // against providers FAMILIES by the drift test in scripts/test-orch-settings.mjs: the
    // settings module cannot import ops-orchestrator-surface (team-presets.ts) for it.
    itemPattern: '^(?:claude|codex|pi:(?:claude|glm|codex|grok|kimi|opencode|qwen|mimo)(?::[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99})?)$',
    apply: 'next-seat',
    help: 'Choose which providers and models a lead may start with: claude, codex, pi:<family> or pi:<family>:<model>; pi alone is refused because it must name a family. Default null keeps starts unrestricted; an empty list is refused. Only a new lead start is gated: a running lead keeps its provider, and restartFresh and crash resume are exempt, so changing this never stops a running lead.',
    reads: 'lead-driver.ts start() reads it with readInstallSetting when the driver has a stateDir, per start; restartFresh and crash resume do not read it (task 3459 C6, decision 22510 item 4).',
  });
}
