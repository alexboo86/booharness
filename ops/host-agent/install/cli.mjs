#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installAgent, parsePairing, uninstallAgent } from './manager.mjs';

async function pairingFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const line = Buffer.concat(chunks).toString('utf8').split(/\r?\n/, 1)[0];
  return parsePairing(line);
}

function argumentsOf(argv) {
  const result = { action: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--bundle', '--home', '--node'].includes(key) || !argv[index + 1]) throw new Error(`invalid argument ${key}`);
    result[key.slice(2)] = argv[++index];
  }
  return result;
}

async function main() {
  const args = argumentsOf(process.argv.slice(2));
  const home = args.home ? path.resolve(args.home) : os.homedir();
  if (args.action === 'uninstall') {
    if (args.bundle || args.node) throw new Error('uninstall accepts only --home');
    uninstallAgent({ home });
    return;
  }
  if (args.action !== 'install' || !args.bundle) throw new Error('usage: install --bundle <tar> [--home <dir>] [--node <node>] or uninstall [--home <dir>]');
  const pairing = await pairingFromStdin();
  const result = installAgent({ home, nodePath: args.node ?? process.execPath, artifact: path.resolve(args.bundle), pairing });
  process.stdout.write(`Installed orch host agent ${result.version} in ${result.root}\n`);
}

function isMain() {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); }
  catch { return false; }
}

if (isMain()) main().catch(error => {
  process.stderr.write(`orch host agent install: ${error.message}\n`);
  process.exitCode = 1;
});
