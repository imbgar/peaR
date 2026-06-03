# pear — Session & Design Memory (index)

> Index only. Keep this ≤150 lines. Link to topic files with `[[name]]`; never inline them.
> Convention (from `ephemeral-controller`): `session_<date>`, `decision_<topic>`,
> `reference_<topic>`, `feedback_<topic>`. Topic files stay 40–150 lines (~5–8 KB) to avoid
> the single-file size cliff.

## Status — 2026-06-03
- **Phase:** 1, iteration **v1.1**. App compiles, core tested (9 tests), boots clean.
- **Stack:** Rust workspace — `crates/pear-core` (in-process engine) + `apps/desktop` (Tauri + xterm.js).
- **Resume from:** [[session_2026-06-03]]
- **Next up:** `/frontend-design` refactor (snapshot saved for A/B), then DF-3 live Insight Bus.
- **Blockers:** none. Known gap: PR checkout/cwd (ROADMAP DF-6).

## Quick links
- [ARCHITECTURE.md](../ARCHITECTURE.md) — locked decisions D1–D4 + branch paths A1/A2/A3/B1/B2.
- [ROADMAP.md](../ROADMAP.md) — shipped + deferred (DF-1…DF-7) + memory plan.
- [[session_2026-06-03]] — this session's recap.

## Map (fill in as topics are written)
- `design_*` — feature/module deep dives (e.g. the Insight Bus once built).
- `reference_*` — reusable gotchas (PTY/TUI, Tauri IPC, xterm fit timing).
- `decision_*` — choices outside ARCHITECTURE.md (tier→command mapping, copy-as-frontend-action).
- `feedback_*` — refinements from review/testing.

## Glossary
- **pear-core** — in-process Rust crate; the only stateful surface, behind a serializable
  `Command`/`Event` protocol (enables the daemon branch path B1 without a rewrite).
- **Engine** — owns tabs + PTY sessions + GitHub + store + dispatch.
- **Insight Bus** — planned file-drop channel (`PEAR_BUS_DIR` + `pear` shim) for the agent to
  push diffs/notes/cards to the panel. NOT PTY-sentinel scraping (agents are TUIs). See ROADMAP DF-3.
- **Review tier** — Light/Standard/Complex → `/code-review low|high|ultra`.
