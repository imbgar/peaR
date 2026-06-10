---
name: pr-coreview
description: Two-engine pipelined co-review of a PR — one engine reviews into structured findings, the other independently cross-examines every finding (via the codex CLI), then the results are distilled into a single merged verdict. Use when two independent AI reviews beat one.
argument-hint: "[pr#] [first=claude|codex] [claude=light|standard|complex] [codex=light|standard|complex]"
allowed-tools: [Bash, Read, Write, Grep, Glob, Task]
metadata:
  category: code-review
  requires:
    cli: [gh, git, codex]
---

# Co-review pipeline (claude ⇄ codex)

Run a **pipelined** two-engine review of the PR: reviewer **A** produces structured
findings, reviewer **B** independently reviews AND adversarially cross-examines A's
findings, then you distill one merged verdict. This is NOT two parallel reviews —
each stage consumes the previous stage's structured output.

## Arguments

Parse `$ARGUMENTS` (all optional, any order):
- A bare number → the PR number. Otherwise detect it from the checked-out branch via `gh pr view`.
- `first=claude` (default) or `first=codex` → which engine is reviewer A.
- `claude=<depth>` / `codex=<depth>` → that engine's review depth (default `standard`).

Depth meaning (same rubric for both engines):
- `light` — only high-confidence, merge-impacting issues; fast pass.
- `standard` — thorough: correctness, security, edge cases, tests.
- `complex` — exhaustive, multiple angles (correctness, security, performance, tests, design); surface anything subtle. For claude at `complex`, fan the first pass out across parallel subagents with distinct lenses, then merge before emitting findings.

## Phase 0 — shared inputs (fetch ONCE)

Create a workdir and snapshot the PR so **both engines review identical inputs** (and
codex can run in a no-network sandbox):

```bash
W=/tmp/pr-coreview-<pr#> && mkdir -p $W
gh pr view <pr#> --json number,title,body,author,baseRefName,headRefName,files > $W/pr.json
gh pr diff <pr#> > $W/diff.patch
```

Never diff the local branch against its base — it may be stale. `diff.patch` is the
single source of truth for both reviewers.

## Findings schema (both engines emit this)

```json
{
  "reviewer": "claude|codex",
  "findings": [
    { "id": "A1", "path": "src/file.rs", "line": 123,
      "severity": "blocker|major|minor|nit",
      "title": "one line", "detail": "why it's wrong + the failing case",
      "confidence": 0.9 }
  ]
}
```

## Phase 1 — reviewer A: first-pass review → `$W/findings-a.json`

- **If A = claude (you):** review `$W/diff.patch` (with `$W/pr.json` for intent) at the
  configured depth. Write the findings JSON to `$W/findings-a.json`.
- **If A = codex:** run it headless against the same files:

```bash
codex exec --sandbox read-only --cd $W --skip-git-repo-check \
  --output-last-message $W/findings-a.json \
  "Review the pull request whose diff is in diff.patch (intent in pr.json) at <depth> depth: <depth rubric>. Your FINAL message must be ONLY a JSON object matching this schema, no prose, no code fences: <schema>"
```

After it returns, validate `$W/findings-a.json` parses as JSON (strip code fences if
codex wrapped it anyway). If codex emitted nothing, re-run once with the instruction
"output the JSON object only".

## Phase 2 — reviewer B: independent review + cross-examination → `$W/findings-b.json`

Reviewer B gets the **same inputs plus A's findings** and must do two jobs:
1. **Independent pass** — its own findings (same schema, ids `B1…`), formed by reading
   the diff, not by paraphrasing A.
2. **Cross-examination** — for EACH of A's findings, an adversarial verdict:

```json
{ "reviewer": "...", "findings": [ ... ],
  "verdicts": [ { "id": "A1", "verdict": "agree|dispute|uncertain",
                  "reason": "evidence from the diff, not vibes" } ] }
```

- **If B = codex:** same `codex exec` shape as above, prompt carrying the contents of
  `findings-a.json`, output to `$W/findings-b.json`.
- **If B = claude (you):** genuinely re-derive from `diff.patch` — do NOT rubber-stamp
  A. Default to `dispute` when the evidence is thin. Write `$W/findings-b.json`.

## Phase 3 — distill: one merged verdict (you, always)

Merge the two files into a single review, in this order:

1. **✅ Confirmed** — A findings B agrees with, plus B findings you verify against the
   diff. Ranked by severity. These are the high-confidence items.
2. **⚔️ Disputed** — A said / B said, then YOUR adjudication with a line-level reason
   (read the actual hunk; one of them is wrong).
3. **➕ Single-engine** — findings only one engine raised; spot-check each against the
   diff and keep only the ones that hold, marked with which engine found it.

End with a 3-line verdict: merge-readiness (`ready / needs-work / blocked`), the single
most important item, and a one-line note on where the engines disagreed most.
Each item: `[severity] title — path:line (A·B agree | A only | B only)`.

Output the merged review as markdown — no preamble. Keep `$W` around (the user may
hit Save Review).
