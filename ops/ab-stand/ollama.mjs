// Stand-local Ollama for the open-codebase-index embedding backend. No global
// binary, home, model directory or long-lived server is installed.
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export const OLLAMA_VERSION = 'v0.34.3';
const ARCHIVE_SHA = '2c45865f94bce0d4d1d2567603dd2fdacaf375585220a175aa4800105193d36e';
const MODEL = 'nomic-embed-text:v1.5';
const MODEL_MANIFEST_SHA = '0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f';
const PORT = 11498;
export const OLLAMA_HOST = `http://127.0.0.1:${PORT}`;
export const standRoot = path.join(os.homedir(), '.local', 'state', 'orch', 'ab-stand');
const binary = path.join(standRoot, 'ollama', 'ollama');
const modelManifest = path.join(standRoot, 'ollama', 'models', 'manifests', 'registry.ollama.ai', 'library', 'nomic-embed-text', 'v1.5');
const aliasManifest = path.join(path.dirname(modelManifest), 'latest');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const environment = () => ({ ...process.env, HOME: path.join(standRoot, 'ollama', 'home'), OLLAMA_HOST, OLLAMA_MODELS: path.join(standRoot, 'ollama', 'models'), OLLAMA_NO_CLOUD: '1', OLLAMA_TELEMETRY: 'false' });

export async function withOllama(work) {
  if (!existsSync(binary)) throw new Error('stand Ollama not installed');
  mkdirSync(path.join(standRoot, 'ollama', 'home'), { recursive: true, mode: 0o700 });
  const child = spawn(binary, ['serve'], { env: environment(), stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stand Ollama start timed out: ${tail.slice(-400)}`)), 30000);
    const onOutput = (chunk) => {
      tail = (tail + chunk.toString()).slice(-2000);
      if (/Listening on 127\.0\.0\.1:11498/.test(tail)) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', onOutput); child.stderr.on('data', onOutput);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`stand Ollama exited ${code}: ${tail.slice(-400)}`)); });
  });
  try { await ready; return await work({ bin: binary, env: environment() }); }
  finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); });
  }
}

export function indexWithOllama(repo, armDir) {
  const cli = path.join(armDir, 'agent', 'npm', 'node_modules', 'open-codebase-index', 'dist', 'cbi.js');
  if (!existsSync(cli)) throw new Error(`OCI CLI missing: ${cli}`);
  execFileSync(process.execPath, [cli, 'index', '--project', repo, '--host', 'pi'], {
    cwd: repo, env: environment(), stdio: 'inherit', timeout: 10 * 60_000,
  });
}

export async function installOllama() {
  mkdirSync(path.dirname(binary), { recursive: true, mode: 0o700 });
  if (!existsSync(binary)) {
    const archive = path.join(standRoot, 'ollama', 'ollama-darwin.tgz');
    const response = await fetch(`https://github.com/ollama/ollama/releases/download/${OLLAMA_VERSION}/ollama-darwin.tgz`, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new Error(`Ollama archive download HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { mode: 0o600 }));
    if (sha(readFileSync(archive)) !== ARCHIVE_SHA) throw new Error('stand Ollama archive sha256 mismatch');
    execFileSync('tar', ['-xzf', archive, '-C', path.join(standRoot, 'ollama')], { timeout: 120000 });
    rmSync(archive);
    if (!existsSync(binary)) throw new Error(`stand Ollama binary missing: ${binary}`);
  }
  if (!execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 }).includes(`client version is ${OLLAMA_VERSION.slice(1)}`)) throw new Error('stand Ollama version changed');
  if (!existsSync(modelManifest)) {
    await withOllama(({ bin, env }) => { execFileSync(bin, ['pull', MODEL], { env, stdio: 'inherit', timeout: 10 * 60_000 }); });
  }
  if (!existsSync(modelManifest) || sha(readFileSync(modelManifest)) !== MODEL_MANIFEST_SHA) throw new Error(`stand Ollama model ${MODEL} manifest differs from pinned digest`);
  // OCI 0.32.1 requests the unqualified default model name. A local alias to
  // the verified v1.5 blob keeps it pinned without fetching mutable latest.
  if (!existsSync(aliasManifest)) await withOllama(({ bin, env }) => { execFileSync(bin, ['cp', MODEL, 'nomic-embed-text:latest'], { env, timeout: 30000 }); });
  if (sha(readFileSync(aliasManifest)) !== MODEL_MANIFEST_SHA) throw new Error('stand Ollama default model does not match pinned v1.5');
  console.log(`stand Ollama ${OLLAMA_VERSION}, model ${MODEL}: ${binary}`);
}
