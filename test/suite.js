// Runs inside the VS Code extension host: `npm test`.
const vscode = require('vscode');
const assert = require('assert');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await globalDeck?.poll();
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

let globalDeck;
exports.run = async function () {
  const ext = vscode.extensions.getExtension('anzemur.agent-deck');
  const { deck } = await ext.activate();
  globalDeck = deck;
  const model = () => ext.exports.model();
  const wtModel = (w) => model().worktrees.find((x) => x.path === w.path);
  const panel = ext.exports.panel;
  // showOnStartup: the Agent Deck sidebar opened on its own, so the panel resolved without help.
  await until(() => !!panel.view, 'Agent Deck sidebar shown on startup', 15000);
  console.log('✓ Agent Deck sidebar opens on startup');
  await until(() => deck.worktrees.length === 3, '3 worktrees');
  const names = deck.worktrees.map((w) => w.branch).sort();
  assert.deepStrictEqual(names, ['feat-a', 'feat-b', 'main']);
  console.log('✓ discovers worktrees:', names.join(', '));

  const a = deck.worktrees.find((w) => w.branch === 'feat-a');
  const b = deck.worktrees.find((w) => w.branch === 'feat-b');

  // Selecting a worktree with no linked terminal does NOT create one.
  await vscode.commands.executeCommand('agentDeck.selectWorktree', a.path);
  await sleep(500);
  assert.strictEqual(deck.active, a.path);
  assert.strictEqual(vscode.window.terminals.length, 0);
  console.log('✓ selecting feat-a with no terminal just activates it (no terminal created)');

  // Explicit "new terminal" creates a named, linked one.
  await vscode.commands.executeCommand('agentDeck.newTerminal', a.path);
  await until(() => vscode.window.activeTerminal?.name === 'feat-a', 'terminal feat-a active');
  await vscode.commands.executeCommand('agentDeck.newTerminal', b.path);
  await until(() => vscode.window.activeTerminal?.name === 'feat-b', 'terminal feat-b active');
  console.log('✓ New terminal creates "feat-a" / "feat-b"');

  // Selecting worktree A brings its existing terminal forward.
  await vscode.commands.executeCommand('agentDeck.selectWorktree', a.path);
  await until(() => vscode.window.activeTerminal?.name === 'feat-a', 'terminal feat-a active again');
  assert.strictEqual(vscode.window.terminals.filter((t) => t.name === 'feat-a').length, 1);
  console.log('✓ selecting feat-a switches to its existing terminal');

  // Tree structure: worktree -> [No changes, Terminals]; changes come first.
  {
    const secs = wtModel(a).sections;
    assert.deepStrictEqual(secs.map((s) => s.kind), ['clean', 'terminals', 'prs']);
    assert.deepStrictEqual(secs[1].terminals.map((t) => t.name), ['feat-a']);
    console.log('✓ worktree dropdown = [No changes, Terminals (feat-a), Pull Requests]');
    // The webview really draws it: all worktrees as cards, the active one open.
    await until(() => panel.lastRender?.worktrees === deck.worktrees.length && panel.lastRender.open === a.path, 'panel rendered', 15000);
    assert.ok(panel.lastRender.openRows.includes('feat-a'), JSON.stringify(panel.lastRender.openRows));
    console.log(`✓ panel webview rendered ${panel.lastRender.worktrees} worktree cards, feat-a open with its terminal row`);
  }

  // Focus terminal B directly (like clicking its tab) -> active worktree follows.
  vscode.window.terminals.find((t) => t.name === 'feat-b').show();
  await until(() => deck.active === b.path, 'deck follows terminal focus');
  console.log('✓ focusing terminal "feat-b" switches active worktree to feat-b');

  // Second terminal in same worktree gets a distinct name and is linked.
  await vscode.commands.executeCommand('agentDeck.newTerminal', b.path);
  await until(() => vscode.window.activeTerminal?.name === 'feat-b · 2', 'second terminal');
  assert.strictEqual(deck.terminalsOf(b.path).length, 2);
  console.log('✓ second terminal in feat-b named "feat-b · 2"');
  {
    const first = vscode.window.terminals.find((t) => t.name === 'feat-b');
    const second = vscode.window.terminals.find((t) => t.name === 'feat-b · 2');
    await until(() => deck.procs.get(first)?.agent === 'claude', 'first terminal started claude', 15000);
    await sleep(1500);
    await deck.poll();
    assert.strictEqual(deck.procs.get(second)?.agent, undefined);
    console.log('✓ first terminal of a worktree starts claude; second is a plain shell');
  }

  // A plain terminal opened in worktree A's folder is associated by cwd.
  const plain = vscode.window.createTerminal({ name: 'plain', cwd: a.path });
  plain.show();
  await until(() => deck.active === a.path, 'plain terminal mapped by cwd');
  console.log('✓ unmanaged terminal in feat-a folder maps to feat-a');

  // Creating a worktree from git outside the editor shows up automatically.
  require('child_process').execSync(`git worktree add -q -b feat-c ${path.join(path.dirname(a.path), 'c')}`, { cwd: a.repo.root });
  await vscode.commands.executeCommand('agentDeck.refresh');
  await until(() => deck.worktrees.some((w) => w.branch === 'feat-c'), 'feat-c appears');
  console.log('✓ externally created worktree feat-c picked up');

  // Closing a terminal unlinks it.
  vscode.window.terminals.find((t) => t.name === 'feat-a').dispose();
  await until(() => !deck.terminalsOf(a.path).some((t) => t.name === 'feat-a'), 'terminal unlinked');
  console.log('✓ closing terminal unlinks it');

  // `claude -w` case: shell stays in the main checkout, the agent process runs inside worktree B.
  const main = deck.worktrees.find((w) => w.isMain);
  const agentTerm = vscode.window.createTerminal({ name: 'zsh-main', cwd: main.path });
  agentTerm.sendText(`cd ${JSON.stringify(b.path)} && ${process.env.AGENT_DECK_TEST_BIN}/claude 60 & cd ${JSON.stringify(main.path)}; wait`);
  await until(() => deck.procs.get(agentTerm)?.agent === 'claude', 'agent detected', 15000).catch(async (e) => {
    const pid = await Promise.race([agentTerm.processId, sleep(1000).then(() => 'no pid')]);
    const dump = { pid, procs: [...deck.procs].map(([t, i]) => [t.name, i]), ps: require('child_process').spawnSync('ps', ['-A', '-o', 'pid=,ppid=,comm=']).stdout.toString().split('\n').filter((l) => /claude|sleep|zsh|bash/.test(l)) };
    require('fs').writeFileSync(process.env.AGENT_DECK_DEBUG ?? '/dev/null', JSON.stringify(dump, null, 1));
    throw e;
  });
  assert.strictEqual(deck.worktreeOf(agentTerm)?.path, b.path);
  console.log('✓ shell in main + claude running in feat-b → terminal listed under feat-b, marked as claude');

  // Idle vs working: the sleeping fake agent is idle; a CPU-spinning one is working.
  await deck.poll();
  await sleep(1500);
  await deck.poll();
  assert.strictEqual(deck.procs.get(agentTerm)?.working, false);
  console.log('✓ idle claude (waiting at prompt) → idle, no spinner');
  const busyTerm = vscode.window.createTerminal({ name: 'busy', cwd: a.path });
  busyTerm.sendText(`${process.env.AGENT_DECK_TEST_BIN}/claude 30 busy`);
  await until(() => deck.procs.get(busyTerm)?.working === true, 'busy agent detected as working', 15000);
  assert.strictEqual(deck.procs.get(agentTerm)?.working, false);
  console.log('✓ busy claude → working (spinner); idle one stays idle');
  busyTerm.dispose();

  // Staged vs unstaged changes, per worktree.
  const fsx = require('fs');
  fsx.writeFileSync(path.join(a.path, 'README.md'), 'changed\n');
  fsx.writeFileSync(path.join(a.path, 'staged.txt'), 'x\n');
  require('child_process').execSync('git add staged.txt', { cwd: a.path });
  fsx.writeFileSync(path.join(a.path, 'new.txt'), 'y\n');
  await deck.poll();
  const staged = deck.changesOf(a.path, 'staged').map((c) => c.path);
  const unstaged = deck.changesOf(a.path, 'unstaged').map((c) => c.path).sort();
  assert.deepStrictEqual(staged, ['staged.txt']);
  assert.deepStrictEqual(unstaged, ['README.md', 'new.txt']);
  assert.strictEqual(deck.changesOf(b.path, 'unstaged').length, 0);
  console.log('✓ feat-a: Staged = [staged.txt], Changes = [README.md, new.txt]; feat-b clean');

  const kids = wtModel(a).sections;
  assert.deepStrictEqual(kids.map((k) => k.title ?? k.kind), ['Staged Changes', 'Changes', 'terminals', 'prs']);
  console.log('✓ feat-a dropdown = [Staged Changes, Changes, Terminals, Pull Requests] (changes on top)');
  const readme = kids[1].files.find((f) => f.path === 'README.md');
  // Seti gives README files their own (info) icon and other .md files the markdown one.
  assert.deepStrictEqual([readme.letter, readme.seti[0]], ['M', 'E04D']);
  const newTxt = kids[1].files.find((f) => f.path === 'new.txt');
  assert.strictEqual(newTxt.letter, 'U');
  console.log('✓ file rows: README.md = M with Seti README icon, new.txt = U');

  // Stage README via the command, then check the index diff content provider.
  const readmeNode = { wtPath: a.path, group: 'unstaged', path: 'README.md' };
  await vscode.commands.executeCommand('agentDeck.stage', readmeNode);
  await until(() => deck.changesOf(a.path, 'staged').some((c) => c.path === 'README.md'), 'README staged');
  const idx = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: 'agentdeck-git', path: path.join(a.path, 'README.md'), query: JSON.stringify({ cwd: a.path, ref: ':' }) }));
  const head = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: 'agentdeck-git', path: path.join(a.path, 'README.md'), query: JSON.stringify({ cwd: a.path, ref: 'HEAD' }) }));
  assert.strictEqual(idx.getText(), 'changed\n');
  assert.strictEqual(head.getText(), 'hello\n');
  console.log('✓ stage command works; diff shows HEAD "hello" ↔ index "changed"');
  await vscode.commands.executeCommand('agentDeck.unstage', readmeNode);
  await until(() => !deck.changesOf(a.path, 'staged').some((c) => c.path === 'README.md'), 'README unstaged');
  console.log('✓ unstage command works');

  // Worktree label follows the Claude session title; /rename wins; PR number shows.
  {
    const fsx = require('fs');
    const dir = path.join(process.env.AGENT_DECK_CLAUDE_PROJECTS, b.path.replace(/[^a-zA-Z0-9]/g, '-'));
    fsx.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 's1.jsonl');
    fsx.writeFileSync(file, [
      { type: 'user', message: { content: 'hi' } },
      { type: 'ai-title', aiTitle: 'Old title' },
      { type: 'ai-title', aiTitle: 'Fix login redirect' },
      { type: 'pr-link', prNumber: 42, prUrl: 'https://example.com/pr/42' },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n');
    await deck.poll();
    let item = wtModel(b);
    assert.strictEqual(item.title, 'Fix login redirect');
    assert.strictEqual(item.branch, 'feat-b');
    console.log(`✓ worktree feat-b labelled "${item.title}" (branch ${item.branch})`);
    await until(async () => (deck.prs.get(b.path) ?? []).some((p) => p.number === 42), 'PR from session', 15000);
    const secsB = wtModel(b).sections;
    assert.deepStrictEqual(secsB.slice(-2).map((s) => s.kind), ['terminals', 'prs']);
    const pr = secsB.at(-1).prs[0];
    assert.strictEqual(pr.number, 42);
    assert.match(pr.sub, /from session/);
    assert.strictEqual(pr.url, 'https://example.com/pr/42');
    console.log('✓ Pull Requests section after Terminals lists #42 (linked in session) with its link');

    // Active worktree: coloured name + ● badge; header shows its name.
    await vscode.commands.executeCommand('agentDeck.selectWorktree', b.path);
    const mb = wtModel(b), ma = wtModel(a);
    assert.ok(mb.active && !ma.active);
    assert.match(mb.colorVar, /--vscode-(agentDeck-worktree\d+|terminal-ansi)/);
    assert.match(mb.badge, /^●/);
    assert.ok(!ma.badge.includes('●'));
    await until(() => panel.view?.description === 'Fix login redirect', 'header shows active worktree');
    console.log(`✓ active worktree: coloured name, badge "${mb.badge}", header "WORKTREES · ${panel.view.description}"`);
    await sleep(20);
    fsx.appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: 'Login bug' }) + '\n');
    await deck.poll();
    assert.strictEqual(wtModel(b).title, 'Login bug');
    console.log('✓ /rename title overrides the AI title');
    assert.strictEqual(wtModel(a).title, 'feat-a');
    console.log('✓ worktree without a session keeps its branch name');
  }

  // Restart recovery: a recorded session that is no longer running gets `claude --resume`d in the
  // directory its transcript lives under, and shows up under its worktree again.
  {
    const fsx = require('fs');
    const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
    const pdir = path.join(process.env.AGENT_DECK_CLAUDE_PROJECTS, enc(b.path));
    fsx.mkdirSync(pdir, { recursive: true });
    // Like a real long session: 3 MB of lines from another (deleted) worktree before the real cwd.
    const filler = JSON.stringify({ type: 'user', cwd: '/gone/worktree', pad: 'x'.repeat(1000) }) + '\n';
    fsx.writeFileSync(path.join(pdir, 'sess-b.jsonl'), filler.repeat(3000) + JSON.stringify({ type: 'user', cwd: b.path }) + '\n');
    // Main checkout session whose transcript only ever mentions another dir: resolved from the dir name.
    const mdir = path.join(process.env.AGENT_DECK_CLAUDE_PROJECTS, enc(main.path));
    fsx.mkdirSync(mdir, { recursive: true });
    fsx.writeFileSync(path.join(mdir, 'sess-main.jsonl'), filler.repeat(3000));
    const all = {};
    all[deck.recordKey] = [
      { sessionId: 'sess-b', wtPath: b.path, name: 'resumed-b' },
      { sessionId: 'sess-main', wtPath: main.path, name: 'resumed-main' },
    ];
    fsx.mkdirSync(path.dirname(deck.recordFile), { recursive: true });
    fsx.writeFileSync(deck.recordFile, JSON.stringify(all));
    const before = new Set(vscode.window.terminals);
    const n = await deck.resumeAgents();
    assert.strictEqual(n, 2);
    // Find the terminal that got the resume command: its fake claude has "--resume sess-b" in argv.
    let pid;
    await until(() => {
      const out = require('child_process').spawnSync('pgrep', ['-f', 'claude 120 --resume sess-b']).stdout.toString().trim();
      pid = out.split('\n')[0];
      return !!pid;
    }, 'resumed claude process', 15000);
    await until(() => require('child_process').spawnSync('pgrep', ['-f', 'claude 120 --resume sess-main']).stdout.toString().trim(), 'main session resumed', 15000);
    console.log('✓ both recorded sessions resumed after restart, incl. one whose 3 MB transcript starts in another dir');

    // Claude's pid file tells us the session id and busy/idle.
    fsx.writeFileSync(path.join(process.env.AGENT_DECK_CLAUDE_SESSIONS, `${pid}.json`), JSON.stringify({ pid: Number(pid), sessionId: 'sess-b', status: 'busy' }));
    let term;
    await until(() => (term = vscode.window.terminals.find((t) => deck.procs.get(t)?.sessionId === 'sess-b')), 'session id from pid file', 15000);
    assert.strictEqual(deck.worktreeOf(term)?.path, b.path);
    assert.strictEqual(deck.procs.get(term).working, true);
    console.log(`✓ resumed session sits under feat-b in terminal "${term.name}", pid file status busy → working`);
    fsx.writeFileSync(path.join(process.env.AGENT_DECK_CLAUDE_SESSIONS, `${pid}.json`), JSON.stringify({ pid: Number(pid), sessionId: 'sess-b', status: 'idle' }));
    await deck.poll();
    assert.strictEqual(deck.procs.get(term).working, false);
    console.log('✓ pid file status idle → idle');

    const saved = JSON.parse(fsx.readFileSync(deck.recordFile, 'utf8'))[deck.recordKey];
    assert.ok(saved.some((r) => r.sessionId === 'sess-b' && r.wtPath === b.path));
    console.log('✓ running session recorded for the next restart');
    assert.strictEqual(await deck.resumeAgents(), 0);
    console.log('✓ a session that is still alive is not resumed twice');

    // "Needs you": an agent that finishes (busy → idle) or asks something (waiting) in a terminal
    // you're not looking at raises an alert once, shows on its card, counts in the badge, and
    // clears when you jump to it.
    {
      const events = [];
      const sub = deck.onAttention((e) => events.push(e));
      const pidFile = path.join(process.env.AGENT_DECK_CLAUDE_SESSIONS, `${pid}.json`);
      const write = (status, extra = {}) =>
        fsx.writeFileSync(pidFile, JSON.stringify({ pid: Number(pid), sessionId: 'sess-b', status, statusUpdatedAt: Date.now(), ...extra }));
      const elsewhere = vscode.window.createTerminal({ name: 'elsewhere', cwd: a.path });
      elsewhere.show();
      await sleep(800);
      write('busy');
      await deck.poll();
      assert.strictEqual(deck.attentionOf(term), undefined);
      await sleep(20);
      write('idle');
      await deck.poll();
      assert.strictEqual(deck.attentionOf(term)?.kind, 'done');
      assert.strictEqual(events.at(-1)?.attention.kind, 'done');
      assert.strictEqual(wtModel(b).state, 'attention');
      assert.match(wtModel(b).meta[0].text, /^done · now$/);
      ext.exports.updateBadge();
      assert.ok((panel.view.badge?.value ?? 0) >= 1);
      console.log(`✓ agent finished while you looked elsewhere → alert "done", card "${wtModel(b).meta[0].text}", badge ${panel.view.badge.value}`);
      const before = events.length;
      await deck.poll();
      assert.strictEqual(events.length, before);
      console.log('✓ the same episode alerts only once');
      await sleep(20);
      write('waiting', { waitingFor: 'permission prompt' }); // what real Claude writes (checked)
      await deck.poll();
      assert.deepStrictEqual([deck.attentionOf(term)?.kind, deck.attentionOf(term)?.reason], ['waiting', 'permission prompt']);
      assert.match(wtModel(b).meta[0].text, /^needs approval · /);
      console.log(`✓ permission prompt → "${wtModel(b).meta[0].text}"`);
      await vscode.commands.executeCommand('agentDeck.nextAttention');
      await until(() => vscode.window.activeTerminal === term, 'jumped to the agent');
      write('idle');
      await deck.poll();
      assert.strictEqual(deck.attentionOf(term), undefined);
      ext.exports.updateBadge();
      console.log('✓ "Go to agent that needs you" focuses it; once seen the alert clears');
      sub.dispose();
      elsewhere.dispose();
    }

    // Refresh Terminals: idle Claude → resumed fresh; empty shell → reopened; busy → left alone.
    const oldPlain = vscode.window.createTerminal({ name: 'old-plain', cwd: a.path });
    const busy = vscode.window.createTerminal({ name: 'old-busy', cwd: a.path });
    busy.sendText('sleep 60');
    // A brand-new zsh briefly runs start-up helpers; wait until it has settled.
    let plan, skipped;
    await until(async () => {
      ({ plan, skipped } = await deck.refreshTerminals());
      return plan.some((p) => p.shown === 'old-plain') && skipped.some((s) => s.startsWith('old-busy'));
    }, 'shells settled', 20000);
    const byName = (n) => plan.find((p) => p.shown === n);
    assert.match(byName(term.name)?.command ?? '', /--resume sess-b$/);
    assert.ok(byName('old-plain') && !byName('old-plain').command);
    assert.ok(!byName('old-busy') && skipped.some((s) => s.startsWith('old-busy')), JSON.stringify(skipped));
    console.log(`✓ refresh plan: idle claude → resume, empty shell → reopen, busy "sleep" left alone (${skipped.length} skipped)`);
    oldPlain.dispose();
    busy.dispose();
  }

  // ⌘⇧F scoping: worktrees nested inside the workspace folder (and usually .gitignored there, like
  // .claude/worktrees) are searched through a symlink so they become their own search root.
  {
    const fsx = require('fs');
    const { searchRootFor } = ext.exports;
    const folders = vscode.workspace.workspaceFolders.map((f) => f.uri.fsPath);
    assert.strictEqual(searchRootFor(a, folders), a.path);
    require('child_process').execSync('git worktree add -q -b feat-n nested/n', { cwd: main.path });
    await deck.refresh();
    const nwt = deck.worktrees.find((w) => w.branch === 'feat-n');
    const link = searchRootFor(nwt, folders);
    assert.ok(link.startsWith(process.env.AGENT_DECK_SEARCH_LINKS) && fsx.realpathSync(link) === fsx.realpathSync(nwt.path));
    console.log(`✓ search scope: outside worktree = its path; nested worktree = symlink ${path.basename(link)}`);
    fsx.writeFileSync(path.join(nwt.path, 'x.ts'), 'a\nb\nc\n');
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(link, 'x.ts')), { selection: new vscode.Range(2, 0, 2, 0) });
    await until(() => vscode.window.activeTextEditor?.document.uri.fsPath === fsx.realpathSync(path.join(nwt.path, 'x.ts')), 'reopened at real path');
    assert.strictEqual(vscode.window.activeTextEditor.selection.active.line, 2);
    assert.ok(!vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input?.uri?.fsPath?.startsWith(process.env.AGENT_DECK_SEARCH_LINKS)));
    console.log('✓ a search result opened via the symlink is swapped to the real file, same line, link tab closed');
  }

  // ⌘P in a worktree: only that worktree's files (tracked + untracked, not ignored), recent first.
  {
    const fsx = require('fs');
    fsx.writeFileSync(path.join(a.path, '.gitignore'), 'ignored.log\n');
    fsx.writeFileSync(path.join(a.path, 'ignored.log'), 'x');
    fsx.writeFileSync(path.join(a.path, 'fresh-untracked.ts'), 'x');
    const files = await ext.exports.listWorktreeFiles(a.path);
    assert.ok(files.includes('README.md') && files.includes('fresh-untracked.ts') && !files.includes('ignored.log'), JSON.stringify(files));
    deck.setActive(a.path);
    await vscode.commands.executeCommand('agentDeck.goToFileInWorktree');
    let qp;
    await until(() => (qp = ext.exports.picker()) && !qp.busy && qp.items.length > 0, 'picker filled');
    const labels = qp.items.filter((i) => i.kind !== vscode.QuickPickItemKind.Separator).map((i) => i.label);
    assert.ok(labels.includes('fresh-untracked.ts') && !labels.includes('ignored.log'));
    assert.ok(qp.items.every((i) => i.kind === vscode.QuickPickItemKind.Separator || i.uri.fsPath.startsWith(a.path)));
    console.log(`✓ ⌘P in feat-a lists ${labels.length} files, all inside feat-a (untracked yes, ignored no)`);
    // Accept "fresh-untracked.ts" → opens; next time it's first under "recently opened".
    qp.activeItems = [qp.items.find((i) => i.label === 'fresh-untracked.ts')];
    qp.selectedItems = qp.activeItems;
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await until(() => vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('fresh-untracked.ts'), 'file opened');
    await vscode.commands.executeCommand('agentDeck.goToFileInWorktree');
    await until(() => (qp = ext.exports.picker()) && !qp.busy && qp.items.length > 0 && qp.items[0].label === 'recently opened', 'recent section');
    assert.strictEqual(qp.items[1].label, 'fresh-untracked.ts');
    console.log('✓ opening a file from the picker works; it then shows first under "recently opened"');
    // Typing ">" hands over to the regular Quick Open (commands).
    qp.value = '>';
    await until(() => !qp.visible || qp.value === '', 'handed over');
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    console.log('✓ typing ">" hands over to the regular ⌘P / command palette');
  }

  // New Task: prompt → branch → fresh worktree → setup (.env copied) → Claude started on the prompt.
  {
    const fsx = require('fs');
    fsx.appendFileSync(path.join(main.path, '.gitignore'), '.env\n');
    fsx.writeFileSync(path.join(main.path, '.env'), 'SECRET=1\n');
    const created = await vscode.commands.executeCommand('agentDeck.newTask', { prompt: 'Fix the flaky login redirect test!' });
    const wt = deck.findWorktree(created);
    assert.ok(wt, `worktree created: ${created}`);
    assert.strictEqual(wt.branch, 'flaky-login-redirect-test');
    assert.strictEqual(path.basename(path.dirname(created)), `${path.basename(main.path)}.worktrees`);
    assert.strictEqual(deck.active, created);
    await until(() => fsx.existsSync(path.join(created, '.env')), '.env copied by setup', 15000);
    await until(() => require('child_process').spawnSync('pgrep', ['-f', 'claude 120 Fix the flaky login redirect test!']).stdout.toString().trim(), 'claude started with the prompt', 15000);
    assert.strictEqual(wtModel(wt).title, 'Fix the flaky login redirect test!');
    console.log(`✓ New Task: branch "${wt.branch}", worktree in ${path.basename(path.dirname(created))}/, .env copied, claude started with the prompt, card titled by the task`);

    // A repo setup script (.superset/config.json format) wins over the automatic setup.
    fsx.mkdirSync(path.join(main.path, '.superset'), { recursive: true });
    fsx.writeFileSync(path.join(main.path, '.superset/config.json'), JSON.stringify({ setup: ['cp "$SUPERSET_ROOT_PATH/.env" .env.from-script'] }));
    const second = await vscode.commands.executeCommand('agentDeck.newTask', { prompt: 'Fix the flaky login redirect test!' });
    assert.strictEqual(deck.findWorktree(second)?.branch, 'flaky-login-redirect-test-2');
    await until(() => fsx.existsSync(path.join(second, '.env.from-script')), 'repo setup script ran', 15000);
    assert.ok(!fsx.existsSync(path.join(second, '.env')), 'automatic setup did not run');
    console.log('✓ New Task uses the repo\'s .superset/config.json setup when present; branch names never collide (…-2)');
  }

  // + New Worktree runs the same setup; deleting a worktree runs the repo's teardown list first.
  {
    const fsx = require('fs');
    fsx.writeFileSync(path.join(main.path, '.superset/config.json'), JSON.stringify({
      setup: ['cp "$SUPERSET_ROOT_PATH/.env" .env.from-script'],
      teardown: ['touch "$AGENT_DECK_ROOT_PATH/torn-down-$(basename "$PWD")"'],
    }));
    const made = await vscode.commands.executeCommand('agentDeck.newWorktree', { wtPath: main.path, branch: 'plain-new' });
    assert.ok(made && deck.findWorktree(made)?.branch === 'plain-new');
    await until(() => fsx.existsSync(path.join(made, '.env.from-script')), '+ worktree setup ran', 15000);
    console.log('✓ + New Worktree runs the repo setup script too');
    const res = await ext.exports.runTeardown(deck.findWorktree(made).repo, made);
    assert.deepStrictEqual(res, { ran: 1, error: undefined });
    assert.ok(fsx.existsSync(path.join(main.path, `torn-down-${path.basename(made)}`)));
    console.log('✓ teardown list runs inside the worktree (with the root path set) before it is deleted');
  }

  // Clean up: only worktrees whose PR is merged/closed AND that have nothing beyond it.
  {
    const fsx = require('fs');
    const cpx = require('child_process');
    const mk = (b) => {
      const p = path.join(path.dirname(main.path), `cleanup-${b}`);
      cpx.execSync(`git worktree add -q -b ${b} ${p} HEAD`, { cwd: main.path });
      return p;
    };
    const pDone = mk('done-x'), pDirty = mk('dirty-y'), pAhead = mk('ahead-z');
    fsx.writeFileSync(path.join(pDirty, 'wip.txt'), 'unsaved work');
    cpx.execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m local-only', { cwd: pAhead });
    await deck.refresh();
    const head = (p) => cpx.execSync('git rev-parse HEAD', { cwd: p }).toString().trim();
    const base = cpx.execSync('git rev-parse HEAD~1', { cwd: pAhead }).toString().trim();
    deck.refreshPrs = async () => {}; // no GitHub here: feed PR states directly
    deck.prs.set(pDone, [{ number: 7, url: 'u7', title: 'x', state: 'MERGED', isDraft: false, own: true, headRefOid: head(pDone) }]);
    deck.prs.set(pDirty, [{ number: 8, url: 'u8', title: 'y', state: 'MERGED', isDraft: false, own: true, headRefOid: head(pDirty) }]);
    deck.prs.set(pAhead, [{ number: 9, url: 'u9', title: 'z', state: 'MERGED', isDraft: false, own: true, headRefOid: base }]);
    await deck.poll();
    const m = (p) => model().worktrees.find((w) => w.path === p);
    assert.ok(m(pDone).cleanable && m(pDone).meta.some((x) => x.text === 'merged · clean up'));
    assert.ok(!m(pDirty).cleanable, 'dirty worktree must not be offered');
    assert.ok(!m(pAhead).cleanable, 'worktree with commits beyond the PR must not be offered');
    console.log('✓ "merged · clean up" shows only on the finished worktree (not on one with uncommitted work or extra commits)');
    const res = await vscode.commands.executeCommand('agentDeck.cleanUpWorktrees', { all: true });
    assert.deepStrictEqual(res.map((r) => path.basename(r.path)), ['cleanup-done-x']);
    assert.ok(!fsx.existsSync(pDone) && fsx.existsSync(pDirty) && fsx.existsSync(pAhead));
    assert.ok(!cpx.execSync('git branch --list done-x', { cwd: main.path }).toString().trim(), 'merged branch deleted');
    console.log('✓ Clean Up removed only the finished worktree and its merged branch; the others are untouched');
  }

  // Colours: every worktree gets its own, stable, and matching its terminal tab.
  {
    const ids = deck.worktrees.map((w) => deck.colorOf(w.path));
    assert.strictEqual(new Set(ids).size, ids.length, `all different: ${ids.join(', ')}`);
    const before = new Map(deck.worktrees.map((w) => [w.path, deck.colorOf(w.path)]));
    await deck.refresh();
    assert.ok(deck.worktrees.every((w) => deck.colorOf(w.path) === before.get(w.path)), 'stable across refreshes');
    const withTerm = deck.worktrees.find((w) => deck.terminalsOf(w.path).some((t) => t.creationOptions?.color));
    const tabColor = deck.terminalsOf(withTerm.path).find((t) => t.creationOptions?.color).creationOptions.color.id;
    assert.strictEqual(tabColor, deck.colorOf(withTerm.path));
    console.log(`✓ ${ids.length} worktrees, ${new Set(ids).size} different colours, stable, tab colour = card colour`);
  }

  // After a reload: terminals that existed before it are offered for refresh (idle/empty ones only),
  // and refreshing swaps them for fresh ones in the same worktree.
  {
    const oldIdle = vscode.window.createTerminal({ name: 'restored-shell', cwd: a.path });
    const oldBusy = vscode.window.createTerminal({ name: 'restored-busy', cwd: a.path });
    oldBusy.sendText('sleep 60');
    const before = new Set([oldIdle, oldBusy]);
    let stale;
    // Wait until the idle shell has settled and the other one is actually running its command.
    await until(async () => {
      stale = await ext.exports.staleAfterReload(before);
      return stale.some((p) => p.t === oldIdle) && !stale.some((p) => p.t === oldBusy);
    }, 'restored shells settled', 20000);
    assert.ok(stale.every((p) => before.has(p.t)), 'only terminals from before the reload');
    ext.exports.applyRefresh(stale);
    await until(() => oldIdle.exitStatus !== undefined || !vscode.window.terminals.includes(oldIdle), 'old one closed');
    assert.ok(vscode.window.terminals.includes(oldBusy));
    assert.ok(vscode.window.terminals.some((t) => t !== oldIdle && deck.worktreeOf(t)?.path === a.path && t.creationOptions?.color));
    console.log('✓ after-reload refresh: only idle terminals from before the reload are replaced (fresh, coloured); busy one kept');
    oldBusy.dispose();
  }

  // Sort by attention: a worktree whose agent needs you jumps to the top; default order otherwise.
  {
    const target = deck.worktrees.find((w) => !w.isMain && deck.terminalsOf(w.path).length);
    const orig = deck.attentionOf.bind(deck);
    deck.attentionOf = (t) => (deck.worktreeOf(t)?.path === target.path ? { kind: 'waiting', since: 1, reason: 'permission prompt' } : undefined);
    const cfg = vscode.workspace.getConfiguration('agentDeck');
    await cfg.update('sortBy', 'default', vscode.ConfigurationTarget.Global);
    const def = model().worktrees.map((w) => w.path);
    assert.ok(def[0] !== target.path);
    await vscode.commands.executeCommand('agentDeck.sortByAttention');
    await until(() => model().worktrees[0].path === target.path, 'needs-you worktree on top');
    const rest = model().worktrees.slice(1).map((w) => w.path);
    assert.deepStrictEqual(rest.filter((p) => !deck.worktrees.some((w) => w.path === p && deck.terminalsOf(p).some((t) => deck.isWorking(t) || deck.isIdleAgent(t)))),
      def.filter((p) => p !== target.path && !deck.worktrees.some((w) => w.path === p && deck.terminalsOf(p).some((t) => deck.isWorking(t) || deck.isIdleAgent(t)))));
    console.log(`✓ sort by attention: "${path.basename(target.path)}" (needs you) moves from #${def.indexOf(target.path) + 1} to #1; the rest keep their order`);
    await vscode.commands.executeCommand('agentDeck.sortDefault');
    await until(() => model().worktrees.map((w) => w.path).join() === def.join(), 'back to default order');
    console.log('✓ toggling back restores the default order');
    deck.attentionOf = orig;
  }

  // macOS notification: the app is built with its own name/id/icon, and its click link focuses the terminal.
  {
    const cpx = require('child_process');
    const app = process.env.AGENT_DECK_NOTIFIER_APP;
    assert.ok(await ext.exports.ensureNotifier(), 'notifier built');
    const plist = path.join(app, 'Contents/Info.plist');
    const read = (k) => cpx.execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${k}`, plist]).toString().trim();
    assert.strictEqual(read('CFBundleIdentifier'), 'dev.agentdeck.notifier');
    assert.strictEqual(read('CFBundleDisplayName'), 'Agent Deck');
    cpx.execFileSync('/usr/bin/codesign', ['--verify', '--deep', app]);
    const hasLogo = require('fs').readdirSync(path.join(require('os').homedir(), '.cursor/extensions')).some((n) => n.startsWith('anthropic.claude-code-'));
    console.log(`✓ notifier app built as "Agent Deck" (${read('CFBundleIdentifier')}), signature valid${hasLogo ? ', Claude icon' : ''}`);
    const target = vscode.window.terminals.find((t) => deck.worktreeOf(t));
    const other = vscode.window.terminals.find((t) => t !== target);
    other.show();
    await until(() => vscode.window.activeTerminal === other, 'focus elsewhere');
    await ext.exports.focusByPid(await target.processId);
    await until(() => vscode.window.activeTerminal === target, 'notification click focused the terminal');
    assert.strictEqual(deck.active, deck.worktreeOf(target).path);
    console.log('✓ clicking the notification (focus?pid=…) jumps to that agent\'s terminal and worktree');
  }

  // In-editor alert disappears on its own; its status bar item jumps to the agent.
  {
    const target = vscode.window.terminals.find((t) => deck.worktreeOf(t));
    const other = vscode.window.terminals.find((t) => t !== target);
    other.show();
    ext.exports.transientNotice(target, 'test — agent finished', 2);
    assert.match(ext.exports.alertItem.text, /agent finished/);
    await vscode.commands.executeCommand(ext.exports.alertItem.command.command, ...ext.exports.alertItem.command.arguments);
    await until(() => vscode.window.activeTerminal === target, 'status item jumped');
    ext.exports.transientNotice(target, 'test — agent finished', 1);
    await sleep(1600);
    console.log('✓ alert: countdown notice + status bar item that jumps to the agent, gone after its time');
  }
  console.log('ALL PASSED');
};
