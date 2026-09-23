# Agent Deck

Worktrees and terminals, linked, for running many coding agents at once in VS Code / Cursor.

- **Worktrees view** (activity bar → Agent Deck): every git worktree of every repo in the window, plus any repo you pin with *Add Repository*.
- **Click a worktree** → its terminal comes to the front (one is created, named after the branch, if it doesn't exist yet).
- **Focus a terminal** (tab, panel, `⌘⌥↑/↓`) → the worktree view selects its worktree and the **Files** view switches to that worktree's files.
- Terminals and worktrees share a colour; a spinner shows while a command (e.g. `claude`) is running in it.
- `+` creates a branch + worktree (in `<repo>.worktrees/` next to the repo) and opens a terminal in it. Right-click to delete.

## Settings

| Setting | Default | |
|---|---|---|
| `agentDeck.terminalLocation` | `panel` | `editor` gives each agent a full-size tab |
| `agentDeck.startupCommand` | `""` | typed into each new worktree terminal, e.g. `claude` |
| `agentDeck.worktreeParentDir` | `""` | where new worktrees go |

## Keys

`⌘⌥W` quick switch · `⌘⌥↓` / `⌘⌥↑` next / previous worktree

## Develop

`./test/run.sh` runs the integration suite in VS Code against a scratch repo.
`npx @vscode/vsce package` builds the `.vsix`.
