import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyBundle } from './verifier.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

function report(root, value) {
  writeFileSync(path.join(root, 'update-result.json'), `${JSON.stringify({ ...value, at: new Date().toISOString() })}\n`, { mode: 0o600 });
}

const root = path.resolve(argument('--root'));
try {
  const current = JSON.parse(readFileSync(path.join(root, 'current.json'), 'utf8'));
  if (!/^versions\/[a-f0-9]{64}$/.test(current.directory)) throw new Error('unsafe current version directory');
  const currentDirectory = path.join(root, ...current.directory.split('/'));
  const manifest = verifyBundle(currentDirectory);
  if (manifest.entry !== current.entry || manifest.version !== current.version) throw new Error('current bundle pointer mismatch');
  const { activateStaged } = await import(pathToFileURL(path.join(currentDirectory, 'install', 'manager.mjs')).href);
  const pointer = JSON.parse(readFileSync(path.join(root, 'pending-update.json'), 'utf8'));
  activateStaged({ root, pointer });
  report(root, { status: 'activated', version: pointer.version });
} catch (error) {
  report(root, { status: 'rolled-back-or-failed', message: error.message });
  process.exitCode = 1;
}
