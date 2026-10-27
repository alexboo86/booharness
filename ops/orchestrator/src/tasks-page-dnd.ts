/**
 * The tasks page's drag and drop (ops/orchestrator/TASKS-BOARD.md, "Drag and drop"). The view
 * (tasks-page.ts) owns the markup, the CSS and the selection state; this script carries a drag
 * from a task row to a status column or a domain chip. Columns open the existing drawer action;
 * chips write the domain through the existing update route with `X-Orch-Tasks: 1`. Nothing is asked with
 * window.prompt or window.confirm: they throw in the Claude app browser pane.
 *
 * A drag from a row whose id is in the selection carries all selected ids; one from outside the
 * selection carries only its own id. A domain drop posts one `/api/tasks/update {id, domain}` for each
 * carried id that is still on the screen and has a different domain, in sequence ("No domain"
 * sends domain null), then
 * unselects the written ids and calls view.refresh(). A drop on the task's own domain writes
 * nothing, and a drop while a write runs is ignored. Route data — domains, errors — is only ever
 * set as textContent, never as markup.
 *
 * The string is a TypeScript template literal, so the browser JS inside it carries no backtick
 * and no dollar-brace (lesson 14831); its newline escapes are written double-escaped so the
 * browser source keeps them as string escapes.
 */
export const TASKS_DND_SCRIPT = `
(function () {
  const mount = document.getElementById('task-dnd');
  const view = window.TasksBoard;
  if (!mount || !view) return;
  const NO_DOMAIN = 'No domain';
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; };
  const status = el('div', 'dnd-status');
  status.id = 'dnd-status';
  status.setAttribute('role', 'status');
  mount.replaceChildren(status);

  let carrying = null;
  let sourceId = null;
  let marked = null;
  let busy = false;

  function mark(target) {
    if (marked === target) return;
    if (marked) marked.classList.remove('drag-over');
    marked = target || null;
    if (marked) marked.classList.add('drag-over');
  }
  function targetOf(node) {
    if (!node || !node.closest) return null;
    return node.closest('.domain-chip') || node.closest('details.task-sec[data-status]');
  }
  /** The domain of a target: a name, or null for the "No domain" chip and group. */
  function domainOf(target) {
    const name = target.dataset.domain || NO_DOMAIN;
    return name === NO_DOMAIN ? null : name;
  }
  /** A carried id writes only when its board domain is not the target's own. */
  function differs(id, domain) {
    const board = view.board;
    const tasks = board && board.tasks ? board.tasks : [];
    for (const t of tasks) if (t.id === id) return t.domain !== domain;
    return true;
  }

  /**
   * A carried id is written only while its row is on the screen: a refresh during the drag can
   * take the task off the board, behind a filter or into a folded group.
   */
  function onScreen(id) {
    return view.onScreen(id);
  }

  document.addEventListener('dragstart', (e) => {
    const wrap = e.target && e.target.closest ? e.target.closest('.task-row-wrap') : null;
    if (!wrap) return;
    const row = wrap.querySelector('.task-row');
    const id = row ? Number(row.dataset.id) : NaN;
    if (!Number.isFinite(id)) return;
    sourceId = id;
    const selected = view.selection();
    // A drag from inside the selection carries all selected ids; one from outside its own id.
    carrying = selected.indexOf(id) !== -1 ? selected.slice() : [id];
    // The result of the previous drop is read; a new drag starts with an empty status.
    if (!busy) status.textContent = '';
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(id));
    }
  });
  document.addEventListener('dragover', (e) => {
    if (!carrying) return;
    const target = targetOf(e.target);
    mark(target);
    if (target) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    }
  });
  document.addEventListener('dragend', () => { carrying = null; sourceId = null; mark(null); });

  async function post(id, domain) {
    const response = await fetch('/api/tasks/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orch-Tasks': '1' },
      body: JSON.stringify({ id: id, domain: domain }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error((data && data.error) || ('HTTP ' + response.status));
  }
  async function run(ids, domain) {
    busy = true;
    const failed = [];
    const ok = [];
    let gone = 0;
    for (let i = 0; i < ids.length; i++) {
      if (!onScreen(ids[i])) { gone++; continue; }
      if (!differs(ids[i], domain)) continue;
      try { await post(ids[i], domain); ok.push(ids[i]); }
      catch (err) { failed.push({ id: ids[i], error: err.message }); }
    }
    busy = false;
    status.textContent = ok.length + ' moved' + (gone ? ', ' + gone + ' left the screen' : '') + failed.map((f) => '\\n#' + f.id + ': ' + f.error).join('');
    // A failed id keeps its checkbox: the operator retries it. A written one leaves the selection.
    if (ok.length) view.unselect(ok);
    void view.refresh();
  }

  document.addEventListener('drop', (e) => {
    const target = targetOf(e.target);
    // A drop on no target, or while a write runs, is ignored and writes nothing.
    if (!carrying || !target || busy) return;
    e.preventDefault();
    const ids = carrying;
    const id = sourceId;
    carrying = null;
    sourceId = null;
    mark(null);
    if (target.dataset.status) {
      // Status transitions are single-task actions; domain chips retain selection-wide moves.
      if (!onScreen(id)) { status.textContent = '#' + id + ' left the screen'; return; }
      const task = view.board.tasks.find((t) => t.id === id);
      if (!task || view.columnOf(task) === target.dataset.status) return;
      busy = true;
      void view.openDrawer(id, { column: target.dataset.status }).finally(() => { busy = false; });
      return;
    }
    void run(ids, domainOf(target));
  });
})();
`;
