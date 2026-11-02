// Native Claude PreToolUse entry, supplied by the adapter, not project settings.
import { readWriteScope, writeScopeBlock } from './write-scope.ts';

try {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) throw new Error('write scope hook input exceeds 4 MiB');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const cwd = process.argv[2];
  if (!cwd) throw new Error('write scope hook has no checkout root');
  const scope = readWriteScope(process.env.ORCH_SEAT_WRITE_SCOPE);
  if (scope === undefined) throw new Error('write scope hook has no scope');
  const blocked = writeScopeBlock(input.tool_name, input.tool_input, scope, cwd);
  if (blocked) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: blocked.reason } }));
  }
} catch {
  process.stderr.write('write scope hook could not judge this edit; refusing it\n');
  process.exitCode = 2;
}
