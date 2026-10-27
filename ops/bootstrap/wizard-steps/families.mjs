// The one family answer for the agent path (operator decision 17731 removed
// the setup wizard): `node ops/bootstrap/resolve-runtime-path.mjs --families`
// prints `probeFamilies` and writes nothing. Each family is shown with two
// facts from a probe: is its runtime found (Claude Code or pinned Pi) and the
// state of its login (the file-only proof). No login is started here; this
// reports the state each login already has.
import path from 'node:path';
import { checkLogin as checkFamilyLogin } from '../../../scripts/lib/family-logins.mjs';
import { HARNESS_FAMILIES } from '../../../scripts/lib/harness-config.mjs';
import { canonicalSearchDirs, FAMILY_CLI_NAMES, pinnedPi, resolveOnPath } from '../resolve-runtime-path.mjs';

export function defaultFindCli(family, home) {
  if (typeof home !== 'string' || !home) throw new Error('the families probe requires home');
  if (FAMILY_CLI_NAMES[family]?.length === 0) {
    try { return pinnedPi(); } catch { return null; }
  }
  const searchDirs = canonicalSearchDirs({ home });
  for (const name of FAMILY_CLI_NAMES[family] ?? []) {
    const found = resolveOnPath(name, searchDirs);
    if (found) return found;
  }
  return null;
}

export function defaultCheckLogin(family, home) {
  return checkFamilyLogin(family, { home, orchStateDir: path.join(home, '.local', 'state', 'orch') });
}

function cliFact(family, cli) {
  const runtime = FAMILY_CLI_NAMES[family]?.length ? 'CLI' : 'pinned Pi';
  return cli ? `${runtime} found at ${cli}` : `${runtime} not found`;
}

function loginFact(proof, error) {
  if (error) return `login check failed (${String(error?.message ?? error)})`;
  return `login ${proof.state} (${proof.detail})`;
}

// Runtime availability is independent of login: step 3 offers sign-in later.
// A credential alone cannot make an absent runtime work here.
export function works(cli) {
  return Boolean(cli);
}

// The judgment of every family: the rows it shows and the families that work
// here. `resolve-runtime-path.mjs --families` prints the same answer, so an
// agent that follows the install prompt reads what the command reads.
export function probeFamilies({ findCli, checkLogin, home }) {
  const working = [];
  const rows = [];
  for (const family of HARNESS_FAMILIES) {
    const cli = findCli(family, home);
    let proof = null;
    let error = null;
    try {
      proof = checkLogin(family, home);
    } catch (thrown) {
      error = thrown;
    }
    if (works(cli)) working.push(family);
    rows.push(`${family}: ${cliFact(family, cli)}; ${loginFact(proof, error)}`);
  }
  return { rows, working };
}
