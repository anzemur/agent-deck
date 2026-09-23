// Runs inside the VS Code extension host: `npm test`.
const vscode = require('vscode');
const assert = require('assert');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

exports.run = async function () {
  const ext = vscode.extensions.getExtension('anzemur.agent-deck');
  const { deck } = await ext.activate();
  await until(() => deck.worktrees.length === 3, '3 worktrees');
  const names = deck.worktrees.map((w) => w.branch).sort();
  assert.deepStrictEqual(names, ['feat-a', 'feat-b', 'main']);
  console.log('✓ discovers worktrees:', names.join(', '));

  const a = deck.worktrees.find((w) => w.branch === 'feat-a');
  const b = deck.worktrees.find((w) => w.branch === 'feat-b');

  // Click worktree A -> terminal A created, named, focused.
  await vscode.commands.executeCommand('agentDeck.selectWorktree', a.path);
  await until(() => vscode.window.activeTerminal?.name === 'feat-a', 'terminal feat-a active');
  assert.strictEqual(deck.active, a.path);
  console.log('✓ clicking worktree feat-a opens + focuses terminal "feat-a"');

  // Click worktree B -> terminal B.
  await vscode.commands.executeCommand('agentDeck.selectWorktree', b.path);
  await until(() => vscode.window.activeTerminal?.name === 'feat-b', 'terminal feat-b active');
  assert.strictEqual(deck.active, b.path);
  console.log('✓ clicking worktree feat-b switches terminal to "feat-b"');

  // Click worktree A again -> reuses existing terminal, no duplicate.
  await vscode.commands.executeCommand('agentDeck.selectWorktree', a.path);
  await until(() => vscode.window.activeTerminal?.name === 'feat-a', 'terminal feat-a active again');
  assert.strictEqual(vscode.window.terminals.filter((t) => t.name === 'feat-a').length, 1);
  console.log('✓ switching back reuses the existing terminal');

  // Focus terminal B directly (like clicking its tab) -> active worktree follows.
  vscode.window.terminals.find((t) => t.name === 'feat-b').show();
  await until(() => deck.active === b.path, 'deck follows terminal focus');
  console.log('✓ focusing terminal "feat-b" switches active worktree to feat-b');

  // Second terminal in same worktree gets a distinct name and is linked.
  await vscode.commands.executeCommand('agentDeck.newTerminal', b.path);
  await until(() => vscode.window.activeTerminal?.name === 'feat-b · 2', 'second terminal');
  assert.strictEqual(deck.terminalsOf(b.path).length, 2);
  console.log('✓ second terminal in feat-b named "feat-b · 2"');

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
  console.log('ALL PASSED');
};
