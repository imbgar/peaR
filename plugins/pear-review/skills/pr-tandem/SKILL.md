---
name: pr-tandem
description: Review a GROUP of related PRs as a group — map how they relate (stacked bases, shared files, cross-PR contracts), review each in that context, surface cross-PR findings, and recommend a merge order. Optionally run the group through the two-engine co-review pipeline. Use when several PRs land together and reviewing them in isolation would miss interactions.
argument-hint: "<owner/repo#N ...> [claude=light|standard|complex] [co] [first=claude|codex] [codex=light|standard|complex]"
allowed-tools: [Bash, Read, Write, Grep, Glob, Task]
metadata:
  category: code-review
  requires:
    cli: [gh, git]
---

# Tandem review (a group of related PRs, reviewed AS a group)

The point of this skill is the **relationships**: a set of PRs that land together can
each look fine alone and still be wrong together (A changes an API, B still calls the
old shape; both touch the same hunk; B silently depends on A merging first). Review
each PR **in the context of the others**, not in isolation.

## Arguments

Parse `$ARGUMENTS`:
- Every `owner/repo#N` (or bare `#N` / `N`, resolved against the current repo) → the PR group.
- `claude=<depth>` → review depth (default `standard`; rubric identical to `/pr-coreview`).
- `co` → run the group through the **two-engine pipeline**: after your review, codex
  independently reviews the same snapshot AND cross-examines your findings, then you
  distill a merged verdict — exactly the `/pr-coreview` phases, but over the whole group.
  `first=codex` swaps who does the first pass; `codex=<depth>` sets codex's depth.

## Phase 0 — snapshot the whole group (fetch ONCE)

```bash
W=/tmp/pr-tandem-<first#>-<last#> && mkdir -p $W
# per PR i (use -R owner/repo — the group may span repos):
gh pr view <N> -R <owner/repo> --json number,title,body,author,baseRefName,headRefName,files,url > $W/pr-<N>.json
gh pr diff <N> -R <owner/repo> > $W/diff-<N>.patch
```

Never diff local branches — the snapshots are the single source of truth for every
reviewer (and let codex run in a no-network sandbox).

## Phase 1 — relationship map (do this BEFORE reviewing any code)

Build `$W/relations.json` from the metadata + diffs:

- **Stacking**: PR B's `baseRefName` == PR A's `headRefName` → B is stacked on A
  (its diff may include A's changes — review only B's own delta).
- **Shared files**: files touched by more than one PR — flag overlapping hunks
  (merge-conflict or last-writer-wins risk).
- **Contracts**: symbols/types/endpoints/schemas one PR *defines or changes* and
  another PR *uses* (grep each diff for identifiers exported/renamed in the others).
- **Intent links**: shared issue refs / "depends on #N" in bodies.
- **Merge order**: a DAG from the above → recommended landing order, and which PRs
  are safe to land independently.

## Phase 2 — review (each PR in group context)

Review every PR at the configured depth with the standard rubric (correctness,
security, edge cases, tests), **plus the cross-PR lens** — findings get a `pr` field
and cross-PR findings get `"pr": "cross"`:

- contract breaks (A changed it, B still assumes the old shape)
- overlapping-hunk conflicts and order-dependent behavior
- duplicated/contradictory logic across PRs
- combined behavior: would the system be correct with ALL of them merged? With only
  a prefix of the merge order?

Findings schema = `/pr-coreview`'s, with the added `pr` field.

## Phase 3 — only when `co`: codex cross-exam of the group

Run the `/pr-coreview` phase-2 machinery over the group snapshot: hand codex the
workdir (all `pr-*.json`, `diff-*.patch`, `relations.json`) **and your findings**:

```bash
codex exec --sandbox read-only --cd $W --skip-git-repo-check \
  --output-last-message $W/findings-codex.json \
  "<group review + cross-examination prompt: independent findings (same schema) AND an agree|dispute|uncertain verdict with evidence for EACH provided finding — including the cross-PR ones>"
```

(`first=codex` inverts phases 2/3: codex reviews first over the snapshot, you
cross-examine.) Then distill exactly as `/pr-coreview` phase 3: ✅ confirmed /
⚔️ disputed-adjudicated / ➕ single-engine-spot-checked.

## Output (markdown, no preamble)

1. **Group map** — a compact picture of how the PRs relate: stacking/dependency DAG,
   shared files, contracts crossed. One line per relationship.
2. **Recommended merge order** — with the reason each edge exists; call out PRs that
   are NOT safe to land alone.
3. **Cross-PR findings** — the interactions; these lead, they're why tandem exists.
4. **Per-PR findings** — `[severity] title — path:line` per PR, depth-ranked.
5. **Verdict** — per PR: `ready / needs-work / blocked (by …)`; then one line for the
   group as a whole.

Keep `$W` around (the user may hit Save Review).
