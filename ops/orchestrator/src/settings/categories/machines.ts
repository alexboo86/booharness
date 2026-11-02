import { defineSetting } from '../registry.ts';

export function registerMachines(): void {
  defineSetting({
    key: 'machines.defaultPlacement', label: 'Default placement', category: 'machines', group: 'seats',
    tier: 'basic', control: 'select', class: 'user', scope: 'install', type: 'enum',
    default: 'any', options: ['any', 'mac', 'win'], apply: 'next-seat',
    help: 'Placement need for a new seat when needs is omitted. Explicit needs, hosts and host-bound scouts keep their placement rules, and a seat that must stay on this Mac keeps the omitted-needs placement with the cause in its placement reason. The default, any, keeps today’s omitted-needs placement.',
    reads: 'seats-create.ts:298 defaultPlacement; any preserves today’s omitted-needs placement, and a Mac-pinned seat keeps it whatever the default.',
  });
  defineSetting({
    key: 'machines.retentionMultiplier', label: 'Coder retention multiplier', category: 'machines', group: 'safety',
    tier: 'advanced', control: 'number', class: 'operator-only', scope: 'install', type: 'number',
    default: 1, bounds: { min: 0.1, max: 365 }, apply: 'live',
    help: 'Scale both unlanded coder idle close (2 days) and the wait after close before checkout removal (1 day). Backup, ownership and active-turn safeguards remain mandatory; landed and never-prompted close rules stay unchanged. The default, 1, keeps the two-day close and the one-day wait.',
    reads: 'seats-close.ts:248 idle close and :295 checkout grace; prune.ts:873, :1189, :1207, :1254 backup/removal age guards; 1 preserves today’s 2-day/1-day intervals.',
  });
  defineSetting({
    key: 'machines.agentPort', label: 'Host-agent listener port', category: 'machines', group: 'tools',
    tier: 'advanced', control: 'number', class: 'operator-only', scope: 'install', type: 'int',
    default: 7762, bounds: { min: 0, max: 65535 }, apply: 'restart',
    help: 'The LAN port of the host-agent listener that paired machines connect to. The listener stays off until a host uses the agent transport or a pairing window opens, it closes on daemon shutdown and drain, and it never binds a board port. 0 binds a free port and is for tests only, because paired machines reconnect to a fixed address. The default, 7762, keeps the listener beside the 7760 and 7761 board ports.',
    reads: 'http-hosts.ts reads machines.agentPort when the listener binds (readInstallSetting); the pair window and orch_status report the bound port.',
  });
  defineSetting({
    key: 'machines.autoCodegraphInit', label: 'Initialize seat codegraph', category: 'machines', group: 'tools',
    tier: 'advanced', control: 'switch', class: 'operator-only', scope: 'install', type: 'bool',
    default: true, apply: 'next-seat',
    help: 'Automatically seed and initialize codegraph for new local and remote seat checkouts. Disabling this skips index setup only, not other provisioning or instrument admission. The default, on, keeps automatic indexing.',
    reads: 'seats-provision.ts:96, :128, :162 passes the setting to worktrees.ts:666 and remote-provision.ts:382; provision-worktree.sh:102 also honors the install boolean at SessionStart; true preserves today’s automatic indexing.',
  });
}
