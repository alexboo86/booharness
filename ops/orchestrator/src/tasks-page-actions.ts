/**
 * The tasks page's write controls (ops/orchestrator/TASKS-BOARD.md, "Page seam"). The view
 * (tasks-page.ts) owns the markup, the CSS and the read path; it embeds this string in a script tag
 * after its own. The two modules meet only at #task-actions, #task-new, window.TasksBoard and the
 * tasks:drawer event, so this file renders nothing else and adds no CSS. The view styles the
 * class names this script sets.
 *
 * The string is a TypeScript template literal, so the browser JS inside it carries no backtick and
 * no dollar-brace (lesson 14831). Route data — titles, handles, reasons, errors — is only ever set
 * as textContent, never as markup.
 */
export const TASKS_ACTIONS_SCRIPT = `
(function () {
  const actionsMount = document.getElementById('task-actions');
  const newMount = document.getElementById('task-new');
  const ADVICE_POLL_MS = 2000;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; };
  // One status line per control group, so a route's message lands beside the control that caused it.
  const noteLine = () => { const n = el('span', 'muted'); n.setAttribute('role', 'status'); return n; };
  const say = (note, text, failed) => { note.className = failed ? 'state error' : 'muted'; note.textContent = text; };
  const lock = (controls, disabled) => { for (const control of controls) control.disabled = disabled; };

  /** Every write is one POST with the tasks header; the server's own message is what the operator reads. */
  async function post(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orch-Tasks': '1' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error((data && data.error) || 'Tasks HTTP ' + response.status);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  /**
   * One write: the group goes dead while it flies, a refusal shows the route's message beside it,
   * and a landed write refreshes the board — reopening the drawer when the open task changed, since
   * the view keeps the drawer's own copy of the row.
   */
  let assignFault = null;
  let columnTask = null;
  async function write(controls, note, path, body, reopenId) {
    if (columnTask === body.id && !window.TasksBoard.onScreen(body.id)) {
      say(note, '#' + body.id + ' left the screen; nothing written', true);
      return false;
    }
    lock(controls, true);
    try {
      const data = await post(path, body);
      const notifyFailed = path === '/api/tasks/assign' && data && data.claimed === true && data.notified === false;
      if (notifyFailed) {
        const text = typeof data.error === 'string' && data.error ? data.error : 'claimed, not notified';
        assignFault = { id: body.id, text: text };
        say(note, text, true);
      } else {
        if (path === '/api/tasks/assign') assignFault = null;
        say(note, '');
      }
      const view = window.TasksBoard;
      await view.refresh();
      if (reopenId !== undefined) await view.openDrawer(reopenId);
      return true;
    } catch (error) {
      say(note, error.message, true);
      return false;
    } finally {
      lock(controls, false);
    }
  }

  let confirmNode = null;

  function closeConfirm() {
    if (confirmNode) { confirmNode.remove(); confirmNode = null; }
  }

  /**
   * One inline form below the control that asked: a label, an input, a confirm
   * button that names the action, and Back. Enter confirms, Escape goes back,
   * and an empty value keeps confirm disabled. A dismissed form writes nothing.
   * Escape stops so the view does not close the drawer.
   */
  function openConfirm(after, labelText, actionName, preset, onConfirm) {
    closeConfirm();
    const form = el('div', 'confirm');
    const label = el('label', null, labelText);
    const input = el('input', 'ctl');
    input.type = 'text';
    input.id = 'taskConfirmInput';
    label.htmlFor = input.id;
    input.value = preset || '';
    const confirm = el('button', 'btn', actionName);
    confirm.type = 'button';
    const back = el('button', 'btn', 'Back');
    back.type = 'button';
    const sync = () => { confirm.disabled = input.value.trim() === ''; };
    sync();
    input.addEventListener('input', sync);
    const dismiss = () => { closeConfirm(); };
    back.addEventListener('click', dismiss);
    confirm.addEventListener('click', () => {
      const value = input.value.trim();
      if (!value) return;
      onConfirm(value, confirm);
    });
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return;
      }
      if (event.key === 'Enter' && event.target === input) {
        event.preventDefault();
        if (!confirm.disabled) confirm.click();
      }
    });
    form.append(label, input, confirm, back);
    after.insertAdjacentElement('afterend', form);
    confirmNode = form;
    input.focus();
  }

  function askText(after, controls, note, labelText, actionName, path, body, field, reopenId, preset) {
    openConfirm(after, labelText, actionName, preset || '', (value, confirm) => {
      body[field] = value;
      void write(controls.concat([confirm]), note, path, body, reopenId);
    });
  }

  // Release takes only an id, so every status allows it.
  // Block is not offered when the task is already blocked or closed.
  // Reopen is not offered when the task is already open or in progress.
  // Done is not offered when the task is already done or cancelled.
  // Delete cancels the task: not when it is already cancelled.
  function allows(status, action) {
    if (action === 'release') return true;
    if (action === 'block') return status === 'open' || status === 'in_progress' || status === 'deferred';
    if (action === 'reopen') return status === 'blocked' || status === 'deferred' || status === 'done' || status === 'cancelled';
    if (action === 'done') return status !== 'done' && status !== 'cancelled';
    if (action === 'delete') return status !== 'cancelled';
    return false;
  }

  let adviceStop = null;
  let duplicatesStop = null;

  /**
   * Poll one agent route until the seat settles, then hand its answer to the render
   * callback; the note carries the wait and a failure. The returned stop ends a poll
   * of a drawer the operator left.
   */
  function poll(url, note, render, waiting) {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      let data = null;
      try {
        const response = await fetch(url, { cache: 'no-store' });
        data = await response.json().catch(() => null);
        if (!response.ok) throw new Error((data && data.error) || 'Tasks HTTP ' + response.status);
      } catch (error) {
        if (!stopped) say(note, error.message, true);
        return;
      }
      if (stopped) return;
      if (data.state === 'done') {
        say(note, '');
        render(data.answer);
        return;
      }
      if (data.state === 'failed') {
        say(note, 'Failed', true);
        return;
      }
      say(note, waiting);
      setTimeout(() => { void tick(); }, ADVICE_POLL_MS);
    };
    void tick();
    return () => { stopped = true; };
  }

  /** Reading order belongs here; unrecognized report data stays in folded JSON. */
  function renderAdvice(box, answer) {
    box.replaceChildren();
    if (typeof answer === 'string') { box.textContent = answer; return; }
    const folded = (mount, label, value) => {
      const details = el('details', 'sec');
      details.append(el('summary', null, label), el('pre', 'mono', JSON.stringify(value, null, 2)));
      mount.append(details);
    };
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
      folded(box, 'Report data', answer);
      return;
    }
    const rest = Object.assign(Object.create(null), answer);
    if (typeof answer.forLead === 'string') {
      box.append(el('div', null, answer.forLead));
      delete rest.forLead;
    }
    if (Array.isArray(answer.findings)) {
      for (const finding of answer.findings) {
        const row = el('div', 'field');
        if (finding && typeof finding === 'object' && !Array.isArray(finding)) {
          const extra = Object.assign(Object.create(null), finding);
          if (typeof finding.claim === 'string') { row.append(el('div', null, finding.claim)); delete extra.claim; }
          if (typeof finding.evidence === 'string') {
            const evidence = el('div');
            evidence.append(el('small', 'muted', finding.evidence));
            row.append(evidence);
            delete extra.evidence;
          }
          if (Object.keys(extra).length) folded(row, 'Finding details', extra);
        } else folded(row, 'Finding details', finding);
        box.append(row);
      }
      delete rest.findings;
    }
    for (const key of ['notChecked', 'checked']) {
      if (!Array.isArray(answer[key])) continue;
      if (answer[key].length) {
        const section = el(key === 'checked' ? 'details' : 'div', key === 'checked' ? 'sec' : 'field');
        section.append(el(key === 'checked' ? 'summary' : 'div', null, key === 'checked' ? 'Checked' : 'Not checked'));
        const list = el('ul');
        for (const item of answer[key]) list.append(el('li', null, typeof item === 'string' ? item : JSON.stringify(item, null, 2)));
        section.append(list);
        box.append(section);
      }
      delete rest[key];
    }
    if (Object.keys(rest).length || !box.childNodes.length) folded(box, 'Report data', rest);
  }

  /** Poll the advice route until the seat settles; the answer box shows the parsed report. */
  function pollAdvice(id, note, answerBox) {
    if (adviceStop) adviceStop();
    adviceStop = poll('/api/tasks/advice?id=' + encodeURIComponent(id), note,
      (answer) => renderAdvice(answerBox, answer), 'Asking…');
  }

  /**
   * The candidates of a finished duplicate search. Each finding is one duplicate: the claim
   * is "#<id> <title>" of that task, the evidence its reason (the brief asks for this shape).
   * Nothing the seat reported is dropped: a claim that names no id is shown as text.
   */
  function renderDuplicates(openId, note, box, answer) {
    box.replaceChildren();
    const findings = answer && Array.isArray(answer.findings) ? answer.findings : [];
    if (!findings.length) { box.append(el('div', 'muted', 'No duplicates found')); return; }
    for (const finding of findings) {
      const claim = finding && typeof finding.claim === 'string' ? finding.claim : '';
      const reason = finding && typeof finding.evidence === 'string' ? finding.evidence : '';
      const row = el('div', 'row sect');
      const match = /^#(\\d+)\\s+([\\s\\S]+)$/.exec(claim.trim());
      if (!match) {
        row.append(el('span', 'chip', claim), el('span', 'muted', reason));
        box.append(row);
        continue;
      }
      const candidateId = Number(match[1]);
      const open = el('button', 'chip', '#' + candidateId + ' ' + match[2]);
      open.type = 'button';
      open.addEventListener('click', () => { window.TasksBoard.openDrawer(candidateId); });
      const cancel = el('button', 'btn', 'Cancel as duplicate');
      cancel.type = 'button';
      cancel.addEventListener('click', () => {
        // Closing a task is the operator's act: the same form, reason filled in.
        askText(row, [cancel], note, 'Reason', 'Cancel as duplicate', '/api/tasks/cancel', { id: candidateId }, 'reason', openId, 'duplicate of #' + openId);
      });
      row.append(open, el('span', 'muted', reason), cancel);
      box.append(row);
    }
  }

  /** Poll the duplicate-search route until the seat settles, then draw its candidates. */
  function pollDuplicates(id, note, box) {
    if (duplicatesStop) duplicatesStop();
    duplicatesStop = poll('/api/tasks/duplicates?id=' + encodeURIComponent(id), note,
      (answer) => renderDuplicates(id, note, box, answer), 'Searching…');
  }

  function renderActions(task, intent) {
    if (adviceStop) { adviceStop(); adviceStop = null; }
    if (duplicatesStop) { duplicatesStop(); duplicatesStop = null; }
    closeConfirm();
    actionsMount.replaceChildren();
    const view = window.TasksBoard;
    const id = task.id;
    columnTask = intent && intent.column ? id : null;

    // Domain
    const domainRow = el('div', 'field');
    const domainNote = noteLine();
    const domain = el('select', 'ctl');
    domain.id = 'taskDomain';
    const domainLabel = el('label', null, 'Domain');
    domainLabel.htmlFor = domain.id;
    const names = view.domains.slice();
    // A row can carry a domain the board no longer lists; showing it keeps the select from
    // reporting a group the task is not in and writing it on the first change.
    if (task.domain && !names.includes(task.domain)) names.push(task.domain);
    const noDomain = el('option', null, 'No domain');
    noDomain.value = '';
    domain.append(noDomain);
    for (const name of names) { const option = el('option', null, name); option.value = name; domain.append(option); }
    domain.value = task.domain || '';
    domain.addEventListener('change', () => {
      void write([domain], domainNote, '/api/tasks/update', { id: id, domain: domain.value === '' ? null : domain.value }, id);
    });
    domainRow.append(domainLabel, domain, domainNote);

    // Assign
    const assignRow = el('div', 'field');
    const assignNote = noteLine();
    const assign = el('select', 'ctl');
    assign.id = 'taskAssign';
    const assignLabel = el('label', null, 'Assign');
    assignLabel.htmlFor = assign.id;
    const noHandle = el('option', null, '');
    noHandle.value = '';
    assign.append(noHandle);
    for (const lead of view.leads) {
      if (!lead.live || !lead.handle) continue;
      const option = el('option', null, lead.handle);
      option.value = lead.handle;
      assign.append(option);
    }
    const assignButton = el('button', 'btn', 'Assign');
    assignButton.type = 'button';
    assignButton.disabled = true;
    assign.addEventListener('change', () => { assignButton.disabled = !assign.value; });
    assignButton.addEventListener('click', () => {
      void write([assign, assignButton], assignNote, '/api/tasks/assign', { id: id, handle: assign.value }, id);
    });
    if (assignFault && assignFault.id === id) say(assignNote, assignFault.text, true);
    assignRow.append(assignLabel, assign, assignButton, assignNote);

    // Release, Block, Reopen, Done, Delete — only the actions this status allows.
    const buttonsRow = el('div', 'actions');
    const buttonsNote = noteLine();
    const actionButtons = {};
    const button = (label, className, run) => {
      const control = el('button', className, label);
      control.type = 'button';
      control.addEventListener('click', () => run(control));
      actionButtons[label] = control;
      return control;
    };
    const status = task.status;
    if (allows(status, 'release')) {
      buttonsRow.append(button('Release', 'btn', (control) => {
        void write([control], buttonsNote, '/api/tasks/release', { id: id }, id);
      }));
    }
    if (allows(status, 'block')) {
      buttonsRow.append(button('Block', 'btn', (control) => {
        askText(buttonsRow, [control], buttonsNote, 'Blocked because', 'Block', '/api/tasks/update', { id: id, status: 'blocked' }, 'blocked_reason', id);
      }));
    }
    if (allows(status, 'reopen')) {
      buttonsRow.append(button('Reopen', 'btn', (control) => {
        void write([control], buttonsNote, '/api/tasks/update', { id: id, status: 'open' }, id);
      }));
    }
    if (allows(status, 'done')) {
      buttonsRow.append(button('Done', 'btn primary', (control) => {
        askText(buttonsRow, [control], buttonsNote, 'Evidence', 'Done', '/api/tasks/done', { id: id }, 'evidence', id);
      }));
    }
    if (allows(status, 'delete')) {
      buttonsRow.append(button('Delete', 'btn danger', (control) => {
        askText(buttonsRow, [control], buttonsNote, 'Delete because', 'Delete', '/api/tasks/cancel', { id: id }, 'reason', id);
      }));
    }
    buttonsRow.append(buttonsNote);

    // Ask agent
    const askRow = el('div', 'field');
    const askNote = noteLine();
    const question = el('input', 'ctl');
    question.type = 'text';
    question.id = 'taskAdviceQuestion';
    const askLabel = el('label', null, 'Ask agent');
    askLabel.htmlFor = question.id;
    const askButton = el('button', 'btn', 'Ask');
    askButton.type = 'button';
    const answerBox = el('div', 'drawer-fields');
    answerBox.id = 'taskAdvice';
    askButton.addEventListener('click', async () => {
      const ask = question.value.trim();
      lock([question, askButton], true);
      say(askNote, 'Asking…');
      try {
        await post('/api/tasks/advise', ask ? { id: id, question: ask } : { id: id });
      } catch (error) {
        say(askNote, error.message, true);
        return;
      } finally {
        lock([question, askButton], false);
      }
      pollAdvice(id, askNote, answerBox);
    });
    askRow.append(askLabel, question, askButton, askNote);

    // Find duplicates
    const dupRow = el('div', 'row sect');
    const dupNote = noteLine();
    const dupButton = el('button', 'btn', 'Find duplicates');
    dupButton.type = 'button';
    const dupBox = el('div');
    dupBox.id = 'taskDuplicates';
    dupButton.addEventListener('click', async () => {
      lock([dupButton], true);
      say(dupNote, 'Searching…');
      try {
        await post('/api/tasks/duplicates', { id: id });
      } catch (error) {
        say(dupNote, error.message, true);
        return;
      } finally {
        lock([dupButton], false);
      }
      pollDuplicates(id, dupNote, dupBox);
    });
    dupRow.append(dupButton, dupNote);

    const heading = el('div', 'sect-label', 'ACTIONS');
    actionsMount.append(heading, domainRow, assignRow, buttonsRow, askRow, answerBox, dupRow, dupBox);
    // Column drops use exactly the drawer's single-task actions, including its inline forms.
    // The freshly read status decides what can run; there is no optimistic card move.
    if (columnTask !== null && view.onScreen(id)) {
      const target = intent.column;
      if (target === 'in_progress' && task.status !== 'in_progress') assign.focus();
      else {
        const name = target === 'blocked' ? 'Block' : target === 'done' ? 'Done'
          : target === 'open' ? (task.status === 'in_progress' ? 'Release' : 'Reopen') : null;
        if (name && actionButtons[name]) actionButtons[name].click();
        else if (name) say(buttonsNote, name + ' is not available for this task', true);
      }
    }
  }

  function renderNewTask() {
    newMount.replaceChildren();
    const view = window.TasksBoard;
    const note = noteLine();
    const duplicate = el('div', 'row sect');
    duplicate.hidden = true;
    const form = el('form');
    form.className = 'card';
    form.hidden = true;

    const title = el('input');
    title.type = 'text';
    title.className = 'ctl';
    title.id = 'taskNewTitle';
    title.required = true;
    title.maxLength = 120;
    const priority = el('select');
    priority.id = 'taskNewPriority';
    for (const name of ['P0', 'P1']) { const option = el('option', null, name); option.value = name; priority.append(option); }
    priority.value = 'P1';
    const domain = el('select');
    domain.id = 'taskNewDomain';
    const newNoDomain = el('option', null, 'No domain');
    newNoDomain.value = '';
    domain.append(newNoDomain);
    for (const name of view.domains) { const option = el('option', null, name); option.value = name; domain.append(option); }
    const track = el('input');
    track.type = 'text';
    track.id = 'taskNewTrack';
    const next = el('input');
    next.type = 'text';
    next.id = 'taskNewNext';
    const fields = [title, priority, domain, track, next];
    for (const control of fields) control.className = 'ctl';
    const field = (labelText, control) => {
      const row = el('div', 'field');
      const label = el('label', null, labelText);
      label.htmlFor = control.id;
      row.append(label, control);
      return row;
    };
    const create = el('button', 'btn primary', 'Create');
    create.type = 'submit';
    const submitRow = el('div', 'row sect');
    submitRow.append(create, note);
    const formHeading = el('div', 'actions');
    const back = el('button', 'btn', 'Back');
    back.type = 'button';
    back.addEventListener('click', () => { form.hidden = true; toggle.focus(); });
    formHeading.append(el('h2', null, 'New task'), back);
    form.append(formHeading, field('Title', title), field('Priority', priority), field('Domain', domain), field('Track', track), field('Next step', next), submitRow, duplicate);

    const toggle = el('button', 'btn primary', 'New task');
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      form.hidden = !form.hidden;
      if (!form.hidden) { fillNewDomains(); title.focus(); }
    });

    function payload() {
      const body = { title: title.value.trim(), priority: priority.value };
      if (next.value.trim()) body.next = next.value.trim();
      if (track.value.trim()) body.track = track.value.trim();
      if (domain.value) body.domain = domain.value;
      return body;
    }

    /** A duplicate refusal names the task memoryd matched; the operator may still force the create. */
    function refused(body, error) {
      duplicate.replaceChildren();
      if (error.status !== 409) { duplicate.hidden = true; return; }
      duplicate.hidden = false;
      const found = error.data ? error.data.duplicate_of : null;
      if (found && typeof found === 'object') duplicate.append(el('span', 'chip', '#' + found.id + ' ' + (found.title || '')));
      else if (found !== null && found !== undefined) duplicate.append(el('span', 'chip', '#' + found));
      const anyway = el('button', 'btn', 'Create anyway');
      anyway.type = 'button';
      anyway.addEventListener('click', () => { void send(body, true); });
      duplicate.append(anyway);
    }

    async function send(body, again) {
      lock(fields.concat([create]), true);
      try {
        await post('/api/tasks/create', again ? Object.assign({}, body, { again: true }) : body);
        say(note, '');
        duplicate.hidden = true;
        duplicate.replaceChildren();
        title.value = '';
        track.value = '';
        next.value = '';
        priority.value = 'P1';
        domain.value = '';
        form.hidden = true;
        await view.refresh();
      } catch (error) {
        say(note, error.message, true);
        refused(body, error);
      } finally {
        lock(fields.concat([create]), false);
      }
    }

    form.addEventListener('submit', (event) => { event.preventDefault(); void send(payload(), false); });
    form.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); form.hidden = true; toggle.focus();
    });
    newMount.append(toggle, form);
  }

  function fillNewDomains() {
    const domain = document.getElementById('taskNewDomain');
    if (!domain) return;
    const selected = domain.value;
    const names = window.TasksBoard.domains.slice();
    domain.replaceChildren();
    const none = el('option', null, 'No domain');
    none.value = '';
    domain.append(none);
    for (const name of names) {
      const option = el('option', null, name);
      option.value = name;
      domain.append(option);
    }
    domain.value = names.indexOf(selected) === -1 ? '' : selected;
  }
  document.addEventListener('tasks:board', () => { fillNewDomains(); });
  document.addEventListener('tasks:drawer', (event) => renderActions(event.detail.task, event.detail.intent));
  renderNewTask();
})();
`;
