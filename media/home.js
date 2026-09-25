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
    'file-media': '\ueaea', file: '\uea7b', close: '\uea76',
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
      <div class="atts" id="atts" hidden></div>
      <div class="drop-hint" id="drop-hint">Drop to attach</div>
      <div class="bar">
        <button class="chip attach" id="attach" title="Attach screenshots or files (or paste: ⌃V / ⌘V)" aria-label="Attach files">${ci('file-media')}</button>
        <input type="file" id="file" multiple hidden>
        <label class="chip" id="repo-chip" hidden>${ci('repo')}<select id="repo" aria-label="Repository"></select></label>
        <label class="chip branch" title="Branch (suggested from the first line; type to set your own)">${ci('git-branch')}<input id="branch" spellcheck="false" placeholder="branch" aria-label="Branch"></label>
        <span class="chip" id="base-chip" title="New branch starts from this, freshly fetched"></span>
        <span class="right">
          <span class="error" id="error"></span>
          <button class="go" id="go">${ci('sparkle')}<span>Start</span> <kbd>⏎</kbd></button>
        </span>
      </div>
    </div>
    <p class="hint"><kbd>⏎</kbd> to start · <kbd>⌥</kbd><kbd>⏎</kbd> new line · ⌃V / ⌘V paste a screenshot</p>`;
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

  // ---- attachments: paste, drop (hold ⇧ in the editor), or pick -----------------------------------

  /** @type {{ id: number, name: string, type: string, size: number, data: string, url: string }[]} */
  let attachments = [];
  let nextId = 0;
  const MAX_FILES = 10;
  const MAX_BYTES = 15 * 1024 * 1024;

  function renderAttachments() {
    const box = $('#atts');
    box.hidden = !attachments.length;
    box.innerHTML = attachments
      .map(
        (a) => `<span class="att" title="${esc(a.name)} · ${Math.max(1, Math.round(a.size / 1024))} KB">
          ${a.type.startsWith('image/') ? `<img src="${a.url}" alt="">` : `<span class="att-icon">${ci('file')}</span>`}
          <span class="att-name">${esc(a.name)}</span>
          <button class="att-x" data-id="${a.id}" title="Remove" aria-label="Remove ${esc(a.name)}">${ci('close')}</button>
        </span>`,
      )
      .join('');
  }

  /** @param {FileList | File[]} files */
  async function addFiles(files) {
    let pasted = attachments.filter((a) => a.name.startsWith('pasted-')).length;
    for (const f of Array.from(files)) {
      if (attachments.length >= MAX_FILES) return error(`At most ${MAX_FILES} attachments.`);
      if (f.size > MAX_BYTES) {
        error(`${f.name} is over 15 MB.`);
        continue;
      }
      // Pasted screenshots all arrive as "image.png"; give them distinct names.
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const name = !f.name || /^image\.(png|jpe?g|gif|webp)$/i.test(f.name) ? `pasted-${++pasted}.${ext}` : f.name;
      const data = await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1] ?? '');
        r.readAsDataURL(f);
      });
      attachments.push({ id: ++nextId, name, type: f.type || 'application/octet-stream', size: f.size, data, url: URL.createObjectURL(f) });
    }
    renderAttachments();
  }

  /** Ask the extension for the image on the system clipboard (works even when the page gets none). */
  const pasteFromSystemClipboard = () => vscode.postMessage({ type: 'task.clipboardImage' });
  ta.addEventListener('paste', (e) => {
    const files = e.clipboardData?.files;
    if (files && files.length) {
      e.preventDefault();
      addFiles(files);
    } else if (!e.clipboardData?.getData('text/plain')) {
      // Nothing usable reached the page (common for screenshots inside the editor): fetch it natively.
      e.preventDefault();
      pasteFromSystemClipboard();
    }
  });
  // ⌃V pastes a screenshot too (on a Mac it does nothing in a text box by default).
  ta.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      pasteFromSystemClipboard();
    }
  });
  const composerEl = $('#composer');
  composerEl.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    composerEl.classList.add('dropping');
  });
  composerEl.addEventListener('dragleave', (e) => {
    if (!composerEl.contains(/** @type {Node} */ (e.relatedTarget))) composerEl.classList.remove('dropping');
  });
  composerEl.addEventListener('drop', (e) => {
    composerEl.classList.remove('dropping');
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  });
  $('#attach').addEventListener('click', () => /** @type {HTMLInputElement} */ ($('#file')).click());
  $('#file').addEventListener('change', (e) => {
    const input = /** @type {HTMLInputElement} */ (e.target);
    if (input.files) addFiles(input.files);
    input.value = '';
  });
  $('#atts').addEventListener('click', (e) => {
    const x = /** @type {HTMLElement} */ (e.target).closest('.att-x');
    if (!x) return;
    const id = Number(/** @type {HTMLElement} */ (x).dataset.id);
    const gone = attachments.find((a) => a.id === id);
    if (gone) URL.revokeObjectURL(gone.url);
    attachments = attachments.filter((a) => a.id !== id);
    renderAttachments();
  });

  function submit() {
    if (busy) return;
    if (!draft.text.trim()) {
      error('Describe the task first.');
      ta.focus();
      return;
    }
    busy = true;
    syncChrome();
    vscode.postMessage({
      type: 'task.create',
      prompt: draft.text,
      branch: draft.branch,
      repo: draft.repo,
      attachments: attachments.map((a) => ({ name: a.name, data: a.data })),
    });
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
      case 'task.clipboard':
        if (m.data) {
          const bytes = Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0));
          addFiles([new File([bytes], m.name, { type: 'image/png' })]);
        } else {
          error('No image on the clipboard.');
        }
        break;
      case 'task.done':
        busy = false;
        attachments.forEach((a) => URL.revokeObjectURL(a.url));
        attachments = [];
        renderAttachments();
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
