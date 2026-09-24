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
/** @typedef {{ wtPath: string | undefined, fromChild: boolean, agent: string | undefined, working: boolean, sessionId: string | undefined, hasChildren: boolean, status: string | undefined, waitingFor: string | undefined, statusSince: number | undefined }} ProcInfo */
/** @typedef {{ kind: 'waiting' | 'done', since: number, reason: string | undefined }} Attention  agent needs you: blocked on a question/approval, or finished unseen work */
/** @typedef {{ sessionId: string, wtPath: string, name: string }} AgentRecord  a Claude session to bring back after a restart */
/** @typedef {{ title: string | undefined, prs: { number: number, url: string }[] }} SessionInfo */
/** @typedef {{ number: number, url: string, title: string | undefined, state: string | undefined, isDraft: boolean, own: boolean }} PullRequest  own = this worktree's branch is its head */

/** @typedef {'staged' | 'unstaged'} Group */

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
    // Claude publishes its session id and busy/idle state per pid; prefer that. Otherwise:
    // working = the agent process itself is burning CPU since the last sample. Its children are
    // ignored on purpose: agents leave dev servers and watchers running in the background.
    let working = false;
    const pidFile = agent === 'claude' && agentPid ? readClaudePidFile(agentPid) : undefined;
    if (pidFile?.status) {
      working = pidFile.status === 'busy';
    } else if (agentPid) {
      const now = Date.now(), cpu = cpuTime.get(agentPid) ?? 0;
      const prev = cpuSamples.get(agentPid);
      if (prev && now > prev.at) working = (cpu - prev.cpu) / ((now - prev.at) / 1000) >= WORKING_CPU;
      cpuSamples.set(agentPid, { cpu, at: now });
    }
    result.set(t, {
      wtPath, fromChild, agent, working,
      sessionId: pidFile?.sessionId,
      hasChildren: children.length > 0,
      status: pidFile?.status,
      waitingFor: pidFile?.waitingFor,
      statusSince: pidFile?.statusUpdatedAt,
    });
  }
  return result;
}

// ---------------------------------------------------------------- claude sessions

const CLAUDE_SESSIONS = process.env.AGENT_DECK_CLAUDE_SESSIONS || path.join(os.homedir(), '.claude', 'sessions');

/** Claude Code writes ~/.claude/sessions/<pid>.json while running: session id, cwd, busy/idle. */
function readClaudePidFile(pid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS, `${pid}.json`), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Session ids of Claude processes alive right now, in any app. */
function liveClaudeSessions() {
  const live = new Set();
  let names = [];
  try {
    names = fs.readdirSync(CLAUDE_SESSIONS);
  } catch {}
  for (const name of names) {
    const m = name.match(/^(\d+)\.json$/);
    if (!m) continue;
    try {
      process.kill(Number(m[1]), 0);
    } catch {
      continue; // stale file from a dead process
    }
    const info = readClaudePidFile(m[1]);
    if (info?.sessionId) live.add(info.sessionId);
  }
  return live;
}

/**
 * Where to run `claude --resume <id>`: resume looks the session up in the project of the current
 * directory, so it must be the directory the transcript is stored under (not wherever the session
 * later cd'd to). Known directories are tried first; otherwise the whole transcript is scanned.
 * @param {string[]} candidates
 * @returns {string | undefined}
 */
