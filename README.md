# Agent Deck

Worktrees and terminals, linked, for running many coding agents at once in VS Code / Cursor.

- **Worktrees view** (activity bar → Agent Deck): every git worktree of every repo in the window.
- Worktrees are named after **what the agent is doing**: the Claude session title (your `/rename` wins), with the branch and PR number next to it. Set `agentDeck.worktreeLabel` to `branch` to turn this off.
- **Click a worktree** → the dropdown opens/closes and its linked terminal comes to the front (nothing is created; use *New terminal*).
- Each worktree's dropdown has **Terminals** (linked terminals, click to focus) and **Changes** (Staged / Unstaged files — click for a side-by-side diff, `+`/`−` to stage/unstage a file or the whole group).
- **Focus a terminal** (tab, panel, `⌘⌥↑/↓`) → the worktree view selects its worktree and the **Files** view switches to that worktree's files.
- Terminals are linked by what's running in them: a `claude -w` session whose shell sits in the main checkout still shows under the worktree the agent is working in.
- Terminals and worktrees share a colour. Spinner = agent is working (thinking / running tools); ✳ = agent is open but idle, waiting for you; ▶ = a plain command (dev server, tests) is running.
- `+` creates a branch + worktree (in `<repo>.worktrees/` next to the repo) and opens a terminal in it. Right-click to delete.

## Settings

| Setting | Default | |
|---|---|---|
| `agentDeck.terminalLocation` | `panel` | `editor` gives each agent a full-size tab |
| `agentDeck.startupCommand` | `claude` | run in the first terminal of a worktree (extra terminals are plain shells); empty = never |
| `agentDeck.worktreeLabel` | `title` | `title` = Claude session title, `branch` = branch name |
| `agentDeck.worktreeParentDir` | `""` | where new worktrees go |

## Keys

`⌘⌥W` quick switch · `⌘⌥↓` / `⌘⌥↑` next / previous worktree

## Develop

`./test/run.sh` runs the integration suite in VS Code against a scratch repo.
`npx @vscode/vsce package` builds the `.vsix`.
