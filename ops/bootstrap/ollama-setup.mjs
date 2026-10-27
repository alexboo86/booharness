#!/usr/bin/env node
// Usage: node ops/bootstrap/ollama-setup.mjs setup
// macOS service/model setup; the agent installs the pinned binary first.
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readHarnessConfig, harnessPaths, harnessLabel } from '../../scripts/lib/harness-config.mjs';
import { embed } from '../../scripts/memory/embed-recipe.mjs';
import { importPinnedEmbedModel, readEmbedImportPin } from '../../scripts/lib/import-embed-model.mjs';

if (process.argv.length !== 3 || process.argv[2] !== 'setup') {
  console.error('Usage: node ops/bootstrap/ollama-setup.mjs setup');
  process.exit(2);
}
if (process.platform !== 'darwin') throw Error('These Ollama commands are macOS only');
const c = readHarnessConfig({ repoRoot: process.cwd() });
const pins = JSON.parse(fs.readFileSync('ops/bootstrap/tool-pins.json', 'utf8'));
const version = pins.ollama;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid Ollama version pin');
const home = process.env.HOME || os.homedir();
const root = path.join(harnessPaths({ prefix: c.names.prefix, home }).shareDir, 'ollama');
const endpoint = c.memory.embed.url ?? 'http://127.0.0.1:11434';
const url = new URL(endpoint);
const model = c.memory.embed.model;
const env = { ...process.env, HOME: home, OLLAMA_HOST: endpoint };
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', env, ...options });
const ready = async () => {
  try {
    const r = await fetch(new URL('/api/version', url), { signal: AbortSignal.timeout(3000) });
    return r.ok && typeof (await r.json()).version === 'string';
  } catch { return false; }
};
const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.pathname === '/';
if (!await ready() && !local) throw Error('Unanswered remote endpoint; refusing a local Ollama replacement');
const stat = (file) => {
  try { return fs.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
};
const current = path.join(root, 'current');
const binary = path.join(home, '.local/bin/ollama');
for (const file of [current, binary]) {
  const s = stat(file);
  if (!s) throw Error('Pinned Ollama binary is absent; install prerequisites in INSTALL.md §4.1: ' + file);
  const target = s.isSymbolicLink() && path.resolve(path.dirname(file), fs.readlinkSync(file));
  if (!target || !target.startsWith(root + path.sep)) throw Error('Refusing unmanaged path: ' + file);
}
const releaseDir = path.join(root, version);
if (!stat(releaseDir)?.isDirectory() || stat(releaseDir).isSymbolicLink()) throw Error('Pinned Ollama release is absent or invalid');
if (fs.realpathSync(current) !== fs.realpathSync(releaseDir)
  || fs.realpathSync(binary) !== fs.realpathSync(path.join(releaseDir, 'ollama'))) throw Error('Ollama links do not select the pinned binary');
fs.accessSync(binary, fs.constants.X_OK);
const versions = [...run(binary, ['--version']).matchAll(/(?:ollama|client) version is ([0-9.]+)/g)];
if (versions.at(-1)?.[1] !== version) throw Error('Ollama client does not match pin: ' + binary);
if (!await ready()) {
  if (!local) throw Error('Unanswered remote endpoint; refusing a local Ollama replacement');
  const label = harnessLabel({ prefix: c.names.prefix, name: 'ollama' });
  const plist = path.join(home, 'Library/LaunchAgents', label + '.plist');
  const log = path.join(home, '.local/state', label);
  const x = (s) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>${x(label)}</string>
<key>ProgramArguments</key><array><string>${x(binary)}</string><string>serve</string></array>
<key>EnvironmentVariables</key><dict><key>OLLAMA_HOST</key><string>${x(endpoint)}</string><key>HOME</key><string>${x(home)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${x(log)}/server.log</string>
<key>StandardErrorPath</key><string>${x(log)}/server.err.log</string>
</dict></plist>\n`;
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.mkdirSync(log, { recursive: true });
  if (stat(plist)) {
    if (!stat(plist).isFile() || fs.readFileSync(plist, 'utf8') !== body) throw Error('Refusing different existing Ollama unit: ' + plist);
  } else fs.writeFileSync(plist, body, { flag: 'wx', mode: 0o600 });
  run('plutil', ['-lint', plist], { stdio: 'inherit' });
  run('launchctl', ['bootstrap', 'gui/' + process.getuid(), plist], { stdio: 'inherit' });
  for (let n = 0; n < 30 && !await ready(); n += 1) await sleep(1000);
  if (!await ready()) throw Error('Ollama did not answer; inspect ' + log + '/server.err.log');
}
const names = run(binary, ['list']).trim().split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+/)[0]);
if (!names.includes(model) && !names.includes(model.includes(':') ? model : model + ':latest')) {
  const embedPin = readEmbedImportPin(pins);
  if (model === embedPin.model) await importPinnedEmbedModel({ binary, pin: embedPin, env, run });
  else run(binary, ['pull', model], { stdio: 'inherit' });
}
const [vector] = await embed(endpoint, model, ['probe'], 30000);
if (!vector?.length) throw Error('Embedding proof returned no vector');
console.log('Embedding dimension:', vector.length);
if (c.memory.embed.url === undefined) {
  run(process.execPath, ['ops/bootstrap/harness-config.mjs', 'set', 'memory.embed.url', JSON.stringify(endpoint)], { stdio: 'inherit' });
}
