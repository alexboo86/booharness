import { contractSummary, moduleForPath, moduleIndex } from '../../../scripts/module-registry.mjs';

type ModuleBudgets = { perModule?: number; section?: number };

/** Daemon-checkout contract view; no routing, caches, or session state. */
export function renderModulesSection(rootDir: string, files: readonly string[], budgets: ModuleBudgets = {}): string {
  if (!files.length) return '';
  const perModule = budgets.perModule ?? 3 * 1024;
  const section = budgets.section ?? 9 * 1024;
  const modules = new Map<string, ReturnType<typeof moduleForPath>>();
  const notes: string[] = [];
  // Non-strict reads: a header key added after this daemon started must not
  // fail a seat's context build.
  const index = moduleIndex(rootDir, { strict: false });
  for (const file of new Set(files)) {
    const module = moduleForPath(rootDir, file, index);
    if (!module) notes.push(`\`${file}\`: no module (excluded or new outside every module)`);
    else {
      modules.set(module.id, module);
      if (module.conflicts) notes.push(`\`${file}\`: matched modules ${module.conflicts.join(', ')}; using ${module.id}`);
    }
  }
  const entries = [...modules.values()];
  const pointers = entries.map((module) => `- ${module.id}: read ${module.contract}`);
  const heading = '## Modules\n\nImport another module only through its `entry` or a file in its `sideEffectEntries`; a deep import fails check:commit and --write-baseline refuses it.';
  const join = (blocks: string[], remaining: string[]) =>
    [heading, ...blocks, ...remaining, ...notes].join('\n\n');
  if (Buffer.byteLength(join([], pointers)) > section) {
    const compact = [...pointers, ...notes];
    const lines = [heading];
    const omitted = (count: number) =>
      `... ${count} more modules or paths not shown; run node scripts/module-registry.mjs --check or read docs/contracts/module-index.md`;
    for (let i = 0; i < compact.length; i++) {
      const remaining = compact.length - i - 1;
      const candidate = [...lines, compact[i], ...(remaining ? [omitted(remaining)] : [])].join('\n\n');
      if (Buffer.byteLength(candidate) > section) {
        const marker = omitted(compact.length - i);
        const result = [...lines, marker].join('\n\n');
        if (Buffer.byteLength(result) <= section) return result;
        // Even a tiny custom budget must not refuse the seat.
        return Buffer.byteLength(marker) <= section ? marker : '';
      }
      lines.push(compact[i]);
    }
    return lines.join('\n\n');
  }
  const blocks: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const module = entries[i];
    const title = `### ${module.id}\n\nContract: \`${module.contract}\`\n\n`;
    const summaryBudget = perModule - Buffer.byteLength(title);
    if (summaryBudget < Buffer.byteLength(`... cut at ${summaryBudget} bytes; read ${module.contract}`)) {
      return join(blocks, pointers.slice(i));
    }
    const summary = contractSummary(rootDir, module.contract, summaryBudget, { strict: false });
    const block = title + summary;
    if (Buffer.byteLength(join([...blocks, block], pointers.slice(i + 1))) > section) {
      return join(blocks, pointers.slice(i));
    }
    blocks.push(block);
  }
  return join(blocks, []);
}
