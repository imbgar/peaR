# Design snapshot — Phase 1 v1 (pre-/frontend-design)

Captured 2026-06-03, before the `/frontend-design` refactor, so we can A/B the two revisions.

## What this revision is

A hand-built, functional dark UI. The goal here was **correct structure and behavior**,
not visual ambition — get the tab/terminal/review model working and legible, then let a
dedicated design pass elevate it.

## Why it looks the way it does

- **Ghostty-adjacent palette.** Near-black `#08090c`/`#0b0c10` panels, a single green accent
  (`#7ee787`) echoing the terminal cursor, mono type for anything code-adjacent (tabs, refs,
  inputs). The intent was for the chrome to feel like an extension of the terminal, not a
  web app wrapped around one.
- **Three-zone layout.** Left sidebar (open/history) · top tab bar · main terminal · status
  bar. A deliberately conventional IDE/terminal shell so the novelty lives in behavior, not
  navigation.
- **Per-CLI color dots** on tabs (claude=green, codex=blue, aider=violet, shell=amber) — a
  cheap way to scan which agent runs where.
- **Restraint over polish.** Flat borders, one accent, no gradients/shadows beyond the modal.
  This is the floor the design pass builds on, and the baseline we compare against.

## Known rough edges (intentionally left for the design pass)
- Toolbar becomes button-crowded as review actions grow (tiers, distill, walk-thru, …).
- The Insight panel (added in v1.x) has a placeholder empty state.
- No motion/transitions, no empty-state art, no density toggle.
- Typography scale is functional, not considered.

The files alongside this note (`index.html`, `styles.css`, `main.ts`, `protocol.ts`) are the
frozen copies of this revision.
