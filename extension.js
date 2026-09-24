// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const ENV_KEY = 'AGENT_DECK_WORKTREE';
const GIT_SCHEME = 'agentdeck-git';
const AGENTS = new Set(['claude', 'codex', 'cursor-agent', 'aider', 'gemini', 'opencode', 'amp', 'goose']);
const POLL_MS = 4000;
// An agent counts as working above this share of one core. Idle Claude sits at ~1–2%; while it
// thinks or runs tools it keeps redrawing its spinner and is well above this.
const WORKING_CPU = 0.04;
/** @type {Map<number, { cpu: number, at: number }>} last CPU-time sample per agent pid */
const cpuSamples = new Map();

/** ps `time` (e.g. "1:02.34", "1:02:03.45", "2-01:02:03") to seconds. */
function parseCpuTime(t) {
  return t
    .replace('-', ':')
    .split(':')
    .reduce((acc, part) => acc * 60 + Number(part), 0);
}
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
/** @typedef {{ code: string, path: string, orig?: string }} Change  code is the two-letter porcelain XY */
/** @typedef {{ changes: Change[], ahead: number, behind: number, upstream: string | undefined }} WtStatus */
/** @typedef {{ wtPath: string | undefined, fromChild: boolean, agent: string | undefined, working: boolean }} ProcInfo */

/** @typedef {{ kind: 'repo', id: string, repo: Repo }} RepoNode */
/** @typedef {{ kind: 'worktree', id: string, wt: Worktree }} WorktreeNode */
/** @typedef {{ kind: 'terminal', id: string, terminal: vscode.Terminal, wtPath: string }} TerminalNode */
/** @typedef {'staged' | 'unstaged'} Group */
/** @typedef {{ kind: 'group', id: string, wt: Worktree, group: Group }} GroupNode */
/** @typedef {{ kind: 'change', id: string, wt: Worktree, group: Group, change: Change }} ChangeNode */
/** @typedef {{ kind: 'section', id: string, wt: Worktree, section: 'terminals' | 'changes' }} SectionNode */
/** @typedef {{ kind: 'newTerminal', id: string, wt: Worktree }} NewTerminalNode */
/** @typedef {RepoNode | WorktreeNode | SectionNode | TerminalNode | NewTerminalNode | GroupNode | ChangeNode} Node */

// ---------------------------------------------------------------- process helpers

/** Resolves stdout even on non-zero exit (lsof exits 1 when any pid is gone). */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts }, (_err, stdout) => resolve(stdout ?? ''));
  });
}

