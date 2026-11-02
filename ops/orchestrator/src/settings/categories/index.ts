import { registerRoutines } from './routines.ts';
import { registerDomainLeads } from './domain-leads.ts';
import { registerSeats } from './seats.ts';
import { registerRouting } from './routing.ts';
import { registerPlacement } from './placement.ts';
import { registerBudget } from './budget.ts';
import { registerGit } from './git.ts';
import { registerLogic } from './logic.ts';
import { registerInstruments } from './instruments.ts';
import { registerMemory } from './memory.ts';
import { registerJev } from './jev.ts';
import { registerJevScripts } from './jev-scripts.ts';
import { registerPresets } from './presets.ts';
import { registerLead } from './lead.ts';
import { registerGates } from './gates.ts';
import { registerPult } from './pult.ts';
import { registerMachines } from './machines.ts';

// One line per category, merged by union (.gitattributes): parallel slices add lines here.
const REGISTER = [
  registerSeats,
  registerRouting,
  registerPlacement,
  registerBudget,
  registerRoutines,
  registerGit,
  registerDomainLeads,
  registerLogic,
  registerInstruments,
  registerMemory,
  registerJev,
  registerJevScripts,
  registerPresets,
  registerLead,
  registerGates,
  registerPult,
  registerMachines,
];

let registered = false;
const completed = new Set<() => void>();

/** Registers every category once per process. A second store in the same process finds them defined. */
export function registerCategories(): void {
  if (registered) return;
  for (const register of REGISTER) {
    if (completed.has(register)) continue;
    register();
    completed.add(register);
  }
  registered = true;
}
