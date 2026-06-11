# peaRview — the structured review framework

> One review shape, every engine, every time — so the human reading reviews in peaR
> trains on a single mental format instead of whatever prose each agent felt like
> emitting. A schema (`review.json`) every pear skill produces, and a rich Insight-panel
> widget that renders it as a consistent, animated map.

**Status: DRAFT v0 — speccing.** Decisions locked so far: widget = new Insight-panel
view; schema = unified single+group (a single-PR review is the N=1 case); learning
model v1 = *consistent visual grammar* only (walkthrough/pedagogy levels logged in
`context/memory/pearview-learning-ladder.md` for later).

## Evidence base

Grounded in two research passes (2026-06-10), not designer priors:

- **Empirical**: 25 merged multi-reviewer PRs across kubernetes, k8s-enhancements,
  rust, node, django, spark, react, pytorch, vscode — 502 inline comments classified.
- **Codified**: Google eng-practices, k8s OWNERS/lgtm-approve, Gerrit −2..+2, Apache
  voting, Rust review policy, LLVM, Conventional Comments, Netlify feedback ladders,
  SARIF 2.1.0, rdformat, Phabricator; Bacchelli & Bird '13, Mäntylä '09, Beller '14;
  CodeRabbit/Greptile/BugBot/Copilot output shapes.

The findings that *bind* the design:

1. **A review is a narrative of understanding with findings attached, ending in a
   graded, justified verdict** — not a set of findings. "Understanding the change" is
   the #1 unmet reviewer need; every machine format gets this wrong.
2. **~75% of real findings are evolvability** (readability/tests/docs/structure), 25%
   functional. AI tools invert this and get punished for noise.
