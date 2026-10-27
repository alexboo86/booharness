// Isolate the capture gate's synchronous git ref walk from orch's event loop.
import { gateNewLesson } from '../../../scripts/memory/capture-gate.mjs';

try {
  const input = JSON.parse(process.argv[2]);
  process.stdout.write(JSON.stringify(await gateNewLesson(input)));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
