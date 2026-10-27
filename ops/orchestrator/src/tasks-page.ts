/**
 * The read-only Tasks board view (task 2189, operator decision #15090; ops/orchestrator/TASKS-BOARD.md).
 *
 * One template string like DASHBOARD_HTML: no framework, no build step, no external URL, served by the
 * lead's wiring at GET /tasks. It reuses the board's CSS tokens and classes; those live inline inside
 * DASHBOARD_HTML's own template literal and are not exported, so the tokens and the classes this page
 * reuses are copied verbatim here (see the report).
 *
 * The whole page sits inside a TypeScript template literal, so the browser JS and CSS use quotes and
 * concatenation only: a backtick or ${...} would close or interpolate the outer string (memory #14831).
 *
 * This module is the read-only view. It renders no write control: the New task button and the drawer
 * actions belong to tasks-page-actions.ts, which mounts into the two seams this view provides
 * (#task-new in the header, #task-actions in the drawer) and listens for the tasks:drawer event.
 * Card/column and right-panel composition adapted from tcarac/taskboard (MIT).
 */
export const TASKS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>orch tasks</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #f4f4f2; --surface: #fcfcfb; --raised: #ffffff; --ink: #1c1c1a; --ink-2: #4a4a45; --muted: #85847d;
  --line: #e4e3de; --track: #ebeae5; --accent: #465e80; --accent-soft: #e9edf3; --badge-ink: #304760; --badge-muted: #67665f;
  --good: #0ca30c; --warning: #fab219; --serious: #ec835a; --critical: #bc3030; --critical-soft: #fbeaea; --on-critical: #ffffff; --warning-soft: #fdf4e1;
  --shadow: 0 1px 2px rgba(0,0,0,.05);
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #121211; --surface: #1a1a19; --raised: #1f1f1d; --ink: #edece7; --ink-2: #c3c2bb; --muted: #8d8c85;
    --line: #2d2c29; --track: #2a2926; --accent: #aabbd5; --accent-soft: #28313d; --badge-ink: #d9e3f1; --badge-muted: #aaa9a0; --critical: #ec8c8c; --critical-soft: #3a1f1f; --on-critical: #121211; --warning-soft: #3a3120;
    --shadow: none; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
