import { defineSetting, type SettingDefinition } from '../registry.ts';

/** Hostless Pult preferences; defaults match the vendored owners' schemas. */
export function registerPult(): void {
  const common = { category: 'pult', group: 'tools', tier: 'basic', class: 'user', scope: 'install', apply: 'live',
    reads: 'pult-dsh/packages/orch/settings-controller: remote.settings projects these keys for ConfigForms.' } as const;
  const rows: Pick<SettingDefinition, 'key' | 'label' | 'help' | 'control' | 'type' | 'default' | 'bounds' | 'options' | 'nullable'>[] = [
    { key: 'pult.ui-theme.preference', label: 'Theme', help: 'Appearance palette; system follows the operating system.', control: 'select', type: 'enum', default: 'system',
      options: ['light', 'dark', 'system', 'catppuccin-latte', 'catppuccin-mocha', 'dracula', 'nord', 'gruvbox-dark', 'tokyo-night'] },
    { key: 'pult.ui-theme.fontSize', label: 'Text size', help: 'Conversation text size in pixels.', control: 'number', type: 'int', default: 14, bounds: { min: 10, max: 22 } },
    { key: 'pult.ui-theme.codeFontSize', label: 'Code text size', help: 'Code block text size in pixels.', control: 'number', type: 'int', default: 11, bounds: { min: 10, max: 16 } },
    { key: 'pult.ui-theme.terminalFontSize', label: 'Terminal text size', help: 'Terminal text size in pixels.', control: 'number', type: 'int', default: 13, bounds: { min: 10, max: 20 } },
    ...['text', 'code', 'terminal'].map((role) => ({ key: `pult.ui-theme.${role}FontFamily`, label: `${role[0]!.toUpperCase()}${role.slice(1)} font`,
      help: 'CSS font-family list; empty uses the built-in font stack.', control: 'text' as const, type: 'string' as const, default: '' })),
    { key: 'pult.ui-settings.enabled', label: 'Developer tools', help: 'Enable the vendored developer-tool views.', control: 'switch', type: 'bool', default: true },
    { key: 'pult.ui-settings.notifications', label: 'Completion notifications', help: 'Show a system notification when a lead or seat finishes.', control: 'switch', type: 'bool', default: true },
    { key: 'pult.ui-settings.notificationSound', label: 'Notification sound', help: 'Play the system sound with completion notifications.', control: 'switch', type: 'bool', default: true },
    { key: 'pult.ui-settings.density', label: 'Density', help: 'Choose comfortable or compact spacing.', control: 'select', type: 'enum', default: 'comfortable', options: ['comfortable', 'compact'] },
    { key: 'pult.locale.preference', label: 'Language', help: 'Language tag; null follows the browser language.', control: 'text', type: 'string', default: null, nullable: true },
  ];
  for (const row of rows) defineSetting({ ...common, ...row });
  defineSetting({
    key: 'pult.firstRunSkipped', label: 'First-run page skipped', category: 'pult', group: 'automation',
    tier: 'basic', control: 'switch', class: 'user', scope: 'install', type: 'bool',
    default: false, apply: 'restart',
    help: 'The BooHarness first-run page (sign in a family, pick the project folder, start the first lead) was skipped and must stay closed; turn this off to let it open again when no family is signed in and no lead exists.',
    reads: 'pult-dsh/packages/orch/ui-orch-first-run/src/client/first-run-model.ts probe() gate (task 3459 O1); default false keeps the page available on a fresh install.',
  });
}
