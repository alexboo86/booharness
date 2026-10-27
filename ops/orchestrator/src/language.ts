// Operator language switch. Read at each use, not at daemon startup, so
// `language off` takes effect for the next read without a restart. A missing,
// non-JSON or unknown-mode file is off: a rollback must never end in enforce.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const LANGUAGE_MODES = ['off', 'flag', 'enforce'] as const;
export type LanguageMode = (typeof LANGUAGE_MODES)[number];
export type LanguageRead = { mode: LanguageMode; fault?: string };

export const languageFile = (stateDir: string): string => path.join(stateDir, 'language.json');

function isLanguageMode(value: unknown): value is LanguageMode {
  return typeof value === 'string' && (LANGUAGE_MODES as readonly string[]).includes(value);
}

/** A missing file is off with no fault. Non-JSON, an unknown mode, and any other read error are off and name the fault. A read error other than a missing file names the file and the error code; it is not thrown. */
export function readLanguageMode(stateDir: string): LanguageRead {
  const file = languageFile(stateDir);
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { mode: 'off' };
    return { mode: 'off', fault: `${file}: ${code || 'read error'}` };
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return { mode: 'off', fault: `${file}: not JSON` }; }
  const mode = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as { mode?: unknown }).mode
    : undefined;
  if (!isLanguageMode(mode)) return { mode: 'off', fault: `${file}: unknown mode` };
  return { mode };
}

/** Replace the switch by renaming a temporary file in the same directory. A failed write never truncates the live file. */
export function writeLanguageMode(stateDir: string, mode: LanguageMode): void {
  if (!isLanguageMode(mode)) throw new Error(`unknown language mode '${String(mode)}'; expected off, flag or enforce`);
  mkdirSync(stateDir, { recursive: true });
  const file = languageFile(stateDir);
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ mode })}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}

/**
 * The STE rule block of a seat's first message (task 2164, plan 14879 D6): the text of rule.md
 * while the switch is flag or enforce, read at each call so `language off` takes effect on the next
 * message. `off`, a fault and a missing rule file are null, and this never throws: with a null
 * block every seat message is byte-identical to a session with no switch. `ruleFile` is a test
 * seam; production callers pass the state directory only.
 */
export function steRuleBlock(stateDir: string, ruleFile: string | URL = new URL('../ste/rule.md', import.meta.url)): string | null {
  try {
    const read = readLanguageMode(stateDir);
    if ((read.mode === 'flag' || read.mode === 'enforce') && !read.fault) return readFileSync(ruleFile, 'utf8');
    return null;
  } catch { return null; }
}