main { height: 100dvh; display: flex; flex-direction: column; padding: 0 1.5rem 1rem; }
header { display: flex; align-items: center; gap: 1rem; margin: 0 -1.5rem; padding: 1rem 1.5rem; border-bottom: thin solid var(--line); background: var(--surface); flex-wrap: wrap; }
.page-nav { display: inline-flex; border: thin solid var(--line); border-radius: .5rem; overflow: hidden; flex: none; }
.page-nav a { color: var(--ink-2); padding: .375rem .875rem; text-decoration: none; font-weight: 600; }
.page-nav a[aria-current="page"] { background: var(--accent-soft); color: var(--accent); }
.page-nav a:hover { background: var(--track); }
.page-nav a:focus-visible { outline: thin solid var(--accent); outline-offset: -.2rem; }
.brand { font-weight: 700; font-size: 16px; letter-spacing: -.01em; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--good); display: inline-block; }
.dot.off { background: var(--critical); }
.summary { display: flex; gap: .75rem; flex-wrap: wrap; margin-left: auto; }
.stat { background: var(--raised); border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; color: var(--ink-2); }
.stat b { color: var(--ink); }
a.stat { text-decoration: none; }
a.stat:hover { border-color: var(--accent); color: var(--ink); }
a.stat:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.muted { color: var(--muted); }
.title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; overflow-wrap: anywhere; }
.chip { font-size: 11px; line-height: 18px; padding: 0 8px; border-radius: 999px; white-space: nowrap; background: var(--accent-soft); color: var(--accent); font-weight: 600; flex: none; }
.chip .dot { width: 6px; height: 6px; }
.chip.lead.none { background: var(--track); color: var(--badge-muted); font-weight: 600; }
.state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-2); white-space: nowrap; flex: none; }
.state::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.state.open::before { background: var(--accent); }
.state.in_progress::before { background: var(--accent); }
.state.blocked::before { background: var(--critical); }
.state.deferred::before { background: var(--warning); }
.state.done::before { background: var(--good); }
.state.cancelled::before { background: var(--muted); }
.state.error::before { background: var(--critical); }
.badge { font-size: 11px; line-height: 20px; padding: 0 8px; border-radius: 6px; white-space: nowrap; font-variant-numeric: tabular-nums; border: 1px solid transparent; }
.badge.prio { font-weight: 700; }
.badge.P0 { background: var(--critical-soft); color: var(--critical); border-color: var(--critical); }
.badge.P1 { background: var(--warning-soft); color: var(--ink); border-color: var(--warning); }
.badge.P2, .badge.P3 { background: var(--track); color: var(--ink-2); }
.sect-label { font-size: 10px; line-height: 20px; text-transform: uppercase; letter-spacing: .05em; color: var(--badge-muted); }
.empty { color: var(--muted); padding: 6px 2px; }
details.sec { margin-top: 14px; }
details.sec[open] > summary { margin-bottom: 8px; }
summary { cursor: pointer; font-size: 12px; color: var(--ink); font-weight: 600; display: flex; align-items: center; gap: 8px; }
summary .sect-count { margin-left: 4px; }
.filters { display: flex; gap: .75rem; align-items: center; flex-wrap: wrap; padding: 1rem 0; }
.domain-chips { flex-basis: 100%; }
.filters label { display: inline-flex; align-items: center; gap: 5px; color: var(--ink-2); font-size: 12px; }
.filters select, #search { font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 3px 8px; }
#search { width: 14rem; min-width: 0; padding: .375rem .75rem; }
#search::placeholder { color: var(--badge-muted); }
.filters :focus-visible, #search:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.domain-chips { display: flex; gap: 5px; flex-wrap: wrap; }
.domain-chip { font-size: 11px; line-height: 20px; padding: 0 9px; border-radius: 999px; border: 1px solid var(--line); background: var(--raised); color: var(--ink-2); cursor: pointer; }
.domain-chip[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); font-weight: 700; }
.domain-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
#sections { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1.5rem; flex: 1; min-height: 0; }
#sections.stale { opacity: .55; }
.task-sec { min-width: 0; min-height: 0; margin: 0; }
details.task-sec[open] { display: flex; flex-direction: column; }
details.task-sec::details-content { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
details.task-sec > summary { padding: .5rem; margin: 0 0 .5rem; min-height: 2.5rem; list-style: none; }
details.task-sec > summary::-webkit-details-marker { display: none; }
details.task-sec > summary .sect-count { margin-left: auto; background: none; border: 0; padding: 0; font-variant-numeric: tabular-nums; }
.column-state { font-size: inherit; }
.column-state.open::before { background: var(--muted); }
.group-check { margin-left: .25rem; }
.column-hint { color: var(--badge-muted); padding: 1.5rem .75rem; border: thin dashed var(--line); border-radius: .5rem; text-align: center; }
.task-list { display: flex; flex-direction: column; gap: .5rem; overflow-y: auto; min-height: 0; padding: .25rem .5rem .75rem; scrollbar-width: thin; scrollbar-color: var(--line) var(--bg); }
details.task-sec:not([open]) .task-list { display: none; }
.task-row { display: flex; flex-direction: column; align-items: stretch; gap: .625rem; width: 100%; text-align: left; font: inherit; color: inherit; background: var(--surface); border: thin solid var(--line); border-radius: .5rem; padding: .875rem; cursor: pointer; min-width: 0; }
.task-row:hover { border-color: var(--accent); }
.task-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.task-row .title { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; white-space: normal; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.card-top, .card-footer { display: flex; align-items: center; justify-content: space-between; gap: .5rem; min-width: 0; }
.card-top { padding-left: 1.5rem; }
.card-tags { display: flex; flex-wrap: wrap; gap: .375rem; min-width: 0; }
.card-tags .chip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.card-footer { margin-top: .125rem; font-size: .75rem; color: var(--badge-muted); }
.card-footer .chip.lead { overflow: hidden; text-overflow: ellipsis; }
.task-row .badge { background: none; border: none; padding: 0; font-weight: 600; }
.task-row .badge.P1 { color: var(--ink-2); }
.task-row .chip { font-weight: 500; }
.task-row .chip.lead { background: none; padding: 0; }
.task-row.cancelled { color: var(--badge-muted); background: var(--bg); }
.task-row.cancelled .title { text-decoration: line-through; }
.task-row .tid { flex: none; color: var(--badge-muted); }
.task-row .track { color: var(--ink-2); background: var(--track); }
.task-row .age { flex: none; font-variant-numeric: tabular-nums; }
.task-row[aria-current="true"] { border-color: var(--accent); background: var(--accent-soft); }
.errbar { display: block; background: var(--critical-soft); color: var(--critical); border: 1px solid var(--critical); border-radius: 8px; padding: 6px 10px; margin-bottom: 10px; font-weight: 600; overflow-wrap: anywhere; }
.errbar.warn { background: var(--warning-soft); color: var(--ink); border-color: var(--warning); }
.errbar[hidden] { display: none; }
.drawer-shade { position: fixed; inset: 0; background: color-mix(in srgb, var(--ink) 30%, transparent); z-index: 9; }
.drawer-shade[hidden] { display: none; }
.drawer { position: fixed; top: 0; right: 0; height: 100%; width: min(36rem, 100%); background: var(--surface); border-left: thin solid var(--line); overflow-y: auto; z-index: 10; padding: 0 1.5rem 1.5rem; }
.drawer[hidden] { display: none; }
.drawer-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; padding: 1rem 1.5rem; margin: 0 -1.5rem 1.5rem; position: sticky; top: 0; background: var(--surface); border-bottom: thin solid var(--line); z-index: 1; }
#drawer-title { font-size: 1.125rem; line-height: 1.5; font-weight: 600; margin: 0 0 1.5rem; overflow-wrap: anywhere; }
#drawer-close { cursor: pointer; background: none; color: var(--ink-2); border: none; padding: .25rem; display: flex; }
#drawer-close:hover { color: var(--accent); background: var(--track); }
#drawer-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.drawer-fields { display: flex; flex-direction: column; gap: 1.5rem; }
.field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.field-grid .field > :last-child { background: var(--track); border-radius: .5rem; padding: .5rem .75rem; width: 100%; overflow-wrap: anywhere; white-space: normal; }
.field-grid .field.notice { grid-column: 1 / -1; }
.field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.field pre.body { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font: inherit; color: var(--ink-2); background: var(--bg); border: thin solid var(--line); border-radius: .5rem; padding: .75rem; line-height: 1.65; }
#task-actions { display: flex; flex-direction: column; gap: 1rem; border-top: thin solid var(--line); padding-top: 1.5rem; margin-top: 1.5rem; }
#task-actions .field { gap: .5rem; }
#taskAdvice { white-space: pre-wrap; overflow-wrap: anywhere; }
#taskAdvice summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.task-row-wrap { position: relative; min-width: 0; }
.task-row-wrap .task-check { position: absolute; left: .875rem; top: 1rem; opacity: 0; }
.task-row-wrap:hover .task-check, .task-check:checked, .task-check:focus-visible { opacity: 1; }
.task-check, .group-check { flex: none; width: 15px; height: 15px; margin: 0; accent-color: var(--accent); cursor: pointer; }
.task-check:focus-visible, .group-check:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.btn { font: inherit; font-weight: 600; line-height: 20px; padding: 2px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--raised); color: var(--ink-2); cursor: pointer; }
.btn:hover { border-color: var(--accent); color: var(--ink); }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.btn:disabled { background: var(--track); color: var(--badge-muted); border-color: var(--line); cursor: default; }
.btn.primary { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
.btn.primary:hover { background: var(--accent); color: var(--raised); }
.btn.primary:disabled { background: var(--track); color: var(--badge-muted); border-color: var(--line); }
.btn.danger { background: var(--critical-soft); color: var(--critical); border-color: var(--critical); }
.btn.danger:hover { background: var(--critical); color: var(--on-critical); }
.btn.danger:disabled { background: var(--track); color: var(--badge-muted); border-color: var(--line); }
.ctl { font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 3px 8px; min-width: 150px; }
.ctl:hover { border-color: var(--accent); }
.ctl:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ctl:disabled { background: var(--track); color: var(--badge-muted); cursor: default; }
.confirm { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; background: var(--accent-soft); border: 1px solid var(--accent); border-radius: 10px; padding: 6px 10px; }
.confirm[hidden] { display: none; }
.confirm label { color: var(--ink-2); font-size: 12px; }
.batch-bar { position: sticky; bottom: 10px; margin-top: 14px; padding: 10px; background: var(--raised); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); z-index: 5; }
.batch-bar[hidden] { display: none; }
#batch-note { margin-top: 6px; }
#batch-errors { margin: 6px 0 0; }
.drag-over { outline: 2px solid var(--accent); outline-offset: 2px; }
.dnd-status { white-space: pre-wrap; margin-top: 6px; }
.dnd-status:empty { display: none; }
#task-new .card { position: fixed; top: 5rem; right: 1.5rem; width: min(30rem, calc(100% - 3rem)); max-height: calc(100dvh - 6rem); overflow-y: auto; z-index: 11; background: var(--surface); border: thin solid var(--line); border-radius: .75rem; padding: 1.5rem; display: flex; flex-direction: column; gap: 1rem; box-shadow: var(--shadow); }
#task-new .card[hidden] { display: none; }
#task-new .card .field { gap: .375rem; }
#task-new .ctl { width: 100%; min-width: 0; }
#task-new .card h2 { font-size: 1.125rem; margin: 0; }
::selection { background: var(--accent-soft); color: var(--ink); }
input, textarea { caret-color: var(--accent); }
@media (prefers-color-scheme: dark) { .drawer-shade { background: color-mix(in srgb, var(--bg) 70%, transparent); } }
@media (hover: none) { .task-row-wrap .task-check { opacity: 1; } }
@media (max-width: 640px) {
  main { height: auto; min-height: 100dvh; padding: 0 1rem 1rem; }
  header { margin: 0 -1rem; padding: 1rem; gap: .75rem; }
  .summary { margin-left: 0; flex: 1 0 100%; gap: 1rem; order: 2; }
  #search { flex: 1; }
  #sections { display: flex; flex-direction: column; gap: 1.5rem; }
  .task-list { max-height: 32rem; }
  .drawer { padding-right: 1rem; padding-left: 1rem; }
  .drawer-head { margin-right: -1rem; margin-left: -1rem; padding-right: 1rem; padding-left: 1rem; }
  .ctl { min-width: 0; max-width: 100%; }
}
</style>
</head>
<body>
<main>
<div id="errbar" class="errbar" role="alert" hidden></div>
<header>
  <span class="dot" id="dot"></span><span class="brand">orch</span>
  <nav class="page-nav" aria-label="Main"><a href="/">Board</a><a href="/tasks" aria-current="page">Tasks</a></nav>
  <div class="summary" id="counts">
    <span class="muted">open <b id="c-open">—</b></span>
    <span class="muted">in progress <b id="c-prog">—</b></span>
    <span class="muted">blocked <b id="c-blocked">—</b></span>
  </div>
  <input id="search" type="search" aria-label="Search" placeholder="id · title · track">
  <span class="muted" id="status">loading…</span>
  <div id="task-new"></div>
