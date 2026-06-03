---
name: pr-distill
description: Distill the review of the current PR down to only the most critical, merge-impacting items. Use when you want just the blockers, not a full review.
argument-hint: "[optional max items, default 5]"
allowed-tools: [Bash, Read, Grep, Glob]
metadata:
  category: code-review
  requires:
    cli: [gh, git]
---

# Distill to blockers

Distill the review of the current PR down to **only what materially affects the merge**.

- Use the review in this session if one exists; otherwise do a fast targeted pass over
  `gh pr diff` for correctness, security, and data-loss risks only.
- Keep the top N (default 5, or the count in $ARGUMENTS), ranked by impact.
- Each item: a severity tag `[blocker] / [should-fix]`, a one-line description, and
  `path:line`. Drop anything cosmetic or stylistic entirely.
- If nothing is blocking, say so in one line and stop.

Output only the ranked list — no preamble.
