// Side-effect import for tests that can execute jev-client. A missing pin writes
// the operator ledger at ~/.local/state/jev. Do not override an explicit dir:
// suites that already point JEV_STATE_DIR at their own temp keep that choice.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.JEV_STATE_DIR) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-state-'));
  process.env.JEV_STATE_DIR = dir;
  process.on('exit', () => { rmSync(dir, { recursive: true, force: true }); });
}