</header>
<div class="filters">
  <div class="domain-chips" id="f-domains"></div>
  <label>lead <select id="f-lead" aria-label="Lead"><option value="any">any</option><option value="none">no lead</option></select></label>
  <label>priority <select id="f-priority" aria-label="Priority"><option value="any">any</option><option value="P0">P0</option><option value="P1">P1</option><option value="P2">P2</option><option value="P3">P3</option></select></label>
  <label>status <select id="f-status" aria-label="Status"><option value="any">any</option><option value="open">open</option><option value="in_progress">in progress</option><option value="blocked">blocked</option><option value="deferred">deferred</option><option value="done">done</option><option value="cancelled">cancelled</option></select></label>
  <label><input id="f-closed" type="checkbox"> show closed</label>
</div>
<div id="sections"></div>
<div id="empty" class="empty" hidden>No tasks match these filters.</div>
<div id="task-dnd"></div>
<div id="task-batch"></div>
</main>
<div id="drawer-shade" class="drawer-shade" hidden></div>
<aside id="drawer" class="drawer" hidden aria-labelledby="drawer-title" role="dialog" aria-modal="true" tabindex="-1">
  <div class="drawer-head">
    <span id="drawer-id" class="mono muted"></span>
    <button type="button" id="drawer-close" aria-label="Close" title="Close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button>
  </div>
  <h1 id="drawer-title"></h1>
  <div id="drawer-fields" class="drawer-fields"></div>
  <div id="task-actions"></div>