/** @returns {Promise<string>} */
function git(cwd, args) {
  return new Promise((resolve, reject) => {
    // Never take index.lock for read-only commands, so we don't collide with agents running git.
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
    execFile('git', args, { cwd, env, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
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

/** @returns {Promise<WtStatus | undefined>} */
async function readStatus(wtPath) {
  let out;
  try {
    out = await git(wtPath, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=normal']);
  } catch {
    return undefined;
  }
  const parts = out.split('\0');
  /** @type {WtStatus} */
  const st = { changes: [], ahead: 0, behind: 0, upstream: undefined };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith('## ')) {
      const m = p.match(/\.\.\.(\S+)/);
      st.upstream = m?.[1];
      st.ahead = Number(p.match(/ahead (\d+)/)?.[1] ?? 0);
      st.behind = Number(p.match(/behind (\d+)/)?.[1] ?? 0);
      continue;
    }
    const code = p.slice(0, 2);
    /** @type {Change} */
    const c = { code, path: p.slice(3) };
    if (code[0] === 'R' || code[0] === 'C') c.orig = parts[++i];
    st.changes.push(c);
  }
  return st;
}

/** Index column says staged; worktree column (or untracked) says unstaged. A file can be both. */
function isStaged(c) {
  return c.code[0] !== ' ' && c.code[0] !== '?';
}
function isUnstaged(c) {
  return c.code === '??' || c.code[1] !== ' ';
}

/**
 * For each terminal: which worktree its processes are in, and whether an agent is running.
 * Looks at the shell *and its descendants*, because `claude -w` / `cd` inside an agent move the
 * child process into a worktree while the shell stays in the main checkout.
 * @param {vscode.Terminal[]} terminals
 * @param {(p: string) => Worktree | undefined} locate
 * @returns {Promise<Map<vscode.Terminal, ProcInfo>>}
 */
async function scanTerminalProcesses(terminals, locate) {
  const result = new Map();
  const shellPids = await Promise.all(
    terminals.map((t) => Promise.race([t.processId, new Promise((r) => setTimeout(() => r(undefined), 500))])),
  );
  if (!shellPids.some(Boolean)) return result;

  /** @type {Map<number, number[]>} */
  const kids = new Map();
  /** @type {Map<number, string>} */
  const comm = new Map();
  /** @type {Map<number, number>} */
  const cpuTime = new Map();
  for (const line of (await run('ps', ['-A', '-o', 'pid=,ppid=,time=,comm='])).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]), ppid = Number(m[2]);
    comm.set(pid, path.basename(m[4].trim()));
    cpuTime.set(pid, parseCpuTime(m[3]));
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }

  /** @type {Map<vscode.Terminal, number[]>} descendants in BFS order, shell first */
  const trees = new Map();
  const allPids = [];
  terminals.forEach((t, i) => {
    const root = shellPids[i];
    if (!root) return;
    const order = [];
    const queue = [root];
    while (queue.length && order.length < 200) {
      const p = /** @type {number} */ (queue.shift());
      order.push(p);
      queue.push(...(kids.get(p) ?? []));
    }
    trees.set(t, order);
    allPids.push(...order);
  });

  /** @type {Map<number, string>} */
  const cwd = new Map();
  const lsof = await run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', allPids.join(',')]);
  let pid = 0;
  for (const line of lsof.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid) cwd.set(pid, line.slice(1));
  }

  for (const [t, order] of trees) {
    const [shell, ...children] = order;
    const agentPid = children.find((p) => AGENTS.has(comm.get(p) ?? ''));
    const agent = agentPid ? comm.get(agentPid) : undefined;
    // Prefer where the agent is, then any child, then the shell itself.
    const candidates = [...(agentPid ? [agentPid] : []), ...children, shell];
    let wtPath, fromChild = false;
    for (const p of candidates) {
      const c = cwd.get(p);
      const wt = c && locate(c);
      if (wt) {
        wtPath = wt.path;
        fromChild = p !== shell;
        break;
      }
    }
    // Working = the agent process itself is burning CPU since the last sample. Its children are
    // ignored on purpose: agents leave dev servers and watchers running in the background.
    let working = false;
    if (agentPid) {
      const now = Date.now(), cpu = cpuTime.get(agentPid) ?? 0;
      const prev = cpuSamples.get(agentPid);
      if (prev && now > prev.at) working = (cpu - prev.cpu) / ((now - prev.at) / 1000) >= WORKING_CPU;
      cpuSamples.set(agentPid, { cpu, at: now });
    }
    result.set(t, { wtPath, fromChild, agent, working });
  }
  return result;
}

// ---------------------------------------------------------------- misc helpers

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

function cwdOption(t) {
  const opts = /** @type {vscode.TerminalOptions} */ (t.creationOptions);
  const cwd = opts?.cwd;
  if (!cwd) return undefined;
  return typeof cwd === 'string' ? cwd : cwd.fsPath;
}

/** Content at `ref` (empty ref = empty document), served by GitContent. */
function gitUri(cwd, relPath, ref) {
  return vscode.Uri.from({ scheme: GIT_SCHEME, path: path.join(cwd, relPath), query: JSON.stringify({ cwd, ref }) });
}

/** Human readable letter + colour for a porcelain code. */
function describeCode(code, group) {
  const c = code === '??' ? '?' : group === 'staged' ? code[0] : code[1];
  const map = {
    M: ['M', 'gitDecoration.modifiedResourceForeground'],
    A: ['A', 'gitDecoration.addedResourceForeground'],
    D: ['D', 'gitDecoration.deletedResourceForeground'],
    R: ['R', 'gitDecoration.renamedResourceForeground'],
    C: ['C', 'gitDecoration.addedResourceForeground'],
    U: ['!', 'gitDecoration.conflictingResourceForeground'],
    '?': ['U', 'gitDecoration.untrackedResourceForeground'],
  };
  return map[c] ?? [c, 'gitDecoration.modifiedResourceForeground'];
}

// ---------------------------------------------------------------- deck state

class Deck {
  /** @param {vscode.ExtensionContext} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {Repo[]} */
    this.repos = [];
    /** @type {Map<vscode.Terminal, string>} terminals we created -> worktree path */
    this.links = new Map();
    /** @type {Map<vscode.Terminal, string>} our own stable display names */
    this.names = new Map();
    /** @type {Map<vscode.Terminal, ProcInfo>} what the terminal's processes are doing */
    this.procs = new Map();
    /** @type {Map<string, vscode.Terminal>} worktree path -> last focused terminal */
    this.lastTerminal = new Map();
    /** @type {Map<vscode.Terminal, number>} running shell executions per terminal */
    this.busy = new Map();
    /** @type {Map<string, WtStatus>} */
    this.status = new Map();
    /** @type {string | undefined} */
    this.active = ctx.workspaceState.get('agentDeck.active');
    /** @type {vscode.FileSystemWatcher[]} */
    this.gitWatchers = [];
    this.watchKey = '';
    this.refreshing = undefined;
    this.pendingRefresh = false;
    this.polling = false;
    this.lastPollSig = '';

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
    await this.poll(true);

    if (!this.active || !this.findWorktree(this.active)) {
      const guess = vscode.window.activeTerminal && this.worktreeOf(vscode.window.activeTerminal);
      this.setActive(guess?.path ?? this.worktrees[0]?.path);
    }
    this._onChange.fire();
  }

  /**
   * Re-reads the cheap-but-changing state: which worktree each terminal's processes are in,
   * git status per worktree. Fires onChange only when something differs.
   */
  async poll(silent = false) {
    if (this.polling) return;
    this.polling = true;
    try {
      const terminals = [...vscode.window.terminals];
      const [procs, statuses] = await Promise.all([
        scanTerminalProcesses(terminals, (p) => this.worktreeContaining(p)).catch(() => new Map()),
        Promise.all(this.worktrees.map(async (w) => /** @type {const} */ ([w.path, await readStatus(w.path)]))),
      ]);
      this.procs = procs;
      this.status = new Map(statuses.filter(([, s]) => s).map(([p, s]) => [p, /** @type {WtStatus} */ (s)]));

      const sig = JSON.stringify([
        [...procs].map(([t, i]) => [this.names.get(t) ?? t.name, i]),
        [...this.status],
      ]);
      if (sig !== this.lastPollSig) {
        this.lastPollSig = sig;
        if (!silent) this._onChange.fire();
      }
    } finally {
      this.polling = false;
    }
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
      const pattern = new vscode.RelativePattern(
        vscode.Uri.file(repo.commonDir),
        '{HEAD,index,worktrees,worktrees/*,worktrees/*/HEAD,worktrees/*/index}',
      );
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

  /**
   * Worktree a terminal belongs to. An agent/child process sitting in a worktree wins (covers
   * `claude -w`), then the terminal we opened it for, then wherever the shell is.
   */
  worktreeOf(t) {
    const proc = this.procs.get(t);
    if (proc?.fromChild && proc.wtPath) return this.findWorktree(proc.wtPath);
    const linked = this.links.get(t);
    if (linked) return this.findWorktree(linked);
    if (proc?.wtPath) return this.findWorktree(proc.wtPath);
    const cwd = t.shellIntegration?.cwd?.fsPath ?? cwdOption(t);
    return cwd ? this.worktreeContaining(cwd) : undefined;
  }

  terminalsOf(wtPath) {
    return vscode.window.terminals.filter((t) => this.worktreeOf(t)?.path === wtPath);
  }

  /** Agent in this terminal is actively thinking / running tools. */
  isWorking(t) {
    return !!this.procs.get(t)?.working;
  }

  /** Agent is open but idle, i.e. waiting for you. */
  isIdleAgent(t) {
    const p = this.procs.get(t);
    return !!p?.agent && !p.working;
  }

  /** A non-agent command (dev server, tests, …) is running in the shell. */
  isRunningCommand(t) {
    return (this.busy.get(t) ?? 0) > 0 && !this.procs.get(t)?.agent;
  }

  displayName(t) {
    return this.names.get(t) ?? t.name;
  }

  /** @param {Group} group */
  changesOf(wtPath, group) {
    const all = this.status.get(wtPath)?.changes ?? [];
    return all.filter(group === 'staged' ? isStaged : isUnstaged);
  }

  /** @param {Worktree} wt */
  createTerminal(wt, { show = true, preserveFocus = false } = {}) {
    const cfg = vscode.workspace.getConfiguration('agentDeck');
    const base = wtLabel(wt);
    const existing = this.terminalsOf(wt.path);
    const taken = new Set(existing.map((t) => this.displayName(t)));
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

    // Only the first terminal of a worktree starts the agent; extra ones are plain shells.
    const startup = /** @type {string} */ (cfg.get('startupCommand') ?? '').trim();
    if (startup && !existing.length) terminal.sendText(startup, true);
    if (show) terminal.show(preserveFocus);
    this._onChange.fire();
    return terminal;
  }

  forgetTerminal(t) {
    const p = this.links.get(t);
    this.links.delete(t);
    this.names.delete(t);
    this.busy.delete(t);
    this.procs.delete(t);
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

  /** Worktree picked: make it active and bring its linked terminal forward, if it has one. */
  switchTo(wtPath, { preserveFocus = false } = {}) {
    if (!this.findWorktree(wtPath)) return;
    this.setActive(wtPath);
    const terms = this.terminalsOf(wtPath);
    const last = this.lastTerminal.get(wtPath);
    const target = last && terms.includes(last) ? last : terms.find((t) => this.procs.get(t)?.agent) ?? terms[0];
    target?.show(preserveFocus);
  }
}

// ---------------------------------------------------------------- git content for diffs

/** @implements {vscode.TextDocumentContentProvider} */
class GitContent {
  /** @param {vscode.Uri} uri */
  async provideTextDocumentContent(uri) {
    const { cwd, ref } = JSON.parse(uri.query);
    if (!ref) return '';
    const rel = path.relative(cwd, uri.path).split(path.sep).join('/');
    // ':' means the index (staged version).
    return git(cwd, ['show', ref === ':' ? `:${rel}` : `${ref}:${rel}`]).catch(() => '');
  }
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

  /** @template {Node} T @param {T} n @returns {T} */
  node(n) {
    const prev = this.nodes.get(n.id);
    if (prev) return /** @type {T} */ (Object.assign(prev, n));
    this.nodes.set(n.id, n);
    return n;
  }

  repoNode(repo) {
    return this.node({ kind: 'repo', id: `repo:${repo.commonDir}`, repo });
  }

  wtNode(wt) {
    return this.node({ kind: 'worktree', id: `wt:${wt.path}`, wt });
  }

  sectionNode(wt, section) {
    return this.node({ kind: 'section', id: `${section}:${wt.path}`, wt, section });
  }

  termNode(t, wtPath) {
    let pid = this.termIds.get(t);
    if (!pid) {
      pid = String(++this.nextTermId);
      this.termIds.set(t, pid);
    }
    return this.node({ kind: 'terminal', id: `term:${pid}`, terminal: t, wtPath });
  }

  /** @param {Node} [el] @returns {Promise<Node[]> | Node[]} */
  getChildren(el) {
    const deck = this.deck;
    if (!el) {
      if (deck.repos.length === 1) return this.repoChildren(deck.repos[0]);
      return deck.repos.map((r) => this.repoNode(r));
    }
    switch (el.kind) {
      case 'repo':
        return this.repoChildren(el.repo);
      case 'worktree':
        return [this.sectionNode(el.wt, 'terminals'), this.sectionNode(el.wt, 'changes')];
      case 'section': {
        const wt = el.wt;
        if (el.section === 'terminals') {
          const terms = deck.terminalsOf(wt.path).map((t) => this.termNode(t, wt.path));
          return terms.length ? terms : [this.node({ kind: 'newTerminal', id: `newTerminal:${wt.path}`, wt })];
        }
        return /** @type {Group[]} */ (['staged', 'unstaged'])
          .filter((g) => deck.changesOf(wt.path, g).length)
          .map((group) => this.node({ kind: 'group', id: `${group}:${wt.path}`, wt, group }));
      }
      case 'group':
        return deck.changesOf(el.wt.path, el.group).map((c) =>
          this.node({ kind: 'change', id: `${el.group}:${el.wt.path}:${c.path}`, wt: el.wt, group: el.group, change: c }),
        );
      default:
        return [];
    }
  }

  repoChildren(repo) {
    return repo.worktrees.map((w) => this.wtNode(w));
  }

  /** @param {Node} el */
  getParent(el) {
    const single = this.deck.repos.length === 1;
    switch (el.kind) {
      case 'terminal': {
        const wt = this.deck.findWorktree(el.wtPath);
        return wt && this.sectionNode(wt, 'terminals');
      }
      case 'newTerminal':
        return this.sectionNode(el.wt, 'terminals');
      case 'worktree':
        return single ? undefined : this.repoNode(el.wt.repo);
      case 'section':
        return this.wtNode(el.wt);
      case 'group':
        return this.sectionNode(el.wt, 'changes');
      case 'change':
        return this.nodes.get(`${el.group}:${el.wt.path}`);
      default:
        return undefined;
    }
  }

  /** @param {Node} el */
  getTreeItem(el) {
    const deck = this.deck;
    const None = vscode.TreeItemCollapsibleState.None;
    const Collapsed = vscode.TreeItemCollapsibleState.Collapsed;
    const Expanded = vscode.TreeItemCollapsibleState.Expanded;

    switch (el.kind) {
      case 'repo': {
        const item = new vscode.TreeItem(el.repo.name, Expanded);
        item.id = el.id;
        item.iconPath = new vscode.ThemeIcon('repo');
        item.description = `${el.repo.worktrees.length} worktree${el.repo.worktrees.length === 1 ? '' : 's'}`;
        item.tooltip = el.repo.root;
        item.contextValue = 'repo';
        return item;
      }

      case 'worktree': {
        const wt = el.wt;
        const terms = deck.terminalsOf(wt.path);
        const st = deck.status.get(wt.path);
        const staged = deck.changesOf(wt.path, 'staged').length;
        const unstaged = deck.changesOf(wt.path, 'unstaged').length;
        const working = terms.some((t) => deck.isWorking(t));
        const idle = !working && terms.some((t) => deck.isIdleAgent(t));
        const isActive = deck.active === wt.path;
        const item = new vscode.TreeItem(wtLabel(wt), Collapsed);
        item.id = el.id;
        const color = new vscode.ThemeColor(hashColor(wt.path));
        item.iconPath = new vscode.ThemeIcon(
          working ? 'loading~spin' : idle ? 'sparkle' : isActive ? 'circle-filled' : wt.isMain ? 'repo' : 'git-branch',
          color,
        );

        const bits = [];
        if (working) bits.push('working');
        else if (idle) bits.push('idle');
        if (st?.ahead) bits.push(`↑${st.ahead}`);
        if (st?.behind) bits.push(`↓${st.behind}`);
        if (staged) bits.push(`✓${staged}`);
        if (unstaged) bits.push(`±${unstaged}`);
        if (terms.length) bits.push(`${terms.length} term`);
        const folder = path.basename(wt.path);
        if (folder !== wt.branch) bits.push(folder);
        if (wt.locked) bits.push('locked');
        if (wt.prunable) bits.push('missing');
        item.description = bits.join(' · ');

        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${wtLabel(wt)}**${wt.isMain ? ' (main checkout)' : ''}\n\n`);
        md.appendMarkdown(`\`${wt.path}\`\n\n`);
        md.appendMarkdown(`HEAD \`${wt.head.slice(0, 10)}\``);
        if (st?.upstream) md.appendMarkdown(` · tracking \`${st.upstream}\` (↑${st.ahead} ↓${st.behind})`);
        md.appendMarkdown(`\n\n${staged} staged · ${unstaged} changed`);
        if (terms.length) md.appendMarkdown(`\n\nTerminals: ${terms.map((t) => deck.displayName(t)).join(', ')}`);
        item.tooltip = md;
        item.contextValue = wt.isMain ? 'worktreeMain' : 'worktree';
        // No command on purpose: a click toggles the dropdown, and selection switches the terminal.
        return item;
      }

      case 'section': {
        const wt = el.wt;
        if (el.section === 'terminals') {
          const n = deck.terminalsOf(wt.path).length;
          const item = new vscode.TreeItem('Terminals', Expanded);
          item.id = el.id;
          item.description = String(n);
          item.iconPath = new vscode.ThemeIcon('terminal');
          item.contextValue = 'terminalsSection';
          return item;
        }
        const n = deck.status.get(wt.path)?.changes.length ?? 0;
        const item = new vscode.TreeItem('Changes', n ? Expanded : None);
        item.id = el.id;
        item.description = n ? String(n) : 'clean';
        item.iconPath = new vscode.ThemeIcon('source-control');
        item.contextValue = 'changesSection';
        return item;
      }

      case 'newTerminal': {
        const item = new vscode.TreeItem('New terminal', None);
        item.id = el.id;
        item.iconPath = new vscode.ThemeIcon('add');
        item.description = 'none linked';
        item.command = { command: 'agentDeck.newTerminal', title: 'New Terminal', arguments: [el.wt.path] };
        return item;
      }

      case 'terminal': {
        const t = el.terminal;
        const proc = deck.procs.get(t);
        const cmdRunning = deck.isRunningCommand(t);
        const item = new vscode.TreeItem(deck.displayName(t), None);
        item.id = el.id;
        const color = new vscode.ThemeColor(hashColor(el.wtPath));
        item.iconPath = new vscode.ThemeIcon(
          proc?.working ? 'loading~spin' : proc?.agent ? 'sparkle' : cmdRunning ? 'play-circle' : 'terminal',
          color,
        );
        const what = proc?.agent ? `${proc.agent} · ${proc.working ? 'working' : 'idle'}` : cmdRunning ? lastCommand.get(t) : undefined;
        item.description = [what ?? '', vscode.window.activeTerminal === t ? 'active' : ''].filter(Boolean).join(' · ');
        item.contextValue = 'terminal';
        item.command = { command: 'agentDeck.showTerminal', title: 'Show Terminal', arguments: [el] };
        return item;
      }

      case 'group': {
        const n = deck.changesOf(el.wt.path, el.group).length;
        const item = new vscode.TreeItem(el.group === 'staged' ? 'Staged' : 'Unstaged', Expanded);
        item.id = el.id;
        item.description = String(n);
        item.iconPath = new vscode.ThemeIcon(el.group === 'staged' ? 'check' : 'diff');
        item.contextValue = el.group === 'staged' ? 'stagedGroup' : 'changesGroup';
        return item;
      }

      case 'change': {
        const c = el.change;
        const uri = vscode.Uri.file(path.join(el.wt.path, c.path));
        const [letter, colorId] = describeCode(c.code, el.group);
        const item = new vscode.TreeItem(uri, None);
        item.id = el.id;
        item.label = path.basename(c.path);
        const dir = path.dirname(c.path);
        item.description = `${letter}${dir === '.' ? '' : `  ${dir}`}`;
        item.tooltip = `${c.orig ? `${c.orig} → ` : ''}${c.path}  (${c.code.trim() || c.code})`;
        item.iconPath = new vscode.ThemeIcon('circle-small-filled', new vscode.ThemeColor(colorId));
        item.contextValue = el.group === 'staged' ? 'stagedChange' : 'change';
        item.command = { command: 'agentDeck.openChange', title: 'Open Changes', arguments: [el] };
        return item;
      }

    }
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

  const view = vscode.window.createTreeView('agentDeck.worktrees', { treeDataProvider: tree, showCollapseAll: true });
  const filesView = vscode.window.createTreeView('agentDeck.files', { treeDataProvider: files, showCollapseAll: false });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'agentDeck.quickSwitch';
  status.tooltip = 'Agent Deck: switch worktree (⌘⌥W)';

  const updateChrome = () => {
    const wt = deck.active ? deck.findWorktree(deck.active) : undefined;
    if (wt) {
      const n = deck.changesOf(wt.path, 'unstaged').length + deck.changesOf(wt.path, 'staged').length;
      status.text = `$(git-branch) ${wtLabel(wt)}${n ? ` ±${n}` : ''}`;
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
    setTimeout(() => {
      revealing = true;
      view.reveal(target, { select: true, focus: false, expand: true }).then(
        () => setTimeout(() => (revealing = false), 50),
        () => (revealing = false),
      );
    }, 50);
  };

  // Selecting a worktree row (mouse or arrow keys) switches to its terminal without taking focus
  // from the tree; the click itself toggles the dropdown.
  let revealing = false;
  view.onDidChangeSelection((e) => {
    if (revealing || e.selection.length !== 1) return;
    const n = e.selection[0];
    if (n.kind === 'worktree') deck.switchTo(n.wt.path, { preserveFocus: true });
  });

  // Poll processes + git status while the window is focused; agents edit files and cd around
  // without telling us.
  const timer = setInterval(() => {
    if (vscode.window.state.focused) deck.poll();
  }, POLL_MS);

  // When polling discovers the active terminal moved worktree (e.g. `claude -w` just started),
  // follow it.
  let lastActiveWt;
  deck.onChange(() => {
    const t = vscode.window.activeTerminal;
    const wt = t && deck.worktreeOf(t);
    if (wt && wt.path !== lastActiveWt) {
      lastActiveWt = wt.path;
      if (wt.path !== deck.active) syncFromTerminal(t);
    }
  });

  const pickWorktree = async (placeHolder) => {
    const items = deck.worktrees.map((w) => {
      const n = deck.terminalsOf(w.path).length;
      const ch = deck.status.get(w.path)?.changes.length;
      return {
        label: `$(${w.isMain ? 'repo' : 'git-branch'}) ${wtLabel(w)}`,
        description: [deck.repos.length > 1 ? w.repo.name : '', ch ? `±${ch}` : '', n ? `${n} term` : '', deck.active === w.path ? 'active' : '']
          .filter(Boolean)
          .join(' · '),
        detail: w.path,
        wt: w,
      };
    });
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
    if (arg && 'wt' in arg && arg.wt) return arg.wt;
    if (arg?.kind === 'terminal') return deck.findWorktree(arg.wtPath);
    if (arg?.kind === 'repo') return undefined;
    return deck.active ? deck.findWorktree(deck.active) : undefined;
  };

  /** Runs a git command on one changed file, or on every file of a Changes / Staged group. */
  const gitOnFiles = async (n, argsFor) => {
    if (!n) return;
    const files = n.kind === 'change' ? [n.change] : deck.changesOf(n.wt.path, n.group);
    const paths = files.flatMap((c) => (c.orig ? [c.orig, c.path] : [c.path]));
    if (!paths.length) return;
    try {
      await git(n.wt.path, argsFor(paths));
    } catch (e) {
      vscode.window.showErrorMessage(`Agent Deck: ${e.message}`);
    }
    deck.poll();
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
    { dispose: () => clearInterval(timer) },
    { dispose: () => deck.gitWatchers.forEach((w) => w.dispose()) },
    { dispose: () => files.watcher?.dispose() },
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitContent()),

    vscode.window.onDidChangeActiveTerminal(syncFromTerminal),
    vscode.window.onDidOpenTerminal(() => {
      deck.adoptTerminals();
      setTimeout(() => deck.poll(), 1500);
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
      setTimeout(() => deck.poll(), 1500);
    }),
    vscode.window.onDidEndTerminalShellExecution((e) => {
      deck.busy.set(e.terminal, Math.max(0, (deck.busy.get(e.terminal) ?? 1) - 1));
      deck.poll();
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

    vscode.commands.registerCommand('agentDeck.openChange', (/** @type {ChangeNode} */ n) => {
      const { wt, change: c, group } = n;
      const file = vscode.Uri.file(path.join(wt.path, c.path));
      const name = path.basename(c.path);
      if (c.code === '??') return vscode.commands.executeCommand('vscode.open', file);
      // Staged: HEAD ↔ index. Unstaged: index ↔ working tree. (Same as the Source Control view.)
      const [lRef, rRef, title] =
        group === 'staged' ? ['HEAD', ':', 'Index'] : [':', undefined, 'Working Tree'];
      const leftPath = group === 'staged' ? c.orig ?? c.path : c.path;
      const left = gitUri(wt.path, leftPath, c.code[0] === 'A' && group === 'staged' ? '' : lRef);
      const deletedHere = (group === 'staged' ? c.code[0] : c.code[1]) === 'D';
      const right = deletedHere ? gitUri(wt.path, c.path, '') : rRef ? gitUri(wt.path, c.path, rRef) : file;
      return vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${wtLabel(wt)} · ${title})`);
    }),
    vscode.commands.registerCommand('agentDeck.openChangedFile', (/** @type {ChangeNode} */ n) => {
      if (n?.kind === 'change') vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(n.wt.path, n.change.path)));
    }),
    vscode.commands.registerCommand('agentDeck.stage', (/** @type {ChangeNode | GroupNode} */ n) =>
      gitOnFiles(n, (paths) => ['add', '-A', '--', ...paths]),
    ),
    vscode.commands.registerCommand('agentDeck.unstage', (/** @type {ChangeNode | GroupNode} */ n) =>
      gitOnFiles(n, (paths) => ['restore', '--staged', '--', ...paths]),
    ),

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
      const n = deck.status.get(wt.path)?.changes.length ?? 0;
      const detail = [wt.path, n ? `${n} uncommitted change(s).` : '', terms.length ? `${terms.length} terminal(s) will be killed.` : '']
        .filter(Boolean)
        .join('\n\n');
      const choice = await vscode.window.showWarningMessage(
        `Delete worktree "${wtLabel(wt)}"?`,
        { modal: true, detail },
        'Delete Worktree',
        ...(wt.branch ? ['Delete Worktree and Branch'] : []),
      );
      if (!choice) return;
      terms.forEach((t) => t.dispose());
      const runRemove = (force) => git(wt.repo.root, ['worktree', 'remove', ...(force ? ['--force'] : []), wt.path]);
      try {
        await runRemove(false);
      } catch (e) {
        const force = await vscode.window.showWarningMessage(
          `git refused: ${e.message}`,
          { modal: true, detail: 'Force delete discards uncommitted changes in this worktree.' },
          'Force Delete',
        );
        if (!force) return;
        try {
          await runRemove(true);
        } catch (e2) {
          vscode.window.showErrorMessage(`Agent Deck: ${e2.message}`);
          return;
        }
      }
      if (choice === 'Delete Worktree and Branch' && wt.branch) {
        try {
          await git(wt.repo.root, ['branch', '-d', wt.branch]);
        } catch {
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

  return { deck, tree };
}

function deactivate() {}

module.exports = { activate, deactivate };
