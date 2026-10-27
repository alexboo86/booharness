// Stand-local openviking arm: an AGPL-3.0 context database (PyPI openviking,
// ByteDance) served by its own uvicorn process for MCP seats. The server, its
// data, its venv and its models never leave the arm directory or the stand's
// own Ollama; it listens on 127.0.0.1 only while a smoke or run is active.
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installOllama, OLLAMA_HOST, standRoot, withOllama } from './ollama.mjs';

export const OPENVIKING_PINS = JSON.parse(readFileSync(new URL('./openviking.json', import.meta.url), 'utf8'));
export const OPENVIKING_PACKAGE = `${OPENVIKING_PINS.package}==${OPENVIKING_PINS.version}`;
export const OPENVIKING_WHEEL_SHA = OPENVIKING_PINS.sha256;
export const OPENVIKING_PORT = OPENVIKING_PINS.port;
export const OPENVIKING_URL = `http://127.0.0.1:${OPENVIKING_PORT}`;
export const OPENVIKING_MCP_URL = `${OPENVIKING_URL}/mcp`;
export const OPENVIKING_CHAT_MODEL = OPENVIKING_PINS.chatModel;
export const OPENVIKING_CHAT_MODEL_SHA = OPENVIKING_PINS.chatModelManifestSha;
// Ollama stores a pulled tag's registry manifest verbatim, so the manifest
// file's sha256 pins that tag by digest (the nomic-embed-text pattern above).
const [OPENVIKING_CHAT_NAMESPACE, OPENVIKING_CHAT_TAG] = OPENVIKING_CHAT_MODEL.split(':');
export const OPENVIKING_CHAT_MODEL_MANIFEST = path.join(standRoot, 'ollama', 'models', 'manifests', 'registry.ollama.ai', 'library', OPENVIKING_CHAT_NAMESPACE, OPENVIKING_CHAT_TAG);

const uvEnv = { UV_PYTHON_INSTALL_DIR: path.join(standRoot, 'python'), UV_CACHE_DIR: path.join(standRoot, 'cache', 'uv') };
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Download the pinned macOS arm64 wheel from PyPI and hash the bytes against
 *  the pinned sha256 before uv ever sees them (the codex-edit tarball audit).
 *  A registry digest that disagrees with the pin refuses the download. */
