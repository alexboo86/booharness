// The tasks board on the loopback server: the page and its read, write, assign and agent routes (TASKS-BOARD.md).
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { chatList, chatPostOperator } from './chat.ts';
import { leadsReader } from './dashboard.ts';
import type { SeatManager } from './seats.ts';
import type { Store } from './store.ts';
import { createTasksAgentRoutes } from './tasks-agent.ts';
import { createTasksAssignRoutes } from './tasks-assign.ts';
import { assignNotice } from './tasks-notice.ts';
import { TASKS_HTML } from './tasks-page.ts';
import { TASKS_ACTIONS_SCRIPT } from './tasks-page-actions.ts';
import { TASKS_BATCH_SCRIPT } from './tasks-page-batch.ts';
import { TASKS_DND_SCRIPT } from './tasks-page-dnd.ts';
import { createMemoryClient, createTasksReadRoutes } from './tasks-read.ts';
import { createTasksWriteRoutes } from './tasks-write.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const DOMAINS_DIR = fileURLToPath(new URL('../../../.agents/domains/', import.meta.url));

/** The view with its write controls: the actions script runs after the view's own, the batch bar after the actions, the drag and drop after the batch (TASKS-BOARD.md, "Page seam"). */
const PAGE_END = '</body>';
if (!TASKS_HTML.includes(PAGE_END)) throw new Error('tasks page: no closing body tag to mount the actions script before');
const PAGE_SCRIPTS = `<script>${TASKS_ACTIONS_SCRIPT}</script>\n<script>${TASKS_BATCH_SCRIPT}</script>\n<script>${TASKS_DND_SCRIPT}</script>\n${PAGE_END}`;
export const TASKS_PAGE = TASKS_HTML.replace(PAGE_END, () => PAGE_SCRIPTS);

export type TasksRuntime = { store: Store; seats: SeatManager; port: () => number };

type Route = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

/**
 * A write must come from the board's own page: the daemon's exact origin and
 * the `X-Orch-Tasks: 1` header, as the chat post routes ask for theirs. The
 * server has already refused a host that is not loopback.
 */
function tasksGuard(port: () => number): (req: IncomingMessage) => string | null {
  return (req) => {
    let own: string;
    try {
      own = new URL(`http://${new URL(`http://${req.headers.host ?? ''}`).hostname}:${port()}`).origin;
    } catch {
      return `host '${req.headers.host ?? ''}' is not a URL host`;
    }
    if (req.headers.origin !== own || req.headers['x-orch-tasks'] !== '1') return 'a tasks write requires the daemon origin and X-Orch-Tasks: 1';
    return null;
  };
}

export function createTasksRoutes(rt: TasksRuntime, held: () => string[] = () => []): Route {
  const memory = createMemoryClient();
  const guard = tasksGuard(rt.port);
  const leads = leadsReader(rt.store);
  const routes: Route[] = [
    createTasksReadRoutes({
      memory,
      leads,
      bindings: () => chatList(rt.store, {}).handles,
      notice: (id) => assignNotice(rt.store, id, held()),
      domainNames: () => readdirSync(DOMAINS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    }),
    createTasksWriteRoutes({ memory, guard }),
    createTasksAssignRoutes({
      memory,
      guard,
      chatPost: (input) => chatPostOperator(rt.store, input),
      liveBinding: (handle) => chatList(rt.store, {}).handles.find((binding) => binding.handle === handle) ?? null,
    }),
    createTasksAgentRoutes({ seats: rt.seats, memory, guard, repo: REPO }),
  ];
  return async (req, res, url) => {
    if (url.pathname === '/tasks' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(TASKS_PAGE);
      return true;
    }
    if (url.pathname !== '/api/tasks' && !url.pathname.startsWith('/api/tasks/')) return false;
    for (const route of routes) {
      if (await route(req, res, url)) return true;
    }
    return false;
  };
}
