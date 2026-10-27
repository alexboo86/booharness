import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// The kit wrapper owns the local writer's label and service tasks.
export function memoryInstallerFor(repoRoot) {
  return existsSync(resolve(repoRoot, 'ops/memory-local/install.mjs'))
    ? 'ops/memory-local/install.mjs' : 'ops/bootstrap/install-memory.mjs';
}
