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

## Frontend (`apps/desktop/src`)

- **No prettier.** eslint only — there is no prettier config, and `prettier --write` reflows
  whole files (a 5857-line diff once). Match the existing style by hand.
- **Popovers in thin bars need `position: fixed`.** `#statusbar` is `overflow: hidden`, so any
  upward `position: absolute` popover is clipped to invisible regardless of z-index. Anchor it
  with `position: fixed` + a JS positioner (see `positionNotifPanel` / `positionThemeMenu`).
  This has bitten the notification bell *and* the theme menu.
- **Translucent + fullscreen.** Surfaces composite over the native `HudWindow` vibrancy, which
  has no backdrop to sample in macOS fullscreen and washes out to grey. Lay an opaque dark
  backdrop on `body.fullscreen` and let the surfaces fake the glass over it.
- **Config/settings gear buttons use `.cfg-gear`.** Every settings/config gear (Teams scope,
  etc.) gets the house style — a yellow (accent) outline, no fill or glow — via the shared
  `.cfg-gear` class. Don't restyle gears ad hoc; add `.cfg-gear` so they stay consistent.

## Backend (`crates/pear-core`)

- **`graphql_partial`, not `graphql`, for multi-repo queries.** GitHub returns a top-level
  `errors` array *alongside* valid `data` for nodes in OAuth/SAML-restricted orgs; the strict
  `graphql` helper discards the whole response on any error. (Root cause of the Teams view
  showing no PRs.)

## Dev workflow

- `cd apps/desktop && npm run tauri dev`. Frontend edits hot-reload (Vite HMR); Rust edits
  trigger a rebuild + relaunch. The review-map theater window is `map.html`. The browser
  preview at `localhost:1420` renders but `invoke` throws (no Tauri backend).
- Isolated feature work: `git worktree` off main, symlink `node_modules`, per-worktree cargo
  target (slow first build).

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
