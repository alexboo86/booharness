#!/usr/bin/env node
// harness-config — the verbs that read and change ops/bootstrap/harness.config.json
// (task 2275, slice Wz1). Each write goes through writeHarnessConfig
// (scripts/lib/harness-config.mjs): one key order, the reader's rules before
// the bytes are published, the installer lock, a temp file and a rename. A
// write also gives the config the wizard's spelling (wizardSpelling), so the
// verbs and the setup wizard publish the same bytes for the same answers. A
// refusal is one stderr line with exit 1 and changes no byte; a wrong call
// prints the usage with exit 2.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { HARNESS_CONFIG_SCHEMA, harnessKeyIsOptional, readHarnessConfig, wizardSpelling, writeHarnessConfig } from '../../scripts/lib/harness-config.mjs';
import { isMain } from '../../scripts/lib/is-main.mjs';

const USAGE = [
  'usage: harness-config validate               check the config file',
  '       harness-config get <key>              print the value of a dotted key as JSON',
  '       harness-config set <key> <JSON value> set one key',
  '       harness-config unset <key>            remove one optional key',
  '       harness-config apply <answers.json>   replace the whole config',
  'option: --home <dir>   the home directory whose installer lock a write takes,',
  '                       as --home of install-harness.mjs',
].join('\n');

const ARITY = { validate: 1, get: 2, set: 3, unset: 2, apply: 2 };
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEAVES = Object.keys(HARNESS_CONFIG_SCHEMA);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function leafOf(key) {
  if (!Object.hasOwn(HARNESS_CONFIG_SCHEMA, key)) throw new Error(`unknown key ${key}`);
  return key.split('.');
}

// The parent object of a leaf, made on the way when `create` is set.
function parentOf(config, parts, create) {
  if (!isObject(config)) throw new Error('the config file must hold an object');
  let node = config;
  for (const [index, part] of parts.slice(0, -1).entries()) {
    if (!Object.hasOwn(node, part)) {
      if (!create) return null;
      node[part] = {};
    }
    if (!isObject(node[part])) throw new Error(`${parts.slice(0, index + 1).join('.')} must be an object`);
    node = node[part];
  }
  return node;
}

function verbGet(key, { repoRoot }) {
  if (!LEAVES.some((leaf) => leaf === key || leaf.startsWith(`${key}.`))) throw new Error(`unknown key ${key}`);
  let value = readHarnessConfig({ repoRoot });
  for (const part of key.split('.')) value = value?.[part];
  if (value === undefined) throw new Error(`${key} is not set`);
  return `${JSON.stringify(value)}\n`;
}

async function verbWrite(verb, rest, { repoRoot, home }) {
  let config;
  if (verb === 'apply') {
    const answers = path.resolve(rest[0]);
    let text;
    try { text = readFileSync(answers, 'utf8'); }
    catch (error) { throw new Error(`Cannot read answers file ${answers}: ${error.message}`, { cause: error }); }
    try { config = JSON.parse(text); }
    catch (error) { throw new Error(`Invalid JSON in answers file ${answers}: ${error.message}`, { cause: error }); }
    config = wizardSpelling({ repoRoot, config });
  } else {
    const parts = leafOf(rest[0]);
    const name = parts.at(-1);
    if (verb === 'unset' && !harnessKeyIsOptional(rest[0])) {
      throw new Error(`${rest[0]} is a required key: unset takes an optional key only`);
    }
    let value;
    if (verb === 'set') {
      try { value = JSON.parse(rest[1]); }
      catch (error) { throw new Error(`the value of ${rest[0]} is not JSON: ${error.message}`, { cause: error }); }
    }
    // The writer drops a branch that unset left empty.
    config = (current) => {
      const parent = parentOf(current, parts, verb === 'set');
      if (verb === 'set') parent[name] = value;
      else if (parent) delete parent[name];
      return wizardSpelling({ repoRoot, config: current });
    };
  }
  const { file, changed } = await writeHarnessConfig({ repoRoot, home, config });
  return `${changed ? 'written' : 'unchanged'} ${file}\n`;
}

// The home of an installer run with the same --home and environment
// (install-harness.mjs main), so that both take one lock file.
function installerHome(flag) {
  return path.resolve(flag || process.env.HARNESS_HOME || process.env.HOME || process.env.USERPROFILE || os.homedir());
}

// --home <dir> as install-harness-args.mjs reads it: a value is required, it
// is not empty and it does not start with `--`.
function takeHome(args) {
  const at = args.indexOf('--home');
  if (at === -1) return { rest: args };
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) return { refusal: '--home requires a value' };
  if (!value) return { refusal: '--home requires a nonempty value' };
  return { rest: [...args.slice(0, at), ...args.slice(at + 2)], home: value };
}

export async function runConfigVerb({
  args = [],
  repoRoot = REPO,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const taken = takeHome(args);
  const [verb, ...rest] = taken.rest ?? [];
  if (taken.refusal || !Object.hasOwn(ARITY, verb) || taken.rest.length !== ARITY[verb]) {
    stderr.write(`${taken.refusal ? `${taken.refusal}\n` : ''}${USAGE}\n`);
    return { code: 2 };
  }
  const home = installerHome(taken.home);
  try {
    if (verb === 'validate') {
      readHarnessConfig({ repoRoot });
      stdout.write('ok\n');
    } else if (verb === 'get') {
      stdout.write(verbGet(rest[0], { repoRoot }));
    } else {
      stdout.write(await verbWrite(verb, rest, { repoRoot, home }));
    }
    return { code: 0 };
  } catch (error) {
    // A JSON parse message can quote text with line ends: a refusal stays one line.
    stderr.write(`${String(error?.message ?? error).replace(/\s*[\r\n]+\s*/g, ' ')}\n`);
    return { code: 1 };
  }
}

async function main() {
  const code = (await runConfigVerb({ args: process.argv.slice(2) })).code;
  process.exit(code);
}

if (isMain(import.meta.url)) {
  await main();
}
