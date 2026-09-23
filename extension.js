// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const ENV_KEY = 'AGENT_DECK_WORKTREE';
const COLORS = [
  'terminal.ansiCyan',
  'terminal.ansiMagenta',
  'terminal.ansiGreen',
  'terminal.ansiYellow',
  'terminal.ansiBlue',
  'terminal.ansiRed',
  'terminal.ansiBrightCyan',
  'terminal.ansiBrightMagenta',
  'terminal.ansiBrightGreen',
  'terminal.ansiBrightYellow',
  'terminal.ansiBrightBlue',
  'terminal.ansiBrightRed',
];

/** @typedef {{ path: string, branch: string | undefined, head: string, isMain: boolean, locked: boolean, prunable: boolean, repo: Repo }} Worktree */
/** @typedef {{ commonDir: string, root: string, name: string, pinned: boolean, worktrees: Worktree[] }} Repo */
/** @typedef {{ kind: 'repo', id: string, repo: Repo }} RepoNode */
/** @typedef {{ kind: 'worktree', id: string, wt: Worktree }} WorktreeNode */
/** @typedef {{ kind: 'terminal', id: string, terminal: vscode.Terminal, wtPath: string }} TerminalNode */
/** @typedef {RepoNode | WorktreeNode | TerminalNode} Node */

// ---------------------------------------------------------------- git helpers

/** @returns {Promise<string>} */
function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

/** Resolves any path inside a repo (or any of its worktrees) to its shared .git dir. */
async function commonDirOf(dir) {
  try {
    const out = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    return fs.realpathSync(out.trim());
  } catch {
    return undefined;
  }
}

/** @returns {Promise<Omit<Worktree, 'repo'>[]>} */
async function listWorktrees(cwd) {
  const out = await git(cwd, ['worktree', 'list', '--porcelain']);
  const result = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), branch: undefined, head: '', isMain: result.length === 0, locked: false, prunable: false, bare: false };
      result.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('locked')) cur.locked = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  return result.filter((w) => !w.bare).map(({ bare, ...w }) => w);
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function hashColor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}

function wtLabel(wt) {
  return wt.branch ?? `${path.basename(wt.path)} (detached)`;
}

// ---------------------------------------------------------------- deck state

class Deck {
  /** @param {vscode.ExtensionContext} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {Repo[]} */
    this.repos = [];
    /** @type {Map<vscode.Terminal, string>} terminal -> worktree path */
    this.links = new Map();
    /** @type {Map<vscode.Terminal, string>} our own stable display names */
    this.names = new Map();
    /** @type {Map<string, vscode.Terminal>} worktree path -> last focused terminal */
    this.lastTerminal = new Map();
    /** @type {Map<vscode.Terminal, number>} running shell executions per terminal */
    this.busy = new Map();
    /** @type {string | undefined} */
    this.active = ctx.workspaceState.get('agentDeck.active');
    /** @type {vscode.FileSystemWatcher[]} */
    this.gitWatchers = [];
    this.refreshing = undefined;
    this.pendingRefresh = false;

