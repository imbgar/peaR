# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.5] — 2026-06-04

### Fixed
- **Reviews now target the actual PR.** The review macros said "review this PR" but never named
  it, so the agent reviewed whatever branch was checked out — diffing against a stale local base
  (often thousands of unrelated files) instead of the PR's real changes. pear now passes the PR
  through to every review: tiers/ultra use `/code-review <effort> <n>`, and the complex/aider
  prompts name `owner/repo#n` and pin the agent to `gh pr diff <n>`. (#27)
- **Self-exited tabs are reaped.** When a terminal process exited on its own, the engine kept a
  stale tab entry, which made resume spuriously start a *new* session instead of resuming. (#26)

## [0.1.4] — 2026-06-04

### Fixed
- **The app now finds your CLI when launched from Finder/Dock.** A macOS GUI launch
  inherits only the bare system PATH and never sources your shell profile, so
  `claude`/`codex`/`aider` (in `~/.local/bin`, `/opt/homebrew/bin`, npm-global, …) couldn't
  be spawned — *"No viable candidates found in PATH"*. pear now reconstructs the login-shell
  PATH, resolves the CLI to an absolute path, and injects that PATH into each terminal so
  tools used inside a session (`gh`, `git`, `node`) resolve too. (#24)

## [0.1.3] — 2026-06-04

### Added
- **One-time, consent-gated install of the `/pr-*` review skills.** On first launch, if the
  skills aren't in `~/.claude/skills`, pear offers (via a modal) to install them — so the
  **Post review / Distill / Walk-thru / Explain / Video** action buttons work out of the box.
  The review *tiers* already worked, since they use Claude's built-in `/code-review`. (#15)

### Fixed
- **History sidebar updates live on open** instead of only after an app restart — a freshly
  opened PR appears in the list immediately (it was always recorded on disk; the list just
  wasn't re-rendering). (#14)
- **`pr-video` is now optional.** It checks for the video-explainer runtime first and prints
  setup guidance (linking a public gist of the engine) instead of failing when the deps are
  missing. (#16)

### Changed
- Dependency bumps (#13): `portable-pty` 0.8→0.9, `directories` 5→6, and **`ureq` 2→3**
  (the GitHub client was migrated to ureq 3.x — no behavior change).

### Internal
- `scripts/check.sh` mirrors the CI matrix locally (rustfmt, core + desktop clippy, core tests,
  eslint, frontend build) with an opt-in `core.hooksPath` pre-push hook. (#17)

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
