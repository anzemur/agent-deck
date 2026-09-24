# Agent Deck

Worktrees and terminals, linked, for running many coding agents at once in VS Code / Cursor.

- **Worktrees panel** (activity bar → Agent Deck): every git worktree of the repo(s) in the window, as roomy two-line cards (task title + branch) with your Seti file icons.
- Worktrees are named after **what the agent is doing**: the Claude session title (your `/rename` wins), with the branch and PR number next to it. Set `agentDeck.worktreeLabel` to `branch` to turn this off.
- The **active worktree** is drawn in its own colour with a ● badge, and its name is shown in the view header.
- **Click a worktree** → it opens (and every other worktree closes) and its linked terminal comes to the front (nothing is created; use *New terminal*).
- Each worktree's dropdown shows **Staged Changes** and **Changes** first (click a file for a side-by-side diff, `+`/`−` to stage/unstage a file or a whole group), then its **Terminals**, then **Pull Requests**: the branch's own PR (via `gh`) plus any PR linked in its Claude session, with state (open / draft / merged / closed). Click to open in the browser.
- **Focus a terminal** (tab, panel, `⌘⌥↑/↓`) → the worktree view selects its worktree and the **Files** view switches to that worktree's files.
- Terminals are linked by what's running in them: a `claude -w` session whose shell sits in the main checkout still shows under the worktree the agent is working in.
- **Survives restarts:** every running Claude session is remembered per window. Quit Cursor and on the next start each one is `claude --resume`d in its worktree (reusing the dead restored terminals). Turn off with `agentDeck.resumeOnStartup`.
- Terminals and worktrees share a colour. Spinner = agent is working (thinking / running tools); ✳ = agent is open but idle, waiting for you; ▶ = a plain command (dev server, tests) is running.
- `+` creates a branch + worktree (in `<repo>.worktrees/` next to the repo) and opens a terminal in it. Right-click to delete.

## Settings

| Setting | Default | |
|---|---|---|
| `agentDeck.terminalLocation` | `panel` | `editor` gives each agent a full-size tab |
| `agentDeck.startupCommand` | `claude` | run in the first terminal of a worktree (extra terminals are plain shells); empty = never |
| `agentDeck.showOnStartup` | `true` | open the Agent Deck sidebar when the window opens or reloads |
| `agentDeck.worktreeLabel` | `title` | `title` = Claude session title, `branch` = branch name |
| `agentDeck.worktreeParentDir` | `""` | where new worktrees go |

## Keys

`⌘⇧F` search only the active worktree (off: `agentDeck.scopeSearch`) · `⌘⌥W` quick switch · `⌘⌥↓` / `⌘⌥↑` next / previous worktree

## Develop

`./test/run.sh` runs the integration suite in VS Code against a scratch repo.
`npx @vscode/vsce package` builds the `.vsix`.
