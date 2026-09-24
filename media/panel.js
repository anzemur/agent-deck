// @ts-check
// Agent Deck worktree panel (webview). Renders the model posted by the extension; every action is
// sent back as a command so the extension stays the single source of truth.
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const root = /** @type {HTMLElement} */ (document.getElementById('root'));

  const CI = {
    'chevron-right': '\ueab6', 'chevron-down': '\ueab4', loading: '\ueb19', sparkle: '\uec10',
    'git-branch': '\uea68', home: '\ueb06', terminal: '\uea85', add: '\uea60', remove: '\ueb3b',
    'go-to-file': '\uea94', copy: '\uebcc', edit: '\uea73', close: '\uea76',
    'git-pull-request': '\uea64', 'git-pull-request-draft': '\uebdb', 'git-merge': '\ueafe',
    'git-pull-request-closed': '\uebda', 'play-circle': '\ueba6', check: '\ueab2',
    'link-external': '\ueb14', folder: '\uea83', 'empty-window': '\ueae4',
    'arrow-up': '\ueaa1', 'arrow-down': '\uea9a',
  };

  /** @type {any} */
  let model = null;
  /** Which worktree is open (accordion: at most one). */
  let ui = vscode.getState() || { open: null };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ci = (name, cls = '', style = '') => `<i class="ci ${cls}" style="${style}" aria-hidden="true">${CI[name] ?? ''}</i>`;
  const ctx = (o) => esc(JSON.stringify({ preventDefaultContextMenuItems: true, ...o }));
  const act = (icon, title, command, arg) =>
    `<button class="act" title="${esc(title)}" aria-label="${esc(title)}" data-cmd="${esc(command)}" data-arg="${esc(JSON.stringify(arg))}">${ci(icon)}</button>`;
  const cssVar = (id) => (id ? `var(--vscode-${id.replace(/\./g, '-')})` : 'var(--vscode-descriptionForeground)');

  function save() {
    vscode.setState(ui);
  }

  function fileIcon(f) {
    if (f.isDir) return ci('folder', '', 'color: var(--vscode-descriptionForeground)');
    const [ch, dark, light] = f.seti;
    return `<i class="seti" aria-hidden="true" style="--fc:${dark};--fcl:${light}">&#x${ch};</i>`;
  }

  function renderFile(w, f) {
    const arg = { wtPath: w.path, group: f.group, path: f.path, orig: f.orig, code: f.code };
    const stageBtn = f.group === 'staged' ? act('remove', 'Unstage', 'agentDeck.unstage', arg) : act('add', 'Stage', 'agentDeck.stage', arg);
    return `<div class="row" tabindex="-1" data-cmd="agentDeck.openChange" data-arg="${esc(JSON.stringify(arg))}"
        title="${esc(f.tooltip)}" data-vscode-context="${ctx({ webviewSection: f.group === 'staged' ? 'stagedChange' : 'change', ...arg })}">
      ${fileIcon(f)}
      <span class="grow"><span class="name" style="color:${cssVar(f.colorId)}">${esc(f.name)}</span><span class="sub">${esc(f.dir)}</span></span>
      <span class="actions">${act('go-to-file', 'Open File', 'agentDeck.openChangedFile', arg)}${stageBtn}</span>
      <span class="end" style="color:${cssVar(f.colorId)}">${esc(f.letter)}</span>
    </div>`;
  }

  function renderSection(w, s) {
    const wtArg = { wtPath: w.path };
    switch (s.kind) {
      case 'staged':
      case 'unstaged': {
        const groupArg = { wtPath: w.path, group: s.kind };
        const bulk = s.kind === 'staged' ? act('remove', 'Unstage All', 'agentDeck.unstage', groupArg) : act('add', 'Stage All', 'agentDeck.stage', groupArg);
        return `<div class="sec">${esc(s.title)} <span class="count">${s.files.length}</span><span class="actions">${bulk}</span></div>
          ${s.files.map((f) => renderFile(w, f)).join('')}`;
      }
      case 'clean':
        return `<div class="sec">Changes</div><div class="row muted">${ci('check')}<span class="grow">No changes</span></div>`;
      case 'terminals': {
        const rows = s.terminals.length
          ? s.terminals
              .map(
                (t) => `<div class="row" tabindex="-1" data-cmd="agentDeck.showTerminal" data-arg="${esc(JSON.stringify({ termId: t.id }))}"
                  data-term="${esc(t.id)}" data-vscode-context="${ctx({ webviewSection: 'terminal', termId: t.id })}">
                ${ci(t.icon, t.spin ? 'spin' : '', `color:${w.colorVar}`)}
                <span class="grow"><span class="name">${esc(t.name)}</span><span class="sub">${esc(t.sub)}</span></span>
                <span class="actions">${act('edit', 'Rename', 'agentDeck.renameTerminal', { termId: t.id })}${act('close', 'Kill Terminal', 'agentDeck.killTerminal', { termId: t.id })}</span>
              </div>`,
              )
              .join('')
          : `<div class="row" tabindex="-1" data-cmd="agentDeck.newTerminal" data-arg="${esc(JSON.stringify(wtArg))}">${ci('add')}<span class="grow"><span class="name">New terminal</span></span></div>`;
        return `<div class="sec">Terminals <span class="count">${s.terminals.length || ''}</span><span class="actions">${act('add', 'New Terminal', 'agentDeck.newTerminal', wtArg)}</span></div>${rows}`;
      }
      case 'prs': {
        const rows = s.prs
          .map(
            (p) => `<div class="row" tabindex="-1" data-cmd="agentDeck.openPrLink" data-arg="${esc(JSON.stringify({ url: p.url }))}" title="${esc(p.tooltip)}"
                data-vscode-context="${ctx({ webviewSection: 'pr', url: p.url })}">
              ${ci(p.icon, '', `color:${cssVar(p.colorId)}`)}
              <span class="grow"><span class="name">#${p.number}</span><span class="sub">${esc(p.title ?? '')}</span></span>
              <span class="actions">${act('copy', 'Copy Link', 'agentDeck.copyPrLink', { url: p.url })}</span>
              <span class="end muted">${esc(p.sub)}</span>
            </div>`,
          )
          .join('');
        return `<div class="sec">Pull requests <span class="count">${s.prs.length || 'none'}</span></div>${rows}`;
      }
    }
    return '';
  }

  function renderWorktree(w) {
    const open = ui.open === w.path;
    const stateIcon = w.state === 'working' ? ci('loading', 'state spin') : w.state === 'idle' ? ci('sparkle', 'state') : ci(w.isMain ? 'home' : 'git-branch', 'state plain');
    const meta = w.meta.map((m) => `<span>${m.icon ? ci(m.icon) : ''}${esc(m.text)}</span>`).join('');
    const head = `<div class="row wt ${w.active ? 'active' : ''}" tabindex="0" role="treeitem" aria-expanded="${open}"
        data-wt="${esc(w.path)}" title="${esc(w.tooltip)}" data-vscode-context="${ctx(w.context)}">
      ${ci(open ? 'chevron-down' : 'chevron-right', 'twisty')}
      ${stateIcon}
      <span class="text"><span class="title">${esc(w.title)}</span><span class="meta">${meta}</span></span>
      <span class="actions">${act('terminal', 'New Terminal', 'agentDeck.newTerminal', { wtPath: w.path })}${act('empty-window', 'Open in New Window', 'agentDeck.openInNewWindow', { wtPath: w.path })}</span>
      <span class="badge">${esc(w.badge)}</span>
    </div>`;
    const body = open ? `<div class="body">${w.sections.map((s) => renderSection(w, s)).join('')}</div>` : '';
    return `<div class="card ${open ? 'open' : ''}" style="--c:${w.colorVar}">${head}${body}</div>`;
  }

  function render() {
    if (!model) return;
    const focused = /** @type {HTMLElement | null} */ (document.activeElement);
    const focusKey = focused?.dataset?.wt ?? focused?.dataset?.term;
    if (!model.worktrees.length) {
      root.innerHTML = `<div class="empty">No git repository is open in this window. Open a folder that is a git repository to see its worktrees.</div>`;
      return;
    }
    let html = '';
    let repo = null;
    for (const w of model.worktrees) {
      if (model.multiRepo && w.repo !== repo) {
        repo = w.repo;
        html += `<div class="repo">${esc(repo)}</div>`;
      }
      html += renderWorktree(w);
    }
    root.innerHTML = html;
    vscode.postMessage({
      type: 'rendered',
      worktrees: root.querySelectorAll('.wt').length,
      open: ui.open,
      openRows: [...root.querySelectorAll('.body .row .name, .body .sec')].map((e) => e.textContent?.trim()),
    });
    // Keep keyboard focus on the same row across re-renders.
    if (focusKey) {
      const again = root.querySelector(`[data-wt="${CSS.escape(focusKey)}"], [data-term="${CSS.escape(focusKey)}"]`);
      if (again instanceof HTMLElement) again.focus();
    }
  }

  function toggle(path, force) {
    ui.open = force ?? (ui.open === path ? null : path);
    save();
    render();
  }

  // ---- events ----

  root.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const btn = t.closest('button[data-cmd]');
    const row = t.closest('[data-cmd], [data-wt]');
    const el = /** @type {HTMLElement | null} */ (btn ?? row);
    if (!el) return;
    if (el.dataset.wt && !btn) {
      // Worktree card: open it (closing the others) and bring its terminal forward.
      toggle(el.dataset.wt);
      vscode.postMessage({ type: 'select', path: el.dataset.wt });
      return;
    }
    vscode.postMessage({ type: 'command', command: el.dataset.cmd, arg: JSON.parse(el.dataset.arg || 'null') });
  });

  root.addEventListener('keydown', (e) => {
    const cur = /** @type {HTMLElement} */ (document.activeElement);
    const rows = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('.row[tabindex]')]);
    const i = rows.indexOf(cur);
    const move = (d) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + d))];
      if (next) next.focus();
    };
    switch (e.key) {
      case 'ArrowDown': move(1); break;
      case 'ArrowUp': move(-1); break;
      case 'ArrowRight': if (cur?.dataset.wt) toggle(cur.dataset.wt, cur.dataset.wt); break;
      case 'ArrowLeft': if (cur?.dataset.wt && ui.open === cur.dataset.wt) toggle(cur.dataset.wt, null); break;
      case 'Enter': case ' ': if (i >= 0) cur.click(); break;
      default: return;
    }
    e.preventDefault();
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      const prevActive = model?.active;
      model = m.model;
      // Whenever the active worktree changes (a click here, a terminal focused elsewhere, a
      // keybinding), open it and close the rest.
      if (model.active && model.active !== prevActive && model.active !== ui.open) {
        ui.open = model.active;
        save();
      }
      render();
    } else if (m.type === 'reveal') {
      // Focus moved to a terminal elsewhere: open its worktree and scroll to it.
      ui.open = m.path;
      save();
      render();
      const el = root.querySelector(`[data-wt="${CSS.escape(m.path)}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