3. **Conditional approval is the dominant real verdict** ("LGTM, nits don't block");
   CHANGES_REQUESTED appeared once in 224 sampled reviews. Negative verdicts require
   technical justification (Apache's veto rule).
4. **7–35% of review comments are legitimately discarded** → declined/deferred are
   first-class outcomes, not failures.
5. **Questions and praise are dominant real review activities** — first-class finding
   types, not decorations.
6. **Severity converges on a few levels whose meaning is the required response
   behavior** (fix-now / before-merge / follow-up / take-or-leave), with type,
   confidence, and blast-radius kept orthogonal — never flattened into one number.
7. **The committable patch is the highest-signal device** (19% of all real comments
   are ```suggestion``` blocks) — a finding's payload slot.
8. **Rule ≠ instance** (SARIF's one genius move): a reusable "why this matters" with a
   stable id makes findings *teachable*; the per-location message is just the instance.
9. **100% of technical findings are line-anchored**; PR-level commentary is a separate
   channel (process/logistics/meta).
10. **Verdicts can be scoped** (per-directory, per-role, per-pass: "haven't gone
    through the tests yet") and good approvals state **verification evidence** ("ran
    it, tested rollback").

## The schema (`review.pear.v1`)

Skills write `review.json` to the review workdir alongside their prose. pear-core
validates (serde, versioned) and emits it to the frontend; invalid/missing JSON
degrades gracefully to today's markdown panel.

```jsonc
{
  "schema": "review.pear.v1",
  "mode": "single | group",                  // group ⇒ relationships + merge_order
  "engines": [                               // who reviewed; ≥1
    { "name": "claude", "role": "reviewer", "depth": "standard" },
    { "name": "codex",  "role": "cross_examiner", "depth": "light" }
  ],
  "subjects": [                              // the PRs; single review = length 1
    { "ref": "owner/repo#42", "title": "…", "head_sha": "…" }
  ],

  // ── 1. UNDERSTANDING — the narrative spine. REQUIRED. Renders FIRST. ──
  "understanding": {
    "purpose": "what this change is and why, one paragraph",
    "walkthrough": [                         // dependency-ordered beats, 3-7
      { "id": "W1", "title": "the engine grows a FetchImage command",
        "body": "…", "risk": "low | medium | high",
        "anchors": [ { "subject": 0, "path": "src/engine.rs", "line": 469 } ] }
    ],
    "verified": [ "read every hunk", "traced the auth path", "ran cargo test" ]
  },

  // ── 2. RELATIONSHIPS — group glue (empty array for single) ──
  "relationships": [
    { "kind": "stacked | shared_file | contract | intent",
      "from": 0, "to": 1, "detail": "B's base is A's head — review only B's delta" }
  ],
  "merge_order": [ 0, 1 ],                   // group only; omit for single

  // ── 3. FINDINGS — hang off the spine ──
  "findings": [
    {
      "id": "F1",
      "type": "bug",                         // closed set, see taxonomy below
      "severity": "fix_before_merge",        // = required response behavior
      "confidence": 0.9,                     // 0..1, surfaced not hidden
      "rule": {                              // the teachable part (optional but urged)
        "id": "unvalidated-redirect-target",
        "why": "Auth-bearing requests that follow redirects can leak the token to an attacker-controlled host."
      },
      "title": "token follows redirects to arbitrary hosts",
      "evidence": "fetch_image() uses a default agent; user-attachments 302s to S3 today but the Location is unvalidated…",
      "anchor": { "subject": 0, "path": "src/github.rs", "line": 312 },
      "suggestion": { "patch": "…replacement hunk, committable…" },   // optional
      "engines": { "claude": "found", "codex": "agree" },             // attribution + cross-exam verdict: found|agree|dispute|uncertain
      "status": "open"                       // open|fixed|declined|deferred|obsolete (+ optional status_note)
    }
  ],

  // ── 4. VERDICT — graded, justified, scoped. Renders as the header. ──
  "verdict": {
    "ledger": { "blocker": 0, "fix_before_merge": 1, "follow_up": 2, "take_or_leave": 3, "question": 1, "praise": 2 },
    "per_subject": [
      { "subject": 0, "state": "ready | ready_with_nits | needs_work | blocked",
        "blocked_by": [ "F1" ],              // REQUIRED when needs_work/blocked (the Apache rule)
        "scope": "did not exercise the UI paths",   // optional honesty slot
        "justification": "one sentence of why" }
    ],
    "group": { "state": "needs_work", "summary": "3 lines max" }   // group only
  }
}
```

### Finding-type taxonomy (closed set, 12)

Collapsed from the 14 empirically-observed themes to stay near the ≤9–12 memorization
ceiling; expected frequencies vary by artifact type, so the widget never hard-codes
weights.

| type | covers (empirical theme) | observed freq |
|---|---|---|
| `bug` | correctness, invariants, races | 22% |
| `test` | missing/weak tests + assertions | 16% |
| `api` | exposed surface, contracts, validation semantics | 13% |
| `docs` | comments, user-facing wording, changelog/release notes | 13%+4% |
| `clarity` | naming, readability, comprehension | 11% |
| `style` | mechanical nits | 10% |
| `error_handling` | edge cases, failure paths | 7% |
| `design` | architecture, placement, reuse | 6% |
| `compat` | back-compat, migration, rollout/rollback | 5% |
| `perf` | performance, allocations, benchmarks | 4% |
| `security` | threat model, authz, injection | 2% (spiky) |
| `observability` | metrics, signals, debuggability | 2% |

Plus two **first-class kinds that are not defects**: `question` (comprehension probe —
how real reviewers phrase suspected bugs) and `praise` (Google codifies it; machines
omit it). They use the same finding envelope with `severity: "take_or_leave"` fixed.

### Severity = response behavior (4 levels)

| severity | the author must… | blocking |
|---|---|---|
| `blocker` | fix now; merge is wrong until then | ✅ |
| `fix_before_merge` | fix before merging, no follow-up allowed | ✅ |
| `follow_up` | schedule it (ticket/TODO) — merge may proceed | ❌ |
| `take_or_leave` | nothing; reviewer's offer | ❌ |

Blocking-ness is derivable (top two) — no separate bit to desync. `confidence` and
`risk` (walkthrough beats) stay orthogonal.

## The widget — Insight-panel review map

A new render mode of the existing Insight panel: when a `review.json` exists for the
tab, the map replaces the markdown dump (toggle back available; prose is never lost).

**The visual grammar — identical every review (this IS the v1 learning model):**

- **Header = verdict strip.** State glyph + the severity ledger (`0 ⛔ · 1 🔶 · 2 ⏳ ·
  3 💭`), justification on hover. Group mode: one strip per subject + the group strip.
- **Spine = the walkthrough**, rendered as a vertical dependency path down the center —
  beats are nodes sized by `risk`, in order. The reveal animation always walks the
  spine top-to-bottom (purpose → beats → verdict), ~1.2s, same every time.
- **Findings = satellites** docked to their beat (by anchor proximity) or to a
  floating "unanchored" rail. Encoding never varies: **hue = type** (12-color wheel,
  evolvability types in the warm-neutral band so the 75% doesn't scream), **size =
  severity**, **ring opacity = confidence**, **dashed ring = disputed by the
  cross-examiner**. `question` = outline-only node; `praise` = leaf-green dot.
- **Group mode**: subjects become clusters laid out by `merge_order` left→right,
  relationship edges drawn between clusters (stacked = solid arrow, contract = red
  dashed, shared_file = thin gray). The cross-PR findings dock to the edges themselves.
- **Interaction**: click a finding → detail card (evidence, rule's "why this matters"
  teaching block, suggestion patch with copy button, engine attribution); click an
  anchor → jumps the diff panel to `path:line` (existing machinery). Status changes
  (fixed/declined/deferred) write back to `review.json`.

**Rendering stack** (vanilla TS, no React in peaR):

- Layout: **d3-hierarchy / d3-force** for the spine+satellite composition; **elkjs**
  only if group-mode edge routing outgrows d3. Both render to SVG (small node counts —
  a review is tens of nodes, not thousands; no WebGL needed).
- Animation: **Motion One** (WAAPI-based, ~4kb) for the choreographed spine reveal +
  micro-interactions; respects the existing `reduce-motion` pref.
- The fractal angle: satellite dock positions follow a **golden-angle phyllotaxis**
  around each beat (sunflower packing) — organic, deterministic, and density-stable, so
  ten findings on one beat stay readable. Self-similar at the group level: subjects
  pack around the group verdict the same way findings pack around beats.

## Plumbing

1. **Skills** (`/pr-coreview`, `/pr-tandem`, tier reviews via a shared
   `review-schema.md` reference embedded in each SKILL.md): final phase writes
   `review.json` (schema above) into the workdir AND prints the prose as today.
2. **pear-core**: `ReviewDoc` serde types (the contract, versioned); a watcher or an
   explicit `LoadReviewDoc { tab }` command reads + validates the workdir's
   `review.json`; emits `Event::ReviewDoc { tab, doc }`. Parse failure → `Notice` +
   prose fallback. Store the doc under the PR's `reviews/` slug for history.
3. **Frontend**: `reviewmap.ts` renders the widget into the Insight panel;
   `panel` event handling gains the doc case. Diff-jump reuses `jumpToThread`-style
   anchoring.

## Build order (proposed)

1. **Schema crate-side**: `review_doc.rs` types + validation + tests (golden JSON).
2. **Skill emission**: `/pr-coreview` writes `review.json`; verify end-to-end on a real
   PR (terminal prose unchanged).
3. **Widget v1**: single-PR map (header/spine/satellites/detail card), Motion One
   reveal, diff-jump.
4. **Group mode**: clusters + relationship edges (tandem).
5. **Write-back**: finding status lifecycle from the widget.
6. Then revisit the learning ladder (walkthrough mode, pedagogy) — see memory note.

## Resolved spec decisions (2026-06-10)

- **Taxonomy: keep all 12 types** — but the type→display mapping (color wheel, legend,
  grouping) lives in ONE frontend table so collapsing to 10 later (`style`→`clarity`,
  `observability`→`design`) is a display-layer remap, not a schema change. The schema
  never changes; old docs stay valid.
- **In-widget question answering ships in v1**: a `question` finding's detail card gets
  a reply box; the reply is typed into the tab's agent terminal (existing PTY input
  machinery), prefixed with the finding's anchor for context.
- **Review history: keep every revision.** Docs are tiny JSON; store as
  `reviews/<slug>/<pr#>/review-<timestamp>.json` with a `review.json` symlink/copy to
  the latest. UI shows only the latest by default (history behind a small ⌚ affordance
  — hidden noise, cheap disk).
- **Engine disagreement: dashed ring first.** If that reads poorly in practice, a
  dedicated "disputed" rail is the planned fallback (toggle, not redesign).
