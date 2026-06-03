# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- DevSecOps CI: gitleaks (secrets), cargo-audit + OSV-Scanner (deps), CodeQL (SAST),
  OSSF Scorecard (supply chain); documented the Socket.dev GitHub App.
- Homebrew cask distribution + auto-update workflow (`brew install --cask imbgar/tap/peaR`).

### Changed
- A PR's repo now **auto-clones** into a managed `repos/` dir when it isn't found locally,
  so pear no longer depends on the user having repos in a specific place.

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

[Unreleased]: https://github.com/imbgar/pear/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/imbgar/pear/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/imbgar/pear/releases/tag/v0.1.0
