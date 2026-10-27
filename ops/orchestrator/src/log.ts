// JSONL log in the state dir with size rotation: orch.log -> orch.log.1 -> ...
// Synchronous appends, so a line written before a crash is on disk.
import { appendFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';

export type Logger = (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;

export function createLogger(file: string, maxBytes = 5 * 1024 * 1024, keep = 3): Logger {
  let size = existsSync(file) ? statSync(file).size : 0;
  const rotate = () => {
    rmSync(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i -= 1) {
      if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    if (existsSync(file)) renameSync(file, `${file}.1`);
    size = 0;
  };
  return (level, event, fields = {}) => {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), level, event, pid: process.pid, ...fields })}\n`;
    if (size + line.length > maxBytes && size > 0) rotate();
    appendFileSync(file, line, 'utf8');
    size += Buffer.byteLength(line);
  };
}
