# Tasks board

The operator's interactive task board: a page of the orch daemon over the
memoryctl task store (`mem_tasks`). Task 2189, operator decision #15090.

memoryd (`http://127.0.0.1:7717`) stays the one writer. The browser cannot call
it (no CORS, mutations need `x-memory-token`), so the orch daemon proxies. The
board never closes a task by itself and never deletes a row: "delete" on the
board is a cancel with a reason.

## Modules

Four modules, one owner each, no shared file. Each route module exports a
factory that returns `(req, res, url) => Promise<boolean>`; `true` means the
request was handled. `tasks-routes.ts` wires them, and `http.ts` calls it on the
loopback server only, never on the LAN board server. Dependencies arrive as narrow interfaces declared
inside the module, so every module is tested alone with fakes.

| module | exports | routes |
|---|---|---|
| `src/tasks-read.ts` | `createMemoryClient`, `createTasksReadRoutes` | `GET /api/tasks`, `GET /api/tasks/one` |
| `src/tasks-write.ts` | `createTasksWriteRoutes` | `POST /api/tasks/{create,update,cancel,done,release}` |
| `src/tasks-assign.ts` | `createTasksAssignRoutes`, `assignNoticePrefix` | `POST /api/tasks/assign` |
| `src/tasks-notice.ts` | `assignNotice` | read-only assign notice projection for task detail |
| `src/tasks-agent.ts` | `createTasksAgentRoutes` | `POST /api/tasks/advise`, `GET /api/tasks/advice`, `POST` and `GET /api/tasks/duplicates` |
| `src/tasks-page.ts` | `TASKS_HTML` | the view: header, filters, list, read-only drawer, refresh; served by the lead's wiring at `GET /tasks` |
| `src/tasks-page-actions.ts` | `TASKS_ACTIONS_SCRIPT` | the page's write controls, a script mounted after the view (see "Page seam") |
| `src/tasks-page-batch.ts` | `TASKS_BATCH_SCRIPT` | the batch bar over the selection, a script mounted after the actions (see "Batch bar") |
| `src/tasks-page-dnd.ts` | `TASKS_DND_SCRIPT` | the drag and drop of tasks to a domain, a script mounted after the batch (see "Drag and drop") |
| `src/tasks-routes.ts` | `createTasksRoutes`, `TASKS_PAGE` | the wiring `http.ts` calls: the guard, the dependencies, `GET /tasks` |

`MemoryClient` is the same narrow interface in every module that needs it:

```ts
interface MemoryClient {
  get(path: string, query?: Record<string, string>): Promise<unknown>   // GET /api/memory<path>
  post(path: string, body: unknown): Promise<unknown>                   // POST /api/memory<path>, with the token
}
```

A memoryd refusal (HTTP 4xx) is passed through with its status and its
message; memoryd down is `502 {error}`. No retry, no silent fallback.

## Store

What the board needs from memoryd (`scripts/memory/store.mjs`), all additive:
no new column, no schema version change.

- **Domain.** A task's domain is `links.domain`, a routing id `domain-<name>`
  as lessons use, or absent. `POST /task` and `POST /task/update` take a
  top-level `domain`: a routing id of the routing map, or `null` to clear it;
  an unknown id is refused with the list. The write merges that one key into
  `links` and keeps every other key (`closed_evidence` among them). A wholesale
  `links` write that names no `domain` keeps the stored one. An update that
  changes only the domain leaves `updated_ts` as it was: filing a task under a
  domain is not progress on it. The task view carries `domain` (id or `null`).
- **List filters.** `GET /tasks` also takes `closed_since=<ms>` (a closed task
  is listed only when `closed_ts >= closed_since`; other tasks are unaffected),
  `fields=compact` (no `body`, no `handoffs`) and `domain=<id>|none`. The
  answer names the filters it applied in `applied: string[]`, so a client can
  tell a memoryd that ignored a key.
- **Duplicate refusal.** The create refusal keeps its status and message and
  adds `duplicate_of: <id>` to its JSON body.
- **CLI and MCP.** `memoryctl task create|update --domain <id|none>`,
  `memoryctl task list --compact [--closed-since <ms>] [--domain <id|none>]`
  printing one line per task (`#id status priority domain track title`), and an
  optional `domain` on the MCP `task_create`.

The orch modules translate: the board speaks the bare name (`harness`), the
store the routing id (`domain-harness`).

