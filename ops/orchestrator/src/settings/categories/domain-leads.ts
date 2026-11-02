import { defineSetting } from '../registry.ts';

/**
 * Task 3459 C13 (decision 22510): domain leads become optional. Defaults keep today's behavior —
 * the registry gates unconditionally — so only a changed value changes a landing or an assign.
 */
export function registerDomainLeads(): void {
  defineSetting({
    key: 'domainLeads.enabled', label: 'Domain leads', category: 'domain-leads', group: 'safety',
    tier: 'basic', control: 'switch', class: 'operator-only', scope: 'install', type: 'bool',
    default: true, apply: 'live',
    help: 'Require domain leads to approve changes in their areas; default on keeps these checks. Off treats the repository as having no domain leads: changes need no domain consent, but lead assignments are kept.',
    reads: 'land-domain.ts:117 landDomainScope gates landings and land-domain.ts:36 domainLeadsRegistered gates seat_create (seats-create.ts:38) on registry domain-native-leads-v1.',
  });
  defineSetting({
    key: 'domainLeads.domains', label: 'Domains needing consent', category: 'domain-leads', group: 'safety',
    tier: 'advanced', control: 'list', class: 'operator-only', scope: 'install', type: 'list',
    default: null, nullable: true, apply: 'live',
    help: 'Choose which domains require owner consent for changes and may receive new lead assignments; default null includes all domains, while an empty list requires no consent. Unlisted paths need no consent; existing assignments still identify leads.',
    reads: 'scripts/memory/domain-leads.mjs:215 assign accepts any known active domain today; land-domain.ts:26 assignments() gates per assignment.',
  });
}
