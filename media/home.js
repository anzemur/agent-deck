// @ts-check
// Agent Deck home page: a big New Task composer and an overview of every agent. All actions go
// back to the extension as messages; the extension stays the single source of truth.
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const CI = {
    'chevron-right': '\ueab6', loading: '\ueb19', sparkle: '\uec10', 'git-branch': '\uea68', home: '\ueb06',
    terminal: '\uea85', repo: '\uea62', 'git-pull-request': '\uea64', 'git-merge': '\ueafe',
    'git-pull-request-closed': '\uebda', bell: '\ueaa2', 'bell-dot': '\ueb9a', 'arrow-up': '\ueaa1',
    'diff': '\ueae1', 'play': '\ueb2c', 'debug-start': '\uead3', 'check': '\ueab2',
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ci = (n, cls = '') => `<i class="ci ${cls}" aria-hidden="true">${CI[n] ?? ''}</i>`;
  const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));

  /** Draft survives closing the tab and reloading the window. */
  const st = vscode.getState() || {};
  let draft = st.draft || { text: '', branch: '', branchEdited: false, repo: undefined };
  let repos = [];
  let base = '';
  let busy = false;
  let seq = 0;
  /** @type {any} */
  let model = null;
  const save = () => vscode.setState({ draft });

  // ---- composer (rendered once; list updates never touch it) ----------------------------------

  const hero = $('#hero');
  hero.innerHTML = `
    <h1>What should we build next?</h1>
    <div class="composer" id="composer">
      <textarea id="text" aria-label="Task" placeholder="Fix the flaky login redirect test — it fails when the session cookie expires mid-redirect.&#10;&#10;Keep the public API; add a regression test."></textarea>
      <div class="bar">
        <label class="chip" id="repo-chip" hidden>${ci('repo')}<select id="repo" aria-label="Repository"></select></label>
        <label class="chip branch" title="Branch (suggested from the first line; type to set your own)">${ci('git-branch')}<input id="branch" spellcheck="false" placeholder="branch" aria-label="Branch"></label>
        <span class="chip" id="base-chip" title="New branch starts from this, freshly fetched"></span>
        <span class="right">
          <span class="error" id="error"></span>
          <button class="go" id="go">${ci('sparkle')}<span>Start</span> <kbd>⏎</kbd></button>
        </span>
      </div>
    </div>
    <p class="hint"><kbd>⏎</kbd> to start · <kbd>⌥</kbd><kbd>⏎</kbd> new line</p>`;
  const ta = /** @type {HTMLTextAreaElement} */ ($('#text'));
  const branch = /** @type {HTMLInputElement} */ ($('#branch'));
  const repoSel = /** @type {HTMLSelectElement} */ ($('#repo'));
  ta.value = draft.text;
  branch.value = draft.branch;

  function grow() {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
  }
  grow();

  function syncChrome() {
    $('#repo-chip').hidden = repos.length < 2;
    repoSel.innerHTML = repos.map((r) => `<option value="${esc(r.root)}" ${r.root === draft.repo ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
    $('#base-chip').innerHTML = base ? `${ci('arrow-up')} from ${esc(base)}` : '';
    $('#base-chip').hidden = !base;
    $('#composer').classList.toggle('busy', busy);
    /** @type {HTMLButtonElement} */ ($('#go')).disabled = busy;
    $('#go').innerHTML = busy ? `${ci('loading', 'spin')}<span>Starting…</span>` : `${ci('sparkle')}<span>Start</span> <kbd>⏎</kbd>`;
    ta.disabled = busy;
    branch.disabled = busy;
  }

  let suggestTimer;
  function suggest() {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => vscode.postMessage({ type: 'task.suggest', text: draft.text, repo: draft.repo, seq: ++seq }), 200);
  }
  const error = (msg) => ($('#error').textContent = msg);

  function submit() {
    if (busy) return;
    if (!draft.text.trim()) {
      error('Describe the task first.');
      ta.focus();
      return;
    }
    busy = true;
    syncChrome();
    vscode.postMessage({ type: 'task.create', prompt: draft.text, branch: draft.branch, repo: draft.repo });
  }

  ta.addEventListener('input', () => {
    draft.text = ta.value;
    grow();
    error('');
    if (!draft.branchEdited) suggest();
    save();
  });
  branch.addEventListener('input', () => {
    draft.branch = branch.value;
    draft.branchEdited = branch.value.trim() !== '';
    if (!draft.branchEdited) suggest();
    error('');
    save();
  });
  repoSel.addEventListener('change', () => {
    draft.repo = repoSel.value;
    save();
    suggest();
  });
  const onEnter = (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    if (e.target === ta && (e.altKey || e.shiftKey)) {
      // ⌥⏎ / ⇧⏎ add a line (a textarea ignores ⌥⏎ on its own).
      e.preventDefault();
      ta.setRangeText('\n', ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
      return;
    }
    e.preventDefault();
    submit();
  };
  ta.addEventListener('keydown', onEnter);
  branch.addEventListener('keydown', onEnter);
  $('#go').addEventListener('click', submit);

  // ---- agents overview ------------------------------------------------------------------------

  const groupsEl = $('#groups');

  function card(w) {
    const icon =
      w.state === 'attention' ? ci('bell-dot', 'state attn')
      : w.state === 'working' ? ci('loading', 'state spin')
      : w.state === 'idle' ? ci('sparkle', 'state')
      : ci(w.isMain ? 'home' : 'git-branch', 'state');
    const sub = w.meta.map((m) => `<span class="${m.cls ?? ''}">${m.icon ? ci(m.icon) : ''}${esc(m.text)}</span>`).join('');
    return `<div class="card ${w.active ? 'active' : ''}" tabindex="0" role="button" data-path="${esc(w.path)}" style="--c:${w.colorVar}" title="${esc(w.tooltip)}">
      ${icon}<span class="title">${esc(w.title)}</span><span class="badge">${esc(w.badge)}</span>
      <span class="sub">${sub}</span>
    </div>`;
  }

  function renderGroups() {
    if (!model) return;
    const ws = model.worktrees;
    const groups = [
      ['needs', 'Needs you', ws.filter((w) => w.state === 'attention')],
      ['working', 'Working', ws.filter((w) => w.state === 'working')],
      ['idle', 'Idle agents', ws.filter((w) => w.state === 'idle')],
      ['other', 'Other worktrees', ws.filter((w) => !w.state)],
    ].filter(([, , list]) => list.length);
    groupsEl.innerHTML = groups.length
      ? groups
          .map(([k, label, list]) => `<section class="group ${k}"><h2>${esc(label)} <span class="n">${list.length}</span></h2><div class="cards">${list.map(card).join('')}</div></section>`)
          .join('')
      : '<p class="empty">No worktrees yet. Start a task above.</p>';
    const n = (s) => ws.filter((w) => w.state === s).length;
    $('#counts').innerHTML = [
      n('attention') ? `<span class="count needs">${ci('bell-dot')}${n('attention')} need you</span>` : '',
      n('working') ? `<span class="count">${ci('loading')}${n('working')} working</span>` : '',
      `<span class="count">${ws.length} worktrees</span>`,
    ].join('');
  }

  const open = (el) => vscode.postMessage({ type: 'select', path: el.dataset.path });
  groupsEl.addEventListener('click', (e) => {
    const el = /** @type {HTMLElement} */ (e.target).closest('.card');
    if (el) open(/** @type {HTMLElement} */ (el));
  });
  groupsEl.addEventListener('keydown', (e) => {
    const el = /** @type {HTMLElement} */ (e.target);
    if ((e.key === 'Enter' || e.key === ' ') && el.classList.contains('card')) {
      e.preventDefault();
      open(el);
    }
  });

  // ---- messages -------------------------------------------------------------------------------

  window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
      case 'state':
        model = m.model;
        $('#where').textContent = m.repoName ?? '';
        repos = m.repos;
        if (!draft.repo || !repos.some((r) => r.root === draft.repo)) draft.repo = m.repo;
        base = m.base || base;
        syncChrome();
        renderGroups();
        break;
      case 'focus':
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        if (draft.text && !draft.branchEdited) suggest();
        break;
      case 'task.suggested':
        if (m.seq !== seq || draft.branchEdited) return; // stale, or you typed your own
        draft.branch = m.branch;
        if (document.activeElement !== branch) branch.value = m.branch;
        base = m.base || base;
        syncChrome();
        save();
        break;
      case 'task.done':
        busy = false;
        draft = { text: '', branch: '', branchEdited: false, repo: draft.repo };
        ta.value = '';
        branch.value = '';
        grow();
        save();
        syncChrome();
        break;
      case 'task.error':
        busy = false;
        syncChrome();
        error(m.message);
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
