#!/usr/bin/env node
// List the routine definitions the harness ships (ops/routines/*.md).
// The skill setup-routines shows this list to the user and creates the chosen
// routines with the scheduler tool of the lead app.
//
//   node scripts/routines.mjs list [--json]
import { loadRoutines } from './lib/routines.mjs';
import { isMain } from './lib/is-main.mjs';

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const usage = 'usage: node scripts/routines.mjs list [--json]';
  if (args.length < 1 || args.length > 2 || args[0] !== 'list'
    || (args[1] !== undefined && args[1] !== '--json')) {
    console.error(usage);
    process.exit(2);
  }
  const routines = loadRoutines();
  if (args[1] === '--json') {
    console.log(JSON.stringify(routines, null, 2));
  } else {
    for (const routine of routines) {
      console.log(`${routine.id}  ${routine.cron}  ${routine.title}`);
      console.log(`    ${routine.summary}`);
    }
  }
}
