// STE summary for a finished report. The switch is read at each call. Mode off,
// or a missing dictionary, is null: the digest then has no language key.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { check } from '../../../scripts/ste-check.mjs';
import { readLanguageMode } from './shared.entry.ts';

export type LanguageSummary = {
  judgedWords: number;
  violationsPer100Words: number;
  technicalNameShare: number;
  rejected: { word: string; alternatives: string[] }[];
  unknown: string[];
  longSentences: number;
};

const WORD_CAP = 5;
const dictionaries = new Map<string, { mtimeMs: number; dictionary: object }>();

function dictionary(stateDir: string): object | null {
  const file = path.join(stateDir, 'ste', 'dictionary.json');
  let stamp;
  try { stamp = statSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stamp.isFile()) return null;
  const cached = dictionaries.get(file);
  if (cached && cached.mtimeMs === stamp.mtimeMs) return cached.dictionary;
  const loaded = JSON.parse(readFileSync(file, 'utf8')) as object;
  dictionaries.set(file, { mtimeMs: stamp.mtimeMs, dictionary: loaded });
  return loaded;
}

/** Null when the switch is off or the dictionary file is missing. Otherwise the checker's counts, capped at five words. */
export function steSummary(text: string, stateDir: string): LanguageSummary | null {
  if (readLanguageMode(stateDir).mode === 'off') return null;
  const loaded = dictionary(stateDir);
  if (!loaded) return null;
  const result = check(text, { dictionary: loaded });
  return {
    judgedWords: result.judgedWords,
    violationsPer100Words: result.violationsPer100Words,
    technicalNameShare: result.technicalNames.share,
    rejected: result.rejected.slice(0, WORD_CAP).map((row: { key: string; alternatives: string[] }) => ({
      word: row.key,
      alternatives: [...row.alternatives],
    })),
    unknown: result.unknown.slice(0, WORD_CAP).map((row: { key: string }) => row.key),
    longSentences: result.sentences.length.violation,
  };
}