## Read

`GET /api/tasks?closed_days=7` answers the board. It sends an `ETag` over the
body and answers `304` to a matching `If-None-Match`.

```ts
interface Board {
  at: number                      // ms
  memory: { ok: boolean; error?: string }   // ok:false keeps tasks: [] and the page shows the error, never an empty board as if true
  domains: string[]               // names of .agents/domains/domain-<name>, without the prefix
  leads: Lead[]
  tasks: TaskRow[]                // every task not closed, plus tasks closed within closed_days
}
interface Lead { handle: string | null; session: string; family: string; live: boolean; at: number }
interface TaskRow {
  id: number; title: string
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  status: 'open' | 'in_progress' | 'blocked' | 'deferred' | 'done' | 'cancelled'
  track: string | null
  domain: string | null           // task links.domain; null is the "No domain" group
  next: string | null; blocked_reason: string | null
  claimed_by: string | null
  created: number; updated: number; closed: number | null
  lead: { handle: string; source: 'claim' | 'track'; live: boolean } | null
}
```

Who leads a task: `claimed_by` when set (`source: 'claim'`); otherwise the
chat handle equal to the task's `track` (`source: 'track'`); otherwise `null`.
`live` is true when that handle has a live chat binding whose session is an
active lead in the leads scan.

`GET /api/tasks/one?id=N` answers one task whole: the `TaskRow` fields plus
`body: string`, `handoffs: number[]` (memory entry ids), and `notice: AssignNotice | null`.

```ts
interface AssignNotice {
  post: number                    // chat post id
  at: string                      // post time, ISO timestamp
  handle: string                  // the assigned addressee
  state: 'read' | 'delivered' | 'pending' | 'no watcher'
  delivered_at?: string           // receipt times, ISO timestamps
  confirmed_at?: string
}
```

The notice is the newest operator post whose body starts with the shared
`assignNoticePrefix(id)` (`Task #<id> assigned to you:`). An exact SQL prefix
comparison distinguishes task 2 from task 21, with no LIKE wildcard expansion.
The lookup covers the full chat log, not just its newest 200 posts: the optional
`chatList({ post })` selector returns that one post with its receipts, without
changing the default log window. `chatList` remains the sole owner of receipt
state; `http.ts` supplies the same held `/chat/wake` session ids used by the main
board through `tasks-routes.ts`. No post or an unreadable chat projection yields
`notice: null`, never a failed task read; a chat binding read failure also leaves
chat-derived lead metadata unavailable. The task list does not carry `notice`.
No stored field or memoryd change is needed.

## Write

All are `POST` with a JSON body. Each request passes `deps.guard(req)` first;
a non-null reason is `403 {error}`. The lead wires the guard to the same
loopback Host/Origin check the chat routes use, with the header
`X-Orch-Tasks: 1`.

| route | body | notes |
|---|---|---|
| `/api/tasks/create` | `{title, priority: 'P0'\|'P1', next?, track?, domain?, again?}` | a duplicate refusal of memoryd is `409 {error, duplicate_of}` |
| `/api/tasks/update` | `{id, title?, next?, priority?, track?, domain?, status?: 'open'\|'blocked'\|'deferred', blocked_reason?}` | `blocked` needs `blocked_reason` |
| `/api/tasks/cancel` | `{id, reason}` | reason required; the board's "delete" |
| `/api/tasks/done` | `{id, evidence}` | evidence required |
| `/api/tasks/assign` | `{id, handle}` | claims the task for `handle`, then posts to that handle in the lead chat as the operator with wake; the post is the operator's order to start the task now (a busy lead takes it next or runs it in parallel through seats) and names the two commands whole, `memoryctl task update --id <id> --next "<step>"` and `memoryctl task show --id <id>` (decision #15281; the lead rule is in orch-team, "The lead chat"); `409` when the handle has no live binding |
| `/api/tasks/release` | `{id}` | releases the claim |

## Agent

`POST /api/tasks/advise {id, question?}` creates one scout seat that reads the
task and answers the question (default: what the task needs, what blocks it,
the first step). It answers `{seat, turn}`. A task with advice still running
answers the running seat instead of creating a second one.

`GET /api/tasks/advice?id=N` answers
`{state: 'none' | 'running' | 'done' | 'failed', seat?, turn?, at?, answer?}`;
`answer` is the seat's parsed report. The seat is found by its title
(`Task advice #<id>`), so the orch store gets no new table.

