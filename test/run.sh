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
printf '#include <unistd.h>\n#include <stdlib.h>\nint main(int c, char **v) { sleep(c > 1 ? atoi(v[1]) : 60); return 0; }\n' | cc -x c - -o "$TMP/bin/claude"
export AGENT_DECK_TEST_BIN="$TMP/bin"
git -C "$TMP/repo" worktree add -q -b feat-a "$TMP/wt/a"
git -C "$TMP/repo" worktree add -q -b feat-b "$TMP/wt/b"
mkdir -p "$TMP/ud/User"
echo '{"security.workspace.trust.enabled": false, "terminal.integrated.defaultProfile.osx": "zsh"}' > "$TMP/ud/User/settings.json"
"${CODE_BIN:-code}" --new-window --disable-extensions --user-data-dir "$TMP/ud" \
  --extensionDevelopmentPath="$HERE" --extensionTestsPath="$HERE/test/suite.js" "$TMP/repo"