export async function verifiedWheel(cacheDir, log = () => {}) {
  const metadataResponse = await fetch(`${OPENVIKING_PINS.registry}${OPENVIKING_PINS.package}/${OPENVIKING_PINS.version}/json`, { signal: AbortSignal.timeout(60_000) });
  if (!metadataResponse.ok) throw new Error(`openviking registry metadata: HTTP ${metadataResponse.status}`);
  const metadata = await metadataResponse.json();
  const file = metadata.urls?.find((entry) => entry.filename === OPENVIKING_PINS.wheel);
  if (!file || !file.url?.startsWith('https://files.pythonhosted.org/') || file.digests?.sha256 !== OPENVIKING_WHEEL_SHA) throw new Error(`openviking: registry wheel ${OPENVIKING_PINS.wheel} absent or its digest differs from the pin`);
  const response = await fetch(file.url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`openviking wheel: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== OPENVIKING_WHEEL_SHA) throw new Error(`openviking: wheel sha256 mismatch: ${digest}`);
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const wheel = path.join(cacheDir, OPENVIKING_PINS.wheel);
  writeFileSync(wheel, bytes, { mode: 0o600 });
  chmodSync(wheel, 0o600);
  log(`openviking: verified wheel sha256-${digest}`);
  return wheel;
}

/** ov.conf: every provider is the stand's own Ollama on 127.0.0.1:11498 — the
 *  embedding endpoint is its OpenAI-compatible /v1, the chat model goes through
 *  litellm's ollama_chat route — and all state sits under the arm's workspace. No
 *  cloud key or hosted endpoint exists in this file. */
function openVikingConfig(dir) {
  return {
    storage: { workspace: path.join(dir, 'openviking', 'data') },
    embedding: { dense: { provider: 'ollama', api_base: `${OLLAMA_HOST}/v1`, model: OPENVIKING_PINS.embeddingModel, dimension: OPENVIKING_PINS.embeddingDimension } },
    // Qwen's non-thinking sampling profile; LiteLLM merges extra_body at the
    // top level, so options must retain OpenViking's 16384-token context.
    vlm: {
      provider: 'litellm', api_key: 'ollama', model: `ollama_chat/${OPENVIKING_CHAT_MODEL}`, api_base: OLLAMA_HOST, temperature: 0.7,
      extra_request_body: { think: false, options: { num_ctx: 16384, temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0 } },
    },
  };
}

/** The runtime env of every openviking process: the arm's own HOME (so even the
 *  ~/.openviking fallback stays inside the arm), the explicit config file, and
 *  arm-local caches. */
export function openVikingEnv(dir) {
  return { HOME: path.join(dir, 'home'), OPENVIKING_CONFIG_FILE: path.join(dir, 'openviking', 'ov.conf'), XDG_CACHE_HOME: path.join(dir, 'cache') };
}

/** Install the arm: pinned Python 3.12 venv (the serena pattern), the
 *  sha256-verified wheel, arm-local ov.conf and ov CLI config, and the
 *  digest-pinned Ollama chat model beside the verified embedding model. */
export async function installOpenViking(dir) {
  const requirements = fileURLToPath(new URL('./openviking.requirements.txt', import.meta.url));
  const topLevel = readFileSync(requirements, 'utf8').split(/\r?\n/).filter((line) => line.startsWith(`${OPENVIKING_PINS.package}==`));
  if (topLevel.length !== 1 || topLevel[0].split(/\s/)[0] !== OPENVIKING_PACKAGE) throw new Error(`openviking: ${requirements} must pin ${OPENVIKING_PACKAGE}`);
  const venv = path.join(dir, 'venv');
  const run = (command, args, timeout = 15 * 60_000) => {
    console.log(`stand install: ${command} ${args.join(' ')}`);
    execFileSync(command, args, { cwd: dir, env: { ...process.env, ...uvEnv }, stdio: 'inherit', timeout });
  };
  if (!existsSync(path.join(standRoot, 'python', 'cpython-3.12-macos-aarch64-none', 'bin', 'python3.12'))) run('uv', ['python', 'install', '3.12']);
  if (!existsSync(path.join(venv, 'bin', 'python'))) run('uv', ['venv', '--python', '3.12', venv]);
  await verifiedWheel(path.join(dir, 'cache'), (line) => console.log(`stand install: ${line}`));
  run('uv', ['pip', 'install', '--python', path.join(venv, 'bin', 'python'), '--require-hashes', '--no-deps', '-r', requirements]);
  const metadata = path.join(venv, 'lib', 'python3.12', 'site-packages', `${OPENVIKING_PINS.package}-${OPENVIKING_PINS.version}.dist-info`, 'METADATA');
  if (!existsSync(metadata) || !readFileSync(metadata, 'utf8').includes(`Version: ${OPENVIKING_PINS.version}\n`)) throw new Error(`openviking: ${OPENVIKING_PACKAGE} missing after uv install`);
  for (const binary of ['openviking-server', 'ov']) if (!existsSync(path.join(venv, 'bin', binary))) throw new Error(`openviking: ${binary} missing after uv install`);
  mkdirSync(path.join(dir, 'openviking'), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, 'openviking', 'ov.conf'), `${JSON.stringify(openVikingConfig(dir), null, 2)}\n`, { mode: 0o600 });
  mkdirSync(path.join(dir, 'home', '.openviking'), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, 'home', '.openviking', 'ovcli.conf'), `${JSON.stringify({ url: OPENVIKING_URL }, null, 2)}\n`, { mode: 0o600 });
  // ov refuses every command until a display language is chosen (it writes ovcli.settings.conf beside ovcli.conf).
  execFileSync(path.join(venv, 'bin', 'ov'), ['language', 'en'], { cwd: dir, env: { ...process.env, ...openVikingEnv(dir) }, stdio: 'inherit', timeout: 60_000 });
  // Models are served only by the stand's own Ollama: embeddings reuse the
  // verified nomic-embed-text:v1.5; the chat model is pulled once and pinned.
  await installOllama();
  if (!existsSync(OPENVIKING_CHAT_MODEL_MANIFEST)) await withOllama(({ bin, env }) => { execFileSync(bin, ['pull', OPENVIKING_CHAT_MODEL], { env, stdio: 'inherit', timeout: 15 * 60_000 }); });
  if (!existsSync(OPENVIKING_CHAT_MODEL_MANIFEST) || sha256(OPENVIKING_CHAT_MODEL_MANIFEST) !== OPENVIKING_CHAT_MODEL_SHA) throw new Error(`stand Ollama model ${OPENVIKING_CHAT_MODEL} manifest differs from pinned digest`);
  console.log(`openviking: ${OPENVIKING_PACKAGE} in ${venv}; MCP ${OPENVIKING_MCP_URL}; models ${OPENVIKING_PINS.embeddingModel} + ${OPENVIKING_CHAT_MODEL}`);
}

/** Start the stand Ollama and the arm-local openviking server for exactly the
 *  duration of work; both stop in finally, so no long-lived process remains. */
export async function withOpenVikingServer(work) {
  const dir = path.join(standRoot, 'arms', 'openviking');
  const server = path.join(dir, 'venv', 'bin', 'openviking-server');
  if (!existsSync(server)) throw new Error('openviking arm not installed');
  return withOllama(async () => {
    const child = spawn(server, ['--host', '127.0.0.1', '--port', String(OPENVIKING_PORT), '--config', path.join(dir, 'openviking', 'ov.conf')], { env: { ...process.env, ...openVikingEnv(dir) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onOutput = (chunk) => { tail = (tail + chunk.toString()).slice(-2000); };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    try {
      const until = Date.now() + 120_000;
      for (;;) {
        if (child.exitCode !== null) throw new Error(`openviking server exited ${child.exitCode}: ${tail.slice(-400)}`);
        try { if ((await fetch(`${OPENVIKING_URL}/health`, { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* not listening yet */ }
        if (Date.now() > until) throw new Error(`openviking server start timed out: ${tail.slice(-400)}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return await work({ url: OPENVIKING_URL, env: openVikingEnv(dir) });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); });
    }
  });
}

/** Index one checkout into the arm-local server: drop the previous cell's
 *  imported trees (an empty tree is not an error), then import this checkout
 *  under viking://resources and wait for processing to finish. */
export function indexWithOpenViking(repo, dir) {
  const ov = path.join(dir, 'venv', 'bin', 'ov');
  if (!existsSync(ov)) throw new Error(`openviking CLI missing: ${ov}`);
  const env = { ...process.env, ...openVikingEnv(dir) };
  spawnSync(ov, ['rm', 'viking://resources', '--recursive', '--wait'], { env, stdio: 'ignore', timeout: 5 * 60_000 });
  execFileSync(ov, ['add-resource', repo, '--parent', 'viking://resources', '--wait'], { cwd: repo, env, stdio: 'inherit', timeout: 20 * 60_000 });
}
