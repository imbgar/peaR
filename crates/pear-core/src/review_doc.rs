//! `review.pear.v1` — the structured review document (the peaRview schema).
//!
//! This is THE contract of the structured-review framework (docs/PEARVIEW.md): every
//! review skill emits a `review.json` in this shape, pear-core validates it here, and
//! the Insight-panel review map renders it. A single-PR review is the `subjects.len()
//! == 1` degenerate case of a group review — one schema for tier / co-review / tandem.
//!
//! Design rules baked in (see the spec's evidence base):
//! - the narrative `understanding` block is the ROOT, findings hang off it;
//! - severity is the *required response behavior*, blocking-ness derivable;
//! - `question` / `praise` are first-class finding types (fixed at `take_or_leave`);
//! - rule ≠ instance: the reusable `rule.why` is what makes a finding teachable;
//! - declined / deferred are legitimate finding outcomes, not failures;
//! - verdicts are graded, justified (blocked ⇒ `blocked_by` non-empty) and scoped.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The exact `schema` discriminator a v1 document must carry.
pub const SCHEMA_V1: &str = "review.pear.v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewDoc {
    /// Must equal [`SCHEMA_V1`].
    pub schema: String,
    pub mode: ReviewMode,
    /// Who reviewed (≥1). Order is presentation order.
    #[serde(default)]
    pub engines: Vec<EngineDecl>,
    /// The PRs under review; a single-PR review has exactly one.
    pub subjects: Vec<Subject>,
    /// The narrative spine — REQUIRED, renders first.
    pub understanding: Understanding,
    /// Group glue; empty for single-PR reviews.
    #[serde(default)]
    pub relationships: Vec<Relationship>,
    /// Recommended landing order (subject indices); group mode only.
    #[serde(default)]
    pub merge_order: Vec<usize>,
    #[serde(default)]
    pub findings: Vec<Finding>,
    pub verdict: Verdict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewMode {
    Single,
    Group,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineDecl {
    /// e.g. "claude" | "codex".
    pub name: String,
    /// e.g. "reviewer" | "cross_examiner". Free-form by design.
    #[serde(default)]
    pub role: String,
    /// light | standard | complex (advisory; not re-validated here).
    #[serde(default)]
    pub depth: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Subject {
    /// Canonical `owner/repo#N`.
    pub r#ref: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub head_sha: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Understanding {
    /// What this change is and why — one paragraph.
    pub purpose: String,
    /// Dependency-ordered beats (the spec suggests 3-7).
    #[serde(default)]
    pub walkthrough: Vec<Beat>,
    /// What the reviewer actually did ("read every hunk", "ran cargo test").
    #[serde(default)]
    pub verified: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Beat {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub risk: Risk,
    #[serde(default)]
    pub anchors: Vec<Anchor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Risk {
    #[default]
    Low,
    Medium,
    High,
}

/// A location in one subject's diff. `line` is the new-side line; `None` = file-level.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Anchor {
    /// Index into `subjects`.
    pub subject: usize,
    pub path: String,
    #[serde(default)]
    pub line: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Relationship {
    pub kind: RelationKind,
    /// Subject indices.
    pub from: usize,
    pub to: usize,
    #[serde(default)]
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationKind {
    /// `to`'s base branch is `from`'s head (review only the delta).
    Stacked,
    SharedFile,
    /// One PR changes a symbol/API the other consumes.
    Contract,
    /// Linked intent (shared issue, "depends on #N").
    Intent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Finding {
    pub id: String,
    pub r#type: FindingType,
    pub severity: Severity,
    /// 0.0..=1.0 — surfaced, never hidden.
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    /// The teachable part: reusable rule id + why it matters. Optional but urged.
    #[serde(default)]
    pub rule: Option<Rule>,
    pub title: String,
    /// Why it's wrong + the failing case (the instance message).
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub anchor: Option<Anchor>,
    /// Committable replacement hunk — the highest-signal payload.
    #[serde(default)]
    pub suggestion: Option<Suggestion>,
    /// engine name → its verdict on this finding (attribution + cross-exam).
    #[serde(default)]
    pub engines: BTreeMap<String, EngineVerdict>,
    #[serde(default)]
    pub status: FindingStatus,
    /// Free-text rationale for declined/deferred (the non-stigmatized outcomes).
    #[serde(default)]
    pub status_note: String,
}

fn default_confidence() -> f64 {
    1.0
}

/// The 12 defect/improvement types + the 2 non-defect kinds. The frontend owns the
/// display grouping (collapsing to fewer buckets is a display remap, never a schema
/// change — resolved spec decision).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingType {
    Bug,
    Test,
    Api,
    Docs,
    Clarity,
    Style,
    ErrorHandling,
    Design,
    Compat,
    Perf,
    Security,
    Observability,
    /// Comprehension probe — how real reviewers phrase suspected bugs.
    Question,
    /// Codified by Google's guide; omitted by every machine format. Not here.
    Praise,
}

impl FindingType {
    /// `question`/`praise` are non-defect kinds: severity is pinned to TakeOrLeave.
    pub fn is_kind(self) -> bool {
        matches!(self, FindingType::Question | FindingType::Praise)
    }
}

/// Severity = the REQUIRED RESPONSE BEHAVIOR (Netlify-ladder semantics), not abstract
/// badness. Blocking-ness is derivable — no separate bit to desync.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// Fix now; merge is wrong until then.
    Blocker,
    /// Fix before merging; no follow-up allowed.
    FixBeforeMerge,
    /// Schedule it (ticket/TODO); merge may proceed.
    FollowUp,
    /// Reviewer's offer; author may ignore freely.
    TakeOrLeave,
}

impl Severity {
    pub fn blocking(self) -> bool {
        matches!(self, Severity::Blocker | Severity::FixBeforeMerge)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    /// Why this matters — the reusable teaching text.
    pub why: String,
    #[serde(default)]
    pub link: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Suggestion {
    /// Replacement hunk, committable as-is.
    pub patch: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineVerdict {
    /// This engine raised the finding.
    Found,
    Agree,
    Dispute,
    Uncertain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingStatus {
    #[default]
    Open,
    Fixed,
    /// Author pushed back with rationale — a legitimate terminal state.
    Declined,
    /// Tracked as a follow-up (ticket/TODO).
    Deferred,
    /// The code it anchored to changed out from under it.
    Obsolete,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Verdict {
    /// Severity (and kind) counts — the "0 blocking, 1 non-blocking, 0 nits" ledger.
    #[serde(default)]
    pub ledger: BTreeMap<String, u64>,
    pub per_subject: Vec<SubjectVerdict>,
    /// Group roll-up; only meaningful in group mode.
    #[serde(default)]
    pub group: Option<GroupVerdict>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubjectVerdict {
    pub subject: usize,
    pub state: VerdictState,
    /// Finding ids. REQUIRED non-empty when state is needs_work/blocked (the Apache
    /// rule: a negative verdict must carry technical justification).
    #[serde(default)]
    pub blocked_by: Vec<String>,
    /// Honesty slot: what this pass did NOT cover ("did not exercise the UI paths").
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub justification: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerdictState {
    Ready,
    /// The empirically dominant terminal verdict ("LGTM, nits don't block").
    ReadyWithNits,
    NeedsWork,
    Blocked,
}

impl ReviewDoc {
    /// Parse + semantically validate a `review.json`. Returns the doc and any
    /// non-fatal WARNINGS; hard errors (wrong schema, bad indices, unjustified
    /// negative verdicts) fail the parse so the frontend falls back to prose.
    pub fn parse(json: &str) -> Result<(ReviewDoc, Vec<String>), String> {
        let doc: ReviewDoc = serde_json::from_str(json).map_err(|e| e.to_string())?;
        let mut errors = Vec::new();
        let mut warnings = Vec::new();
        doc.validate(&mut errors, &mut warnings);
        if errors.is_empty() {
            Ok((doc, warnings))
        } else {
            Err(errors.join("; "))
        }
    }

    fn validate(&self, errors: &mut Vec<String>, warnings: &mut Vec<String>) {
        if self.schema != SCHEMA_V1 {
            errors.push(format!("schema is '{}', want '{SCHEMA_V1}'", self.schema));
        }
        if self.subjects.is_empty() {
            errors.push("subjects is empty".into());
        }
        if self.mode == ReviewMode::Single && self.subjects.len() > 1 {
            errors.push("mode 'single' with multiple subjects".into());
        }
        if self.understanding.purpose.trim().is_empty() {
            errors.push("understanding.purpose is empty (the narrative is required)".into());
        }
        let n = self.subjects.len();
        let check_anchor = |a: &Anchor, what: &str, errors: &mut Vec<String>| {
            if a.subject >= n {
                errors.push(format!("{what}: anchor subject {} out of range", a.subject));
            }
        };
        for b in &self.understanding.walkthrough {
            for a in &b.anchors {
                check_anchor(a, &format!("beat {}", b.id), errors);
            }
        }
        for r in &self.relationships {
            if r.from >= n || r.to >= n {
                errors.push(format!(
                    "relationship {:?} {}→{} out of range",
                    r.kind, r.from, r.to
                ));
            }
        }
        for (i, s) in self.merge_order.iter().enumerate() {
            if *s >= n {
                errors.push(format!("merge_order[{i}] = {s} out of range"));
            }
        }
        for f in &self.findings {
            if let Some(a) = &f.anchor {
                check_anchor(a, &format!("finding {}", f.id), errors);
            }
            if !(0.0..=1.0).contains(&f.confidence) {
                errors.push(format!(
                    "finding {}: confidence {} not in 0..=1",
                    f.id, f.confidence
                ));
            }
            if f.r#type.is_kind() && f.severity != Severity::TakeOrLeave {
                warnings.push(format!(
                    "finding {}: {:?} is pinned to take_or_leave (got {:?})",
                    f.id, f.r#type, f.severity
                ));
            }
            if f.rule.is_none() && !f.r#type.is_kind() {
                warnings.push(format!("finding {}: no rule.why (less teachable)", f.id));
            }
        }
        for v in &self.verdict.per_subject {
            if v.subject >= n {
                errors.push(format!("verdict subject {} out of range", v.subject));
            }
            let negative = matches!(v.state, VerdictState::NeedsWork | VerdictState::Blocked);
            if negative && v.blocked_by.is_empty() {
                errors.push(format!(
                    "subject {} verdict {:?} without blocked_by — negative verdicts require justification",
                    v.subject, v.state
                ));
            }
            for id in &v.blocked_by {
                if !self.findings.iter().any(|f| &f.id == id) {
                    errors.push(format!("blocked_by '{id}' names no finding"));
                }
            }
        }
        if self.verdict.per_subject.is_empty() {
            errors.push("verdict.per_subject is empty".into());
        }
        if self.mode == ReviewMode::Group && self.verdict.group.is_none() {
            warnings.push("group mode without a group verdict".into());
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupVerdict {
    pub state: VerdictState,
    #[serde(default)]
    pub summary: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The spec's own example shape (docs/PEARVIEW.md), round-tripped.
    const GOLDEN: &str = r#"{
      "schema": "review.pear.v1",
      "mode": "single",
      "engines": [
        { "name": "claude", "role": "reviewer", "depth": "standard" },
        { "name": "codex", "role": "cross_examiner", "depth": "light" }
      ],
      "subjects": [ { "ref": "imbgar/peaR#64", "title": "image proxy", "head_sha": "27f6bf4" } ],
      "understanding": {
        "purpose": "Private GitHub comment images need auth the webview lacks; proxy them through the backend with the token.",
        "walkthrough": [
          { "id": "W1", "title": "the engine grows a FetchImage command",
            "body": "frontend asks, backend fetches with the token", "risk": "medium",
            "anchors": [ { "subject": 0, "path": "src/engine.rs", "line": 469 } ] }
        ],
        "verified": [ "read every hunk", "traced the auth path" ]
      },
      "findings": [
        {
          "id": "F1", "type": "bug", "severity": "fix_before_merge", "confidence": 0.9,
          "rule": { "id": "unvalidated-redirect-target",
                    "why": "Auth-bearing requests that follow redirects can leak the token." },
          "title": "token follows redirects to arbitrary hosts",
          "evidence": "fetch_image() uses a default agent; the Location is unvalidated.",
          "anchor": { "subject": 0, "path": "src/github.rs", "line": 312 },
          "suggestion": { "patch": "let agent = builder.max_redirects(0)..." },
          "engines": { "claude": "found", "codex": "agree" },
          "status": "open"
        },
        { "id": "F2", "type": "praise", "severity": "take_or_leave",
          "title": "clean degradation to prose on parse failure" },
        { "id": "Q1", "type": "question", "severity": "take_or_leave",
          "title": "does the data-url cache ever evict?" }
      ],
      "verdict": {
        "ledger": { "blocker": 0, "fix_before_merge": 1, "follow_up": 0, "take_or_leave": 0, "question": 1, "praise": 1 },
        "per_subject": [
          { "subject": 0, "state": "needs_work", "blocked_by": [ "F1" ],
            "scope": "did not exercise the UI paths",
            "justification": "redirect token leak must be fixed first" }
        ]
      }
    }"#;

    #[test]
    fn golden_doc_parses_and_round_trips() {
        let (doc, warnings) = ReviewDoc::parse(GOLDEN).expect("golden must parse");
        assert_eq!(doc.schema, SCHEMA_V1);
        assert_eq!(doc.subjects.len(), 1);
        assert_eq!(doc.findings.len(), 3);
        assert!(
            warnings.is_empty(),
            "golden should be warning-free: {warnings:?}"
        );
        // Round-trip: serialize → reparse → same finding ids.
        let json = serde_json::to_string(&doc).unwrap();
        let (doc2, _) = ReviewDoc::parse(&json).unwrap();
        assert_eq!(
            doc.findings.iter().map(|f| &f.id).collect::<Vec<_>>(),
            doc2.findings.iter().map(|f| &f.id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn severity_encodes_blocking() {
        assert!(Severity::Blocker.blocking());
        assert!(Severity::FixBeforeMerge.blocking());
        assert!(!Severity::FollowUp.blocking());
        assert!(!Severity::TakeOrLeave.blocking());
    }

    #[test]
    fn negative_verdict_requires_justification() {
        let bad = GOLDEN.replace(r#""blocked_by": [ "F1" ],"#, r#""blocked_by": [],"#);
        let err = ReviewDoc::parse(&bad).unwrap_err();
        assert!(err.contains("require justification"), "{err}");
    }

    #[test]
    fn anchors_must_point_at_subjects() {
        let bad = GOLDEN.replace(
            r#"{ "subject": 0, "path": "src/github.rs", "line": 312 }"#,
            r#"{ "subject": 7, "path": "src/github.rs", "line": 312 }"#,
        );
        let err = ReviewDoc::parse(&bad).unwrap_err();
        assert!(err.contains("out of range"), "{err}");
    }

    #[test]
    fn wrong_schema_is_fatal() {
        let bad = GOLDEN.replace("review.pear.v1", "review.pear.v9");
        assert!(ReviewDoc::parse(&bad).is_err());
    }

    #[test]
    fn kind_findings_pin_severity_as_warning() {
        let odd = GOLDEN.replace(
            r#"{ "id": "Q1", "type": "question", "severity": "take_or_leave","#,
            r#"{ "id": "Q1", "type": "question", "severity": "blocker","#,
        );
        let (_, warnings) = ReviewDoc::parse(&odd).expect("kind severity is non-fatal");
        assert!(warnings
            .iter()
            .any(|w| w.contains("pinned to take_or_leave")));
    }

    #[test]
    fn blocked_by_must_name_real_findings() {
        let bad = GOLDEN.replace(r#""blocked_by": [ "F1" ]"#, r#""blocked_by": [ "NOPE" ]"#);
        let err = ReviewDoc::parse(&bad).unwrap_err();
        assert!(err.contains("names no finding"), "{err}");
    }
}
