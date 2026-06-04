//! The frontend-agnostic contract for `pear-core`.
//!
//! Everything that crosses the core boundary is one of these serde-serializable
//! types. A frontend (Tauri today; a daemon or TUI tomorrow — see ARCHITECTURE.md
//! branch paths) sends [`Command`]s in and receives [`Event`]s out. Keeping this
//! the *only* surface is what lets the transport change without touching the engine.

use serde::{Deserialize, Serialize};

/// Stable identifier for a tab/terminal session.
pub type TabId = u64;

/// A pull request reference, e.g. `owner/repo#123`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PrRef {
    pub owner: String,
    pub repo: String,
    pub number: u64,
}

impl PrRef {
    /// The canonical `repo#NUMBER` label used in the history list and tab titles.
    pub fn short_label(&self) -> String {
        format!("{}#{}", self.repo, self.number)
    }

    /// The fully-qualified `owner/repo#NUMBER` form.
    pub fn full_label(&self) -> String {
        format!("{}/{}#{}", self.owner, self.repo, self.number)
    }

    /// Filesystem-safe slug used under `reviews/`.
    pub fn slug(&self) -> String {
        format!("{}__{}", sanitize(&self.owner), sanitize(&self.repo))
    }

    /// Parse `owner/repo#123` (or `owner/repo/123`).
    pub fn parse(s: &str) -> Option<PrRef> {
        let (path, num) = if let Some((p, n)) = s.rsplit_once('#') {
            (p, n)
        } else {
            let (p, n) = s.rsplit_once('/')?;
            (p, n)
        };
        let number = num.trim().parse().ok()?;
        let (owner, repo) = path.split_once('/')?;
        if owner.is_empty() || repo.is_empty() {
            return None;
        }
        Some(PrRef {
            owner: owner.to_string(),
            repo: repo.trim_end_matches('/').to_string(),
            number,
        })
    }
}

fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// The CLI/agent running inside a tab's PTY. Per-tab configurable (decision D4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CliKind {
    #[default]
    Claude,
    Codex,
    Aider,
    Shell,
}

impl CliKind {
    /// The base program + args to launch this CLI. `Shell` defers to `$SHELL`.
    /// Claude's permission flags are appended by the engine from its current
    /// permission setting (see `Command::SetClaudePermission`).
    pub fn program(self) -> (&'static str, &'static [&'static str]) {
        match self {
            CliKind::Claude => ("claude", &[]),
            CliKind::Codex => ("codex", &[]),
            CliKind::Aider => ("aider", &[]),
            CliKind::Shell => ("", &[]), // resolved to $SHELL at spawn time
        }
    }
}

/// Review action buttons surfaced in the UI (button -> slash macro, except
/// `CopyContent` which the frontend handles via the clipboard).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewButton {
    PostReview,
    Distill,
    WalkThrough,
    Explain,
    Video,
    /// Paid cloud review (`/code-review ultra`) — uploads the repo to Claude on the
    /// web. Surfaced as a distinct, money-marked button so the cost is never implicit.
    Ultra,
    CopyContent,
}

/// Intensity of a launched review. Maps to review-command effort / agent breadth.
/// `light` ≈ single fast pass, `standard` ≈ deep single pass, `complex` ≈ diverse
/// multi-agent review.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewTier {
    Light,
    Standard,
    Complex,
}

/// A structured block the Insight panel renders. `kind` is one of
/// `markdown` | `diff` | `note`; `body` is the raw content for that kind.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PanelPayload {
    pub kind: String,
    pub title: String,
    pub body: String,
}

/// Lightweight metadata about a PR for the UI (subset of the GitHub payload).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrMeta {
    pub pr: PrRef,
    pub title: String,
    pub author: String,
    pub state: String,
    pub draft: bool,
    pub url: String,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
}

/// One resumable Claude session for a PR (`claude --resume <id>`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRec {
    pub id: String,
    pub started: String,     // RFC3339
    pub last_opened: String, // RFC3339
}

/// A reviewed PR and its session history (newest session first).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrRecord {
    pub pr: PrRef,
    pub title: String,
    pub last_opened: String,
    #[serde(default)]
    pub cli: CliKind,
    #[serde(default)]
    pub sessions: Vec<SessionRec>,
}