    this._onChange = new vscode.EventEmitter();
    this.onChange = this._onChange.event;
    this._onActive = new vscode.EventEmitter();
    this.onActive = this._onActive.event;
  }

  get worktrees() {
    return this.repos.flatMap((r) => r.worktrees);
  }

  findWorktree(p) {
    return this.worktrees.find((w) => w.path === p);
  }

  /** Deepest worktree containing `p` (worktrees can be nested inside the main checkout). */
  worktreeContaining(p) {
    let best;
    for (const w of this.worktrees) {
      if (isInside(p, w.path) && (!best || w.path.length > best.path.length)) best = w;
    }
    return best;
  }

  // ------------------------------------------------------------ discovery

  refresh() {
    if (this.refreshing) {
      this.pendingRefresh = true;
      return this.refreshing;
    }
    this.refreshing = this._refresh().finally(() => {
      this.refreshing = undefined;
      if (this.pendingRefresh) {
        this.pendingRefresh = false;
        this.refresh();
      }
    });
    return this.refreshing;
  }

  async _refresh() {
    const pinned = this.ctx.globalState.get('agentDeck.repos', /** @type {string[]} */ ([]));
    const candidates = [
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => ({ dir: f.uri.fsPath, pinned: false })),
      ...pinned.map((dir) => ({ dir, pinned: true })),
    ];

    /** @type {Map<string, Repo>} */
    const byCommon = new Map();
    for (const c of candidates) {
      if (!fs.existsSync(c.dir)) continue;
      const commonDir = await commonDirOf(c.dir);
      if (!commonDir) continue;
      const existing = byCommon.get(commonDir);
      if (existing) {
        existing.pinned = existing.pinned || c.pinned;
        continue;
      }
      try {
        const raw = await listWorktrees(c.dir);
        const root = raw[0]?.path ?? c.dir;
        /** @type {Repo} */
        const repo = { commonDir, root, name: path.basename(root), pinned: c.pinned, worktrees: [] };
        repo.worktrees = raw.map((w) => ({ ...w, repo }));
        byCommon.set(commonDir, repo);
      } catch (e) {
        console.error('[agent-deck]', e);
      }
    }

    this.repos = [...byCommon.values()];
    this.adoptTerminals();
    this.watchGit();

    if (!this.active || !this.findWorktree(this.active)) {
      const guess = vscode.window.activeTerminal && this.worktreeOf(vscode.window.activeTerminal);
      this.setActive(guess?.path ?? this.worktrees[0]?.path);
    }
    this._onChange.fire();
  }

  watchGit() {
    const key = this.repos.map((r) => r.commonDir).sort().join('\n');
    if (key === this.watchKey) return;
    this.watchKey = key;
    for (const w of this.gitWatchers) w.dispose();
    this.gitWatchers = [];
    let timer;
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.refresh(), 300);
    };
    for (const repo of this.repos) {
      const pattern = new vscode.RelativePattern(vscode.Uri.file(repo.commonDir), '{HEAD,worktrees,worktrees/*,worktrees/*/HEAD}');
      const w = vscode.workspace.createFileSystemWatcher(pattern);
      w.onDidCreate(kick);
      w.onDidChange(kick);
      w.onDidDelete(kick);
      this.gitWatchers.push(w);
    }
  }

  // ------------------------------------------------------------ terminals

  /** Re-link terminals that survived a window reload, using the env marker or saved names. */
  adoptTerminals() {
    const saved = this.ctx.workspaceState.get('agentDeck.links', /** @type {{name: string, path: string}[]} */ ([]));
    for (const t of vscode.window.terminals) {
      if (this.links.has(t)) continue;
      const opts = /** @type {vscode.TerminalOptions} */ (t.creationOptions);
      const fromEnv = opts?.env?.[ENV_KEY];
      const fromName = saved.find((s) => s.name === t.name)?.path;
      const p = fromEnv ?? fromName;
      if (p && this.findWorktree(p)) {
        this.links.set(t, p);
        this.names.set(t, t.name);
      }
    }
  }

  saveLinks() {
    const data = [...this.links].map(([t, p]) => ({ name: this.names.get(t) ?? t.name, path: p }));
    this.ctx.workspaceState.update('agentDeck.links', data);
  }

  /** Worktree a terminal belongs to: explicit link first, else whatever directory the shell is in. */
  worktreeOf(t) {
    const linked = this.links.get(t);
    if (linked) return this.findWorktree(linked);
    const cwd = t.shellIntegration?.cwd?.fsPath ?? cwdOption(t);
    return cwd ? this.worktreeContaining(cwd) : undefined;
  }

  terminalsOf(wtPath) {
    return vscode.window.terminals.filter((t) => this.worktreeOf(t)?.path === wtPath);
  }

  displayName(t) {
    return this.names.get(t) ?? t.name;
  }

  /** @param {Worktree} wt */
  createTerminal(wt, { show = true, preserveFocus = false } = {}) {
    const cfg = vscode.workspace.getConfiguration('agentDeck');
    const base = wtLabel(wt);
    const taken = new Set(this.terminalsOf(wt.path).map((t) => this.displayName(t)));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base} · ${i}`;

    const terminal = vscode.window.createTerminal({
      name,
      cwd: wt.path,
      iconPath: new vscode.ThemeIcon(wt.isMain ? 'repo' : 'git-branch'),
      color: new vscode.ThemeColor(hashColor(wt.path)),
      env: { [ENV_KEY]: wt.path },
      location: cfg.get('terminalLocation') === 'editor' ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel,
    });
    this.links.set(terminal, wt.path);
    this.names.set(terminal, name);
    this.lastTerminal.set(wt.path, terminal);
    this.saveLinks();

    const startup = /** @type {string} */ (cfg.get('startupCommand') ?? '').trim();
    if (startup) terminal.sendText(startup, true);
    if (show) terminal.show(preserveFocus);
    this._onChange.fire();
    return terminal;
  }

  forgetTerminal(t) {
    const p = this.links.get(t);
    this.links.delete(t);
    this.names.delete(t);
    this.busy.delete(t);
    for (const [k, v] of this.lastTerminal) if (v === t) this.lastTerminal.delete(k);
    if (p) this.saveLinks();
    this._onChange.fire();
  }

  // ------------------------------------------------------------ selection

  setActive(p) {
    if (p === this.active) return false;
    this.active = p;
    this.ctx.workspaceState.update('agentDeck.active', p);
    this._onActive.fire(p);
    this._onChange.fire();
    return true;
  }

  /** Worktree clicked: make it active and bring its terminal forward (creating one if needed). */
  switchTo(wtPath, { preserveFocus = false } = {}) {
    const wt = this.findWorktree(wtPath);
    if (!wt) return;
    this.setActive(wtPath);
    const terms = this.terminalsOf(wtPath);
    const last = this.lastTerminal.get(wtPath);
    const target = last && terms.includes(last) ? last : terms[0];
    if (target) target.show(preserveFocus);
    else this.createTerminal(wt, { preserveFocus });
  }
}

function cwdOption(t) {
  const opts = /** @type {vscode.TerminalOptions} */ (t.creationOptions);
  const cwd = opts?.cwd;
  if (!cwd) return undefined;
  return typeof cwd === 'string' ? cwd : cwd.fsPath;
}

// ---------------------------------------------------------------- worktree tree

/** @implements {vscode.TreeDataProvider<Node>} */
class WorktreeTree {
  /** @param {Deck} deck */
  constructor(deck) {
    this.deck = deck;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    /** @type {Map<string, Node>} stable node objects so reveal() can find them */
    this.nodes = new Map();
    /** @type {Map<vscode.Terminal, string>} */
    this.termIds = new Map();
    this.nextTermId = 0;
    deck.onChange(() => this._onDidChange.fire(undefined));
  }

  node(n) {
    const prev = this.nodes.get(n.id);
    if (prev) {
      Object.assign(prev, n);
      return prev;
    }
    this.nodes.set(n.id, n);
    return n;
  }

  repoNode(repo) {
    return /** @type {RepoNode} */ (this.node({ kind: 'repo', id: `repo:${repo.commonDir}`, repo }));
  }

  wtNode(wt) {
    return /** @type {WorktreeNode} */ (this.node({ kind: 'worktree', id: `wt:${wt.path}`, wt }));
  }

  termNode(t, wtPath) {
    let pid = this.termIds.get(t);
    if (!pid) {
      pid = String(++this.nextTermId);
      this.termIds.set(t, pid);
    }
    return /** @type {TerminalNode} */ (this.node({ kind: 'terminal', id: `term:${pid}`, terminal: t, wtPath }));
  }

  /** @param {Node} [el] */
  getChildren(el) {
    const deck = this.deck;
    if (!el) {
      if (deck.repos.length === 1) return deck.repos[0].worktrees.map((w) => this.wtNode(w));
      return deck.repos.map((r) => this.repoNode(r));
    }
    if (el.kind === 'repo') return el.repo.worktrees.map((w) => this.wtNode(w));
    if (el.kind === 'worktree') return deck.terminalsOf(el.wt.path).map((t) => this.termNode(t, el.wt.path));
    return [];
  }

  /** @param {Node} el */
  getParent(el) {
    if (el.kind === 'terminal') {
      const wt = this.deck.findWorktree(el.wtPath);
      return wt && this.wtNode(wt);
    }
    if (el.kind === 'worktree' && this.deck.repos.length > 1) return this.repoNode(el.wt.repo);
    return undefined;
  }

  /** @param {Node} el */
  getTreeItem(el) {
    const deck = this.deck;
    if (el.kind === 'repo') {
      const item = new vscode.TreeItem(el.repo.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = el.id;
      item.iconPath = new vscode.ThemeIcon('repo');
      item.description = `${el.repo.worktrees.length} worktree${el.repo.worktrees.length === 1 ? '' : 's'}`;
      item.tooltip = el.repo.root;
      item.contextValue = 'repo';
      return item;
    }

    if (el.kind === 'worktree') {
      const wt = el.wt;
      const terms = deck.terminalsOf(wt.path);
      const running = terms.some((t) => (deck.busy.get(t) ?? 0) > 0);
      const isActive = deck.active === wt.path;
      const item = new vscode.TreeItem(
        wtLabel(wt),
        terms.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      );
      item.id = el.id;
      const color = new vscode.ThemeColor(hashColor(wt.path));
      item.iconPath = running
        ? new vscode.ThemeIcon('loading~spin', color)
        : new vscode.ThemeIcon(isActive ? 'circle-filled' : wt.isMain ? 'repo' : 'git-branch', color);
      const folder = path.basename(wt.path);
      const bits = [];
      if (terms.length) bits.push(`${terms.length} term`);
      if (folder !== wt.branch) bits.push(folder);
      if (wt.isMain) bits.push('main checkout');
      if (wt.locked) bits.push('locked');
      if (wt.prunable) bits.push('missing');
      item.description = bits.join(' · ');
      item.tooltip = new vscode.MarkdownString(
        `**${wtLabel(wt)}**\n\n\`${wt.path}\`\n\nHEAD \`${wt.head.slice(0, 8)}\`${terms.length ? `\n\nTerminals: ${terms.map((t) => deck.displayName(t)).join(', ')}` : ''}`,
      );
      item.contextValue = wt.isMain ? 'worktreeMain' : 'worktree';
      item.command = { command: 'agentDeck.selectWorktree', title: 'Switch to Worktree', arguments: [wt.path] };
      return item;
    }

    const t = el.terminal;
    const running = (deck.busy.get(t) ?? 0) > 0;
    const item = new vscode.TreeItem(deck.displayName(t), vscode.TreeItemCollapsibleState.None);
    item.id = el.id;
    item.iconPath = new vscode.ThemeIcon(running ? 'loading~spin' : 'terminal', new vscode.ThemeColor(hashColor(el.wtPath)));
    const cmd = running ? lastCommand.get(t) : undefined;
    item.description = [vscode.window.activeTerminal === t ? 'active' : '', cmd ?? ''].filter(Boolean).join(' · ');
    item.contextValue = 'terminal';
    item.command = { command: 'agentDeck.showTerminal', title: 'Show Terminal', arguments: [el] };
    return item;
  }
}

