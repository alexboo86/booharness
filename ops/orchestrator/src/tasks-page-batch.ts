/**
 * The tasks page's batch bar (ops/orchestrator/TASKS-BOARD.md, "Batch bar"). The view
 * (tasks-page.ts) owns the markup, the CSS and the selection state; this script renders the
 * sticky bar into the `<div id="task-batch"></div>` seam and speaks to the view only through
 * window.TasksBoard and the tasks:selection / tasks:board events.
 *
 * A batch calls the existing single-task routes in sequence with `X-Orch-Tasks: 1` — no new
 * server route. Every text is asked in the bar's inline form (`.confirm`), never with
 * window.prompt or window.confirm: they throw in the Claude app browser pane. Route data —
 * reasons, evidence, errors — is only ever set as textContent, never as markup.
 *
 * The string is a TypeScript template literal, so the browser JS inside it carries no backtick
 * and no dollar-brace (lesson 14831).
 */
export const TASKS_BATCH_SCRIPT = `
(function () {
  const mount = document.getElementById('task-batch');
  const view = window.TasksBoard;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; };

  const ACTIONS = {
    domain: { label: 'Set domain', field: 'select', ask: 'Domain', path: '/api/tasks/update', body: (id, value) => ({ id: id, domain: value === '' ? null : value }) },
    priority: { label: 'Set priority', field: 'priority', ask: 'Priority', path: '/api/tasks/update', body: (id, value) => ({ id: id, priority: value }) },
    block: { label: 'Block', field: 'text', ask: 'Blocked because', path: '/api/tasks/update', body: (id, value) => ({ id: id, status: 'blocked', blocked_reason: value }) },
    reopen: { label: 'Reopen', field: null, ask: '', path: '/api/tasks/update', body: (id) => ({ id: id, status: 'open' }) },
    delete: { label: 'Delete', field: 'text', ask: 'Delete because', path: '/api/tasks/cancel', body: (id, value) => ({ id: id, reason: value }) },
    done: { label: 'Done', field: 'text', ask: 'Evidence', path: '/api/tasks/done', body: (id, value) => ({ id: id, evidence: value }) },
  };

  const bar = el('div', 'batch-bar');
  bar.id = 'batch-bar';
  bar.hidden = true;
  const row = el('div', 'actions');
  const count = el('span', 'stat');
  count.id = 'batch-count';
  const button = (id, label, cls) => { const b = el('button', cls || 'btn', label); b.type = 'button'; b.id = id; return b; };
  const clearBtn = button('batch-clear', 'Clear');
  const form = el('div', 'confirm');
  form.id = 'batch-form';
  form.hidden = true;
  const ask = el('label');
  ask.id = 'batch-ask';
  const select = el('select', 'ctl');
  select.id = 'batch-select';
  select.hidden = true;
  const text = el('input', 'ctl');
  text.id = 'batch-text';
  text.type = 'text';
  text.hidden = true;
  const go = button('batch-go', '', 'btn primary');
  const stop = button('batch-stop', 'Back');
  const note = el('div', 'mono');
  note.id = 'batch-note';
  note.setAttribute('role', 'status');
  const errors = el('div', 'errbar');
  errors.id = 'batch-errors';
  errors.hidden = true;
  const actBtns = {};
  for (const key of ['domain', 'priority', 'block', 'reopen', 'delete', 'done']) {
    const b = button('batch-' + key, ACTIONS[key].label, key === 'delete' ? 'btn danger' : 'btn');
    b.addEventListener('click', () => openForm(key));
    actBtns[key] = b;
  }
  row.append(count, clearBtn, actBtns.domain, actBtns.priority, actBtns.block, actBtns.reopen, actBtns.delete, actBtns.done, form);
  form.append(ask, select, text, go, stop);
  bar.append(row, note, errors);
  mount.replaceChildren(bar);

  let open = null;
  let busy = false;

  function closeForm() {
    open = null;
    form.hidden = true;
    select.hidden = true;
    text.hidden = true;
    select.replaceChildren();
    text.value = '';
    ask.textContent = '';
  }
  function openForm(key) {
    const action = ACTIONS[key];
    errors.hidden = true;
    note.textContent = '';
    closeForm();
    open = key;
    ask.textContent = action.ask;
    ask.hidden = !action.ask;
    form.hidden = false;
    if (action.field === 'text') { text.hidden = false; text.focus(); }
    else if (!action.field) go.focus();
    else {
      select.hidden = false;
      if (action.field === 'priority') {
        for (const name of ['P0', 'P1']) select.append(el('option', null, name));
      } else {
        const none = el('option', null, 'No domain');
        none.value = '';
        select.append(none);
        for (const name of view.domains) { const option = el('option', null, name); option.value = name; select.append(option); }
      }
      select.focus();
    }
    sync();
  }
  function sync() {
    const ids = view.selection();
    bar.hidden = busy ? false : ids.length === 0;
    count.textContent = ids.length + ' selected';
    if (open) {
      const action = ACTIONS[open];
      go.textContent = action.label + ' ' + ids.length;
      go.disabled = busy || ids.length === 0 || (action.field === 'text' && !text.value.trim());
    }
    clearBtn.disabled = busy;
    for (const key of Object.keys(actBtns)) actBtns[key].disabled = busy;
    stop.disabled = busy;
    text.disabled = busy;
    select.disabled = busy;
  }

  /** Every write is one POST with the tasks header; the server's own message is what the operator reads. */
  async function post(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orch-Tasks': '1' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error((data && data.error) || ('HTTP ' + response.status));
  }

  async function run(key, value) {
    const action = ACTIONS[key];
    const ids = view.selection();
    if (!ids.length) return;
    busy = true;
    closeForm();
    errors.hidden = true;
    sync();
    const failed = [];
    const ok = [];
    for (let i = 0; i < ids.length; i++) {
      note.textContent = action.label + ' ' + (i + 1) + ' / ' + ids.length;
      try { await post(action.path, action.body(ids[i], value)); ok.push(ids[i]); }
      catch (e) { failed.push({ id: ids[i], error: e.message }); }
    }
    busy = false;
    note.textContent = action.label + ': ' + ok.length + ' ok, ' + failed.length + ' failed';
    if (failed.length) {
      errors.replaceChildren(...failed.map((f) => el('div', null, '#' + f.id + ': ' + f.error)));
      errors.hidden = false;
    }
    // A failed id keeps its checkbox: the operator retries it. A written one leaves the selection.
    if (ok.length) view.unselect(ok);
    sync();
    void view.refresh();
  }

  clearBtn.addEventListener('click', () => { closeForm(); view.clearSelection(); sync(); });
  stop.addEventListener('click', () => { closeForm(); sync(); });
  go.addEventListener('click', () => {
    if (!open || busy) return;
    const action = ACTIONS[open];
    void run(open, action.field === 'text' ? text.value.trim() : select.value);
  });
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
  // Escape closes the form and stops there: the view's own Escape closes the drawer.
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || busy) return;
    e.stopPropagation();
    closeForm();
    sync();
  });
  text.addEventListener('input', sync);
  document.addEventListener('tasks:selection', sync);
  sync();
})();
`;
