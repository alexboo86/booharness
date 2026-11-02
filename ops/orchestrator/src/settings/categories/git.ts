import { defineSetting } from '../registry.ts';

export function registerGit(): void {
  defineSetting({
    key: 'git.syncCommits', label: 'Push commits to origin', category: 'git', group: 'automation',
    tier: 'basic', control: 'switch', class: 'operator-only', scope: 'project', type: 'bool',
    default: true, apply: 'live', help: 'Copy new commits to the origin repository on the local network; default on keeps this copying enabled. Never publishes automatically to other destinations.',
    reads: '.githooks/post-commit:81: git.syncCommits=false suppresses this checkout’s LAN sync.',
  });
  defineSetting({
    key: 'git.pushGate', label: 'Confirm external publication', category: 'gates', group: 'safety',
    tier: 'advanced', control: 'switch', class: 'operator-only', scope: 'project', type: 'bool',
    default: true, apply: 'live', help: 'Require publication confirmations before pushing commits outside the local-network copy; default on keeps this gate enabled. Deletion checks remain enabled even when this is off.',
    reads: '.githooks/pre-push:66: non-LAN pushes run the publication safety gate.',
  });
}
