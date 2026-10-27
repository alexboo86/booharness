#!/usr/bin/env node
// Task 2414 S2: the agent opens a terminal; credentials go directly from the
// human to the provider's own login UI, never through this process.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLogin, loadFamilyLogins } from '../../scripts/lib/family-logins.mjs';
import { isMain } from '../../scripts/lib/is-main.mjs';
import { canonicalSearchDirs, pinnedPi, resolveOnPath } from './resolve-runtime-path.mjs';

const USAGE = 'usage: harness-login <family> [--quota] [--force]';
const secretScript = fileURLToPath(new URL('./harness-secret.mjs', import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function terminalCommand(login) {
  const words = login.command.split(' ');
  // This is a script, not a PATH alias. Resolve it relative to this module so
  // an arbitrary cwd (or a checkout path containing spaces) works as well.
  if (words[0] === 'harness-secret') {
    words.splice(0, 1, process.execPath, secretScript);
  } else if (words[0] === 'pi') {
    try {
      words.splice(0, 1, process.execPath, pinnedPi());
    } catch {
      console.error('pinned Pi CLI not found; run npm ci in ops/pi-runtime before logging in.');
      return null;
    }
    // Pi 1.3.0 has no startup /login flag; positional text is a model prompt.
    // Keep the provider instruction in scrollback instead of clearing it on
    // entry to the default fullscreen alternate screen.
    words.push('--tui-mode', 'regular');
  } else {
    const cli = resolveOnPath(words[0], canonicalSearchDirs());
    if (!cli) {
      console.error(`${words[0]} login CLI not found in canonical directories; install it before logging in.`);
      return null;
    }
    words[0] = cli;
  }
  if (process.platform === 'win32') {
    const literal = (word) => `'${word.replaceAll("'", "''")}'`;
    const argument = (word) => /^[A-Za-z0-9._-]+$/.test(word) ? word : literal(word);
    // PowerShell requires the call operator for a quoted executable path.
    const command = `${path.isAbsolute(words[0]) ? '& ' : ''}${words.map(argument).join(' ')}`;
    return login.provider
      ? `Write-Output ${literal(`type /login ${login.provider}`)}; ${command}`
      : command;
  }
  const command = words.map(quote).join(' ');
  return login.provider
    ? `printf '%s\\n' ${quote(`type /login ${login.provider}`)}; ${command}`
    : command;
}

function main() {
  const [family, ...flags] = process.argv.slice(2);
  if (!family || flags.some((flag) => !['--quota', '--force'].includes(flag))
    || new Set(flags).size !== flags.length) {
    console.error(USAGE);
    return 2;
  }
  const logins = loadFamilyLogins();
  if (!Object.hasOwn(logins, family)) {
    console.error('unknown login');
    return 2;
  }
  const descriptor = logins[family];
  let login = descriptor.terminalLogin;
  if (flags.includes('--quota')) {
    if (descriptor.usageCredential?.kind === 'chrome-cookie') {
      console.error(`${family} quota uses a Chrome session; there is no quota-only terminal login.`);
      return 3;
    }
    login = descriptor.usageCredential?.login;
    if (!login) {
      console.error(`${family} has no quota-only login.`);
      return 3;
    }
  }
  if (!login) {
    console.error('no terminal login descriptor');
    return 1;
  }
  if (process.platform === 'darwin' && family === 'claude' && !flags.includes('--force')) {
    const home = os.homedir();
    const proof = checkLogin(family, { home, orchStateDir: path.join(home, '.local', 'state', 'orch') });
    // An unknown file proof cannot disprove the running Claude Code session or
    // its Keychain login. A second login rotates that token (decision 10650).
    if (proof.state === 'unknown') {
      console.error('Claude login is unknown (Keychain is not read); refusing a second login that may rotate the current token. Use --force only to sign in again intentionally.');
      return 1;
    }
  }
  const command = terminalCommand(login);
  if (!command) return 1;
  if (process.platform !== 'darwin') {
    console.log(`Run in your own terminal (automatic window launch not measured on ${process.platform}):\n${command}`);
    return 3;
  }
  // Opening a .command document avoids Apple Events and Automation consent.
  const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-login-'));
  const file = path.join(directory, 'login.command');
  let opened = false;
  try {
    chmodSync(directory, 0o700);
    writeFileSync(file, `/bin/rm -f -- ${quote(file)}; /bin/rmdir -- ${quote(directory)}\n${command}\n`, {
      mode: 0o700, flag: 'wx',
    });
    chmodSync(file, 0o700);
    const result = spawnSync('open', ['-a', 'Terminal', file], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
    });
    if (result.error || result.status !== 0) {
      console.error('could not open the login terminal; no login was confirmed');
      return 1;
    }
    opened = true;
  } finally {
    if (!opened) rmSync(directory, { recursive: true, force: true });
  }
  console.log(`Opened ${family}${flags.includes('--quota') ? ' quota' : ''} login in a new terminal; sign in there, then run harness-secret.mjs has ${family}.`);
  return 0;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch {
    // Credential readers and process errors must never echo file contents.
    console.error('cannot prepare the login terminal; no login was confirmed');
    process.exitCode = 1;
  }
}