/// Commands a frontend sends into the engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    /// Open a PR tab; fetches metadata and spawns a terminal. Session handling
    /// (Claude): `session_id: Some(id)` resumes that exact session; else `fresh`
    /// forces a brand-new session; else (default) resumes the PR's most recent
    /// session if one exists, otherwise starts a new one.
    OpenPr {
        pr: PrRef,
        cli: CliKind,
        cwd: Option<String>,
        #[serde(default)]
        fresh: bool,
        #[serde(default)]
        session_id: Option<String>,
    },
    /// Open a bare terminal tab not tied to a PR.
    OpenScratch { cli: CliKind, cwd: Option<String> },
    /// Close a tab and kill its PTY.
    CloseTab { tab: TabId },
    /// Raw keystrokes from the terminal widget -> PTY stdin.
    Input { tab: TabId, bytes: Vec<u8> },
    /// Terminal widget resized; update the PTY window size.
    Resize { tab: TabId, cols: u16, rows: u16 },
    /// A review button was pressed; the engine writes the mapped macro to the PTY.
    Button { tab: TabId, button: ReviewButton },
    /// Launch a review at a given intensity; the engine writes the mapped review
    /// command to the PTY.
    StartReview { tab: TabId, tier: ReviewTier },
    /// Persist an arbitrary review artifact (e.g. captured agent output).
    SaveReview { tab: TabId, content: String },
    /// Load the latest persisted review for the tab's PR into the Insight panel
    /// (replied via `Event::Panel`).
    LoadPanel { tab: TabId },
    /// Set the permission mode used when launching Claude tabs. One of
    /// `"full"` (bypass — no prompts), `"edits"` (auto-accept edits, default),
    /// `"ask"` (default prompts), `"plan"` (read-only). Applies to future opens.
    SetClaudePermission { mode: String },
    /// Ask for the history list (replied via `Event::History`).
    LoadHistory,
    /// Clear the history (backed up first; restorable across runs).
    ClearHistory,
    /// Restore history from the last clear's backup.
    RestoreHistory,
    /// Report whether the bundled `/pr-*` review skills are installed in
    /// `~/.claude/skills` (replied via `Event::SkillsStatus`).
    CheckSkills,
    /// Install the bundled `/pr-*` review skills into `~/.claude/skills`.
    InstallSkills,
}

/// Events the engine emits to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    /// A tab was created and its terminal is live.
    TabOpened {
        tab: TabId,
        title: String,
        pr: Option<PrRef>,
        cli: CliKind,
    },
    /// PR metadata arrived (may land after `TabOpened`).
    PrMeta { tab: TabId, meta: PrMeta },
    /// Raw bytes from the PTY -> terminal widget.
    Output { tab: TabId, bytes: Vec<u8> },
    /// The tab's child process exited.
    TabClosed { tab: TabId, code: Option<i32> },
    /// A review artifact was written to disk.
    ReviewSaved { tab: TabId, path: String },
    /// Structured content for the Insight panel.
    Panel { tab: TabId, payload: PanelPayload },
    /// Reply to `LoadHistory`.
    History { entries: Vec<PrRecord> },
    /// Whether the bundled `/pr-*` skills are installed (reply to `CheckSkills`,
    /// also emitted after `InstallSkills`).
    SkillsStatus { installed: bool },
    /// A non-fatal problem the UI should surface (toast).
    Notice { tab: Option<TabId>, message: String },
    /// A fatal-for-this-command error.
    Error { tab: Option<TabId>, message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pr_refs() {
        let a = PrRef::parse("ruvnet/claude-flow#42").unwrap();
        assert_eq!(a.owner, "ruvnet");
        assert_eq!(a.repo, "claude-flow");
        assert_eq!(a.number, 42);
        assert_eq!(a.short_label(), "claude-flow#42");
        assert_eq!(a.full_label(), "ruvnet/claude-flow#42");

        let b = PrRef::parse("octo/repo/7").unwrap();
        assert_eq!(b.number, 7);

        assert!(PrRef::parse("nope").is_none());
        assert!(PrRef::parse("owner/repo#notanum").is_none());
    }

    #[test]
    fn command_roundtrips_json() {
        let c = Command::OpenPr {
            pr: PrRef {
                owner: "o".into(),
                repo: "r".into(),
                number: 1,
            },
            cli: CliKind::Claude,
            cwd: None,
            fresh: false,
            session_id: None,
        };
        let s = serde_json::to_string(&c).unwrap();
        assert!(s.contains("\"type\":\"open_pr\""));
        let _back: Command = serde_json::from_str(&s).unwrap();
    }
}
