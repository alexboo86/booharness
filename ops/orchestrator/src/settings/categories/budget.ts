import { defineSetting } from '../registry.ts';

export function registerBudget(): void {
  defineSetting({
    key: 'budget.alertAheadOfPace', label: 'Early spending warning', category: 'budget', group: 'models',
    tier: 'basic', control: 'switch', class: 'user', scope: 'install', type: 'bool',
    default: false, apply: 'next-seat',
    help: 'Warn in the seat’s family-selection explanation when a family has used a larger share of its budget than the share of the budget period elapsed; default off adds no warning. Budget reserved for planned work does not trigger it; warnings never block work.',
    reads: 'profiles.ts:667 pickFamily why; default false preserves today’s absence of an ahead-of-pace alert.',
  });
}
