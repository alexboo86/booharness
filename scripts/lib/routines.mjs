// Routine definitions shipped as data: one markdown file per routine under
// ops/routines/, with front matter (id, title, cron, summary) and a prompt
// body. A public install offers these to the user (scripts/routines.mjs list);
// the skill setup-routines creates the chosen ones with the scheduler tool of
// the lead app, because a scheduled task can be created only by that app.
//
// Loading validates: a parsable front-matter block with all four keys, an id
// that matches ^[a-z0-9][a-z0-9-]*$, a five-field cron, a non-empty prompt, and
// a unique id across the directory. Any fault throws with the file name in the
// message; there is no partial load.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROUTINES_DIR = path.resolve(HERE, '../../ops/routines');

const FRONT_KEYS = Object.freeze(['id', 'title', 'cron', 'summary']);
const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const LINE_RE = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/;
export const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

const fault = (file, message) => new Error(`ops/routines/${file}: ${message}`);

/** Parse one routine definition. `file` is the base name inside ops/routines/. */
export function parseRoutine(file, text) {
  const front = FRONT_RE.exec(text);
  if (!front) throw fault(file, 'no front matter block (--- ... ---)');
  const fields = new Map();
  for (const line of front[1].split(/\r?\n/)) {
    const kv = LINE_RE.exec(line);
    if (!kv) throw fault(file, `front matter line is not "key: value": ${line || '<empty>'}`);
    fields.set(kv[1], kv[2].trim());
  }
  for (const key of FRONT_KEYS) {
    if (!fields.get(key)) throw fault(file, `front matter misses a non-empty ${key}`);
  }
  const routine = {
    id: fields.get('id'),
    title: fields.get('title'),
    cron: fields.get('cron'),
    summary: fields.get('summary'),
    prompt: text.slice(front[0].length).trim(),
  };
  if (!ID_RE.test(routine.id)) throw fault(file, `id "${routine.id}" must match ${ID_RE}`);
  const fields5 = routine.cron.split(/\s+/);
  if (fields5.length !== 5 || fields5.some((field) => !field)) {
    throw fault(file, `cron "${routine.cron}" must have exactly five fields (minute hour day-of-month month day-of-week, local time)`);
  }
  if (!routine.prompt) throw fault(file, 'the prompt body is empty');
  return routine;
}

/** Load and validate every definition in `dir`, sorted by id. */
export function loadRoutines(dir = ROUTINES_DIR) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`routines directory not found: ${dir}`);
  }
  // CONTRACT.md is the module contract of this directory (task 2409), not a routine.
  const files = readdirSync(dir).filter((name) => name.endsWith('.md') && name !== 'CONTRACT.md').sort();
  for (const name of files) {
    // lstat, not stat: a symlink named like a routine must be refused, not followed
    // to the prompt of a file outside this directory.
    if (!lstatSync(path.join(dir, name)).isFile()) {
      throw fault(name, 'not a regular file (symlink or special entry)');
    }
  }
  const routines = [];
  const byId = new Map();
  for (const file of files) {
    const routine = parseRoutine(file, readFileSync(path.join(dir, file), 'utf8'));
    if (byId.has(routine.id)) {
      throw fault(file, `duplicate id "${routine.id}" (already defined by ${byId.get(routine.id)})`);
    }
    byId.set(routine.id, file);
    routines.push(routine);
  }
  return routines;
}
