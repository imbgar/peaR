---
name: pr-review-schema
description: The canonical review.pear.v1 schema reference — how any review flow emits the structured review.json that peaR renders (review map, deck, findings). Read this when asked to write a structured review document, emit review.json, or validate one.
allowed-tools: [Bash, Read, Write]
metadata:
  category: code-review
---

# review.pear.v1 — the structured review document

Every peaR review flow ends by writing the SAME review it just printed as prose into a
structured JSON document. peaR validates it (`ReviewDoc::parse`) and renders it as the
review map / finding deck. One shape, every engine, every time.

## Where to write it

The per-PR drop-box (exact path matters — peaR reads exactly this):

```bash
D=/tmp/pear-reviews/<owner>__<repo>__<pr#> && mkdir -p "$D"   # __ between all three
# write $D/review.json
```

## Validate before you finish (required)

peaR exposes its validator through the `PEAR_BIN` env var in every peaR-spawned
session. After writing the file, run:

```bash
"$PEAR_BIN" validate "$D/review.json"
```

Fix every reported error and re-run until it prints `VALID`. Warnings are advisory —
fix them when cheap. If `PEAR_BIN` is unset (not inside peaR), ensure the JSON at
least parses and follows the rules below.

## The shape (emit ONLY valid JSON — comments here are explanatory)

```jsonc
{
  "schema": "review.pear.v1",
  "mode": "single",                            // "group" for multi-PR (tandem) reviews
  "engines": [ { "name": "claude", "role": "reviewer", "depth": "standard" } ],
  "subjects": [ { "ref": "owner/repo#N", "title": "<PR title>", "head_sha": "<sha>" } ],

  "understanding": {                           // the narrative — REQUIRED, renders first
    "purpose": "what this PR is and why, one paragraph",
    "walkthrough": [ { "id": "W1", "title": "…", "body": "…",
                       "risk": "low|medium|high",
                       "anchors": [ { "subject": 0, "path": "…", "line": 123 } ] } ],
    "verified": [ "what you actually did: read every hunk, ran X, traced Y" ]
  },

  "findings": [ {
    "id": "F1",
    "type": "bug|test|api|docs|clarity|style|error_handling|design|compat|perf|security|observability|question|praise",
    "severity": "blocker|fix_before_merge|follow_up|take_or_leave",
    "confidence": 0.9,                         // 0..1, your honest calibration
    "rule": { "id": "kebab-case-reusable-rule", "why": "why this matters in general — the teachable part" },
    "title": "one line",
    "evidence": "why it's wrong + the failing case",
    "anchor": { "subject": 0, "path": "…", "line": 123 },
    "suggestion": { "patch": "committable replacement hunk (omit if none)" },
    "engines": { "claude": "found|agree|dispute|uncertain" },
    "status": "open"
  } ],

  "verdict": {
    "ledger": { "blocker": 0, "fix_before_merge": 1, "follow_up": 2, "take_or_leave": 3 },
    "per_subject": [ { "subject": 0, "state": "ready|ready_with_nits|needs_work|blocked",
                       "blocked_by": [ "F1" ],
                       "scope": "what this pass did NOT cover",
                       "justification": "one sentence" } ]
  }
}
```

## Rules the validator enforces (and the reasoning behind them)

- `understanding.purpose` must be non-empty — a review is a narrative of understanding
  with findings attached, not a bare findings list.
- **severity = the required response behavior**, nothing else:
  `blocker` (fix now) · `fix_before_merge` (before merge, no follow-up allowed) ·
  `follow_up` (schedule it; merge may proceed) · `take_or_leave` (reviewer's offer).
  Keep `confidence` and walkthrough `risk` separate — never flatten them into severity.
- `question` and `praise` are first-class finding types (severity always
  `take_or_leave`) — real reviewers ask and appreciate; so do we.
- Every `subject`/`anchor` index points into `subjects` (0-based); out-of-range anchors
  are hard errors.
- `blocked_by` must be non-empty when `state` is `needs_work`/`blocked`, and must name
  real finding ids — negative verdicts require technical justification.
- Prefer a real `rule.why` on every defect finding — the reusable "why this matters"
  is what makes a finding teachable rather than a one-off nit.
- Expect ~75% of honest findings to be evolvability (tests/docs/clarity/style/design)
  and ~25% functional — don't pad with noise to look thorough.

## After it validates

Tell the user: `review.json written — open the Insight panel ⊞ to load the review map`.
