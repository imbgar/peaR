# pear — Roadmap & Feature Scoping

Living doc. Captures what shipped, what's explicitly deferred (with scope), and the
creative design work for the bigger features. Pairs with [ARCHITECTURE.md](./ARCHITECTURE.md)
(locked decisions) and [docs/memory/](./memory/MEMORY.md) (session memory).

---

## Shipped — iteration v1.1 (2026-06-03)

| Feature | Notes |
|---------|-------|
| **Paste GitHub URL** to open a PR | `parsePrRef` accepts `owner/repo#123`, `owner/repo/123`, and full `github.com/owner/repo/pull/123` URLs. |
| **Review launch tiers** — Light / Standard / Complex | Toolbar buttons + core `StartReview{tier}`. Claude: light→`/code-review low`, standard→`/code-review high`, **complex→a *local* diverse multi-agent review** (free; "deeply review this PR across a diverse set of agents"). |
| **Ultra 💸 button** — paid cloud review | Distinct, gold money-marked `ReviewButton::Ultra` → `/code-review ultra` (uploads repo to Claude on the web). Kept OUT of the tiers so cost is never implicit. |
| **PR repo resolution + checkout** (was DF-6) | Opening a PR resolves the local repo (`~/repos`, `~/projects`, … or `PEAR_REPO_DIRS`), launches the CLI there, and `gh pr checkout`s the branch so reviews run against the PR. Clear notice if the repo isn't found locally. |
| **Resumable sessions per PR** | Each PR tracks a list of Claude session-ids (`--session-id` on launch, `--resume` to return). History is now **PR-centric with a session tree**: hover a PR for floating **⟲ Resume** / **+ New** icons; click it for a **floating session popover** (newest-first, click any to resume that exact chat). Default open = resume most recent; New = fresh session. Fixes "can't get back to where I launched it." |
| **Auto-review on open** toggle + tier dropdown | Sidebar; persisted in `localStorage`. On opening a PR tab it queues the selected tier (2.2s delay for CLI boot). |
| **Distill** button | `/pr-distill` — only merge-blocking items. |
| **Walk-thru** button | `/pr-walkthru` — interactive, finding-by-finding tour. |
| **Explain** button | `/pr-explain` — purpose + changes + gaps (intentionally *light*, not a full review). |
| **Video** button | `/pr-video` — dispatches a narrated MP4 via the `video-explainer` skill. |
| **Copy content** | Frontend clipboard + editable preview modal (v1.0). |
| **Insight panel** (collapsible) | Renders markdown / diff / note. `LoadPanel` loads the latest **saved** review. The *live* push path (the "bus") is designed below, not yet wired. |

Skills shipped under `skills/commands/`: `pr-post-review`, `pr-copy`, `pr-distill`,
`pr-walkthru`, `pr-explain`, `pr-video`.

---

## Deferred — with scope (return points)

### DF-1 · Default-org search (`web-app#323`)
Let a bare `repo#NUMBER` resolve against a configured default org/owner.
- **Scope:** add `default_owner` to a small config (`<data-dir>/config.json`); in `parsePrRef`,
  if no `owner/` present, prefix the default. Add a sidebar setting. ~1 evening.
- **Why deferred:** needs a config surface; trivial but not load-bearing for MVP.

### DF-2 · "Launch resolution agent" button
A button that spawns an agent specialized in *remediating* the review's findings (not just
reporting them).
- **Scope:** a new `ReviewButton::Resolve` → `/pr-resolve` skill that reads the latest saved
  review (or distill), then implements fixes on a worktree branch, running tests. Best as an
  **isolated worktree** session (we already have the isolation primitive in mind). Surfaces a
  diff back into the Insight panel via the bus.
- **Why deferred:** it's an *acting* agent (mutates code) — wants the worktree + bus wired first.

### DF-3 · Live Insight Bus (panel push from the agent) ⭐ the creative core
The Insight panel today only renders saved reviews. The vision: **the agent pushes structured
data to the panel live** — diffs, notes, checklists, "go look here" focus events.

**Why not PTY-sentinel parsing:** the agent CLIs (Claude Code, etc.) are full-screen TUIs that
*repaint* the screen; scraping a sentinel token out of that byte stream is unreliable. So the
bus is **file-drop**, not stream-scraping.

