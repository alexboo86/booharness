import { defineSetting } from '../registry.ts';
import { SETTINGS_FAMILIES } from './seats.ts';

export function registerRouting(): void {
  defineSetting({
    key: 'routing.manual', label: 'Choose family shares', category: 'routing', group: 'models',
    tier: 'basic', control: 'switch', class: 'user', scope: 'install', type: 'bool',
    default: false, apply: 'next-seat',
    help: 'Default off keeps automatic family choice: use budget before it resets, spread work across families, then prefer spare spending capacity, including saved credit from a weekly reset. On ranks each family by its percentage divided by one plus its working seats in this role; zero shares are excluded. Short-term budget limits, expected spending, pauses and reviewer independence still apply.',
    reads: 'profiles.ts:580-612 pickFamily; default false keeps today’s automatic pace ordering.',
  });
  defineSetting({
    key: 'routing.percentages', label: 'Work shares by family', category: 'routing', group: 'models',
    tier: 'basic', control: 'matrix', class: 'user', scope: 'install', type: 'percent-map',
    default: Object.fromEntries(SETTINGS_FAMILIES.map((family) => [family, 100 / SETTINGS_FAMILIES.length])),
    options: [...SETTINGS_FAMILIES], apply: 'next-seat',
    help: 'Set family percentages totalling 100 for manual selection; default equal shares do nothing while manual selection is off. Omitted families have zero share; shares guide simultaneous work, not guaranteed completed turns, and unavailable families are still skipped.',
    reads: 'profiles.ts:580-612 has no manual map today; equal dormant shares have no effect while routing.manual defaults off.',
  });
  defineSetting({
    key: 'routing.supportedFamilies', label: 'Allowed seat families', category: 'routing', group: 'models',
    tier: 'basic', control: 'list', class: 'user', scope: 'install', type: 'list',
    default: [...SETTINGS_FAMILIES], options: [...SETTINGS_FAMILIES], apply: 'next-seat',
    help: 'Choose families allowed for new seats, including those requested by name; default includes every supported family. Removing one never stops an existing seat; add it back to allow new seats again. An empty list refuses every new seat.',
    reads: 'providers/types.ts:5 FAMILIES; profiles.ts:581 and seats-create.ts:508 previously allow every supported family.',
  });
}
