import { defineSetting } from '../registry.ts';

export function registerPlacement(): void {
  for (const [key, label, value, unit] of [
    ['reserveCores', 'Keep CPU cores free', 6, 'cores'],
    ['reserveMemoryGb', 'Keep memory free (GB)', 12, 'GB'],
  ] as const) {
    defineSetting({
      key: `placement.${key}`, label, category: 'placement', group: 'seats',
      tier: 'advanced', control: 'number', class: 'user', scope: 'install', type: 'int',
      default: value, bounds: { min: 0 }, apply: 'next-seat',
      help: `Subtract this many ${unit} from the daemon machine’s free capacity when automatically choosing a seat machine, never counting less than zero; default ${value} keeps the current reserve. Explicit machine choices and required operating systems remain unchanged.`,
      reads: `placement.ts:371 MAC_RESERVE; default ${value} ${unit} is today’s local reserve.`,
    });
  }
}