**Design — `pear` helper + watched drop dir:**
- When the core spawns a tab's PTY, it sets `PEAR_BUS_DIR=<data-dir>/bus/<tabkey>/` in the env.
- We ship a tiny `pear` shim on `PATH`. The agent calls it; it writes a JSON file to `PEAR_BUS_DIR`.
- The core **watches** that dir (`notify` crate) and emits `Event::Panel` on each new file.
- Commands (the "bus type command logic" you asked to ideate on):
  | Command | Panel render |
  |---------|--------------|
  | `pear diff <path>` | colored diff card |
  | `pear note "…"` | pinned note |
  | `pear md <file.md>` | rendered markdown |
  | `pear checklist <file>` | interactive review checklist (tick items) |
  | `pear focus path:line` | highlights + scrolls; click → types `goto` in the terminal |
  | `pear map` | changed-files heatmap (size = churn) |
  | `pear step "title" "body"` | a walk-thru card; `pear step --next` advances |
- **Two-way:** panel interactions send `Command`s back (click a finding → inject `path:line`
  into the terminal; tick a checklist item → persist). This is where the panel becomes a
  *control surface*, not a viewer.
- **Walk-thru, upgraded:** the `/pr-walkthru` skill drives `pear step` cards in the panel while
  narrating in the terminal — synced guided tour.
- **Scope:** `notify` watcher + `pear` shim binary + 3–4 render kinds. ~2–3 focused days.

### DF-4 · Walk-thru video (already dispatchable, mark experimental)
`/pr-video` exists and wraps `video-explainer`. Deferred = *hardening*: it's heavy (Kokoro TTS +
MP4 render), runtime is minutes, and output size is large. Keep behind an "experimental" label
until DF-3's structured script (purpose/changes/findings) feeds it cleanly.

### DF-5 · Team review exchange (live messaging) ⭐ creative, deferred until further progress
A multi-user PR-review coordination surface — its own window.
- **States:** `Requested → Incoming → In Review → Changes Requested → Approved`, plus
  `Passed (no time today)`.
- **Priority lanes:** `EARLY` (early-stage feedback), `FINAL`, `URGENT`, `INCIDENT`. (Creative
  room: an `INCIDENT` lane could auto-pin + notify; `EARLY` could be lower-fidelity review.)
- **Transport options (pick later):** (a) GitHub as source of truth (review-requests = assigned
  PRs, statuses = PR review states) — least infra; (b) a shared Postgres/Supabase relay for the
  custom states/priorities GitHub can't model; (c) the **daemon branch path (B1)** — the pear
  core daemon already speaks a serializable protocol, so it can fan review-queue state to multiple
  clients. (c) is the natural home.
- **Why deferred:** needs the daemon boundary (B1) and an identity/transport decision. Big.

### DF-6 · PR checkout / working-dir ✅ SHIPPED (v1.2)
`workdir::resolve` finds the PR's local repo and the engine `gh pr checkout`s the branch on open.
Remaining polish (deferred): make auto-checkout a toggle (some users won't want their branch
switched), and offer an **isolated git worktree** per PR so reviews never disturb the working
checkout. Also: clone-if-missing for repos not found locally.

### DF-7 · Per-tier model routing
Tiers map to `/code-review` effort, not explicit models. Wanted: light→sonnet, standard→opus,
complex→multi-agent. Cleanest when tabs spawn with `claude --model …`; revisit once tier intent
is proven.

---

## Long-term memory structure (researched from your own projects)

Your `ephemeral-controller` already proves the pattern that beats the 24 KB `MEMORY.md` cliff:
an **index file + prefixed topic files**, each small and cross-linked. Adopted for pear under
[`docs/memory/`](./memory/MEMORY.md):

- `MEMORY.md` — ≤150-line index: status, resume block, `[[wikilinks]]` to topics. Never embed.
- `session_<date>.md` — per-session recap (did / next / blockers).
- `decision_<topic>.md` — choices that don't belong in the locked ARCHITECTURE.md.
- `reference_<topic>.md` — reusable gotchas (PTY timing, TUI-bus rationale…).
- `feedback_<topic>.md` — refinements from review/testing.

Guardrails: index stays an index; topic files 40–150 lines (~5–8 KB); link, don't inline; after a
substantial session write a `session_<date>.md` and update the resume block. This distributes
~250 KB across 30–40 files with no single-file ceiling.

---

## Design revisions
- `docs/design-snapshots/phase1-v1/` — frozen pre-`/frontend-design` UI (the "why it looks this
  way" snapshot), kept for A/B against the design-pass revision.