</aside>
<script>
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; };
const NO_DOMAIN = 'No domain';
const LS = 'orch.tasks.column.';
const COLUMNS = [['open', 'Open'], ['in_progress', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done']];
const STATUS_WORD = { open: 'open', in_progress: 'in progress', blocked: 'blocked', deferred: 'deferred', done: 'done', cancelled: 'cancelled' };
const state = { board: null, etag: null, openTaskId: null, leadSig: null, domainSig: null,
  selected: new Set(), filters: { q: '', domains: new Set(), lead: 'any', priority: 'any', status: 'any', showClosed: false } };
const rowCache = new Map();
const sectionCache = new Map();

const sectionsEl = document.getElementById('sections');
const emptyEl = document.getElementById('empty');
const errbar = document.getElementById('errbar');
const statusEl = document.getElementById('status');
const dot = document.getElementById('dot');
const search = document.getElementById('search');
const leadSel = document.getElementById('f-lead');
const prioSel = document.getElementById('f-priority');
const statusSel = document.getElementById('f-status');
const closedBox = document.getElementById('f-closed');
const domainChipsEl = document.getElementById('f-domains');
const drawer = document.getElementById('drawer');
const drawerShade = document.getElementById('drawer-shade');
const drawerId = document.getElementById('drawer-id');
const drawerTitle = document.getElementById('drawer-title');
const drawerClose = document.getElementById('drawer-close');
const fieldsEl = document.getElementById('drawer-fields');
const actionsMount = document.getElementById('task-actions');

function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'now';
  if (min < 60) return min + 'm';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h';
  return Math.floor(hr / 24) + 'd';
}
function opt(value, text) { const o = el('option', null, text); o.value = value; return o; }
function leadChip(t) {
  if (!t.lead) return el('span', 'chip lead none', 'no lead');
  const c = el('span', 'chip lead');
  c.append(document.createTextNode(t.lead.handle + ' '));
  c.append(el('i', 'dot' + (t.lead.live ? '' : ' off')));
  return c;
}
function rowSig(t, at) { return JSON.stringify([t.priority, t.id, t.title, t.status, t.domain, t.track, t.lead, ageText(at - (t.updated || 0))]); }
function buildRow(t, at) {
  const b = el('button', 'task-row' + (t.status === 'cancelled' ? ' cancelled' : ''));
  b.type = 'button';
  b.dataset.id = String(t.id);
  const top = el('span', 'card-top');
  top.append(el('span', 'mono tid', '#' + t.id), el('span', 'badge prio ' + t.priority, t.priority));
  const title = el('span', 'title', t.title);
  b.title = t.title;
  const tags = el('span', 'card-tags');
  tags.append(el('span', 'chip domain', t.domain || NO_DOMAIN));
  if (t.track) tags.append(el('span', 'chip track mono', t.track));
  if (t.status === 'deferred' || t.status === 'cancelled') tags.append(el('span', 'state ' + t.status, STATUS_WORD[t.status]));
  const footer = el('span', 'card-footer');
  footer.append(leadChip(t), el('span', 'age', ageText(at - (t.updated || 0))));
  b.append(top, title, tags, footer);
  return b;
}
function makeRow(t, at) {
  const wrap = el('div', 'task-row-wrap');
  wrap.draggable = true;
  const check = el('input', 'task-check');
  check.type = 'checkbox';
  check.dataset.id = String(t.id);
  check.setAttribute('aria-label', 'Select #' + t.id);
  check.addEventListener('change', () => { setSelected([Number(t.id)], check.checked); });
  const row = buildRow(t, at);
  row.addEventListener('click', () => { openDrawer(Number(row.dataset.id)); });
  wrap.append(check, row);
  return { wrap: wrap, row: row, check: check };
}
function patchRow(row, t, at) {
  const fresh = buildRow(t, at);
  row.className = fresh.className;
  row.title = fresh.title;
  row.replaceChildren(...Array.from(fresh.childNodes));
}
function reconcileList(listEl, tasks, at) {
  let cursor = listEl.firstChild;
  for (const t of tasks) {
    let entry = rowCache.get(t.id);
    const sig = rowSig(t, at);
    if (!entry) { entry = makeRow(t, at); entry.sig = sig; rowCache.set(t.id, entry); }
    else if (entry.sig !== sig) { patchRow(entry.row, t, at); entry.sig = sig; }
    entry.check.checked = state.selected.has(t.id);
    const wrap = entry.wrap;
    if (wrap === cursor) cursor = cursor.nextSibling;
    else listEl.insertBefore(wrap, cursor);
  }
  while (cursor) { const nx = cursor.nextSibling; listEl.removeChild(cursor); cursor = nx; }
  if (!tasks.length) listEl.append(el('div', 'column-hint', 'No tasks'));
}
function makeSection(status, name) {
  const details = el('details', 'sec task-sec');
  details.dataset.status = status;
  const summary = el('summary');
  const list = el('div', 'task-list');
  const group = el('input', 'group-check');
  group.type = 'checkbox';
  group.setAttribute('aria-label', 'Select the visible rows of ' + name);
  group.addEventListener('click', (e) => { e.stopPropagation(); });
  group.addEventListener('change', () => {
    // A group selected from its header unfolds: a selected row is always on the screen.
    if (group.checked && !details.open) details.open = true;
    const ids = Array.from(list.querySelectorAll('.task-check')).map((c) => Number(c.dataset.id));
    setSelected(ids, group.checked);
  });
  const countEl = el('span', 'stat sect-count');
  const heading = el('span', 'state column-state ' + status);
  heading.append(el('span', 'sect-name', name));
  summary.append(heading, countEl, group);
  summary.title = 'Fold or unfold ' + name;
  details.append(summary, list);
  let saved = null;
  try { saved = localStorage.getItem(LS + status); } catch { saved = null; }
  details.open = saved === null ? true : saved === '1';
  details.addEventListener('toggle', () => {
    try { localStorage.setItem(LS + status, details.open ? '1' : '0'); } catch { /* not remembered */ }
    if (dropFolded()) { syncSelectionUI(); emitSelection(); }
  });
  return { details: details, list: list, countEl: countEl, group: group };
}
function columnOf(t) {
  if (t.status === 'deferred') return 'open';
  if (t.status === 'cancelled') return 'done';
  return t.status;
}
function renderSections(board, tasks) {
  const groups = new Map(COLUMNS.map((c) => [c[0], []]));
  for (const t of tasks) groups.get(columnOf(t)).push(t);
  let cursor = sectionsEl.firstChild;
  for (const c of COLUMNS) {
    const status = c[0], list = groups.get(status);
    list.sort((a, b) => Number(a.priority.slice(1)) - Number(b.priority.slice(1)) || b.updated - a.updated || a.id - b.id);
    let sec = sectionCache.get(status);
    if (!sec) { sec = makeSection(status, c[1]); sectionCache.set(status, sec); }
    sec.countEl.textContent = String(list.length);
    reconcileList(sec.list, list, board.at);
    if (sec.details === cursor) cursor = cursor.nextSibling;
    else sectionsEl.insertBefore(sec.details, cursor);
  }
  while (cursor) { const nx = cursor.nextSibling; sectionsEl.removeChild(cursor); cursor = nx; }
  emptyEl.hidden = tasks.length !== 0;
}
function renderCounts(board) {
  let open = 0, prog = 0, blocked = 0;
  for (const t of board.tasks) { if (t.status === 'open') open++; else if (t.status === 'in_progress') prog++; else if (t.status === 'blocked') blocked++; }
  document.getElementById('c-open').textContent = String(open);
  document.getElementById('c-prog').textContent = String(prog);
  document.getElementById('c-blocked').textContent = String(blocked);
}
function reconcileChips(domains) {
  const sig = domains.join(',');
  if (sig === state.domainSig) return;
  state.domainSig = sig;
  const nodes = domains.map((d) => {
    const chip = el('button', 'domain-chip', d);
    chip.type = 'button';
    chip.dataset.domain = d;
    chip.setAttribute('aria-pressed', state.filters.domains.has(d) ? 'true' : 'false');
    chip.addEventListener('click', () => {
      const set = state.filters.domains;
      if (set.has(d)) set.delete(d); else set.add(d);
      chip.setAttribute('aria-pressed', set.has(d) ? 'true' : 'false');
      render();
    });
    return chip;
  });
  domainChipsEl.replaceChildren(...nodes);
}
function renderFilterOptions(board) {
  reconcileChips((board.domains || []).concat([NO_DOMAIN]));
  const handles = new Set();
  for (const l of (board.leads || [])) if (l && l.handle) handles.add(l.handle);
  for (const t of board.tasks) if (t.lead && t.lead.handle) handles.add(t.lead.handle);
  const sig = Array.from(handles).sort().join(',');
  if (sig !== state.leadSig) {
    state.leadSig = sig;
    while (leadSel.options.length > 2) leadSel.remove(2);
    const cur = leadSel.value;
    for (const h of Array.from(handles).sort()) leadSel.append(opt(h, h));
    if (cur !== 'any' && cur !== 'none' && !handles.has(cur)) leadSel.value = 'any';
  }
}
function visibleTasks(board) {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  const out = [];
  for (const t of board.tasks) {
    if (!f.showClosed && t.status === 'cancelled') continue;
    if (f.priority !== 'any' && t.priority !== f.priority) continue;
    if (f.status !== 'any' && t.status !== f.status) continue;
    if (f.lead === 'none' && t.lead) continue;
    if (f.lead !== 'any' && f.lead !== 'none' && (!t.lead || t.lead.handle !== f.lead)) continue;
    if (f.domains.size && !f.domains.has(t.domain || NO_DOMAIN)) continue;
    if (q) { const hay = (t.id + ' ' + t.title + ' ' + (t.track || '')).toLowerCase(); if (hay.indexOf(q) === -1) continue; }
    out.push(t);
  }
  return out;
}
function markOpen() {
  for (const r of sectionsEl.querySelectorAll('.task-row[aria-current]')) r.removeAttribute('aria-current');
  if (state.openTaskId !== null) { const r = sectionsEl.querySelector('.task-row[data-id="' + state.openTaskId + '"]'); if (r) r.setAttribute('aria-current', 'true'); }
}
function emitSelection() { document.dispatchEvent(new CustomEvent('tasks:selection', { detail: { ids: Array.from(state.selected) } })); }
function syncSelectionUI() {
  for (const entry of rowCache.values()) entry.check.checked = state.selected.has(Number(entry.check.dataset.id));
  for (const sec of sectionCache.values()) {
    const checks = Array.from(sec.list.querySelectorAll('.task-check'));
    let on = 0;
    for (const c of checks) if (c.checked) on++;
    sec.group.checked = checks.length > 0 && on === checks.length;
    sec.group.indeterminate = on > 0 && on < checks.length;
  }
}
function setSelected(ids, on) {
  let changed = false;
  for (const id of ids) {
    const n = Number(id);
    if (on && !state.selected.has(n)) { state.selected.add(n); changed = true; }
    if (!on && state.selected.has(n)) { state.selected.delete(n); changed = true; }
  }
  if (!changed) return;
  syncSelectionUI();
  emitSelection();
}
/** A folded group hides its rows: they leave the selection, so a batch never writes a row the operator does not see. */
function dropFolded() {
  let dropped = false;
  for (const sec of sectionCache.values()) {
    if (sec.details.open) continue;
    for (const c of sec.list.querySelectorAll('.task-check')) if (state.selected.delete(Number(c.dataset.id))) dropped = true;
  }
  return dropped;
}
function clearSelection() { if (state.selected.size === 0) return; state.selected.clear(); syncSelectionUI(); emitSelection(); }
function render() {
  const board = state.board;
  if (!board) return;
  const bad = board.memory && board.memory.ok === false;
  const warn = !bad && !!(board.memory && board.memory.error);
  errbar.classList.toggle('warn', warn);
  errbar.hidden = !(bad || warn);
  if (bad) { errbar.setAttribute('role', 'alert'); errbar.textContent = board.memory.error || 'memory unavailable'; sectionsEl.classList.add('stale'); return; }
  sectionsEl.classList.remove('stale');
  if (warn) { errbar.setAttribute('role', 'status'); errbar.textContent = board.memory.error; }
  else errbar.textContent = '';
  renderCounts(board);
  renderFilterOptions(board);
  const tasks = visibleTasks(board);
  // The selection holds only rows on the screen: a task that left the board or that a
  // filter hides leaves it, so a batch never writes a task the operator does not see.
  const shown = new Set(tasks.map((t) => t.id));
  let dropped = false;
  for (const id of Array.from(state.selected)) if (!shown.has(id)) { state.selected.delete(id); dropped = true; }
  renderSections(board, tasks);
  if (dropFolded()) dropped = true;
  syncSelectionUI();
  if (dropped) emitSelection();
  markOpen();
  statusEl.textContent = tasks.length + ' / ' + board.tasks.length;
  dot.className = 'dot';
}
let refreshReading = false, refreshPending = false, refreshTimer;
async function refresh() {
  // A write action can request a fresh board while an older snapshot is in flight.
  if (refreshReading) { refreshPending = true; return; }
  clearTimeout(refreshTimer);
  refreshReading = true;
  refreshPending = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const headers = {};
    if (state.etag) headers['If-None-Match'] = state.etag;
    let res;
    try { res = await fetch('/api/tasks', { cache: 'no-store', headers: headers, signal: controller.signal }); }
    catch (e) { dot.className = 'dot off'; statusEl.textContent = 'unreachable: ' + e.message; return; }
    if (res.status === 304) return;
    let data;
    try { data = await res.json(); } catch (e) { dot.className = 'dot off'; statusEl.textContent = 'bad response'; return; }
    if (!res.ok) { dot.className = 'dot off'; statusEl.textContent = (data && data.error) || ('HTTP ' + res.status); return; }
    const etag = res.headers && res.headers.get ? res.headers.get('ETag') : null;
    if (etag) state.etag = etag;
    state.board = data;
    render();
    document.dispatchEvent(new CustomEvent('tasks:board'));
  } finally {
    clearTimeout(timeout);
    refreshReading = false;
    if (refreshPending) void refresh();
    else refreshTimer = setTimeout(refresh, 5000);
  }
}
function field(label, node) { const d = el('div', 'field'); d.append(el('span', 'sect-label', label), node); return d; }
let drawerSession = null;
let noticeTimer = null;
let noticeField = null;
function stopNoticePoll() { if (noticeTimer !== null) clearTimeout(noticeTimer); noticeTimer = null; }
function noticeTime(at) {
  const date = new Date(at), today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const time = pad(date.getHours()) + ':' + pad(date.getMinutes());
  if (date.toDateString() === today.toDateString()) return time;
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + time;
}
function noticeText(notice) {
  let text = notice.handle + ' · ' + notice.state + ' · sent ' + noticeTime(notice.at);
  if (notice.delivered_at != null) text += ' · delivered ' + noticeTime(notice.delivered_at);
  if (notice.confirmed_at != null) text += ' · read ' + noticeTime(notice.confirmed_at);
  return text;
}
function pollNotice(id, session, notice) {
  if (!notice || notice.state === 'read') return;
  async function readNotice() {
    if (drawerSession !== session) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    let again = true;
    try {
      const res = await fetch('/api/tasks/one?id=' + encodeURIComponent(id), { cache: 'no-store', signal: controller.signal });
      if (!res.ok) return;
      const task = await res.json();
      if (drawerSession !== session) return;
      if (task.notice) {
        noticeField.lastElementChild.textContent = noticeText(task.notice);
        if (task.notice.state === 'read') again = false;
      } else {
        noticeField.remove();
        noticeField = null;
        again = false;
      }
    } catch { /* Keep the last shown notice on a failed read. */ }
    finally {
      clearTimeout(timeout);
      if (again && drawerSession === session) noticeTimer = setTimeout(readNotice, 5000);
    }
  }
  noticeTimer = setTimeout(readNotice, 5000);
}
function renderDrawer(task) {
  drawerId.textContent = '#' + task.id;
  drawerTitle.textContent = task.title;
  const nodes = [];
  const grid = el('div', 'field-grid');
  grid.append(field('status', el('span', 'state ' + task.status, STATUS_WORD[task.status] || task.status)),
    field('priority', el('span', 'badge prio ' + task.priority, task.priority)),
    field('domain', el('span', 'chip', task.domain || NO_DOMAIN)),
    field('track', el('span', 'mono', task.track || '—')),
    field('lead', leadChip(task)));
  noticeField = task.notice ? field('assign notice', el('div', null, noticeText(task.notice))) : null;
  if (noticeField) { noticeField.classList.add('notice'); grid.append(noticeField); }
  nodes.push(grid);
  nodes.push(field('next', el('div', null, task.next || 'none')));
  if (task.blocked_reason) nodes.push(field('blocked', el('div', null, task.blocked_reason)));
  const pre = el('pre', 'body'); pre.textContent = task.body || '—';
  nodes.push(field('body', pre));
  if (Array.isArray(task.handoffs) && task.handoffs.length) nodes.push(field('handoffs', el('span', 'mono', task.handoffs.map((h) => '#' + h).join(' '))));
  fieldsEl.replaceChildren(...nodes);
}
async function openDrawer(id, intent) {
  stopNoticePoll();
  const session = {};
  drawerSession = session;
  state.openTaskId = id;
  const opening = drawer.hidden;
  drawer.hidden = false;
  drawerShade.hidden = false;
  document.querySelector('main').inert = true;
  drawerId.textContent = '#' + id;
  drawerTitle.textContent = '';
  if (opening) drawerClose.focus();
  actionsMount.replaceChildren();
  fieldsEl.replaceChildren(el('div', 'empty', 'loading…'));
  markOpen();
  let res;
  try { res = await fetch('/api/tasks/one?id=' + encodeURIComponent(id), { cache: 'no-store' }); }
  catch (e) { if (drawerSession === session) fieldsEl.replaceChildren(el('div', 'empty', e.message)); return; }
  let task;
  try { task = await res.json(); } catch (e) { if (drawerSession === session) fieldsEl.replaceChildren(el('div', 'empty', 'bad response')); return; }
  if (drawerSession !== session) return;
  if (!res.ok) { fieldsEl.replaceChildren(el('div', 'empty', (task && task.error) || ('HTTP ' + res.status))); return; }
  renderDrawer(task);
  pollNotice(id, session, task.notice);
  document.dispatchEvent(new CustomEvent('tasks:drawer', { detail: { task: task, intent: intent } }));
}
function closeDrawer() {
  stopNoticePoll(); drawerSession = null;
  const id = state.openTaskId;
  state.openTaskId = null; drawer.hidden = true; drawerShade.hidden = true;
  document.querySelector('main').inert = false;
  markOpen();
  const row = sectionsEl.querySelector('.task-row[data-id="' + id + '"]');
  if (row) row.focus();
}
/** Rechecked at drop and again at a delayed column confirmation, never trusted from dragstart. */
function onScreen(id) {
  if (!state.board || (state.board.memory && state.board.memory.ok === false)) return false;
  const check = sectionsEl.querySelector('.task-check[data-id="' + id + '"]');
  const group = check && check.closest('details.task-sec');
  return !!group && group.open;
}

