# pear — PR Control Center · Architecture & Decisions

> A terminal-centric control center for reviewing pull requests. Each PR is a tab;
> each tab is a real terminal running the CLI/agent of your choice; review buttons
> fire slash-command macros into that terminal; review artifacts are persisted to an
> app data directory for later recall by `repo#PRNUMBER`.

Status: **MVP / baseline**. Date locked: 2026-06-03.

---

## 1. Locked decisions (MVP)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | First frontend | **Tauri GUI** (web UI + Rust core) | Lets us use the `/frontend-design` skill for a genuinely beautiful native macOS app; `xterm.js` gives real terminals; ships as a universal (arm64 + x86_64) `.app`. |
| D2 | Core boundary | **In-process core crate** (`pear-core`) with a **protocol-shaped, serializable command/event API** | Most performant + stable: no IPC hop for terminal byte streams. The serializable `Command`/`Event` protocol keeps the boundary clean so a daemon transport can wrap it later **without touching the core** (see Branch B1). |
| D3 | PR data source | **GitHub REST API + token** | Token sourced automatically from `gh auth token` (fallback: `PEAR_GITHUB_TOKEN` / `GITHUB_TOKEN` env). Rich metadata (state, reviewers, checks) without manual token setup. |
| D4 | Agent CLI per tab | **Configurable per tab** | Each tab picks its CLI (`claude`, `codex`, `aider`, plain `$SHELL`). The review buttons map to a per-CLI macro table so "post review" means the right thing for each tool. |

### Terminal strategy
We do **not** embed `libghostty` (no stable public embedding API as of 2026). Instead:
- The core spawns a real **PTY** (`portable-pty`) per tab and pipes raw bytes both ways.
- The **frontend** (`xterm.js`) does VT parsing + rendering, themed to look ghostty-like
  (font, ligatures, palette). This keeps `pear-core` free of a VT/grid model for the MVP.
- A native/TUI frontend (Branch A1/A2) would add a grid model via `alacritty_terminal`.

---

## 2. Component map

```
┌──────────────────────────────────────────────────────────────┐
│ apps/desktop  (Tauri app)                                      │
│  ┌───────────────────────────┐   Tauri IPC    ┌──────────────┐ │
│  │ Web UI (frontend-design)  │ <───commands──> │ src-tauri    │ │
│  │  • tab bar / history list │ <───events────  │ (thin shim)  │ │
│  │  • xterm.js terminals     │                 │  wires core  │ │
│  │  • review buttons         │                 │  to IPC      │ │
│  └───────────────────────────┘                 └──────┬───────┘ │
└────────────────────────────────────────────────────────┼───────┘
                                                          │ direct calls
                                              ┌───────────▼───────────┐
                                              │ crates/pear-core      │
                                              │  Engine               │
                                              │  • protocol (Cmd/Evt) │
                                              │  • session (PTY)      │
                                              │  • github (REST)      │
                                              │  • store (artifacts)  │
                                              │  • dispatch (macros)  │
                                              └───────────────────────┘
```

### `pear-core` modules
- **`protocol`** — `Command` (in) and `Event` (out) enums + shared value types
  (`TabId`, `PrRef`, `CliKind`, `ReviewButton`…). This *is* the public contract.
- **`engine`** — owns tabs + sessions; `handle(Command)` mutates state and emits `Event`s
  over an `UnboundedSender<Event>` supplied at construction.
- **`session`** — one PTY child per tab; a reader thread forwards output as `Event::Output`.
- **`github`** — REST client (fetch PR, list PRs) using a bearer token.
- **`store`** — app data dir layout + review-artifact persistence + history index.
- **`dispatch`** — maps a `ReviewButton` + `CliKind` to the literal keystrokes/slash
  command written into the tab's PTY.

---

## 3. Data & directory layout

App data dir (resolved via `directories`, overridable with `PEAR_DATA_DIR`):

```
<data-dir>/pear/
  history.json                      # index of reviewed PRs (repo#NUMBER, last opened, title)
  reviews/
    <owner>__<repo>/
      <pr-number>/
        review-<timestamp>.md       # artifacts agents write / buttons capture
        meta.json
```

This dir is a future git repo (D3 follow-up): tracking reviews over time. Not wired in MVP.

---

## 4. Slash-command / button model

`ReviewButton` variants (MVP): `PostReview`, `CopyContent`, `ReduceToKeyPoints`.
`dispatch::keystrokes(button, cli)` returns the bytes to write into the PTY, e.g.:

| Button | `claude` | `codex` | `aider` | `shell` |
|--------|----------|---------|---------|---------|
| PostReview | `/pr-post-review\n` | `/review post\n` | `/run gh pr review\n` | (no-op + toast) |
| CopyContent | `/pr-copy\n` | … | … | … |
| ReduceToKeyPoints | `/pr-key-points\n` | … | … | … |

The `/pr-*` skills ship in `skills/` and are symlinked into the working repo on tab attach.

---

## 5. Branch paths (return points if we dislike the MVP outcome)

These are deliberately preserved alternatives. Each is a clean pivot, not a rewrite,
because the `pear-core` protocol boundary (D2) is frontend-agnostic.

| ID | Branch | What changes | What's reused |
|----|--------|--------------|----------------|
| **A1** | TUI frontend (`ratatui` + `tui-term`) | New frontend binary; add `alacritty_terminal` grid model behind a `core` feature | All of `pear-core` (engine, github, store, dispatch) |
| **A2** | Native Rust GUI (`egui`/`iced`) | New frontend; lose `/frontend-design` (no HTML/CSS) | All of `pear-core` |
| **A3** | Dual frontend (TUI + Tauri on one core) | Ship both A1 and D1 | Proves the common-backend thesis hardest |
| **B1** | Daemon boundary | Wrap `Engine` in a process exposing the **same** `Command`/`Event` protocol over a unix socket (JSON-RPC + a byte-stream channel) | The protocol enums are already serde-serializable — transport is additive |
| **B2** | Embed real ghostty | Revisit if `libghostty` ships a stable embedding API | Frontend swap only |

Recommended retry order if MVP underwhelms: **A1** (fastest, proves portability) → **B1**.

---

## 6. Phase plan

- **Phase 1 (this commit):** workspace + `pear-core` (compiling + tested) + Tauri shell wired to core.
- **Phase 2:** `/frontend-design` pass on the web UI (tab bar, history, terminals, buttons).
- **Phase 3:** ship `/pr-*` review skills; symlink-on-attach.
- **Phase 4:** reviews-as-git-repo; universal `.app` bundle + notarization notes.
