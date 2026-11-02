import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHarnessConfig } from '../../../../../scripts/lib/harness-config.mjs';
import { serviceUrl } from '../../../../../scripts/memory/service-client.mjs';
import { defineSetting } from '../registry.ts';

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
type Observation = { value: string | null; source: string };

function embeddingOwnerValue(repoRoot: string): Observation {
  if (process.env.MEMORYCTL_EMBED_MODEL) return { value: process.env.MEMORYCTL_EMBED_MODEL, source: 'MEMORYCTL_EMBED_MODEL' };
  const stateDir = process.env.MEMORYCTL_STATE_DIR || path.join(process.env.MEMORYCTL_HOME || homedir(), '.local/state/memoryctl');
  const file = path.join(stateDir, 'local-service.json');
  try {
    const options = JSON.parse(readFileSync(file, 'utf8'));
    if (options.embedModel != null) return typeof options.embedModel === 'string' && options.embedModel.length > 0
      ? { value: options.embedModel, source: `${file}:embedModel` }
      : { value: null, source: `unknown: ${file}:embedModel is invalid` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { value: null, source: `unknown: cannot read ${file}` };
  }
  try {
    const config = readHarnessConfig({ repoRoot });
    return { value: config.memory.embed.model, source: `${path.join(repoRoot, 'ops/bootstrap/harness.config.json')}:memory.embed.model` };
  } catch {
    return { value: null, source: `unknown: cannot resolve memory.embed.model in ${repoRoot}` };
  }
}

const EMBEDDING_MODELS = ['nomic-embed-text', 'bge-m3', 'qwen3-embedding:0.6b'];

// memoryd refuses any other model; a row outside the options must not fail every settings read.
function knownEmbeddingModel(observed: Observation): Observation {
  if (observed.value === null || EMBEDDING_MODELS.includes(observed.value)) return observed;
  return { value: null, source: `unknown: ${observed.value} from ${observed.source} is not a known model` };
}

/** Observation only: the installer/daemon own memory configuration, never settings.json. */
export function memoryOwnerValue(key: string, repoRoot = REPO): Observation | undefined {
  if (key === 'memory.endpoint') return { value: serviceUrl(), source: 'scripts/memory/service-client.mjs:8 (MEMORYCTL_URL → service.url → localhost)' };
  if (key === 'memory.embedding.model') return knownEmbeddingModel(embeddingOwnerValue(repoRoot));
  if (key === 'memory.reranker.model') return { value: 'BAAI/bge-reranker-v2-m3', source: 'scripts/memory/rerank-worker.py:13 (MODEL pin)' };
  return undefined;
}

export function registerMemory(): void {
  defineSetting({
    key: 'memory.endpoint', label: 'Memory service address', category: 'memory', group: 'tools',
    tier: 'advanced', control: 'text', class: 'operator-only', scope: 'install', type: 'string',
    default: 'http://127.0.0.1:7717', readOnly: true, apply: 'live',
    help: 'Read-only: shows the memory service address from MEMORYCTL_URL, then service.url, with localhost:7717 as the default. Use the memory installer’s --remote option to configure it; these settings cannot start or configure another memory writer.',
    reads: '.claude/scripts/memoryctl:24-28; scripts/memory/service-client.mjs:8-17 resolve MEMORYCTL_URL, service.url, then http://127.0.0.1:7717.',
  });
  defineSetting({
    key: 'memory.embedding.model', label: 'Memory search model', category: 'memory', group: 'models',
    tier: 'advanced', control: 'select', class: 'operator-only', scope: 'install', type: 'enum',
    default: null, nullable: true, options: EMBEDDING_MODELS, readOnly: true, apply: 'restart',
    help: 'Read-only: shows the configured embedding model from MEMORYCTL_EMBED_MODEL, then local-service.json (saved by --embed-model), then the checkout’s memory configuration. Default null means unknown, not a live remote reading; settings never probes the memory service.',
    reads: 'scripts/memory/memoryd.mjs:52 reads MEMORYCTL_EMBED_MODEL; ops/bootstrap/install-memory.mjs:215,272-288,433 resolves and saves local-service.json embedModel before harness.config.json memory.embed.model.',
  });
  defineSetting({
    key: 'memory.reranker.model', label: 'Memory result sorter', category: 'memory', group: 'models',
    tier: 'advanced', control: 'select', class: 'operator-only', scope: 'install', type: 'enum',
    default: 'BAAI/bge-reranker-v2-m3', options: ['BAAI/bge-reranker-v2-m3'], readOnly: true, apply: 'restart',
    help: 'Read-only: shows the worker’s fixed result-sorting model, BAAI/bge-reranker-v2-m3 by default, not whether it is available. MEMORYCTL_RERANK=off disables it; deep search uses a separate language-model sorting route.',
    reads: 'scripts/memory/rerank-worker.py:13-14 pins MODEL and REVISION; scripts/memory/reranker.mjs:8 owns the off switch; ops/bootstrap/install-memory.mjs:1060-1073 installs the worker requirements.',
  });
  defineSetting({
    key: 'memory.lessons.enabled', label: 'Lessons in seat briefs', category: 'memory', group: 'tools',
    tier: 'basic', control: 'switch', class: 'user', scope: 'install', type: 'bool',
    default: true, apply: 'next-seat', help: 'Include memory lessons in briefs for eligible seat roles; default on keeps them included. Off omits both lesson text and lesson lookups.',
    reads: 'ops/orchestrator/src/context.ts:510,553-561 previously delivered lessons unless read-only or suppressed.',
  });
  defineSetting({
    key: 'memory.lessons.maxCount', label: 'Full lessons per brief', category: 'memory', group: 'tools',
    tier: 'advanced', control: 'number', class: 'user', scope: 'install', type: 'int',
    default: null, nullable: true, bounds: { min: 0 }, apply: 'next-seat',
    help: 'Limit how many lessons a brief includes in full, in relevance order; default null keeps only the existing text-size limit. Zero omits lessons; other limits leave lookup references listed for lessons not included in full.',
    reads: 'ops/bootstrap/lesson-router.mjs:151-160 previously capped whole bodies by bytes only; ops/orchestrator/src/context.ts:554 calls that renderer.',
  });
  defineSetting({
    key: 'memory.knowledge.enabled', label: 'Knowledge in briefs', category: 'memory', group: 'tools',
    tier: 'basic', control: 'switch', class: 'user', scope: 'install', type: 'bool',
    default: true, apply: 'next-seat', help: 'Include relevant domain knowledge pages and guidance when pages are missing in seat briefs; default on keeps this material included.',
    reads: 'ops/orchestrator/src/context.ts:529-546 previously always rendered knowledge or no-files guidance.',
  });
  defineSetting({
    key: 'memory.jevTimeoutMs', label: 'Brief selection timeout (ms)', category: 'memory', group: 'tools',
    tier: 'advanced', control: 'number', class: 'user', scope: 'install', type: 'int',
    default: 5000, bounds: { min: 1, max: 2147483647 }, apply: 'next-seat',
    help: 'Set the time limit in milliseconds for choosing lessons and skills for a seat; default 5000 keeps the five-second limit. SEAT_JEV_TIMEOUT_MS overrides this when set.',
    reads: 'ops/orchestrator/src/context.ts:32,470,575 previously used SEAT_JEV_TIMEOUT_MS = 5000 for both routers.',
  });
}