The advice brief tells the scout that the operator reads the report: each
`claim` and `forLead` is in Russian, in plain words. `forLead` opens with a
one-sentence direct answer to the question, then the next step. Identifiers,
paths and commands stay as they are. These instructions stay in full even
when a long task body is trimmed to keep the brief within 300 words.

The page reads advice in this order: `forLead`, each finding's claim with its
evidence below in smaller muted text, then a visible "Not checked" list.
"Checked" is a folded list. Finding metadata (`reproduced`, `severity`, or
unknown keys) and other unrecognized report keys stay in folded JSON details;
unexpected field shapes are kept there too. A string answer stays plain text.
All report content is set as text, never interpreted as markup. The duplicate
search keeps its own candidate renderer.

`POST /api/tasks/duplicates {id}` and `GET /api/tasks/duplicates?id=N` are the
same pair for the duplicate search, with the seat title `Task duplicates #<id>`.
The scout reads the task, then every other task's line from
`memoryctl task list --compact` (tasks not closed) and
`memoryctl task list --compact --closed-since <ms, 90 days back>` (a duplicate
is often a task opened again after it was closed), and reports each task that
asks for the same outcome: its id, its title, why, and how sure. The agent only
reports: merging is the operator's act on the board (Cancel with the reason
`duplicate of #<id>`). No embeddings: at about 2200 tasks the titles fit one
agent context.

## Page

`TASKS_HTML` is one template string like `DASHBOARD_HTML`: no framework, no
build step, no external URL. It reuses the board's CSS tokens and classes and
its language.

- **Header:** the counts (open, in progress, blocked), a search box over id,
  title and track, filters (domain chips, lead: any / no lead / each handle,
  priority, status), a "show closed" toggle, and a New task button.
- **Body:** four collapsible status columns: Open, In progress, Blocked, Done.
  Cards show priority, `#id`, title, domain/track, lead and update age.
  A card opens the drawer; column drops use its actions and confirmations.
  Folds use `localStorage`; deferred is Open, cancelled is Done.
- **Drawer** (a click on a card): title, body, next step, blocked reason, track,
  a domain select, handoff ids, and the actions: Assign (a select of the live
  handles), Release, Block (asks the reason), Reopen, Cancel (asks the reason),
  Done (asks the evidence), Ask agent (a question box; the answer appears when
  the seat finishes), Find duplicates (the candidates appear when the seat
  finishes; each opens its task and offers "Cancel as duplicate").
- **Assign notice:** when the single-task answer has a notice, a read-only
  field after lead shows its handle, state (`pending`, `no watcher`,
  `delivered`, `read`) and the times present: sent, delivered, read.
  Times are local `HH:MM`, prefixed with `YYYY-MM-DD` when not today; all
  values are text. A null notice has no field. Until read, the open drawer
  re-reads `/api/tasks/one?id=` every 5 seconds, updating only this field:
  other fields, inline forms and `#task-actions` stay untouched, and no
  `tasks:drawer` event fires. Failed reads retain the last state. Polling
  stops on close, another drawer open, read, or a null notice; late answers
  from a previous drawer open are ignored.
- **New task:** title, priority, domain, track, next step. On `409` it shows
  the existing task and a "create anyway" button (`again: true`).
- **Batch bar** (`tasks-page-batch.ts`): a checkbox in each row (a row button is
  wrapped, the checkbox is its sibling: no interactive control inside a button)
  and one in each group header that selects the visible rows of that group. The
  selection survives a refresh and holds only rows on the screen: an id that left
  the board, that a filter hides or whose group is folded leaves it, so a batch
  never writes a hidden task; a group selected from its header unfolds. Escape or Back closes the form and writes nothing. With a
  selection a sticky bar shows the count, Clear, and Set domain, Set priority,
  Block (reason), Reopen, Delete (reason; `/api/tasks/cancel`), Done (evidence).
  A text is asked in the bar's inline form (`.confirm`), never with
  `window.prompt` or `window.confirm`: they throw in the Claude app browser pane.
  The confirm button names the action and the count ("Delete 112"). The batch
  calls the existing single routes in sequence with `X-Orch-Tasks: 1`, shows
  progress, and lists each failed id with its error at the end; a failed id stays
  selected and a written one leaves the selection. No new server route.
