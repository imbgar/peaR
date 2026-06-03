---
description: Explain the PR's purpose and changes, then surface gaps (lightweight).
argument-hint: "[optional: 'deep' to also cross-check against an existing review]"
---

Give me an orientation to this PR — assume I haven't read it yet.

**1. Purpose** (2–3 sentences): what problem this PR solves and why, drawn from the PR
title/description (`gh pr view`) and the shape of the diff. State the intent, not a
file-by-file recap.

**2. The changes** (4–8 bullets): the meaningful moves, grouped by concern (not by file).
Lead each with the *what*, then the *where* (`path`).

**3. Gaps** (the point of this command): a fast, targeted check for what's MISSING or risky —
untested paths, unhandled edge cases, missing migrations/docs, breaking changes, surface
area that grew without guards. `path:line` where it applies.

Scope note: this is intentionally a *light* pass — do NOT run a full line-by-line review here
(that's what the review tiers are for). Identify gaps from the diff's structure and the PR's
stated intent. Only if $ARGUMENTS is "deep" should you also reconcile against the most recent
saved review and flag where the implementation diverges from its own description.
