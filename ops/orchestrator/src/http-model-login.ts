// GET /api/models/:family/login (task 3459 A2): the argv the pult's embedded
// terminal runs for an OAuth family. No token passes here: the argv holds only
// executable paths, and the login itself runs provider to Pi (or claude) in the PTY.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LoginRefused, loginCommand } from '../../bootstrap/harness-login.mjs';
import { sendJson } from './http-leads.ts';

const ROUTE = /^\/api\/models\/([a-z]+)\/login$/;
const REFUSAL_STATUS: Record<string, number> = { unknown: 404, 'key-family': 409, 'login-unproved': 409, 'cli-missing': 503 };

/** Loopback only (serveBoardAndFiles); false lets the remaining routes answer. */
export function handleModelLogin(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const match = ROUTE.exec(url.pathname);
  if (!match || req.method !== 'GET') return false;
  try {
    sendJson(res, 200, loginCommand(match[1], { force: url.searchParams.get('force') === '1' }));
  } catch (error) {
    if (error instanceof LoginRefused) sendJson(res, REFUSAL_STATUS[error.code] ?? 500, { error: error.message, code: error.code });
    // A credential reader's error may hold file content: never echo it.
    else sendJson(res, 500, { error: 'cannot prepare the login terminal' });
  }
  return true;
}
