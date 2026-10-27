import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Compare filesystem identities: Node resolves the module but leaves argv[1] as typed. */
export function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
