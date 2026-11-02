import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SettingsError, validateSetting, type SettingDefinition } from './registry.ts';
import type { SettingsLinkAdapter } from './store.ts';

const KEY = 'gates.maxFileLines';

/** The ratchet baseline remains the sole owner of the limit, including its default. */
export function createRatchetSettingsAdapter(repoRoot: string): SettingsLinkAdapter {
  const file = path.join(repoRoot, 'docs/architecture/large-file-ratchet-baseline.json');
  const read = () => {
    const text = readFileSync(file, 'utf8');
    const document = JSON.parse(text);
    if (document?.version !== 1 || !Array.isArray(document.files)) throw new SettingsError(400, `${file}: invalid large-file baseline`);
    const definition: SettingDefinition = { key: KEY, label: 'Maximum source file lines', category: 'gates', group: 'safety',
      tier: 'advanced', control: 'number', class: 'operator-only', scope: 'link', type: 'int', bounds: { min: 1 },
      default: document.threshold, apply: 'live', help: 'Source files at or above this limit require a ratchet baseline entry. Raising it relaxes the gate.',
      reads: 'scripts/check-large-file-ratchet.mjs (baseline.threshold)' };
    try { validateSetting(definition, document.threshold); }
    catch (error) { throw new SettingsError(400, `${file}: ${(error as Error).message}`); }
    return { text, document, definition };
  };
  return {
    read() {
      const { text, document, definition } = read();
      return { definitions: [definition], values: { [KEY]: document.threshold }, source: file, fingerprint: text };
    },
    prepare(changes) {
      const { text, document, definition } = read();
      for (const [key, value] of Object.entries(changes)) {
        if (key !== KEY) throw new SettingsError(400, `${key}: unknown ratchet setting`);
        validateSetting(definition, value);
        document.threshold = value;
      }
      return [{ file, before: text, text: `${JSON.stringify(document, null, 2)}\n` }];
    },
  };
}