search.addEventListener('input', () => { state.filters.q = search.value; render(); });
leadSel.addEventListener('change', () => { state.filters.lead = leadSel.value; render(); });
prioSel.addEventListener('change', () => { state.filters.priority = prioSel.value; render(); });
statusSel.addEventListener('change', () => { state.filters.status = statusSel.value; render(); });
closedBox.addEventListener('change', () => { state.filters.showClosed = closedBox.checked; render(); });
drawerClose.addEventListener('click', () => { closeDrawer(); });
drawerShade.addEventListener('click', () => { closeDrawer(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeDrawer(); return; }
  if (e.key === '/') {
    const a = document.activeElement;
    const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
    if (!typing) { e.preventDefault(); search.focus(); }
  }
  if (e.key === 'Tab' && !drawer.hidden) {
    const controls = Array.from(drawer.querySelectorAll('button, input, select, textarea, summary, a[href]')).filter((n) => !n.disabled && n.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

window.TasksBoard = {
  get board() { return state.board; },
  get leads() { return state.board ? (state.board.leads || []) : []; },
  get domains() { return state.board ? (state.board.domains || []) : []; },
  refresh: refresh,
  openDrawer: openDrawer,
  closeDrawer: closeDrawer,
  selection: () => Array.from(state.selected),
  unselect: (ids) => setSelected(ids, false),
  clearSelection: clearSelection,
  onScreen: onScreen,
  columnOf: columnOf,
};
refresh();
</script>
</body>
</html>
`;
