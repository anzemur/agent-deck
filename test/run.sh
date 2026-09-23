#!/bin/bash
# Builds a scratch repo with worktrees and runs test/suite.js inside VS Code.
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
git init -q -b main "$TMP/repo"
git -C "$TMP/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$TMP/repo" worktree add -q -b feat-a "$TMP/wt/a"
git -C "$TMP/repo" worktree add -q -b feat-b "$TMP/wt/b"
"${CODE_BIN:-code}" --new-window --disable-extensions --user-data-dir "$TMP/ud" \
  --extensionDevelopmentPath="$HERE" --extensionTestsPath="$HERE/test/suite.js" "$TMP/repo"
