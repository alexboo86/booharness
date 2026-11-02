import { SettingsError, type SettingValue } from './registry.ts';
import type { SettingsLinkAdapter } from './store.ts';

/** Compose link owners without another store slot or another publication path. */
export function composeSettingsLinks(...adapters: SettingsLinkAdapter[]): SettingsLinkAdapter {
  const snapshot = () => {
    const reads = adapters.map(adapter => adapter.read());
    const owners = new Map<string, number>();
    const source: Record<string, string> = {};
    for (const [index, read] of reads.entries()) {
      for (const { key } of read.definitions) {
        if (owners.has(key)) throw new SettingsError(400, `${key}: overlapping link adapters`);
        owners.set(key, index);
        source[key] = typeof read.source === 'string' ? read.source : read.source[key];
        if (!source[key]) throw new SettingsError(400, `${key}: missing linked source`);
      }
    }
    return { reads, owners, source };
  };
  return {
    read() {
      const { reads, source } = snapshot();
      return { definitions: reads.flatMap(read => read.definitions),
        values: Object.assign({}, ...reads.map(read => read.values)), source,
        fingerprint: JSON.stringify(reads.map(read => read.fingerprint)) };
    },
    prepare(changes) {
      const { owners } = snapshot();
      const batches = adapters.map(() => ({} as Record<string, SettingValue>));
      for (const [key, value] of Object.entries(changes)) {
        const index = owners.get(key);
        if (index === undefined) throw new SettingsError(400, `${key}: unknown linked setting`);
        batches[index][key] = value;
      }
      return adapters.flatMap((adapter, index) => Object.keys(batches[index]).length ? adapter.prepare(batches[index]) : []);
    },
  };
}
