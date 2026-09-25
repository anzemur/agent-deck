# Agent Deck

Worktrees and terminals, linked, for running many coding agents at once in VS Code / Cursor.

- **Worktrees panel** (activity bar → Agent Deck): every git worktree of the repo(s) in the window, as roomy two-line cards (task title + branch) with your Seti file icons.
- Worktrees are named after **what the agent is doing**: the Claude session title (your `/rename` wins), with the branch and PR number next to it. Set `agentDeck.worktreeLabel` to `branch` to turn this off.
- The **active worktree** is drawn in its own colour with a ● badge, and its name is shown in the view header.
- **Click a worktree** → it opens (and every other worktree closes) and its linked terminal comes to the front (nothing is created; use *New terminal*).
- Each worktree's dropdown shows **Staged Changes** and **Changes** first (click a file for a side-by-side diff, `+`/`−` to stage/unstage a file or a whole group), then its **Terminals**, then **Pull Requests**: the branch's own PR (via `gh`) plus any PR linked in its Claude session, with state (open / draft / merged / closed). Click to open in the browser.
- **Focus a terminal** (tab, panel, `⌘⌥↑/↓`) → the worktree view selects its worktree and the **Files** view switches to that worktree's files.
- Terminals are linked by what's running in them: a `claude -w` session whose shell sits in the main checkout still shows under the worktree the agent is working in.
- **Needs you:** when an agent finishes, or stops for a permission prompt / question, in a terminal you're not looking at, its card gets an orange bell ("needs approval · 2m", "done · 4m"), the Agent Deck icon shows a count, and you get a notification (plus a macOS one with sound when Cursor isn't in front). `⌘⌥N` jumps to the agent that has waited longest. Settings: `agentDeck.notifications`, `agentDeck.macNotifications`.
- **Survives restarts:** every running Claude session is remembered per window. Quit Cursor and on the next start each one is `claude --resume`d in its worktree (reusing the dead restored terminals). Turn off with `agentDeck.resumeOnStartup`.
- **Refresh Terminals** (`…` menu on Worktrees, or the command palette): replaces old terminals with fresh ones: idle Claude sessions are `claude --resume`d, empty shells reopened, busy ones left alone. Clears the ⚠ "relaunch" markers (the Claude Code extension picks a new port every window load) and gives old terminals their worktree colour.
- Every worktree gets its own colour (16 distinct hues, handed out far-apart-first, kept for the worktree's lifetime), shared by its card and terminal tabs. Spinner = agent is working (thinking / running tools); ✳ = agent is open but idle, waiting for you; ▶ = a plain command (dev server, tests) is running.
- **New Task** (✨ on the Worktrees header, `⌘⌥T`): type what the agent should do. Agent Deck names a branch after it (following your repo's pattern, e.g. `anze/fix/flaky-login-redirect-test`), creates a worktree from the latest remote default branch, runs setup (your `.agent-deck/config.json` or `.superset/config.json` `setup` list, else copies ignored `.env*` files and runs `bun`/`pnpm`/`yarn`/`npm install`), and starts `claude "<task>"` in it. The card shows the task until Claude titles the session.
- **Clean up:** a worktree whose branch's PR is merged or closed, that sits exactly on the PR's commit with no uncommitted changes and nothing running, shows "merged · clean up" with a delete button on its card. **Clean Up Finished Worktrees…** (`…` menu) lists all of them and removes the ones you keep ticked (teardown, terminals, folder; merged branches deleted, closed ones kept).
- **Setup / teardown per repo:** `.agent-deck/config.json` (or Superset's `.superset/config.json`, same format) — `{ "setup": [...], "teardown": [...] }`. `setup` runs in every new worktree (New Task and `+`), `teardown` runs inside a worktree before it's deleted. Both see `$AGENT_DECK_ROOT_PATH` / `$SUPERSET_ROOT_PATH` = the main checkout.
- `+` creates a branch + worktree (in `<repo>.worktrees/` next to the repo) and opens a terminal in it. Right-click to delete.

## Settings

| Setting | Default | |
|---|---|---|
| `agentDeck.terminalLocation` | `panel` | `editor` gives each agent a full-size tab |
| `agentDeck.startupCommand` | `claude` | run in the first terminal of a worktree (extra terminals are plain shells); empty = never |
| `agentDeck.showOnStartup` | `true` | open the Agent Deck sidebar when the window opens or reloads |
| `agentDeck.worktreeLabel` | `title` | `title` = Claude session title, `branch` = branch name |
| `agentDeck.baseBranch` | `""` | where new branches start, always freshly fetched; empty = remote default branch (e.g. origin/staging) |
| `agentDeck.branchTemplate` | `""` | New Task branch name, e.g. `anze/{type}/{slug}`; empty = follow the repo's recent branches |
| `agentDeck.worktreeParentDir` | `""` | where new worktrees go |

## Keys

`⌘P` go to a file in the active worktree, recent files first (`>`, `@`, `#`, `:` hand over to the regular ⌘P; off: `agentDeck.scopeQuickOpen`) · `⌘⇧F` search only the active worktree (off: `agentDeck.scopeSearch`) · `⌘⌥T` new task · `⌘⌥N` go to the agent that needs you · `⌘⌥W` quick switch · `⌘⌥↓` / `⌘⌥↑` next / previous worktree

## Develop

`./test/run.sh` runs the integration suite in VS Code against a scratch repo.
`npx @vscode/vsce package` builds the `.vsix`.
