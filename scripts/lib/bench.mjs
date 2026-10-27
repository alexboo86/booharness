import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { scrubbedGitEnv } from '../git-env.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Bundle a benchmark's exports using the requested revision's transitive sources. */
export async function loadBenchRevision(ref, contents) {
  const result = await build({
    stdin: { contents, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
    define: { 'import.meta.env.DEV': 'false' },
    plugins: [{ name: 'revision-source', setup(builder) {
      builder.onLoad({ filter: /\.tsx?$/ }, ({ path: filename }) => {
        const relative = path.relative(root, filename).replaceAll('\\', '/');
        if (!relative.startsWith('src/')) return;
        const contents = ref
          ? execFileSync('git', ['show', `${ref}:${relative}`], { env: scrubbedGitEnv(), cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
          : readFileSync(filename, 'utf8');
        return { contents, loader: filename.endsWith('.tsx') ? 'tsx' : 'ts' };
      });
    } }],
  });
  // Equal bundles from a ref and the worktree must still be separate modules.
  return import(`data:text/javascript;base64,${Buffer.from(`${result.outputFiles[0].text}\n// ${ref ?? 'tree'}`).toString('base64')}`);
}

/** Keep the measured loops in the caller so sampling observes the same call path. */
export async function startAllocationSampling(samplingInterval) {
  const session = new Session();
  session.connect();
  const post = promisify(session.post.bind(session));
  await post('HeapProfiler.startSampling', { samplingInterval,
    includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  return async function finishAllocationSampling(functionName) {
    const { profile } = await post('HeapProfiler.stopSampling');
    session.disconnect();
    function sum(node, selected = false) {
      selected ||= node.callFrame.functionName === functionName;
      let bytes = selected ? node.selfSize : 0;
      for (const child of node.children) bytes += sum(child, selected);
      return bytes;
    }
    return sum(profile.head);
  };
}
