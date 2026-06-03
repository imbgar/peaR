# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] — 2026-06-03

### Added
- DevSecOps CI: gitleaks (secrets), cargo-audit + OSV-Scanner (deps), CodeQL (SAST),
  OSSF Scorecard (supply chain); documented the Socket.dev GitHub App.
- Homebrew cask distribution + auto-update workflow (`brew install --cask imbgar/tap/peaR`).
- Repackaged the PR-review skills as an installable **Claude Code + Codex plugin**
  (`plugins/pear-review`) with `.claude-plugin`/`.codex-plugin` manifests, per-skill
  `SKILL.md` (rich frontmatter), and a `.claude-plugin/marketplace.json`.
- The pear logo now appears in the app sidebar; README hero is an animated GIF flipping
  between the Phosphor and Instrument themes.
- **Frontend linting** — ESLint (typescript-eslint) + a CI lint step; clippy now also
  covers the `desktop` (Tauri) crate.

### Security
- Documented OSV-Scanner ignores (`osv-scanner.toml`) for 18 transitive advisories that
  don't reach pear's macOS target — Tauri's Linux GTK stack (never compiled), plus
  unmaintained build-time deps with no fixed version. Each entry has a reason.

### Changed
- A PR's repo now **auto-clones** into a managed `repos/` dir when it isn't found locally,
  so pear no longer depends on the user having repos in a specific place.

### Fixed
- **Auto-review on open no longer fires when resuming a session** (or opening from history) —
  it only triggers on a fresh launch from the Open box. Resuming a PR now restores the chat
  instead of injecting a new `/code-review`.

## [0.1.1] — 2026-06-03

### Added
- App icon — the pear logo across the full icon set (macOS bundle no longer ships
  the default Tauri art).

### Changed
- Product name is now **peaR** (Launchpad / window title / titles); prose stays "pear".

### Fixed
- The Open box always starts a fresh Claude session, so opening the same PR twice no
  longer points two tabs at one session id. The engine also forks to a new session if a
  resume would target a session already live in another tab.

## [0.1.0] — 2026-06-03

First public release. A functional, terminal-native PR review control center.

### Added
- **Rust core (`pear-core`)** with a serializable `Command`/`Event` protocol: engine,
  PTY-backed terminal sessions, GitHub REST client, review store, slash dispatch, and
  repo resolution.
- **Tauri + xterm.js desktop app** (macOS) — PRs as tabs, each a real terminal.
- **Per-tab CLI selection** — `claude`, `codex`, `aider`, or `$SHELL`.
- **PR repo resolution + checkout** — finds the PR's local repo and `gh pr checkout`s it.
- **Review launch tiers** — Light / Standard / Complex (local diverse multi-agent), plus a
  distinct **Ultra 💸** button for the paid cloud review.
- **Resumable Claude sessions** — each PR tracks a session tree; resume the exact chat or
  start a new one from history. Floating Resume/New icons + a session popover.
- **Insight panel** — renders saved reviews (markdown / diff / note).
- **Copy content** — system-clipboard capture with an editable preview modal.
- **Two themes** — Phosphor (amber CRT) and Instrument (refined industrial), live toggle.
- **Claude permission selector** — `auto` (default) · `acceptEdits` · `dontAsk` ·
  `bypassPermissions` · `default` · `plan`.
- **Clear / Restore history** — backed up to disk, restorable across runs.
- **Shipped review skills** — `pr-post-review`, `pr-copy`, `pr-distill`, `pr-walkthru`,
  `pr-explain`, `pr-video`.

[Unreleased]: https://github.com/imbgar/peaR/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/imbgar/peaR/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/imbgar/peaR/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/imbgar/peaR/releases/tag/v0.1.0