/** @type {WeakMap<vscode.Terminal, string>} */
const lastCommand = new WeakMap();

// ---------------------------------------------------------------- files tree

/** @implements {vscode.TreeDataProvider<vscode.Uri>} */
class FilesTree {
  /** @param {Deck} deck */
  constructor(deck) {
    this.deck = deck;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    this.watcher = undefined;
    this.root = undefined;
    /** @type {Map<string, vscode.FileType>} */
    this.types = new Map();
    this.setRoot(deck.active);
    deck.onActive((p) => this.setRoot(p));
  }

  setRoot(p) {
    if (p === this.root) return;
    this.root = p;
    this.watcher?.dispose();
    this.watcher = undefined;
    if (p) {
      let timer;
      const kick = () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.refresh(), 250);
      };
      this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(p), '**/*'), false, true, false);
      this.watcher.onDidCreate(kick);
      this.watcher.onDidDelete(kick);
    }
    this.refresh();
  }

  refresh() {
    this._onDidChange.fire(undefined);
  }

  excluded(name) {
    const exclude = vscode.workspace.getConfiguration('files').get('exclude', {});
    if (name === '.git') return true;
    return Object.entries(exclude).some(([glob, on]) => on && glob.replace(/^\*\*\//, '') === name);
  }

  /** @param {vscode.Uri} [uri] */
  async getChildren(uri) {
    const dir = uri ?? (this.root ? vscode.Uri.file(this.root) : undefined);
    if (!dir) return [];
    let entries;
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return [];
    }
    return entries
      .filter(([name]) => !this.excluded(name))
      .sort(([a, at], [b, bt]) => {
        const ad = at & vscode.FileType.Directory, bd = bt & vscode.FileType.Directory;
        if (ad !== bd) return ad ? -1 : 1;
        return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
      })
      .map(([name, type]) => {
        const child = vscode.Uri.joinPath(dir, name);
        this.types.set(child.toString(), type);
        return child;
      });
  }

  /** @param {vscode.Uri} uri */
  getTreeItem(uri) {
    const isDir = ((this.types.get(uri.toString()) ?? 0) & vscode.FileType.Directory) !== 0;
    const item = new vscode.TreeItem(uri, isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = uri.toString();
    if (!isDir) item.command = { command: 'vscode.open', title: 'Open', arguments: [uri] };
    return item;
  }
}

// ---------------------------------------------------------------- activation

/** @param {vscode.ExtensionContext} ctx */
function activate(ctx) {
  const deck = new Deck(ctx);
  const tree = new WorktreeTree(deck);
  const files = new FilesTree(deck);

  const view = vscode.window.createTreeView('agentDeck.worktrees', { treeDataProvider: tree, showCollapseAll: false });
  const filesView = vscode.window.createTreeView('agentDeck.files', { treeDataProvider: files, showCollapseAll: false });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'agentDeck.quickSwitch';
  status.tooltip = 'Agent Deck: switch worktree (⌘⌥W)';

  const updateChrome = () => {
    const wt = deck.active ? deck.findWorktree(deck.active) : undefined;
    if (wt) {
      status.text = `$(git-branch) ${wtLabel(wt)}`;
      status.show();
      filesView.description = wtLabel(wt);
      filesView.message = undefined;
    } else {
      status.hide();
      filesView.description = undefined;
      filesView.message = deck.repos.length ? 'Select a worktree.' : undefined;
    }
  };
  deck.onChange(updateChrome);

  /** Reflect the active terminal's worktree in the tree without stealing focus. */
  const syncFromTerminal = (t) => {
    if (!t) return;
    const wt = deck.worktreeOf(t);
    if (!wt) return;
    deck.lastTerminal.set(wt.path, t);
    deck.setActive(wt.path);
    tree._onDidChange.fire(undefined);
    if (!view.visible) return;
    const target = deck.terminalsOf(wt.path).includes(t) ? tree.termNode(t, wt.path) : tree.wtNode(wt);
    // Give the tree a tick to re-render before revealing.
    setTimeout(() => view.reveal(target, { select: true, focus: false, expand: true }).then(undefined, () => {}), 50);
  };

  const pickWorktree = async (placeHolder) => {
    const items = deck.worktrees.map((w) => ({
      label: `$(${w.isMain ? 'repo' : 'git-branch'}) ${wtLabel(w)}`,
      description: [deck.repos.length > 1 ? w.repo.name : '', deck.terminalsOf(w.path).length ? `${deck.terminalsOf(w.path).length} term` : '', deck.active === w.path ? 'active' : ''].filter(Boolean).join(' · '),
      detail: w.path,
      wt: w,
    }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDetail: true });
    return pick?.wt;
  };

  const pickRepo = async () => {
    if (deck.repos.length === 1) return deck.repos[0];
    if (!deck.repos.length) {
      vscode.window.showWarningMessage('Agent Deck: add a repository first.');
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      deck.repos.map((r) => ({ label: r.name, detail: r.root, repo: r })),
      { placeHolder: 'Repository for the new worktree' },
    );
    return pick?.repo;
  };

  /** Accepts a tree node, a path string, or nothing (falls back to the active worktree). */
  const resolveWt = (arg) => {
    if (typeof arg === 'string') return deck.findWorktree(arg);
    if (arg?.kind === 'worktree') return arg.wt;
    if (arg?.kind === 'terminal') return deck.findWorktree(arg.wtPath);
    return deck.active ? deck.findWorktree(deck.active) : undefined;
  };

  const cycle = (dir) => {
    const all = deck.worktrees;
    if (!all.length) return;
    const i = all.findIndex((w) => w.path === deck.active);
    const next = all[(i + dir + all.length) % all.length];
    deck.switchTo(next.path);
  };

  ctx.subscriptions.push(
    view,
    filesView,
    status,
    { dispose: () => deck.gitWatchers.forEach((w) => w.dispose()) },
    { dispose: () => files.watcher?.dispose() },

    vscode.window.onDidChangeActiveTerminal(syncFromTerminal),
    vscode.window.onDidOpenTerminal(() => {
      deck.adoptTerminals();
      tree._onDidChange.fire(undefined);
    }),
    vscode.window.onDidCloseTerminal((t) => {
      const id = tree.termIds.get(t);
      if (id) tree.nodes.delete(`term:${id}`);
      tree.termIds.delete(t);
      deck.forgetTerminal(t);
    }),
    vscode.window.onDidChangeTerminalShellIntegration(() => tree._onDidChange.fire(undefined)),
    vscode.window.onDidStartTerminalShellExecution((e) => {
      deck.busy.set(e.terminal, (deck.busy.get(e.terminal) ?? 0) + 1);
      lastCommand.set(e.terminal, e.execution.commandLine.value.split(/\s+/)[0] || '');
      tree._onDidChange.fire(undefined);
    }),
    vscode.window.onDidEndTerminalShellExecution((e) => {
      deck.busy.set(e.terminal, Math.max(0, (deck.busy.get(e.terminal) ?? 1) - 1));
      // A shell `cd` may have moved an unlinked terminal into another worktree.
      tree._onDidChange.fire(undefined);
      if (e.terminal === vscode.window.activeTerminal) syncFromTerminal(e.terminal);
    }),
    vscode.window.onDidChangeWindowState((s) => s.focused && deck.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => deck.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('files.exclude') && files.refresh()),
    view.onDidChangeVisibility((e) => e.visible && syncFromTerminal(vscode.window.activeTerminal)),

    vscode.commands.registerCommand('agentDeck.refresh', () => deck.refresh()),
    vscode.commands.registerCommand('agentDeck.refreshFiles', () => files.refresh()),
    vscode.commands.registerCommand('agentDeck.collapseFiles', () =>
      vscode.commands.executeCommand('workbench.actions.treeView.agentDeck.files.collapseAll'),
    ),

    vscode.commands.registerCommand('agentDeck.selectWorktree', (p) => deck.switchTo(p)),
    vscode.commands.registerCommand('agentDeck.quickSwitch', async () => {
      const wt = await pickWorktree('Switch to worktree');
      if (wt) deck.switchTo(wt.path);
    }),
    vscode.commands.registerCommand('agentDeck.nextWorktree', () => cycle(1)),
    vscode.commands.registerCommand('agentDeck.prevWorktree', () => cycle(-1)),

    vscode.commands.registerCommand('agentDeck.showTerminal', (/** @type {TerminalNode} */ n) => {
      deck.lastTerminal.set(n.wtPath, n.terminal);
      deck.setActive(n.wtPath);
      n.terminal.show(false);
    }),
    vscode.commands.registerCommand('agentDeck.newTerminal', async (arg) => {
      const wt = resolveWt(arg) ?? (await pickWorktree('New terminal in…'));
      if (!wt) return;
      deck.setActive(wt.path);
      deck.createTerminal(wt);
    }),
    vscode.commands.registerCommand('agentDeck.killTerminal', (/** @type {TerminalNode} */ n) => n?.terminal.dispose()),
    vscode.commands.registerCommand('agentDeck.renameTerminal', async (/** @type {TerminalNode} */ n) => {
      if (!n) return;
      const name = await vscode.window.showInputBox({ prompt: 'Terminal name', value: deck.displayName(n.terminal) });
      if (!name) return;
      n.terminal.show(true);
      await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
      deck.names.set(n.terminal, name);
      deck.saveLinks();
      tree._onDidChange.fire(undefined);
    }),

    vscode.commands.registerCommand('agentDeck.newWorktree', async (arg) => {
      const repo = arg?.kind === 'repo' ? arg.repo : arg?.kind === 'worktree' ? arg.wt.repo : await pickRepo();
      if (!repo) return;
      const branch = await vscode.window.showInputBox({
        prompt: `New worktree in ${repo.name}: branch name (existing branches are checked out, new ones branch off the main checkout's HEAD)`,
        placeHolder: 'feat/my-agent-task',
        validateInput: (v) => (/^[\w.\-/]+$/.test(v.trim()) && !v.includes('..') ? undefined : 'Letters, digits, . - _ / only'),
      });
      if (!branch) return;
      const name = branch.trim();
      const setting = /** @type {string} */ (vscode.workspace.getConfiguration('agentDeck').get('worktreeParentDir') ?? '').trim();
      const parent = setting ? expandHome(setting) : path.join(path.dirname(repo.root), `${repo.name}.worktrees`);
      const target = path.join(parent, name.replace(/\//g, '-'));
      if (fs.existsSync(target)) {
        vscode.window.showErrorMessage(`Agent Deck: ${target} already exists.`);
        return;
      }

      let exists = false;
      try {
        await git(repo.root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
        exists = true;
      } catch {}

      try {
        fs.mkdirSync(parent, { recursive: true });
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Creating worktree ${name}…` },
          () => git(repo.root, exists ? ['worktree', 'add', target, name] : ['worktree', 'add', '-b', name, target, 'HEAD']),
        );
      } catch (e) {
        vscode.window.showErrorMessage(`Agent Deck: ${e.message}`);
        return;
      }
      await deck.refresh();
      const created = deck.findWorktree(target) ?? deck.worktrees.find((w) => w.branch === name);
      if (created) deck.switchTo(created.path);
    }),

    vscode.commands.registerCommand('agentDeck.removeWorktree', async (arg) => {
      const wt = resolveWt(arg);
      if (!wt || wt.isMain) return;
      const terms = deck.terminalsOf(wt.path);
      const detail = `${wt.path}${terms.length ? `\n\n${terms.length} terminal(s) will be killed.` : ''}`;
      const choice = await vscode.window.showWarningMessage(
        `Delete worktree "${wtLabel(wt)}"?`,
        { modal: true, detail },
        'Delete Worktree',
        ...(wt.branch ? ['Delete Worktree and Branch'] : []),
      );
      if (!choice) return;
      terms.forEach((t) => t.dispose());
      const run = (force) => git(wt.repo.root, ['worktree', 'remove', ...(force ? ['--force'] : []), wt.path]);
      try {
        await run(false);
      } catch (e) {
        const force = await vscode.window.showWarningMessage(
          `git refused: ${e.message}`,
          { modal: true, detail: 'Force delete discards uncommitted changes in this worktree.' },
          'Force Delete',
        );
        if (!force) return;
        try {
          await run(true);
        } catch (e2) {
          vscode.window.showErrorMessage(`Agent Deck: ${e2.message}`);
          return;
        }
      }
      if (choice === 'Delete Worktree and Branch' && wt.branch) {
        try {
          await git(wt.repo.root, ['branch', '-d', wt.branch]);
        } catch (e) {
          const force = await vscode.window.showWarningMessage(`Branch ${wt.branch} is not fully merged.`, { modal: true }, 'Delete Anyway');
          if (force) await git(wt.repo.root, ['branch', '-D', wt.branch]).catch((e3) => vscode.window.showErrorMessage(e3.message));
        }
      }
      if (deck.active === wt.path) deck.setActive(wt.repo.root);
      deck.refresh();
    }),

    vscode.commands.registerCommand('agentDeck.addRepository', async () => {
      const uris = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true, openLabel: 'Add to Agent Deck' });
      if (!uris?.length) return;
      const pinned = new Set(ctx.globalState.get('agentDeck.repos', /** @type {string[]} */ ([])));
      for (const u of uris) {
        if (await commonDirOf(u.fsPath)) pinned.add(u.fsPath);
        else vscode.window.showWarningMessage(`Agent Deck: ${u.fsPath} is not a git repository.`);
      }
      await ctx.globalState.update('agentDeck.repos', [...pinned]);
      deck.refresh();
    }),
    vscode.commands.registerCommand('agentDeck.removeRepository', async (/** @type {RepoNode} */ n) => {
      if (!n) return;
      const pinned = ctx.globalState.get('agentDeck.repos', /** @type {string[]} */ ([]));
      const keep = [];
      for (const p of pinned) if ((await commonDirOf(p)) !== n.repo.commonDir) keep.push(p);
      if (keep.length === pinned.length) {
        vscode.window.showInformationMessage('Agent Deck: this repository is part of the open workspace; remove the folder from the workspace instead.');
        return;
      }
      await ctx.globalState.update('agentDeck.repos', keep);
      deck.refresh();
    }),

    vscode.commands.registerCommand('agentDeck.openInNewWindow', (arg) => {
      const wt = resolveWt(arg);
      if (wt) vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wt.path), { forceNewWindow: true });
    }),
    vscode.commands.registerCommand('agentDeck.revealInFinder', (arg) => {
      const wt = resolveWt(arg);
      if (wt) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(wt.path));
    }),
    vscode.commands.registerCommand('agentDeck.copyPath', (arg) => {
      const wt = resolveWt(arg);
      if (wt) vscode.env.clipboard.writeText(wt.path);
    }),
  );

  deck.refresh().then(() => {
    updateChrome();
    syncFromTerminal(vscode.window.activeTerminal);
  });

  return { deck };
}

function deactivate() {}

module.exports = { activate, deactivate };