function resumeDirFor(sessionId, candidates) {
  const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
  let dirs = [];
  try {
    dirs = fs.readdirSync(CLAUDE_PROJECTS);
  } catch {}
  for (const d of dirs) {
    const file = path.join(CLAUDE_PROJECTS, d, `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const known = candidates.find((c) => enc(c) === d);
    if (known) return known;
    // Stream the file in chunks: long sessions run to tens of MB and the matching cwd can be anywhere.
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(4 * 1024 * 1024);
      let carry = '';
      let n;
      while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        const text = carry + buf.toString('utf8', 0, n);
        for (const m of text.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) {
          const cwd = JSON.parse(`"${m[1]}"`);
          if (enc(cwd) === d) return cwd;
        }
        carry = text.slice(-4096);
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- claude session titles

const CLAUDE_PROJECTS = process.env.AGENT_DECK_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const TAIL_BYTES = 512 * 1024;
/** @type {Map<string, { mtimeMs: number, size: number, info: SessionInfo }>} parsed session files */
const sessionCache = new Map();

/** Claude Code stores sessions under ~/.claude/projects/<cwd with non-alphanumerics as '-'>. */
function claudeProjectDir(cwd) {
  return path.join(CLAUDE_PROJECTS, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** Last title (/rename beats the AI one) and PR link from a session transcript. */
function parseSession(file, stat) {
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(stat.size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, stat.size - len);
    /** @type {SessionInfo} */
    const info = { title: undefined, prs: [] };
    let custom, ai;
    for (const line of buf.toString('utf8').split('\n')) {
      // Cheap pre-filter; the transcript is mostly large message lines we don't care about.
      if (!line.includes('-title"') && !line.includes('"pr-link"')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type === 'custom-title' && o.customTitle) custom = o.customTitle;
      else if (o.type === 'ai-title' && o.aiTitle) ai = o.aiTitle;
      else if (o.type === 'pr-link' && o.prNumber && !info.prs.some((p) => p.number === Number(o.prNumber))) {
        info.prs.push({ number: Number(o.prNumber), url: o.prUrl });
      }
    }
    info.title = custom ?? ai;
    return info;
  } finally {
    fs.closeSync(fd);
  }
}

/** Title / PR of the most recently active Claude session in this worktree. */
function readSessionInfo(wtPath) {
  const dir = claudeProjectDir(wtPath);
  let newest;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (!newest || stat.mtimeMs > newest.stat.mtimeMs) newest = { file, stat };
    }
  } catch {
    return undefined;
  }
  if (!newest) return undefined;
  const { file, stat } = newest;
  const cached = sessionCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.info;
  try {
    const info = parseSession(file, stat);
    // Keep what scrolled out of the tail on very long sessions.
    if (!info.title && cached?.info.title) info.title = cached.info.title;
    for (const p of cached?.info.prs ?? []) if (!info.prs.some((q) => q.number === p.number)) info.prs.push(p);
    sessionCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, info });
    return info;
  } catch {
    return cached?.info;
  }
}

// ---------------------------------------------------------------- pull requests (gh)

const PR_TTL_MS = 90 * 1000;
/** @type {Map<string, { at: number, data: any }>} */
const ghCache = new Map();
let ghMissing = false;

/** Cached `gh` JSON call; undefined when gh is missing, not logged in, or the repo isn't on GitHub. */
async function ghJson(cwd, args) {
  if (ghMissing) return undefined;
  const key = `${cwd}\0${args.join(' ')}`;
  const hit = ghCache.get(key);
  if (hit && Date.now() - hit.at < PR_TTL_MS) return hit.data;
  const data = await new Promise((resolve) => {
    execFile('gh', args, { cwd, timeout: 15000 }, (err, stdout) => {
      if (err && /** @type {any} */ (err).code === 'ENOENT') ghMissing = true;
      if (err) return resolve(undefined);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(undefined);
      }
    });
  });
  ghCache.set(key, { at: Date.now(), data });
  return data;
}

const PR_FIELDS = 'number,title,url,state,isDraft,headRefName';

/**
 * PRs for a worktree: the ones whose head is its branch, plus the ones its Claude session linked.
 * @param {Worktree} wt
 * @param {SessionInfo | undefined} session
 * @returns {Promise<PullRequest[]>}
 */
async function readPrs(wt, session) {
  /** @type {Map<number, PullRequest>} */
  const out = new Map();
  if (wt.branch) {
    const own = await ghJson(wt.repo.root, ['pr', 'list', '--head', wt.branch, '--state', 'all', '--json', PR_FIELDS, '--limit', '5']);
    for (const p of own ?? []) out.set(p.number, { ...p, own: true });
  }
  for (const link of session?.prs ?? []) {
    if (out.has(link.number)) continue;
    const p = await ghJson(wt.repo.root, ['pr', 'view', String(link.number), '--json', PR_FIELDS]);
    out.set(link.number, p ? { ...p, own: p.headRefName === wt.branch } : { number: link.number, url: link.url, title: undefined, state: undefined, isDraft: false, own: false });
  }
  // Own PRs first, then newest first.
  return [...out.values()].sort((a, b) => Number(b.own) - Number(a.own) || b.number - a.number);
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

/** Tree label: what the agent is working on, when we know it and the user wants it. */
function wtTitle(wt, deck) {
  const mode = vscode.workspace.getConfiguration('agentDeck').get('worktreeLabel');
  if (mode === 'branch') return wtLabel(wt);
  // Claude's title once it has one; until then the task you typed (for worktrees made by New Task).
  return deck.sessions.get(wt.path)?.title || deck.taskTitles.get(wt.path) || wtLabel(wt);
}

/** "now", "4m", "2h", "3d". */
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Short human label for what an agent needs, e.g. "needs you: approve Bash · 2m" or "done · 4m". */
function attentionText(a) {
  return `${attentionWhat(a)} · ${ago(a.since)}`;
}

/** Claude's own reasons ("permission prompt", "input needed", …) as short labels. */
function attentionWhat(a) {
  if (a.kind === 'done') return 'done';
  const map = { 'permission prompt': 'needs approval', 'input needed': 'needs input', 'dialog open': 'needs you' };
  return map[a.reason ?? ''] ?? `needs you${a.reason ? `: ${a.reason}` : ''}`;
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

/**
 * Path to give Search's "files to include" for a worktree. A worktree outside every workspace
 * folder is searched as its own root. One nested inside a workspace folder (like
 * .claude/worktrees/*) would be searched as part of that folder, whose .gitignore usually excludes
 * it, so it is reached through a symlink outside the workspace, making it its own root again.
 */
const SEARCH_LINKS = process.env.AGENT_DECK_SEARCH_LINKS || path.join(os.homedir(), '.agent-deck', 'search');

function searchRootFor(wt, folders) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  if (!folders.some((f) => isInside(real(wt.path), real(f)))) return wt.path;
  const dir = SEARCH_LINKS;
  // Readable name; disambiguated only if two worktrees share a folder name.
  const hash = Math.abs([...wt.path].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)).toString(36).slice(0, 4);
  let link = path.join(dir, path.basename(wt.path));
  try {
    if (fs.readlinkSync(link) !== wt.path) link = `${link}-${hash}`;
  } catch {}
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.readlinkSync(link) !== wt.path) fs.unlinkSync(link);
  } catch {}
  try {
    fs.symlinkSync(wt.path, link, 'dir');
  } catch {}
  return link;
}

// ---------------------------------------------------------------- new task helpers

const STOPWORDS = new Set(
  'a an the to for of in on at by and or with from into please can could you we i should would make let lets just so that this these those it its be is are was were do does'.split(' '),
);

/** "Fix the flaky login redirect test!" → "flaky-login-redirect-test" (at most 5 words, 40 chars). */
function slugify(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
  // A leading "fix"/"refactor"/… becomes the branch type, so it isn't repeated in the slug.
  if (words.length > 1 && BRANCH_TYPES[words[0]]) words.shift();
  const kept = words.filter((w) => !STOPWORDS.has(w));
  return (kept.length ? kept : words).slice(0, 5).join('-').slice(0, 40).replace(/-+$/, '') || 'task';
}

/** Leading verb → branch type, the way people name branches. */
const BRANCH_TYPES = /** @type {Record<string, string>} */ ({
  fix: 'fix', bug: 'fix', bugfix: 'fix', hotfix: 'fix', repair: 'fix',
  refactor: 'refactor', cleanup: 'refactor', rename: 'refactor', simplify: 'refactor',
  perf: 'perf', speed: 'perf', optimize: 'perf', optimise: 'perf',
  test: 'test', tests: 'test', docs: 'docs', document: 'docs', chore: 'chore', bump: 'chore', upgrade: 'chore',
});
function branchType(text) {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const w of words.slice(0, 4)) if (BRANCH_TYPES[w]) return BRANCH_TYPES[w];
  return 'feat';
}

/**
 * Suggested branch for a task, following how this repo's recent branches are named
 * (e.g. "anze/fix/…" → "anze/{type}/{slug}", "feat/…" → "{type}/{slug}").
 */
async function suggestBranch(repo, text) {
  const out = await git(repo.root, ['for-each-ref', '--sort=-committerdate', '--count=30', '--format=%(refname:short)', 'refs/heads']).catch(() => '');
  const types = new Set(Object.values(BRANCH_TYPES).concat('feat'));
  const patterns = new Map();
  for (const b of out.split('\n').filter(Boolean)) {
    const parts = b.split('/');
    let pat;
    if (parts.length >= 3 && types.has(parts[1])) pat = `${parts[0]}/{type}/{slug}`;
    else if (parts.length >= 2 && types.has(parts[0])) pat = '{type}/{slug}';
    if (pat) patterns.set(pat, (patterns.get(pat) ?? 0) + 1);
  }
  const setting = /** @type {string} */ (vscode.workspace.getConfiguration('agentDeck').get('branchTemplate') ?? '').trim();
  const best = [...patterns].sort((x, y) => y[1] - x[1])[0]?.[0];
  const template = setting || best || '{slug}';
  const base = template.replace('{type}', branchType(text)).replace('{slug}', slugify(text));
  // Don't collide with an existing branch.
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    const taken = await git(repo.root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).then(() => true, () => false);
    if (!taken) return name;
  }
}

/**
 * Commands that make a fresh worktree usable. Uses the repo's own setup script when it has one
 * (.agent-deck/config.json, or Superset's .superset/config.json — same format: { "setup": [...] }),
 * otherwise copies the main checkout's ignored .env files and installs dependencies.
 * @returns {Promise<{ commands: string[], source: string }>}
 */
async function setupFor(repo) {
  for (const rel of ['.agent-deck/config.json', '.superset/config.json']) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(repo.root, rel), 'utf8'));
      if (Array.isArray(cfg.setup)) return { commands: cfg.setup.map(String), source: rel };
    } catch {}
  }
  const commands = [];
  const ignored = await git(repo.root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory']).catch(() => '');
  for (const f of ignored.split('\n').filter((l) => /(^|\/)\.env(\.[^/]+)?$/.test(l))) {
    const dir = path.dirname(f);
    commands.push(`${dir === '.' ? '' : `mkdir -p ${sq(dir)} && `}cp "$AGENT_DECK_ROOT_PATH"/${sq(f)} ${sq(f)}`);
  }
  const has = (f) => fs.existsSync(path.join(repo.root, f));
  if (has('bun.lock') || has('bun.lockb')) commands.push('bun install');
  else if (has('pnpm-lock.yaml')) commands.push('pnpm install');
  else if (has('yarn.lock')) commands.push('yarn install');
  else if (has('package-lock.json')) commands.push('npm install');
  return { commands, source: 'auto' };
}

/** Single-quote for POSIX shells. */
function sq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Every file git knows about in a worktree: tracked plus untracked-but-not-ignored. */
async function listWorktreeFiles(wtPath) {
  const out = await git(wtPath, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).catch(() => '');
  return [...new Set(out.split('\0').filter(Boolean))];
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
    /** @type {Map<string, SessionInfo>} worktree path -> latest Claude session title / PR */
    this.sessions = new Map();
    /** @type {Map<string, string>} worktree path -> the task typed into New Task */
    this.taskTitles = new Map(ctx.workspaceState.get('agentDeck.taskTitles', []));
    /** @type {Map<string, PullRequest[]>} worktree path -> related pull requests */
    this.prs = new Map();
    this.prsLoading = false;
    /** @type {string | undefined} */
    this.active = ctx.workspaceState.get('agentDeck.active');
    /** @type {vscode.FileSystemWatcher[]} */
    this.gitWatchers = [];
    this.watchKey = '';
    this.refreshing = undefined;
    this.pendingRefresh = false;
    this.polling = false;
    this.lastPollSig = '';
    this.recordReady = false;
    /** @type {Map<vscode.Terminal, number>} when you last looked at each terminal */
    this.seenAt = new Map();
    /** @type {Set<vscode.Terminal>} agents that did work since you last looked */
    this.workedSinceSeen = new Set();
    /** @type {Map<vscode.Terminal, string>} last alert sent per terminal, so each episode alerts once */
    this.alerted = new Map();
    this._onAttention = new vscode.EventEmitter();
    /** Fires once per new "needs you" episode: { terminal, worktree, attention }. */
    this.onAttention = this._onAttention.event;
    this.lastRecordJson = '';

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
  /** `light`: only re-scan terminal processes (used while the window is in the background). */
  poll(silent = false, { light = false } = {}) {
    // One poll at a time; a request during a poll gets a fresh one right after it, so callers
    // always see state read after they asked.
    if (this.pollRun) {
      this.pollNext ??= this.pollRun.then(() => {
        this.pollNext = undefined;
        return this.poll(silent, { light });
      });
      return this.pollNext;
    }
    this.pollRun = this._poll(silent, light).finally(() => (this.pollRun = undefined));
    return this.pollRun;
  }

  async _poll(silent, light) {
    this.polling = true;
    try {
      const terminals = [...vscode.window.terminals];
      const [procs, statuses] = await Promise.all([
        scanTerminalProcesses(terminals, (p) => this.worktreeContaining(p)).catch(() => new Map()),
        light ? undefined : Promise.all(this.worktrees.map(async (w) => /** @type {const} */ ([w.path, await readStatus(w.path)]))),
      ]);
      this.procs = procs;
      this.recordAgents();
      this.trackAttention();
      if (statuses) {
        this.status = new Map(statuses.filter(([, s]) => s).map(([p, s]) => [p, /** @type {WtStatus} */ (s)]));
        this.sessions = new Map();
        for (const w of this.worktrees) {
          const info = readSessionInfo(w.path);
          if (info) this.sessions.set(w.path, info);
        }
        this.refreshPrs();
      }
      const sig = JSON.stringify([
        [...procs].map(([t, i]) => [this.names.get(t) ?? t.name, i]),
        [...this.status],
        [...this.sessions],
      ]);
      if (sig !== this.lastPollSig) {
        this.lastPollSig = sig;
        if (!silent) this._onChange.fire();
      }
    } finally {
      this.polling = false;
    }
  }

  /** Looks PRs up in the background (gh is slow); results are cached for a minute and a half. */
  async refreshPrs() {
    if (this.prsLoading) return;
    this.prsLoading = true;
    try {
      const next = new Map();
      for (const w of this.worktrees) next.set(w.path, await readPrs(w, this.sessions.get(w.path)));
      const changed = JSON.stringify([...next]) !== JSON.stringify([...this.prs]);
      this.prs = next;
      if (changed) this._onChange.fire();
    } finally {
      this.prsLoading = false;
    }
  }

  /**
   * Replaces terminals with fresh ones: idle Claude sessions are resumed (`claude --resume`) in a
   * new terminal, empty shells are reopened in the same folder. Fresh terminals get the current
   * environment (no "relaunch" warnings, working editor integration) and their worktree colour.
   * Anything busy — a working agent, a dev server, tests — is left alone.
   */
  async refreshTerminals() {
    await this.poll(true);
    const startup = /** @type {string} */ (vscode.workspace.getConfiguration('agentDeck').get('startupCommand') ?? '').trim();
    const base = startup.startsWith('claude') || startup.includes('/claude') ? startup : 'claude';
    /** @type {{ t: vscode.Terminal, wt: Worktree, name: string | undefined, shown: string, command?: string, cwd?: string }[]} */
    const plan = [];
    const skipped = [];
    for (const t of vscode.window.terminals) {
      const p = this.procs.get(t);
      const wt = this.worktreeOf(t);
      if (!p || !wt || t.exitStatus) continue;
      const shown = this.displayName(t);
      // Titles like "2.1.282" (Claude Code's version) or "zsh" say nothing; use the worktree name.
      const name = /^(v?\d+(\.\d+)+|zsh|bash|fish|sh|node|claude|codex)$/i.test(shown.trim()) ? undefined : shown;
      if (p.agent) {
        if (p.working || p.agent !== 'claude' || !p.sessionId) {
          skipped.push(`${shown} (${p.working ? 'agent working' : `${p.agent} can't be resumed`})`);
          continue;
        }
        const dir = resumeDirFor(p.sessionId, [wt.path, ...this.worktrees.map((w) => w.path)]);
        if (!dir) {
          skipped.push(`${shown} (session not found)`);
          continue;
        }
        plan.push({ t, wt, name, shown, command: `${base} --resume ${p.sessionId}`, cwd: dir });
      } else if (p.hasChildren || this.isRunningCommand(t)) {
        skipped.push(`${shown} (command running)`);
      } else {
        plan.push({ t, wt, name, shown, cwd: p.wtPath && isInside(p.wtPath, wt.path) ? undefined : wt.path });
      }
    }
    return { plan, skipped };
  }

  // ------------------------------------------------------------ attention ("needs you")

  /** You looked at this terminal: whatever it finished so far is no longer news. */
  markSeen(t) {
    if (!t) return;
    this.seenAt.set(t, Date.now());
    this.workedSinceSeen.delete(t);
    if (this.alerted.delete(t)) this._onChange.fire();
  }

  /** @returns {Attention | undefined} */
  attentionOf(t) {
    const p = this.procs.get(t);
    if (!p?.agent) return undefined;
    const since = p.statusSince ?? Date.now();
    if (p.status === 'waiting') return { kind: 'waiting', since, reason: p.waitingFor };
    if (p.status === 'idle' && this.workedSinceSeen.has(t)) return { kind: 'done', since, reason: undefined };
    return undefined;
  }

  /** Terminals whose agent needs you, most urgent (blocked) first, then oldest first. */
  attentionList() {
    return vscode.window.terminals
      .map((t) => ({ t, a: this.attentionOf(t) }))
      .filter((x) => x.a)
      .sort((x, y) => Number(y.a?.kind === 'waiting') - Number(x.a?.kind === 'waiting') || (x.a?.since ?? 0) - (y.a?.since ?? 0));
  }

  trackAttention() {
    const looking = vscode.window.state.focused ? vscode.window.activeTerminal : undefined;
    for (const [t, p] of this.procs) {
      // Only real work makes a later "done" worth telling you about; a question you already saw
      // isn't news. ("waiting" is shown from the live status anyway.)
      if (p.status === 'busy') this.workedSinceSeen.add(t);
      // Watching it happen counts as seeing it.
      if (t === looking) this.markSeen(t);
      const a = this.attentionOf(t);
      if (!a) {
        this.alerted.delete(t);
        continue;
      }
      const key = `${a.kind}:${a.since}`;
      if (this.alerted.get(t) === key) continue;
      this.alerted.set(t, key);
      const wt = this.worktreeOf(t);
      if (wt && t !== looking) this._onAttention.fire({ terminal: t, worktree: wt, attention: a });
    }
  }

  // ------------------------------------------------------------ resume after restart

  /** One record list per window, keyed by its folders, so two windows never resume each other's agents. */
  get recordKey() {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath).sort().join('|') || 'no-folder';
  }

  get recordFile() {
    return path.join(this.ctx.globalStorageUri.fsPath, 'agents.json');
  }

  readRecords() {
    try {
      return JSON.parse(fs.readFileSync(this.recordFile, 'utf8'));
    } catch {
      return {};
    }
  }

  /**
   * Remembers which Claude sessions are running in this window's terminals. Quitting the app kills
   * them without warning, so this runs on every poll; whatever was last written is what we resume.
   */
  recordAgents() {
    if (!this.recordReady) return; // don't clobber the list before startup resume has read it
    /** @type {AgentRecord[]} */
    const list = [];
    for (const [t, p] of this.procs) {
      const wt = this.worktreeOf(t);
      if (p.sessionId && wt) list.push({ sessionId: p.sessionId, wtPath: wt.path, name: this.displayName(t) });
    }
    const json = JSON.stringify(list);
    if (json === this.lastRecordJson) return;
    this.lastRecordJson = json;
    const all = this.readRecords();
    all[this.recordKey] = list;
    try {
      fs.mkdirSync(path.dirname(this.recordFile), { recursive: true });
      fs.writeFileSync(this.recordFile, JSON.stringify(all, null, 1));
    } catch (e) {
      console.error('[agent-deck] could not save agents', e);
    }
  }

  /**
   * After a restart: run `claude --resume` for every recorded session that is no longer alive.
   * Terminals restored by the editor are empty shells at that point; one is closed per resumed session.
   * @returns {Promise<number>} how many sessions were resumed
   */
  async resumeAgents() {
    try {
      const cfg = vscode.workspace.getConfiguration('agentDeck');
      if (!cfg.get('resumeOnStartup', true)) return 0;
      /** @type {AgentRecord[]} */
      const records = this.readRecords()[this.recordKey] ?? [];
      const live = liveClaudeSessions();
      const running = new Set([...this.procs.values()].map((p) => p.sessionId).filter(Boolean));
      const todo = records.filter((r) => !live.has(r.sessionId) && !running.has(r.sessionId) && this.findWorktree(r.wtPath));
      if (!todo.length) return 0;

      const startup = /** @type {string} */ (cfg.get('startupCommand') ?? '').trim();
      const base = startup.startsWith('claude') || startup.includes('/claude') ? startup : 'claude';
      // Restored terminals with nothing running in them.
      const spare = vscode.window.terminals.filter((t) => {
        const p = this.procs.get(t);
        return p && !p.agent && !this.isRunningCommand(t) && t.exitStatus === undefined;
      });

      let resumed = 0;
      /** @type {string[]} */
      const failed = [];
      for (const r of todo) {
        const wt = /** @type {Worktree} */ (this.findWorktree(r.wtPath));
        const dir = resumeDirFor(r.sessionId, [r.wtPath, ...this.worktrees.map((w) => w.path)]);
        if (!dir) {
          failed.push(r.sessionId);
          continue;
        }
        const command = `${base} --resume ${r.sessionId}`;
        // Replace a dead restored terminal rather than typing into it: restored shells keep a stale
        // environment (the editor then flags them), and Claude's editor integration needs the fresh one.
        const pick = spare.findIndex((t) => t.name === r.name);
        const dead = spare.splice(pick >= 0 ? pick : 0, spare.length ? 1 : 0)[0];
        dead?.dispose();
        this.createTerminal(wt, { show: false, name: r.name, command, cwd: dir });
        resumed++;
      }
      this.saveLinks();
      if (failed.length) {
        vscode.window.showWarningMessage(
          `Agent Deck: could not find the transcript for ${failed.length} Claude session(s) to resume: ${failed.join(', ')}. Resume manually with \`claude --resume <id>\`.`,
        );
      }
      return resumed;
    } finally {
      this.recordReady = true;
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
  /** `command` replaces the startup command; `cwd` overrides where the shell starts. */
  createTerminal(wt, { show = true, preserveFocus = false, name: wanted = undefined, command = undefined, cwd = undefined, plain = false, env = {} } = {}) {
    const cfg = vscode.workspace.getConfiguration('agentDeck');
    const base = wanted ?? wtLabel(wt);
    const existing = this.terminalsOf(wt.path);
    const taken = new Set(existing.map((t) => this.displayName(t)));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base} · ${i}`;

    const terminal = vscode.window.createTerminal({
      name,
      cwd: cwd ?? wt.path,
      iconPath: new vscode.ThemeIcon(wt.isMain ? 'repo' : 'git-branch'),
      color: new vscode.ThemeColor(hashColor(wt.path)),
      env: { ...env, [ENV_KEY]: wt.path },
      location: cfg.get('terminalLocation') === 'editor' ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel,
    });
    this.links.set(terminal, wt.path);
    this.names.set(terminal, name);
    this.lastTerminal.set(wt.path, terminal);
    this.saveLinks();

    // Only the first terminal of a worktree starts the agent; extra ones are plain shells.
    const startup = /** @type {string} */ (cfg.get('startupCommand') ?? '').trim();
    if (command) terminal.sendText(command, true);
    else if (startup && !existing.length && !plain) terminal.sendText(startup, true);
    if (show) terminal.show(preserveFocus);
    this._onChange.fire();
    return terminal;
  }

  forgetTerminal(t) {
    this.seenAt.delete(t);
    this.workedSinceSeen.delete(t);
    this.alerted.delete(t);
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

// ---------------------------------------------------------------- worktree panel (webview)

const SETI = require('./media/seti-map.json');

/** Seti glyph + colours for a file, the same lookup order the icon theme uses. */
function setiFor(relPath) {
  const base = path.basename(relPath).toLowerCase();
  if (SETI.name[base]) return SETI.name[base];
  const parts = base.split('.');
  // Longest compound extension first: "d.ts" before "ts".
  for (let i = 1; i < parts.length; i++) {
    const hit = SETI.ext[parts.slice(i).join('.')];
    if (hit) return hit;
  }
  return SETI.default;
}

/**
 * Everything the panel draws, as plain JSON. The webview only renders this; tests assert on it.
 * @param {Deck} deck
 * @param {(t: vscode.Terminal) => string} termId
 */
function buildModel(deck, termId) {
  const worktrees = deck.worktrees.map((wt) => {
    const terms = deck.terminalsOf(wt.path);
    const st = deck.status.get(wt.path);
    const working = terms.some((t) => deck.isWorking(t));
    const idle = !working && terms.some((t) => deck.isIdleAgent(t));
    // Most urgent thing any of its agents needs from you.
    const attention = terms
      .map((t) => deck.attentionOf(t))
      .filter(Boolean)
      .sort((x, y) => Number(y?.kind === 'waiting') - Number(x?.kind === 'waiting') || (x?.since ?? 0) - (y?.since ?? 0))[0];
    const prs = deck.prs.get(wt.path) ?? [];
    const ownPr = prs.find((p) => p.own);
    const title = wtTitle(wt, deck);
    const active = deck.active === wt.path;
    const n = st?.changes.length ?? 0;

    /** @type {{ icon?: string, text: string }[]} */
    const meta = [];
    if (attention) meta.push({ icon: 'bell', text: attentionText(attention), cls: 'attn' });
    meta.push({ icon: 'git-branch', text: wtLabel(wt) });
    if (ownPr) meta.push({ icon: 'git-pull-request', text: `#${ownPr.number}` });
    if (st?.ahead || st?.behind) meta.push({ text: `${st.ahead ? `↑${st.ahead}` : ''}${st.behind ? ` ↓${st.behind}` : ''}`.trim() });
    if (wt.locked) meta.push({ text: 'locked' });
    if (wt.prunable) meta.push({ text: 'missing' });

    const files = (group) =>
      deck.changesOf(wt.path, group).map((c) => {
        const [letter, colorId] = describeCode(c.code, group);
        const isDir = c.path.endsWith('/');
        const clean = c.path.replace(/\/$/, '');
        const dir = path.dirname(clean);
        return {
          group, path: c.path, orig: c.orig, code: c.code, letter, colorId, isDir,
          name: path.basename(clean) + (isDir ? '/' : ''),
          dir: dir === '.' ? '' : dir,
          seti: isDir ? null : setiFor(clean),
          tooltip: `${c.orig ? `${c.orig} → ` : ''}${c.path}`,
        };
      });

    /** @type {any[]} */
    const sections = [];
    const staged = files('staged'), unstaged = files('unstaged');
    if (staged.length) sections.push({ kind: 'staged', title: 'Staged Changes', files: staged });
    if (unstaged.length) sections.push({ kind: 'unstaged', title: 'Changes', files: unstaged });
    if (!staged.length && !unstaged.length) sections.push({ kind: 'clean' });
    sections.push({
      kind: 'terminals',
      terminals: terms.map((t) => {
        const proc = deck.procs.get(t);
        const cmd = deck.isRunningCommand(t);
        const att = deck.attentionOf(t);
        return {
          id: termId(t),
          name: deck.displayName(t),
          icon: att ? 'bell-dot' : proc?.working ? 'loading' : proc?.agent ? 'sparkle' : cmd ? 'play-circle' : 'terminal',
          spin: !att && !!proc?.working,
          attention: !!att,
          sub: proc?.agent
            ? `${proc.agent} · ${att ? attentionText(att) : proc.working ? 'working' : 'idle'}`
            : cmd ? lastCommand.get(t) ?? '' : '',
        };
      }),
    });
    sections.push({
      kind: 'prs',
      prs: prs.map((p) => {
        const state = p.isDraft && p.state === 'OPEN' ? 'DRAFT' : p.state;
        const [icon, colorId, word] = {
          OPEN: ['git-pull-request', 'charts.green', 'open'],
          DRAFT: ['git-pull-request-draft', 'descriptionForeground', 'draft'],
          MERGED: ['git-merge', 'charts.purple', 'merged'],
          CLOSED: ['git-pull-request-closed', 'charts.red', 'closed'],
        }[state ?? ''] ?? ['git-pull-request', 'descriptionForeground', ''];
        return {
          number: p.number, title: p.title, url: p.url, icon, colorId,
          sub: [word, p.own ? '' : 'from session'].filter(Boolean).join(' · '),
          tooltip: `#${p.number} ${p.title ?? ''}\n${word}${p.own ? ' · this branch' : ' · linked in the Claude session'}\n${p.url}`,
        };
      }),
    });

    const tooltip = [
      title,
      `Branch: ${wtLabel(wt)}${wt.isMain ? ' (main checkout)' : ''}`,
      st?.upstream ? `Upstream: ${st.upstream} ↑${st.ahead} ↓${st.behind}` : '',
      `${staged.length} staged · ${unstaged.length} changed`,
      attention ? `Agent ${attentionText(attention)}` : working ? 'Agent working' : idle ? 'Agent idle' : '',
      wt.path,
    ].filter(Boolean).join('\n');

    return {
      path: wt.path, repo: wt.repo.name, title, branch: wtLabel(wt), isMain: wt.isMain, active,
      colorVar: `var(--vscode-${hashColor(wt.path).replace(/\./g, '-')})`,
      state: attention ? 'attention' : working ? 'working' : idle ? 'idle' : '',
      // Badges: "●3" on the active worktree, plain change count on the others.
      badge: active ? `●${n || ''}` : n ? String(n) : '',
      meta, sections, tooltip,
      context: { webviewSection: 'worktree', wtPath: wt.path, isMain: wt.isMain, hasPr: prs.length > 0 },
    };
  });
  return { worktrees, active: deck.active, multiRepo: deck.repos.length > 1 };
}

