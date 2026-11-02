import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyBundle } from './verifier.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

const root = path.resolve(argument('--root'));
const pointer = JSON.parse(readFileSync(path.join(root, 'current.json'), 'utf8'));
if (!/^versions\/[a-f0-9]{64}$/.test(pointer.directory)) throw new Error('unsafe current version directory');
const directory = path.join(root, ...pointer.directory.split('/'));
const manifest = verifyBundle(directory);
if (manifest.version !== pointer.version || manifest.entry !== pointer.entry) throw new Error('current pointer does not match the verified bundle');
const entry = await import(pathToFileURL(path.join(directory, ...manifest.entry.split('/'))).href);
if (typeof entry.runInstalled !== 'function') throw new Error(`${manifest.entry}: bundle entry has no runInstalled export`);
await entry.runInstalled(root);
