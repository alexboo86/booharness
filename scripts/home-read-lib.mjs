// One answer to "this file is not readable from where I run", shared by every
// sensor that reads the operator's LIVE machine home.
//
// A Paseo member seat is sandboxed away from `~/.claude`, and the two failure
// shapes it produces are both wrong on their own:
//
//   - an unguarded `readFileSync` throws EPERM and takes the WHOLE sensor down,
//     so a member reports a defect where there is only a wall (measured round r3:
//     `test:harness-audit` died on `~/.claude/settings.json` before it judged
//     anything);
//   - an `existsSync` guard passes on a path the process may stat but not open,
//     so the sensor silently judges an EMPTY file and calls the result green.
//
// The answer is a NAMED skip: not a failure, not silence. The caller keeps its
// own `skipped` array, prints it, and counts it in the summary — a reader then
// sees what was not measured instead of guessing.
//
// ENOENT is NOT caught here. A file that is genuinely absent is an answer, and
// each caller already knows what absence means for it.
import { readFileSync } from 'node:fs';

/** Codes that mean "the wall", not "the answer". */
export const UNREADABLE = new Set(['EPERM', 'EACCES']);

/**
 * Build a reader bound to the caller's `skipped` array.
 *
 * Returns the file's text, or `null` when the path exists but this process may
 * not open it — and in that case pushes one line naming the path and the code.
 */
export function homeReader(skipped) {
  return function readHome(path, label) {
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      if (UNREADABLE.has(error?.code)) {
        skipped.push(
          `${path} — ${label}: not readable from here (${error.code}); a sandboxed seat cannot audit the operator's live home`,
        );
        return null;
      }
      throw error;
    }
  };
}
