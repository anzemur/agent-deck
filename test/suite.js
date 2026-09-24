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

  // Tree structure: worktree -> [Terminals, Changes]
  {
    const { tree } = ext.exports;
    const secs = (await tree.getChildren(tree.wtNode(a))).map((n) => tree.getTreeItem(n).label);
    assert.deepStrictEqual(secs, ['Terminals', 'Changes']);
    const terms = await tree.getChildren(tree.sectionNode(a, 'terminals'));
    assert.deepStrictEqual(terms.map((n) => tree.getTreeItem(n).label), ['feat-a']);
    console.log('✓ worktree dropdown = [Terminals (feat-a), Changes]');
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

  const { tree } = ext.exports;
  const kids = await tree.getChildren(tree.sectionNode(a, 'changes'));
  const groups = kids.filter((k) => k.kind === 'group').map((k) => tree.getTreeItem(k).label);
  assert.deepStrictEqual(groups, ['Staged', 'Unstaged']);
  console.log('✓ feat-a › Changes shows "Staged" and "Unstaged" groups');

  // Stage README via the command, then check the index diff content provider.
  const readmeNode = (await tree.getChildren(kids.find((k) => k.group === 'unstaged'))).find((n) => n.change.path === 'README.md');
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
    const { tree } = ext.exports;
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
    let item = tree.getTreeItem(tree.wtNode(b));
    assert.strictEqual(item.label, 'Fix login redirect');
    assert.match(item.description, /feat-b/);
    assert.match(item.description, /#42/);
    console.log(`✓ worktree feat-b labelled "${item.label}" (${item.description})`);
    await sleep(20);
    fsx.appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: 'Login bug' }) + '\n');
    await deck.poll();
    item = tree.getTreeItem(tree.wtNode(b));
    assert.strictEqual(item.label, 'Login bug');
    console.log('✓ /rename title overrides the AI title');
    assert.strictEqual(tree.getTreeItem(tree.wtNode(a)).label, 'feat-a');
    console.log('✓ worktree without a session keeps its branch name');
  }
  console.log('ALL PASSED');
};