/** @implements {vscode.WebviewViewProvider} */
class PanelProvider {
  /** @param {vscode.ExtensionContext} ctx @param {Deck} deck */
  constructor(ctx, deck) {
    this.ctx = ctx;
    this.deck = deck;
    /** @type {vscode.WebviewView | undefined} */
    this.view = undefined;
    /** @type {Map<vscode.Terminal, string>} */
    this.termIds = new Map();
    this.nextTermId = 0;
    this.pending = undefined;
    this._onSelect = new vscode.EventEmitter();
    this.onSelect = this._onSelect.event;
    deck.onChange(() => this.schedule());
  }

  termId(t) {
    let id = this.termIds.get(t);
    if (!id) {
      id = `t${++this.nextTermId}`;
      this.termIds.set(t, id);
    }
    return id;
  }

  terminalById(id) {
    for (const [t, tid] of this.termIds) if (tid === id) return t;
    return undefined;
  }

  model() {
    return buildModel(this.deck, (t) => this.termId(t));
  }

  /** Coalesce bursts of changes into one post. */
  schedule() {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.post();
    }, 30);
  }

  post() {
    this.view?.webview.postMessage({ type: 'state', model: this.model() });
  }

  reveal(wtPath) {
    this.view?.webview.postMessage({ type: 'reveal', path: wtPath });
  }

  /** @param {vscode.WebviewView} view */
  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const uri = (f) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    const nonce = [...Array(24)].map(() => Math.random().toString(36)[2]).join('');
    const csp = view.webview.cspSource;
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${csp}; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
@font-face { font-family: 'codicon'; src: url('${uri('codicon.ttf')}') format('truetype'); }
@font-face { font-family: 'seti'; src: url('${uri('seti.woff')}') format('woff'); }
</style>
<link rel="stylesheet" href="${uri('panel.css')}">
</head><body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
<div id="root" role="tree" aria-label="Worktrees"></div>
<script nonce="${nonce}" src="${uri('panel.js')}"></script>
</body></html>`;
    view.webview.onDidReceiveMessage((m) => {
      if (m.type === 'ready') this.post();
      else if (m.type === 'select') this._onSelect.fire(m.path);
      else if (m.type === 'rendered') this.lastRender = m; // lets tests see what the panel drew
      else if (m.type === 'command' && typeof m.command === 'string' && m.command.startsWith('agentDeck.')) {
        vscode.commands.executeCommand(m.command, m.arg);
      }
    });
    view.onDidChangeVisibility(() => view.visible && this.post());
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
  const panel = new PanelProvider(ctx, deck);
  const files = new FilesTree(deck);

  const filesView = vscode.window.createTreeView('agentDeck.files', { treeDataProvider: files, showCollapseAll: false });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'agentDeck.quickSwitch';
  status.tooltip = 'Agent Deck: switch worktree (⌘⌥W)';

  const updateChrome = () => {
    const wt = deck.active ? deck.findWorktree(deck.active) : undefined;
    if (wt) {
      const n = deck.changesOf(wt.path, 'unstaged').length + deck.changesOf(wt.path, 'staged').length;
      status.text = `$(git-branch) ${wtTitle(wt, deck)}${n ? ` ±${n}` : ''}`;
      status.show();
      if (panel.view) panel.view.description = wtTitle(wt, deck);
      filesView.description = wtLabel(wt);
      filesView.message = undefined;
    } else {
      status.hide();
      if (panel.view) panel.view.description = undefined;
      filesView.description = undefined;
      filesView.message = deck.repos.length ? 'Select a worktree.' : undefined;
    }
  };
  deck.onChange(updateChrome);

  // Badge on the Agent Deck icon: how many agents need you.
  const updateBadge = () => {
    if (!panel.view) return;
    const n = deck.attentionList().length;
    panel.view.badge = n ? { value: n, tooltip: `${n} agent${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you` } : undefined;
  };
  deck.onChange(updateBadge);

  // ---- Go to File, scoped to the active worktree ------------------------------------------------

  /** Recently opened files per worktree (most recent first), shown first like ⌘P does. */
  const recentFiles = new Map(/** @type {[string, string[]][]} */ (ctx.workspaceState.get('agentDeck.recentFiles', [])));
  const noteOpened = (fsPath) => {
    const wt = deck.worktreeContaining(fsPath);
    if (!wt) return;
    const rel = path.relative(wt.path, fsPath);
    const list = [rel, ...(recentFiles.get(wt.path) ?? []).filter((r) => r !== rel)].slice(0, 30);
    recentFiles.set(wt.path, list);
    ctx.workspaceState.update('agentDeck.recentFiles', [...recentFiles]);
  };

  const goToFile = async () => {
    const wt = deck.active ? deck.findWorktree(deck.active) : undefined;
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const isRoot = !wt || folders.some((f) => {
      try {
        return fs.realpathSync(f) === fs.realpathSync(wt.path);
      } catch {
        return f === wt.path;
      }
    });
    // The main checkout is the workspace itself: the built-in ⌘P already covers it (and more).
    if (!wt || isRoot) return vscode.commands.executeCommand('workbench.action.quickOpen');

    const qp = vscode.window.createQuickPick();
    qp.title = `Go to File · ${wtTitle(wt, deck)}`;
    qp.placeholder = `Search files in ${wtLabel(wt)} (> commands, @ symbols, : line go to the regular ⌘P)`;
    qp.matchOnDescription = true;
    qp.busy = true;
    qp.show();

    const openSide = { iconPath: new vscode.ThemeIcon('split-horizontal'), tooltip: 'Open to the Side' };
    const recent = recentFiles.get(wt.path) ?? [];
    const toItem = (rel) => {
      const uri = vscode.Uri.file(path.join(wt.path, rel));
      const dir = path.dirname(rel);
      return {
        label: path.basename(rel),
        description: dir === '.' ? '' : dir,
        iconPath: vscode.ThemeIcon.File,
        resourceUri: uri,
        uri,
        buttons: [openSide],
      };
    };
    const files = await listWorktreeFiles(wt.path);
    const known = new Set(files);
    const recentItems = recent.filter((r) => known.has(r)).map((r) => toItem(r));
    const rest = files.filter((r) => !recent.includes(r)).sort((a, b) => a.length - b.length || a.localeCompare(b));
    qp.items = [
      ...(recentItems.length ? [{ label: 'recently opened', kind: vscode.QuickPickItemKind.Separator }, ...recentItems] : []),
      { label: `${files.length} files`, kind: vscode.QuickPickItemKind.Separator },
      ...rest.map((r) => toItem(r)),
    ];
    qp.busy = false;

    const open = async (item, beside) => {
      if (!item?.uri) return;
      qp.hide();
      await vscode.window.showTextDocument(item.uri, { preview: !beside, viewColumn: beside ? vscode.ViewColumn.Beside : undefined });
    };
    qp.onDidChangeValue((v) => {
      // Prefixes that mean "not a file name": hand over to the built-in Quick Open.
      if (/^[>@#:%]/.test(v)) {
        qp.hide();
        vscode.commands.executeCommand('workbench.action.quickOpen', v);
      }
    });
    qp.onDidAccept(() => open(qp.selectedItems[0] ?? qp.activeItems[0], false));
    qp.onDidTriggerItemButton((e) => open(e.item, true));
    qp.onDidHide(() => qp.dispose());
    lastPicker = qp; // for tests
  };
  /** @type {vscode.QuickPick<any> | undefined} */
  let lastPicker;

  // ---- worktree creation (shared by New Worktree and New Task) ----------------------------------

  const validateBranch = (v) =>
    /^[\w.\-/]+$/.test(v.trim()) && !v.includes('..') && !v.trim().endsWith('/') ? undefined : 'Letters, digits, . - _ / only';

  /** Where new branches start: agentDeck.baseBranch, else the remote's default branch, else HEAD. */
  const baseRefFor = async (repo) => {
    const setting = /** @type {string} */ (vscode.workspace.getConfiguration('agentDeck').get('baseBranch') ?? '').trim();
    if (setting) return { ref: setting, remote: setting.includes('/') ? setting : undefined };
    const head = (await git(repo.root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
    return head ? { ref: head, remote: head } : { ref: 'HEAD', remote: undefined };
  };
  const baseRefLabel = async (repo) => {
    const b = await baseRefFor(repo);
    return b.ref === 'HEAD' ? "the main checkout's HEAD" : b.ref;
  };

  /**
   * Creates (or checks out) `branch` as a new worktree next to the repo and returns it.
   * `fresh`: fetch the base first so the task starts from the latest remote default branch.
   */
  const createWorktree = async (repo, branch, { fresh = false } = {}) => {
    const setting = /** @type {string} */ (vscode.workspace.getConfiguration('agentDeck').get('worktreeParentDir') ?? '').trim();
    const parent = setting ? expandHome(setting) : path.join(path.dirname(repo.root), `${repo.name}.worktrees`);
    let target = path.join(parent, branch.split('/').pop() || branch.replace(/\//g, '-'));
    for (let i = 2; fs.existsSync(target); i++) target = `${target.replace(/-\d+$/, '')}-${i}`;
    const exists = await git(repo.root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
    const base = await baseRefFor(repo);
    try {
      fs.mkdirSync(parent, { recursive: true });
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating worktree ${branch}…` }, async (p) => {
        if (fresh && !exists && base.remote) {
          p.report({ message: `fetching ${base.remote}` });
          const [remote, ...rest] = base.remote.split('/');
          await git(repo.root, ['fetch', '--quiet', remote, rest.join('/')]).catch(() => {}); // offline is fine
        }
        p.report({ message: 'adding worktree' });
        await git(repo.root, exists ? ['worktree', 'add', target, branch] : ['worktree', 'add', '--no-track', '-b', branch, target, base.ref]);
      });
    } catch (e) {
      vscode.window.showErrorMessage(`Agent Deck: ${e.message}`);
      return undefined;
    }
    await deck.refresh();
    return deck.findWorktree(target) ?? deck.worktrees.find((w) => w.branch === branch);
  };

  /** Jump to a terminal that needs you: its worktree becomes active and the terminal is focused. */
  const goTo = (t) => {
    const wt = deck.worktreeOf(t);
    if (wt) {
      deck.lastTerminal.set(wt.path, t);
      deck.setActive(wt.path);
    }
    t.show(false);
    deck.markSeen(t);
  };

  deck.onAttention(({ terminal, worktree, attention }) => {
    const cfg = vscode.workspace.getConfiguration('agentDeck');
    if (!cfg.get('notifications', true)) return;
    const what = attention.kind === 'waiting' ? attentionWhat(attention) : 'finished';
    const title = wtTitle(worktree, deck);
    vscode.window.showInformationMessage(`${title} — agent ${what}`, 'Show').then((c) => c && goTo(terminal));
    if (!vscode.window.state.focused && cfg.get('macNotifications', true) && process.platform === 'darwin') {
      const q = (x) => JSON.stringify(String(x));
      execFile('osascript', ['-e', `display notification ${q(`Agent ${what}`)} with title "Agent Deck" subtitle ${q(title)} sound name "Glass"`], () => {});
    }
  });

  /** Reflect the active terminal's worktree in the panel without stealing focus. */
  const syncFromTerminal = (t) => {
    if (!t) return;
    if (vscode.window.state.focused) deck.markSeen(t);
    const wt = deck.worktreeOf(t);
    if (!wt) return;
    deck.lastTerminal.set(wt.path, t);
    deck.setActive(wt.path);
    panel.schedule();
    panel.reveal(wt.path);
  };

  // Clicking a worktree card opens it (the panel closes the others) and brings its terminal
  // forward without taking focus away from the panel.
  panel.onSelect((p) => deck.switchTo(p, { preserveFocus: true }));

  // Poll processes + git status while the window is focused; agents edit files and cd around
  // without telling us.
  // In the background only terminal processes are re-scanned (cheap), so "needs you" alerts still
  // arrive while you're in another app.
  const timer = setInterval(() => deck.poll(false, { light: !vscode.window.state.focused }), POLL_MS);

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
        label: `$(${w.isMain ? 'repo' : 'git-branch'}) ${wtTitle(w, deck)}`,
        description: [wtTitle(w, deck) !== wtLabel(w) ? wtLabel(w) : '', deck.repos.length > 1 ? w.repo.name : '', ch ? `±${ch}` : '', n ? `${n} term` : '', deck.active === w.path ? 'active' : '']
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

  /**
   * Commands get a path string (keybindings, tests), a `{ wtPath, … }` object from the panel or its
   * context menus, or nothing, which means the active worktree.
   */
  const resolveWt = (arg) => {
    if (typeof arg === 'string') return deck.findWorktree(arg);
    if (arg?.wtPath) return deck.findWorktree(arg.wtPath);
    if (arg?.termId) {
      const t = panel.terminalById(arg.termId);
      return t && deck.worktreeOf(t);
    }
    return deck.active ? deck.findWorktree(deck.active) : undefined;
  };

  /** Runs a git command on one changed file (`arg.path`), or on every file of `arg.group`. */
  const gitOnFiles = async (arg, argsFor) => {
    const wt = arg && resolveWt(arg);
    if (!wt) return;
    const files = arg.path ? [{ path: arg.path, orig: arg.orig }] : deck.changesOf(wt.path, arg.group);
    const paths = files.flatMap((c) => (c.orig ? [c.orig, c.path] : [c.path]));
    if (!paths.length) return;
    try {
      await git(wt.path, argsFor(paths));
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
    vscode.window.registerWebviewViewProvider('agentDeck.worktrees', panel, { webviewOptions: { retainContextWhenHidden: true } }),
    filesView,
    status,
    { dispose: () => clearInterval(timer) },
    { dispose: () => deck.gitWatchers.forEach((w) => w.dispose()) },
    { dispose: () => files.watcher?.dispose() },
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitContent()),

    vscode.window.onDidChangeActiveTerminal(syncFromTerminal),
    vscode.window.onDidChangeActiveTextEditor((ed) => ed?.document.uri.scheme === 'file' && noteOpened(ed.document.uri.fsPath)),
    vscode.window.onDidOpenTerminal(() => {
      deck.adoptTerminals();
      setTimeout(() => deck.poll(), 1500);
      panel.schedule();
    }),
    vscode.window.onDidCloseTerminal((t) => {
      panel.termIds.delete(t);
      deck.forgetTerminal(t);
    }),
    vscode.window.onDidChangeTerminalShellIntegration(() => panel.schedule()),
    vscode.window.onDidStartTerminalShellExecution((e) => {
      deck.busy.set(e.terminal, (deck.busy.get(e.terminal) ?? 0) + 1);
      lastCommand.set(e.terminal, e.execution.commandLine.value.split(/\s+/)[0] || '');
      panel.schedule();
      setTimeout(() => deck.poll(), 1500);
    }),
    vscode.window.onDidEndTerminalShellExecution((e) => {
      deck.busy.set(e.terminal, Math.max(0, (deck.busy.get(e.terminal) ?? 1) - 1));
      deck.poll();
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (!s.focused) return;
      deck.refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => deck.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('files.exclude') && files.refresh()),

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
    // Search results inside a symlinked worktree open under the link path; swap to the real file
    // so git decorations, the Files view and other open tabs all agree on one path.
    vscode.window.onDidChangeActiveTextEditor(async (ed) => {
      const uri = ed?.document.uri;
      if (!uri || uri.scheme !== 'file' || !isInside(uri.fsPath, SEARCH_LINKS)) return;
      let real;
      try {
        real = fs.realpathSync(uri.fsPath);
      } catch {
        return;
      }
      if (real === uri.fsPath) return;
      // The editor applies the search hit's selection just after it becomes active.
      await new Promise((r) => setTimeout(r, 60));
      const selection = ed.selection;
      const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
      const opened = await vscode.window.showTextDocument(vscode.Uri.file(real), { selection, viewColumn: ed.viewColumn, preview: tab?.isPreview });
      opened.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      if (tab && !ed.document.isDirty) await Promise.resolve(vscode.window.tabGroups.close(tab)).catch(() => {}); // may already be gone
    }),
    vscode.commands.registerCommand('agentDeck.refreshTerminals', async () => {
      const { plan, skipped } = await deck.refreshTerminals();
      if (!plan.length) {
        vscode.window.showInformationMessage(`Agent Deck: nothing to refresh.${skipped.length ? ` Left alone: ${skipped.join(', ')}.` : ''}`);
        return;
      }
      const agents = plan.filter((p) => p.command).length;
      const ok = await vscode.window.showWarningMessage(
        `Refresh ${plan.length} terminal${plan.length === 1 ? '' : 's'}?`,
        {
          modal: true,
          detail: [
            agents ? `${agents} idle Claude session(s) will be resumed in fresh terminals (conversation kept).` : '',
            plan.length - agents ? `${plan.length - agents} empty shell(s) will be reopened.` : '',
            skipped.length ? `Left alone: ${skipped.join(', ')}.` : '',
          ].filter(Boolean).join('\n'),
        },
        'Refresh',
      );
      if (ok !== 'Refresh') return;
      const active = vscode.window.activeTerminal;
      let focus;
      for (const p of plan) {
        const fresh = deck.createTerminal(p.wt, { show: false, name: p.name, command: p.command, cwd: p.cwd, plain: true });
        if (p.t === active) focus = fresh;
        p.t.dispose();
      }
      focus?.show(true);
      setTimeout(() => deck.poll(), 3000);
    }),
    vscode.commands.registerCommand('agentDeck.goToFileInWorktree', () => goToFile()),
    vscode.commands.registerCommand('agentDeck.findInWorktree', () => {
      // Scope Search to the active worktree. An absolute path in "files to include" also works for
      // worktrees outside the open folder (e.g. ~/.superset/worktrees/...). For the main checkout,
      // which is the workspace itself, clear the scope instead.
      const wt = deck.active ? deck.findWorktree(deck.active) : undefined;
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const same = (x, y) => {
        try {
          return fs.realpathSync(x) === fs.realpathSync(y);
        } catch {
          return x === y;
        }
      };
      if (!wt || folders.some((f) => same(f, wt.path))) {
        return vscode.commands.executeCommand('workbench.action.findInFiles', { filesToInclude: '', showIncludesExcludes: false });
      }
      return vscode.commands.executeCommand('workbench.action.findInFiles', { filesToInclude: searchRootFor(wt, folders), showIncludesExcludes: true });
    }),
    vscode.commands.registerCommand('agentDeck.nextWorktree', () => cycle(1)),
    vscode.commands.registerCommand('agentDeck.prevWorktree', () => cycle(-1)),

    vscode.commands.registerCommand('agentDeck.showTerminal', (arg) => {
      const t = arg?.termId && panel.terminalById(arg.termId);
      if (!t) return;
      const wt = deck.worktreeOf(t);
      if (wt) {
        deck.lastTerminal.set(wt.path, t);
        deck.setActive(wt.path);
      }
      t.show(false);
      deck.markSeen(t);
    }),
    vscode.commands.registerCommand('agentDeck.nextAttention', () => {
      const next = deck.attentionList()[0];
      if (next) goTo(next.t);
      else vscode.window.showInformationMessage('Agent Deck: no agent needs you right now.');
    }),
    vscode.commands.registerCommand('agentDeck.newTerminal', async (arg) => {
      const wt = resolveWt(arg) ?? (await pickWorktree('New terminal in…'));
      if (!wt) return;
      deck.setActive(wt.path);
      deck.createTerminal(wt);
    }),
    vscode.commands.registerCommand('agentDeck.killTerminal', (arg) => panel.terminalById(arg?.termId)?.dispose()),
    vscode.commands.registerCommand('agentDeck.renameTerminal', async (arg) => {
      const t = panel.terminalById(arg?.termId);
      if (!t) return;
      const name = await vscode.window.showInputBox({ prompt: 'Terminal name', value: deck.displayName(t) });
      if (!name) return;
      t.show(true);
      await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
      deck.names.set(t, name);
      deck.saveLinks();
      panel.schedule();
    }),

    vscode.commands.registerCommand('agentDeck.openChange', (arg) => {
      const wt = resolveWt(arg);
      if (!wt || !arg.path) return;
      const group = arg.group;
      const c = { path: arg.path, orig: arg.orig, code: arg.code ?? ' M' };
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
    vscode.commands.registerCommand('agentDeck.openChangedFile', (arg) => {
      const wt = resolveWt(arg);
      if (wt && arg?.path) vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(wt.path, arg.path)));
    }),
    vscode.commands.registerCommand('agentDeck.stage', (arg) => gitOnFiles(arg, (paths) => ['add', '-A', '--', ...paths])),
    vscode.commands.registerCommand('agentDeck.unstage', (arg) => gitOnFiles(arg, (paths) => ['restore', '--staged', '--', ...paths])),

    vscode.commands.registerCommand('agentDeck.newWorktree', async (arg) => {
      const repo = (arg?.wtPath && deck.findWorktree(arg.wtPath)?.repo) ?? (await pickRepo());
      if (!repo) return;
      const branch = await vscode.window.showInputBox({
        prompt: `New worktree in ${repo.name}: branch name (existing branches are checked out, new ones start from ${await baseRefLabel(repo)})`,
        placeHolder: 'feat/my-agent-task',
        validateInput: validateBranch,
      });
      if (!branch) return;
      const wt = await createWorktree(repo, branch.trim());
      if (wt) deck.switchTo(wt.path);
    }),

    vscode.commands.registerCommand('agentDeck.newTask', async (arg) => {
      // arg lets tests (and keybindings) skip the prompts: { prompt, branch }.
      const repo = (arg?.wtPath && deck.findWorktree(arg.wtPath)?.repo) ?? (await pickRepo());
      if (!repo) return;
      const task = arg?.prompt ?? (await vscode.window.showInputBox({
        title: `New task · ${repo.name}`,
        prompt: 'What should the agent do? It gets its own worktree, set up and ready, with Claude started on this.',
        placeHolder: 'Fix the flaky login redirect test',
        ignoreFocusOut: true,
      }));
      if (!task?.trim()) return;
      const suggested = await suggestBranch(repo, task);
      // Called with a prompt (tests, other extensions): take the suggested branch without asking.
      let branch = arg?.branch ?? (arg?.prompt ? suggested : undefined);
      if (!branch) {
        const slugAt = suggested.lastIndexOf('/') + 1;
        branch = await vscode.window.showInputBox({
          title: `New task · branch`,
          prompt: `Starts from ${await baseRefLabel(repo)}. Enter to accept.`,
          value: suggested,
          valueSelection: [slugAt, suggested.length],
          validateInput: validateBranch,
          ignoreFocusOut: true,
        });
      }
      if (!branch?.trim()) return;
      const wt = await createWorktree(repo, branch.trim(), { fresh: true });
      if (!wt) return;

      deck.taskTitles.set(wt.path, task.trim().replace(/\s+/g, ' ').slice(0, 80));
      ctx.workspaceState.update('agentDeck.taskTitles', [...deck.taskTitles]);

      const { commands, source } = await setupFor(repo);
      const cfg = vscode.workspace.getConfiguration('agentDeck');
      const startup = /** @type {string} */ (cfg.get('startupCommand') ?? '').trim();
      const agent = startup.startsWith('claude') || startup.includes('/claude') ? startup : 'claude';
      // Setup failures shouldn't stop the agent: it can often fix them itself.
      const setup = commands.length ? `{ ${commands.join(' && ')}; } ; ` : '';
      deck.setActive(wt.path);
      deck.createTerminal(wt, {
        command: `${setup}${agent} ${sq(task.trim())}`,
        plain: true,
        env: { AGENT_DECK_ROOT_PATH: repo.root, SUPERSET_ROOT_PATH: repo.root },
      });
      if (!arg?.prompt) {
        vscode.window.setStatusBarMessage(`Agent Deck: ${wtLabel(wt)} created${commands.length ? `, setup from ${source}` : ''}, Claude started`, 6000);
      }
      return wt.path;
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
    vscode.commands.registerCommand('agentDeck.openInNewWindow', (arg) => {
      const wt = resolveWt(arg);
      if (wt) vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wt.path), { forceNewWindow: true });
    }),
    vscode.commands.registerCommand('agentDeck.revealInFinder', (arg) => {
      const wt = resolveWt(arg);
      if (wt) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(wt.path));
    }),
    vscode.commands.registerCommand('agentDeck.openPr', (arg) => {
      const wt = resolveWt(arg);
      const url = wt && (deck.prs.get(wt.path) ?? [])[0]?.url;
      if (url) vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand('agentDeck.openPrLink', (arg) => {
      if (arg?.url) vscode.env.openExternal(vscode.Uri.parse(arg.url));
    }),
    vscode.commands.registerCommand('agentDeck.copyPrLink', (arg) => {
      if (arg?.url) vscode.env.clipboard.writeText(arg.url);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('agentDeck.worktreeLabel') && panel.schedule()),
    vscode.commands.registerCommand('agentDeck.copyPath', (arg) => {
      const wt = resolveWt(arg);
      if (wt) vscode.env.clipboard.writeText(wt.path);
    }),
  );

  // Open the Agent Deck sidebar on start / reload instead of whatever was showing (usually Explorer).
  if (vscode.workspace.getConfiguration('agentDeck').get('showOnStartup', true)) {
    vscode.commands.executeCommand('workbench.view.extension.agentDeck').then(undefined, () => {});
  }

  deck.refresh().then(async () => {
    updateChrome();
    syncFromTerminal(vscode.window.activeTerminal);
    // Restored terminals need a moment before their shells report a pid.
    await new Promise((r) => setTimeout(r, 1500));
    await deck.poll(true);
    const n = await deck.resumeAgents();
    if (n) {
      vscode.window.showInformationMessage(`Agent Deck: resumed ${n} Claude session${n === 1 ? '' : 's'} from before the restart.`);
      setTimeout(() => deck.poll(), 3000);
    }
  });

  return { deck, panel, model: () => panel.model(), searchRootFor, updateBadge, listWorktreeFiles, picker: () => lastPicker };
}

function deactivate() {}

module.exports = { activate, deactivate };
