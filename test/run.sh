#!/bin/bash
# Builds a scratch repo with worktrees and runs test/suite.js inside VS Code.
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
git init -q -b main "$TMP/repo"
echo hello > "$TMP/repo/README.md"
git -C "$TMP/repo" add README.md
git -C "$TMP/repo" -c user.email=t@t -c user.name=t commit -q -m init
# fake agent binary named `claude` (copies of system binaries get killed by code signing)
mkdir -p "$TMP/bin"
# `claude N` sleeps N seconds (idle agent); `claude N busy` spins the CPU for N seconds (working agent).
cat > "$TMP/bin/claude.c" <<'C'
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
int main(int c, char **v) {
  int n = c > 1 ? atoi(v[1]) : 60;
  if (c > 2 && !strcmp(v[2], "busy")) { time_t end = time(0) + n; volatile unsigned long x = 0; while (time(0) < end) x++; return 0; }
  sleep(n); return 0;
}
C
cc "$TMP/bin/claude.c" -o "$TMP/bin/claude"
export AGENT_DECK_TEST_BIN="$TMP/bin"
export AGENT_DECK_CLAUDE_PROJECTS="$TMP/claude-projects"
export AGENT_DECK_CLAUDE_SESSIONS="$TMP/claude-sessions"
export AGENT_DECK_SEARCH_LINKS="$TMP/search-links"
export AGENT_DECK_NOTIFIER_APP="$TMP/Agent Deck.app"
mkdir -p "$AGENT_DECK_CLAUDE_SESSIONS"
git -C "$TMP/repo" worktree add -q -b feat-a "$TMP/wt/a"
git -C "$TMP/repo" worktree add -q -b feat-b "$TMP/wt/b"
mkdir -p "$TMP/ud/User"
cat > "$TMP/ud/User/settings.json" <<JSON
{"security.workspace.trust.enabled": false, "terminal.integrated.defaultProfile.osx": "zsh",
 "agentDeck.startupCommand": "$TMP/bin/claude 120"}
JSON
"${CODE_BIN:-code}" --new-window --disable-extensions --user-data-dir "$TMP/ud" \
  --extensionDevelopmentPath="$HERE" --extensionTestsPath="$HERE/test/suite.js" "$TMP/repo"
