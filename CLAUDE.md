# CLAUDE.md — peaR

peaR is a Tauri 2 desktop app for AI-assisted PR review: a Vite + vanilla-TS frontend
(`apps/desktop/src`) over a Rust core (`crates/pear-core`) behind a serde `Command`/`Event`
protocol. Public repo: **imbgar/peaR**.

## Releases

**The GitHub release body MUST be that version's actual `CHANGELOG.md` section — never a bare
"see CHANGELOG" pointer.** The release page is the first thing a user sees; the notes have to
stand on their own. (We drifted here: every release v0.1.1–v0.1.15 shipped the same one-line
stub while the real notes sat in the repo. Fixed in `release.yml`; do not regress it.)

- **Source of truth — `CHANGELOG.md`** ([Keep a Changelog] format). Every release is a
  `## [x.y.z] — YYYY-MM-DD` section: a one-paragraph plain-English summary of the release,
  then `### Added / ### Changed / ### Fixed / ### Dependencies` with **bold** feature names,
  a user-facing description of each change, and its `(#PR)` reference.
- **Cutting a release** (via a `release/vX.Y.Z` PR): promote `## [Unreleased]` →
  `## [x.y.z] — DATE` and write that section *before* tagging. Bump the four version files
  (`Cargo.toml`, `apps/desktop/package.json`, `apps/desktop/src-tauri/Cargo.toml`,
  `apps/desktop/src-tauri/tauri.conf.json`) and regen `Cargo.lock` (`cargo check`).
- **Publishing** — push an **annotated** tag (`git tag -a vX.Y.Z -m "…"`; lightweight tags are
  rejected with "no tag message"). `release.yml` extracts the matching CHANGELOG section into
  the release body and **fails the build if that section is missing**, so a stub can't ship.
  Never patch a release body back to a pointer — fix the CHANGELOG and re-tag.

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
