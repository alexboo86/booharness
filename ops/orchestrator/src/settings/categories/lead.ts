import { defineSetting } from '../registry.ts';
import { REPLY_LANGUAGE_PATTERN } from '../../../../../scripts/lib/harness-config.mjs';

/**
 * Lead behaviour keys (task 3459 slice C9, corrected): every key acts at its
 * owning read site, and each default keeps today's bytes exactly — instruction
 * files, lead child argv, drain behavior and the hook's rule delivery.
 */
export function registerLead(): void {
  defineSetting({
    key: 'lead.replyLanguage', label: 'Lead reply language', category: 'lead', group: 'automation',
    tier: 'basic', control: 'text', class: 'user', scope: 'install', type: 'string', nullable: true,
    default: null, pattern: REPLY_LANGUAGE_PATTERN, apply: 'restart',
    help: 'Choose the lead’s reply language for its instruction files; default null keeps the language from the checkout configuration. Changes reach those files at the next installer run.',
    reads: 'install-harness.mjs installInstructions: the stored value wins over the checkout config (harness-config.mjs lead.replyLanguage, absent means Russian); both pass the same rule (replyLanguageRefusal), so the settings store and the config reader refuse the same names.',
  });
  defineSetting({
    key: 'lead.adhdRules', label: 'Short lead replies', category: 'lead', group: 'automation',
    tier: 'basic', control: 'switch', class: 'operator-only', scope: 'install', type: 'bool',
    default: true, apply: 'next-seat',
    help: 'Operator-only: give leads the short-reply rules when a session starts; default on keeps delivery enabled. Off stops delivery, and disabling plain reply style in the checkout configuration keeps the rules off even when this is on.',
    reads: 'session-start.mjs operatorRules (i-have-adhd body; the hook reads this key from the install document via readInstallSettings). The checkout config’s lead.plainStyle false overrides a stored true; a stored false suppresses regardless.',
  });
  defineSetting({
    key: 'lead.permissionMode', label: 'Lead permissions', category: 'lead', group: 'safety',
    tier: 'advanced', control: 'select', class: 'operator-only', scope: 'install', type: 'enum',
    default: 'default', options: ['default', 'plan', 'bypassPermissions'], apply: 'restart',
    help: 'Operator-only: choose the permission mode for newly started supervised leads after a daemon restart; default leaves the launch command unchanged. A model must not raise its own permissions; a provider that cannot honor the chosen mode, or unreadable settings, prevents the lead from starting.',
    reads: 'http.ts createHttpServer reads it once per daemon start into LeadDriver (apply restart); a claude lead started afterwards carries --permission-mode <mode> (claude-lead.ts buildSpawn), and a provider whose permissionModes cannot honour a set mode, or an unreadable settings document, refuses the lead start (lead-driver.ts) instead of ignoring the key.',
  });
  defineSetting({
    key: 'lead.restartWhenIdle', label: 'Restart after work finishes', category: 'lead', group: 'automation',
    tier: 'advanced', control: 'switch', class: 'operator-only', scope: 'install', type: 'bool',
    default: true, apply: 'live',
    help: 'Operator-only: allow a harness change to restart the daemon by drain; default on waits for current work to finish before restarting. Off refuses the when-idle restart, so the operator must restart it manually.',
    reads: 'http.ts /restart reads it per request (readInstallSetting): false refuses before any notice post or drain flag (apply live); main.ts restart --when-idle relays the refusal.',
  });
  defineSetting({
    key: 'lead.wake', label: 'Wake supervised leads for chat', category: 'lead', group: 'automation',
    tier: 'advanced', control: 'switch', class: 'operator-only', scope: 'install', type: 'bool',
    default: true, apply: 'live',
    help: 'Operator-only: on (default) an addressed non-FYI chat post wakes its supervised lead; a busy lead receives one coalesced turn at turn end. Off leaves posts unread and no supervised wake turn running.',
    reads: 'lead-wake.ts (task 3459 L2) reads it at every delivery attempt (readInstallSetting, apply live): false defers the pending batch without sending or receipt; an unreadable settings document also defers and names the failure in one status frame.',
  });
  defineSetting({
    key: 'lead.handover', label: 'Self handover at the context limit', category: 'lead', group: 'automation',
    tier: 'advanced', control: 'switch', class: 'operator-only', scope: 'install', type: 'bool',
    default: true, apply: 'live',
    help: 'Operator-only autonomy: on (default) a supervised lead that reaches the handover limit is asked to write memoryctl handoff and is restarted on the verified id; off keeps the session running with no self handover.',
    reads: 'lead-handover.ts (task 3459 L1) reads it at every supervised turn end and immediately before every pending restart, including card settlement and async verification (readInstallSetting, apply live): false stops the ask and any pending restart; a document the reader refuses stops them too, with one status frame naming the read failure.',
  });
  defineSetting({
    key: 'lead.secretsVeil', label: 'Mask lead tool results', category: 'lead', group: 'safety',
    tier: 'advanced', control: 'switch', class: 'operator-only', scope: 'install', type: 'bool',
    default: true, apply: 'live',
    help: 'Operator-only: mask secret values in a supervised lead’s tool results before its model reads them (the vendored secrets-veil mod); default on. Off gives the model raw results and says so in one status line at spawn; a mask failure withholds the result either way. Off stops the driver’s loading only — a secrets-veil plugin in your own claude settings still masks.',
    reads: 'lead-driver.ts reads it per child spawn (readInstallSetting, apply live: a running child keeps its state and the next start or crash restart sees the change; an unreadable document keeps the mask on and names the failure in one status frame at spawn). claude-lead.ts then loads the vendored secrets-veil plugin for the child through CLAUDE_CODE_PLUGIN_DIRS; pi-lead.ts arms ORCH_PI_LEAD_SECRETS_VEIL and pi-extension.ts masks in its tool_result handler.',
  });
}
