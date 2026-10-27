// Imports the pinned default embedding model from its official GGUF.
// `ollama pull` follows a registry blob redirect; a fake-ip DNS makes that
// target non-public, which Ollama refuses. The pin in tool-pins.json is the
// only copy of the URL, size and sha256. A non-default model is not imported here.

import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function readEmbedImportPin(pins) {
  const pin = pins?.['qwen3-embedding'];
  if (!pin || typeof pin !== 'object') throw new Error('Invalid embedding import pin');
  if (typeof pin.model !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(pin.model)) {
    throw new Error('Invalid embedding import model');
  }
  let url;
  try { url = new URL(pin.url); } catch { throw new Error('Invalid embedding import URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.hostname !== 'huggingface.co'
    || !/^\/[^/]+\/[^/]+\/resolve\/main\/[^/]+\.gguf$/.test(url.pathname)
    || url.pathname.split('/').includes('..')) {
    throw new Error('Invalid embedding import URL');
  }
  if (typeof pin.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pin.sha256)) {
    throw new Error('Invalid embedding import sha256');
  }
  if (!Number.isSafeInteger(pin.bytes) || pin.bytes <= 0) throw new Error('Invalid embedding import size');
  return { model: pin.model, url: url.href, sha256: pin.sha256, bytes: pin.bytes };
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function importPinnedEmbedModel({ binary, pin, env, run }) {
  if (typeof run !== 'function') throw new Error('importPinnedEmbedModel requires run');
  if (typeof binary !== 'string' || binary.length === 0) throw new Error('importPinnedEmbedModel requires the ollama binary');
  const checked = readEmbedImportPin({ 'qwen3-embedding': pin });
  const tempRoot = process.env.TMPDIR || process.env.TEMP || process.env.TMP || tmpdir();
  const dir = mkdtempSync(path.join(tempRoot, 'embed-import-'));
  try {
    const file = path.join(dir, 'model.gguf');
    if (/[\r\n]/.test(file)) throw new Error('Embedding import path is not a single line');
    run('curl', ['--proto', '=https', '--proto-redir', '=https', '-fsSL', checked.url, '-o', file], { stdio: 'inherit', env });
    const size = statSync(file).size;
    if (size !== checked.bytes) {
      throw new Error(`Embedding GGUF size mismatch: expected ${checked.bytes}, got ${size}; nothing imported`);
    }
    const digest = await sha256File(file);
    if (digest !== checked.sha256) throw new Error('Embedding GGUF checksum mismatch; nothing imported');
    const modelfile = path.join(dir, 'Modelfile');
    writeFileSync(modelfile, `FROM ${file}\n`, { mode: 0o600 });
    run(binary, ['create', checked.model, '-f', modelfile], { stdio: 'inherit', env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
