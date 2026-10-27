// POST /api/tasks/assign: claim the task for a chat handle in memoryd, then
// order that handle in the lead chat, as the operator with wake, to start it now. The one write
// pair of the tasks board (TASKS-BOARD.md "Write"); the route factory returns
// `(req, res, url) => Promise<boolean>` and the lead wires it into http.ts's
// loopback server. Task 2189, operator decision #15090.
import type { IncomingMessage, ServerResponse } from 'node:http';

/** The same narrow interface as every tasks module (TASKS-BOARD.md "Modules"). */
interface MemoryClient {
  get(path: string, query?: Record<string, string>): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

/** A live chat binding is a ChatBinding with no ended_at (chat.ts). */
type LiveBinding = { handle: string; session: string };

export type TasksAssignDeps = {
  memory: MemoryClient;
  /** The loopback Host/Origin check plus the X-Orch-Tasks header; a non-null reason is 403. */
  guard: (req: IncomingMessage) => string | null;
  /** Posts as the operator: `chatPostOperator` (chat.ts) bound to the store. */
  chatPost: (input: { body: string; to: string[]; wake?: boolean }) => unknown;
  /** The live binding of a handle, or null: `chatList` (chat.ts) `.handles` lookup. */
  liveBinding: (handle: string) => LiveBinding | null;
};

const HANDLE = /^[A-Za-z0-9._-]{1,64}$/;
/** The chat's own limit (chat.ts insertPost): a code point is at most two UTF-16 units. */
const CHAT_BODY_CHARS = 600;
const BODY_LIMIT = 4096;

/** Stable task-id boundary shared by the notice writer and reader. */
export function assignNoticePrefix(id: number): string {
  return `Task #${id} assigned to you:`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error(`body over ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A memoryd HTTP 4xx is a refusal of this request: its status and message pass through. */
function isRefusal(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

export function createTasksAssignRoutes(deps: TasksAssignDeps) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== '/api/tasks/assign' || req.method !== 'POST') return false;
    const refused = deps.guard(req);
    if (refused) {
      sendJson(res, 403, { error: refused });
      return true;
    }
    let body: unknown;
    try {
      body = await readJson(req, BODY_LIMIT);
    } catch (error) {
      sendJson(res, 400, { error: messageOf(error) });
      return true;
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { error: 'body must be a JSON object' });
      return true;
    }
    const input = body as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (key !== 'id' && key !== 'handle') {
        sendJson(res, 400, { error: `assign takes no '${key}'` });
        return true;
      }
    }
    // memoryd's own id rule (scripts/memory/store.mjs taskIdParam), kept identical
    // so this proxy adds no stricter contract of its own.
    const id = Number(input.id);
    if (input.id === undefined || !Number.isSafeInteger(id) || id <= 0) {
      sendJson(res, 400, { error: 'id must be a positive integer' });
      return true;
    }
    const handle = input.handle;
    if (typeof handle !== 'string' || !HANDLE.test(handle)) {
      sendJson(res, 400, { error: 'handle must be 1-64 characters of letters, digits, dot, underscore or hyphen' });
      return true;
    }
    // Before any write: a handle nobody holds cannot be notified, and the claim
    // must not outlive a notification that was never possible.
    if (!deps.liveBinding(handle)) {
      sendJson(res, 409, { error: `handle '${handle}' has no live chat binding` });
      return true;
    }
    // memoryd names the claimer in `agent` (scripts/memory/store.mjs claimTask);
    // `session_id` stays unset: the board claims for the handle, not the session.
    let claimed: unknown;
    try {
      claimed = await deps.memory.post('/task/claim', { id, agent: handle });
    } catch (error) {
      if (isRefusal(error)) sendJson(res, (error as { status: number }).status, { error: messageOf(error) });
      else sendJson(res, 502, { error: messageOf(error) });
      return true;
    }
    const title = (claimed as { title?: unknown } | null)?.title;
    if (typeof title !== 'string' || title.length === 0) {
      sendJson(res, 200, { claimed: true, notified: false, error: 'memoryd claim answer carried no task title' });
      return true;
    }
    // The notice is the operator's order (decision #15281), so it says what to do and names the
    // two commands whole: a lead acts on the post alone, whatever its skill copy says.
    const text = `${assignNoticePrefix(id)} ${title}\n`
      + 'Operator order: take it into work now. In the middle of other work it is next, or it runs in parallel through seats. '
      + `Write your first step into the task: memoryctl task update --id ${id} --next "<step>"\n`
      + `Show it: memoryctl task show --id ${id}`;
    if (Array.from(text).length > CHAT_BODY_CHARS) {
      sendJson(res, 200, { claimed: true, notified: false, error: `task ${id} title is too long for a chat post` });
      return true;
    }
    try {
      await deps.chatPost({ body: text, to: [handle], wake: true });
    } catch (error) {
      // The claim already happened: never report this as an unclaimed task.
      sendJson(res, 200, { claimed: true, notified: false, error: messageOf(error) });
      return true;
    }
    sendJson(res, 200, { claimed: true, notified: true });
    return true;
  };
}
