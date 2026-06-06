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
    /// Instruct the agent to write the full review it produced, verbatim, to a
    /// markdown file (replaces the old buffer-capture Save).
    SaveReview,
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

/// One existing review comment on a PR, anchored to a file + line in the diff.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffComment {
    /// File path the comment is on (matches the diff's `b/` path).
    pub path: String,
    /// 1-based line in the file's new side, if the comment is line-anchored
    /// (`None` for file-level or outdated comments).
    pub line: Option<u64>,
    pub author: String,
    pub body: String,
}

/// One emoji reaction rollup on a comment (read side). `me` is whether the
/// authenticated viewer has reacted with this emoji.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reaction {
    /// The GraphQL `ReactionContent` enum (e.g. `THUMBS_UP`) — sent back on toggle.
    pub content: String,
    pub emoji: String,
    pub count: u64,
    #[serde(default)]
    pub me: bool,
}

/// A single comment — used for both PR conversation (issue) comments and the
/// comments inside an inline review thread. `id` is the GraphQL node id (used by
/// later phases to edit/delete/react). `mine` = the viewer authored it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Comment {
    pub id: String,
    pub author: String,
    pub body: String,
    /// RFC3339 creation timestamp.
    pub created_at: String,
    #[serde(default)]
    pub mine: bool,
    #[serde(default)]
    pub reactions: Vec<Reaction>,
    /// For a PR *review* summary surfaced in the conversation, its state
    /// (`APPROVED` | `CHANGES_REQUESTED` | `COMMENTED` | `DISMISSED`). `None` for a
    /// plain issue comment.
    #[serde(default)]
    pub review_state: Option<String>,
}

/// One inline review thread anchored to a file + line in the diff, with its
/// resolved/outdated state and the ordered comments in it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewThread {
    /// GraphQL node id (used by later phases to resolve/unresolve/reply).
    pub id: String,
    pub path: String,
    /// Current new-side line (`None` when the thread is outdated).
    pub line: Option<u64>,
    /// The line in the diff the thread was originally left on.
    pub original_line: Option<u64>,
    pub is_resolved: bool,
    pub is_outdated: bool,
    pub comments: Vec<Comment>,
}

/// All comments on a PR: the conversation (issue-level) comments plus the inline
/// review threads. Reply to [`Command::LoadComments`]. Also carries the ids the UI
/// needs to *write* comments (anchor a new comment, batch into / submit a review).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PrComments {
    pub conversation: Vec<Comment>,
    pub threads: Vec<ReviewThread>,
    /// PR GraphQL node id (to start a review / add review threads).
    #[serde(default)]
    pub pr_node_id: String,
    /// Head commit SHA (required to anchor a standalone review comment via REST).
    #[serde(default)]
    pub head_sha: String,
    /// The viewer's in-progress (PENDING) review id, if any — present once a review
    /// has been started, drives the "Finish review" UI.
    #[serde(default)]
    pub pending_review_id: Option<String>,
    /// Number of comments queued in that pending review.
    #[serde(default)]
    pub pending_count: u64,
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

/// One persisted open tab for persist-session restore. `cwd` is the tab's live working
/// directory captured at save time (shells that `cd`'d restore where you left them).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutEntry {
    pub pr: Option<PrRef>,
    pub cli: CliKind,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    pub title: String,
}

