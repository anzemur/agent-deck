# Third-party assets

- `seti.woff`, `seti-map.json` — Seti file icons, from the `theme-seti` extension bundled with
  Visual Studio Code (MIT, © Microsoft Corporation; original Seti UI © Jesse Weed, MIT).
  Regenerate with `node scripts/build-icons.js`.
- `codicon.ttf` — @vscode/codicons 0.0.36 (font: CC BY 4.0, © Microsoft Corporation).
- `terminal-notifier-3.1.0.zip` — terminal-notifier 3.1.0 by Julien Blanchard (MIT), used to show macOS notifications. At runtime it's copied to `~/.agent-deck/Agent Deck.app`, renamed, and given the Claude logo from the locally installed Claude Code extension as its icon.
