#!/usr/bin/env node
// harness-secret — the one verb that puts a key into its store (task 2275,
// slice L1b). `set <name>` reads each entry of the login with hidden input
// from the user's own terminal and writes the provider's own store; `has
// <name>` answers yes or no. The question is the descriptor's human prompt,
// never the entry path. The value never reaches argv, stdout, stderr,
// an error message or a log: it travels only from the terminal (or an
// injected reader in tests) into scripts/lib/family-logins.mjs, whose writer
// keeps it out of every message. Descriptors: ops/bootstrap/family-logins.json.
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { checkLogin, keyLogin, writeLoginSecrets } from '../../scripts/lib/family-logins.mjs';
import { isMain } from '../../scripts/lib/is-main.mjs';

const USAGE = [
  'usage: harness-secret set <name>   read each entry with hidden input and store it',
  '       harness-secret has <name>   print yes or no, exit 0 or 1',
].join('\n');

function orchStateDirFor(home) {
  // The glm provider reads stateDirFor(home) with no environment override
  // (ops/orchestrator/src/providers/index.ts glmEnv, install-harness.mjs
  // migrateOrchProviders), so the verb writes exactly that path.
  return path.join(home, '.local', 'state', 'orch');
}

// Hidden input: readline echoes to its output stream, so the output is a
// stream that writes nothing. The prompt goes to the real stdout before it.
function hiddenRead(prompt, { stdin, stdout }) {
  return new Promise((resolve, reject) => {
    const muted = new Writable({
      write(chunk, encoding, callback) {
        callback();
      },
    });
    stdout.write(prompt);
    const rl = readline.createInterface({ input: stdin, output: muted, terminal: true });
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(answer);
    };
    rl.question('', finish);
    rl.on('close', () => finish(''));
    rl.on('error', (error) => {
      if (settled) return;
      settled = true;
      rl.close(); // echo and terminal state are restored on every path
      reject(error);
    });
  });
}

async function verbSet(name, { home, stdin, stdout, stderr, read }) {
  let shape;
  try {
    shape = keyLogin(name);
  } catch (error) {
    stderr.write(`${error?.message ?? 'unknown login'}\n`);
    return 1;
  }
  if (shape.command) {
    stderr.write(`${name} signs in with its own command: ${shape.command}\n`);
    return 1;
  }
  let reader = read;
  if (!reader) {
    if (!stdin.isTTY) {
      stderr.write('run harness-secret set in a terminal; the value is read with hidden input\n');
      return 1;
    }
    reader = (prompt) => hiddenRead(prompt, { stdin, stdout });
  }
  const values = {};
  try {
    for (const entry of shape.entries) {
      const label = shape.prompts?.[entry];
      if (typeof label !== 'string' || label.length === 0) {
        // Never fall back to the entry path: that string is not a question,
        // and this message must not carry a value.
        stderr.write('family logins: entry has no prompt\n');
        return 1;
      }
      const value = await reader(`${label}: `);
      if (value === '') {
        // Ctrl-C or Ctrl-D closed the input (readline resolves the close with
        // an empty answer): stop at once, ask for no more values, write nothing.
        stderr.write('input closed; nothing was written\n');
        return 1;
      }
      values[entry] = value;
    }
  } catch {
    // A reader error can carry the value in its message; a fixed text cannot.
    stderr.write('cannot read the value; nothing was written\n');
    return 1;
  }
  try {
    writeLoginSecrets(name, { home, orchStateDir: orchStateDirFor(home), values });
  } catch (error) {
    stderr.write(`${error?.message ?? 'cannot write the credential store'}\n`);
    return 1;
  }
  stdout.write(`stored ${shape.entries.length} ${shape.entries.length === 1 ? 'entry' : 'entries'}\n`);
  return 0;
}

function verbHas(name, { home }) {
  try {
    const state = checkLogin(name, { home, orchStateDir: orchStateDirFor(home) }).state;
    return state === 'ok' ? { text: 'yes\n', code: 0 } : { text: 'no\n', code: 1 };
  } catch (error) {
    // A store that cannot be proved is not a yes; the reason names no value.
    return { text: 'no\n', code: 1, reason: `${error?.message ?? 'credential file is unreadable'}\n` };
  }
}

// The test seam is `read`: an injected reader function (async (prompt) =>
// value). Without it the value comes only from a TTY stdin with hidden input.
// The CLI cannot receive a state directory outside home: the store always
// lands at stateDirFor(home), where the glm provider reads it (correction 8).
export async function runSecretVerb({
  args = [],
  home = os.homedir(),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  read = null,
} = {}) {
  if (args.length !== 2 || !['set', 'has'].includes(args[0])) {
    stderr.write(`${USAGE}\n`);
    return { code: 2 };
  }
  const [verb, name] = args;
  if (verb === 'set') return { code: await verbSet(name, { home, stdin, stdout, stderr, read }) };
  const answer = verbHas(name, { home });
  stdout.write(answer.text);
  if (answer.reason) stderr.write(answer.reason);
  return { code: answer.code };
}

async function main() {
  const code = (await runSecretVerb({ args: process.argv.slice(2) })).code;
  process.exit(code);
}

if (isMain(import.meta.url)) {
  await main();
}