/// The persisted window layout: the ordered open tabs + which one was focused.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Layout {
    pub entries: Vec<LayoutEntry>,
    #[serde(default)]
    pub active: Option<usize>,
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
    /// Open a bare terminal tab not tied to a PR. `session_id` (Claude) resumes that
    /// session — used by persist-session restore of a non-PR Claude tab.
    OpenScratch {
        cli: CliKind,
        cwd: Option<String>,
        #[serde(default)]
        session_id: Option<String>,
    },
    /// Close a tab and kill its PTY.
    CloseTab { tab: TabId },
    /// Raw keystrokes from the terminal widget -> PTY stdin.
    Input { tab: TabId, bytes: Vec<u8> },
    /// Terminal widget resized; update the PTY window size.
    Resize { tab: TabId, cols: u16, rows: u16 },
    /// A review button was pressed; the engine writes the mapped macro to the PTY.
    /// `agent` overrides which CLI's macros to use (the frontend resolves the actual
    /// agent — declared, or detected from the terminal for a "shell" tab); falls back
    /// to the tab's own cli when absent.
    Button {
        tab: TabId,
        button: ReviewButton,
        #[serde(default)]
        agent: Option<CliKind>,
    },
    /// Launch a review at a given intensity; the engine writes the mapped review
    /// command to the PTY. `agent` overrides the dispatch CLI (see `Button`).
    StartReview {
        tab: TabId,
        tier: ReviewTier,
        #[serde(default)]
        agent: Option<CliKind>,
    },
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
    /// Delete a single PR's history entry (replied via `Event::History`).
    DeleteHistory { pr: PrRef },
    /// Restore history from the last clear's backup.
    RestoreHistory,
    /// Report whether the bundled `/pr-*` review skills are installed in
    /// `~/.claude/skills` (replied via `Event::SkillsStatus`).
    CheckSkills,
    /// Install the bundled `/pr-*` review skills into `~/.claude/skills`.
    InstallSkills,
    /// Fetch the tab's PR diff + existing review comments for the diff panel
    /// (replied via `Event::Diff`).
    LoadDiff { tab: TabId },
    /// Fetch the tab's PR conversation comments + inline review threads for the
    /// comments panel (replied via `Event::Comments`). One GraphQL round-trip.
    LoadComments { tab: TabId },
    /// Add (`add: true`) or remove a reaction on a comment, identified by its GraphQL
    /// node id. `content` is the `ReactionContent` enum. The engine re-fetches and
    /// replies with a fresh `Event::Comments`.
    ToggleReaction {
        tab: TabId,
        subject_id: String,
        content: String,
        add: bool,
    },
    /// Create a new inline review comment anchored to a diff line (or line range).
    /// `mode` = `"single"` posts it immediately as a standalone comment; `"review"`
    /// adds it to the viewer's pending review (starting one if needed). `side` /
    /// `start_side` are `"RIGHT"` | `"LEFT"`. `start_line` is set only for a multi-line
    /// range. The engine re-fetches and replies with a fresh `Event::Comments`.
    CreateReviewComment {
        tab: TabId,
        mode: String,
        body: String,
        commit_id: String,
        pr_node_id: String,
        #[serde(default)]
        review_id: Option<String>,
        path: String,
        line: u64,
        side: String,
        #[serde(default)]
        start_line: Option<u64>,
        #[serde(default)]
        start_side: Option<String>,
    },
    /// Submit the viewer's pending review. `event` = `"COMMENT"` | `"APPROVE"` |
    /// `"REQUEST_CHANGES"`. The engine re-fetches and replies with `Event::Comments`.
    SubmitReview {
        tab: TabId,
        review_id: String,
        event: String,
        #[serde(default)]
        body: String,
    },
    /// Reply to an existing inline review thread (its GraphQL node id). The engine
    /// re-fetches and replies with a fresh `Event::Comments`.
    ReplyReviewThread {
        tab: TabId,
        thread_id: String,
        body: String,
    },
    /// Resolve (`resolved: true`) or unresolve an inline review thread by node id.
    /// The engine re-fetches and replies with a fresh `Event::Comments`.
    ResolveThread {
        tab: TabId,
        thread_id: String,
        resolved: bool,
    },
    /// List the tab's repository's tracked files (`git ls-files` in its live cwd) for the
    /// diff's file-tree panel — the "whole repo" / contextual scopes beyond the diff's own
    /// files. Replied via `Event::RepoTree`.
    LoadRepoTree { tab: TabId },
    /// Start streaming the tab's Claude session *thinking* to the brain panel
    /// (replied via `Event::Thought`s). No-op for non-Claude / session-less tabs.
    WatchBrain { tab: TabId },
    /// Stop streaming the tab's thinking (e.g. the brain panel was closed).
    StopBrain { tab: TabId },
    /// Persist the current window layout for restore on next launch. `active` is the
    /// focused tab. The engine fills each tab's live cwd / pr / session id itself.
    SaveLayout {
        #[serde(default)]
        active: Option<TabId>,
    },
    /// Restore the persisted layout. The engine opens the saved tabs itself, and only on a
    /// fresh start — a reload against a live engine re-syncs existing tabs instead of
    /// duplicating. `restore` is the persist preference (false = a fresh engine opens nothing).
    LoadLayout {
        #[serde(default)]
        restore: bool,
    },
    /// Forget the persisted layout (persist toggled off).
    ClearLayout,
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
    /// The tab's PR unified diff + existing review comments (reply to `LoadDiff`).
    Diff {
        tab: TabId,
        diff: String,
        comments: Vec<DiffComment>,
    },
    /// The tab's PR conversation comments + inline review threads (reply to
    /// `LoadComments`).
    Comments { tab: TabId, comments: PrComments },
    /// The tab repo's tracked files (repo-relative paths) for the diff file-tree panel
    /// (reply to `LoadRepoTree`). Empty when the cwd isn't a git repo.
    RepoTree { tab: TabId, files: Vec<String> },
    /// One streamed item from the tab's Claude transcript for the brain panel.
    /// `kind` is `thinking` | `action` | `note`; `detail` is the full content revealed
    /// on click (e.g. a tool's whole command/input), empty when there's nothing more.
    Thought {
        tab: TabId,
        kind: String,
        text: String,
        detail: String,
    },
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