- **Refresh:** `GET /api/tasks` every 5 seconds with `If-None-Match`; a `304`
  changes nothing. A new body updates rows in place: the scroll position, the
  open drawer and a focused input survive it.
- **Keys:** `/` focuses the search, `Esc` closes the drawer.
- A control whose route does not exist is not rendered.

### Page seam

The view (`tasks-page.ts`), the write controls (`tasks-page-actions.ts`), the
batch bar (`tasks-page-batch.ts`) and the drag and drop (`tasks-page-dnd.ts`)
meet at this seam and nowhere else.
`tasks-routes.ts` serves `TASKS_PAGE`: the view with
`<script>${TASKS_ACTIONS_SCRIPT}</script>`, `<script>${TASKS_BATCH_SCRIPT}</script>`
and `<script>${TASKS_DND_SCRIPT}</script>` mounted after the view's own script,
the batch after the actions, the drag and drop after the batch. `TASKS_HTML`
alone is the read-only view.
The view owns the markup and provides:

- `<div id="task-actions"></div>` inside the drawer, emptied on every drawer
  open, `<div id="task-new"></div>` in the header, `<div id="task-dnd"></div>`
  and `<div id="task-batch"></div>` at the end of main: the four mount points.
- `window.TasksBoard = { board, leads, domains, refresh(), openDrawer(id), closeDrawer(), selection(), unselect(ids), clearSelection(), columnOf(task) }`:
  `board` is the last `Board` answer, `refresh()` fetches now and resolves when
  the rows are updated. `selection()` answers the selected id list; the two
  mutators change it, sync the checkboxes and fire `tasks:selection`.
  `columnOf(task)` shares the card-to-column mapping with drag and drop.
- The event `tasks:drawer` on `document` after a drawer opened, with
  `detail: { task }` (the `GET /api/tasks/one` answer).
- The event `tasks:selection` on `document` after the selection changed, with
  `detail: { ids }`.

The actions script owns everything it puts into the two mount points: the
drawer actions (domain select, Assign, Release, Block, Reopen, Cancel, Done,
Ask agent with its answer) and the New task button with its form. After a
successful write it calls `TasksBoard.refresh()`, and `openDrawer(id)` again
when the drawer's task changed. It uses the view's CSS classes and adds none
of its own tokens.

The batch script owns everything it puts into `#task-batch`: the sticky bar, its
inline form and its error list. It touches the selection only through
`window.TasksBoard` and the `tasks:selection` event. It uses the view's CSS
classes (`.btn`, `.ctl`, `.actions`, `.confirm`) and adds none of its own tokens.

The drag and drop script owns the status node it renders into `#task-dnd` and
the drag behaviour over the rows and the domain targets. It touches the
selection only through `window.TasksBoard`, and it uses the view's CSS classes
(`.drag-over`, `.dnd-status`) and adds none of its own tokens.

### Drag and drop

`tasks-page-dnd.ts` files tasks under a domain with the native HTML5 drag
events, no library. The view adds only what the script cannot do itself:
`draggable` on the row wrapper, the mark and status CSS, and the
`<div id="task-dnd"></div>` mount node.

- **Source:** a task row (`.task-row-wrap`). A drag from a row whose id is in
  the selection carries all selected ids; a drag from outside the selection
  carries only its own id.
- **Targets:** a domain group (`details.task-sec`, folded too) and a domain
  chip (`.domain-chip`). The target below the pointer shows the mark (the class
  `.drag-over`); a drop on no target writes nothing.
- **Drop:** for each carried id with a different domain, `POST
  /api/tasks/update {id, domain}` with `X-Orch-Tasks: 1`, in sequence; `No
  domain` sends `domain: null`. Then the written ids leave the selection and
  `view.refresh()` runs. A drop on the task's own domain writes nothing, and a
  drop while a write runs is ignored. A carried id whose row left the
  screen during the drag (a refresh took the task off the board, behind a
  filter or into a folded group) is not written; the status counts it.
- **Status:** one status node in `#task-dnd` shows the result as `textContent`:
  the count moved and each failed id with the server message. A failed id stays
  selected, and the next drag starts with an empty status. No text is asked: the drop writes the domain only.

### Links

The header of the tasks page links to the main board (`/`), and the header of
the main board (`dashboard.ts`) links to `/tasks`: one `a.stat` each.
