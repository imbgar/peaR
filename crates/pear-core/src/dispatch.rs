//! Maps review actions to the literal bytes written into a tab's PTY — the
//! "button/tier -> /slash macro" table from ARCHITECTURE.md §4.
//!
//! IMPORTANT: macros end with `\r` (carriage return), NOT `\n`. A terminal's Enter
//! key is CR; agent TUIs (Claude Code, etc.) run the PTY in raw mode and treat `\n`
//! as "insert a newline" rather than "submit". `\r` is what actually presses Enter.
//!
//! Returning `None` means "no terminal macro for this combo" — the engine turns that
//! into a `Notice` toast instead (e.g. a review launched in a plain shell).

use crate::protocol::{CliKind, ReviewButton, ReviewTier};

/// Keystrokes for an action [`ReviewButton`] under `cli` (trailing CR = Enter).
pub fn keystrokes(button: ReviewButton, cli: CliKind) -> Option<String> {
    use CliKind::*;
    use ReviewButton::*;
    let s = match (cli, button) {
        (Claude, PostReview) => "/pr-post-review\r",
        (Claude, Distill) => "/pr-distill\r",
        (Claude, WalkThrough) => "/pr-walkthru\r",
        (Claude, Explain) => "/pr-explain\r",
        (Claude, Video) => "/pr-video\r",
        (Claude, Ultra) => "/code-review ultra\r", // paid cloud review
        (Claude, CopyContent) => "/pr-copy\r",

        (Codex, PostReview) => "/review post\r",
        (Codex, Distill) => "/review summarize\r",
        (Codex, WalkThrough) => "/explain the review\r",
        (Codex, Explain) => "/explain this PR and its gaps\r",
        (Codex, Video) => return None,
        (Codex, Ultra) => return None,
        (Codex, CopyContent) => "/review copy\r",

        (Aider, PostReview) => "/run gh pr review --comment -F -\r",
        (Aider, Distill) => "/ask Reduce the review to its most critical, blocking points.\r",
        (Aider, WalkThrough) => "/ask Walk me through the review you produced, point by point.\r",
        (Aider, Explain) => "/ask Explain this PR's purpose and changes, then list gaps.\r",
        (Aider, Video) => return None,
        (Aider, Ultra) => return None,
        (Aider, CopyContent) => "/run pbcopy\r",

        // Plain shell has no agent slash commands.
        (Shell, _) => return None,
    };
    Some(s.to_string())
}

/// Keystrokes to launch a review at `tier` under `cli` (trailing CR = Enter).
///
/// For Claude: light → `/code-review low` (fast), standard → `/code-review high`
/// (deep single pass), complex → a *local* diverse multi-agent review (free; this
/// is the phrasing that engages the workflow fleet). The paid *cloud* review
/// (`/code-review ultra`) is intentionally NOT a tier — it's the explicit
/// money-marked `ReviewButton::Ultra` instead. Review correctness assumes the tab's
/// working dir is the PR's repo (handled by `workdir::resolve` on open).
pub fn tier_keystrokes(tier: ReviewTier, cli: CliKind) -> Option<String> {
    use CliKind::*;
    use ReviewTier::*;
    let s = match (cli, tier) {
        (Claude, Light) => "/code-review low\r",
        (Claude, Standard) => "/code-review high\r",
        (Claude, Complex) => "deeply review this PR across a diverse set of agents\r",

        (Codex, Light) => "/review\r",
        (Codex, Standard) => "/review deep\r",
        (Codex, Complex) => "/review deep\r",

        (Aider, Light) => "/ask Give this PR a quick review — only the obvious issues.\r",
        (Aider, Standard) => "/ask Review this PR thoroughly: correctness, security, tests.\r",
        (Aider, Complex) => "/ask Review this PR from multiple angles; be exhaustive.\r",

        (Shell, _) => return None,
    };
    Some(s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_macros_submit_with_cr() {
        for b in [
            ReviewButton::PostReview,
            ReviewButton::Distill,
            ReviewButton::WalkThrough,
            ReviewButton::Explain,
            ReviewButton::Video,
        ] {
            let k = keystrokes(b, CliKind::Claude).unwrap();
            assert!(k.ends_with('\r'), "{b:?} must end with CR (Enter), not LF");
            assert!(!k.contains('\n'), "{b:?} must not contain LF");
            assert!(k.starts_with("/pr-"), "{b:?} not a /pr- macro");
        }
    }

    #[test]
    fn tiers_and_ultra_split_local_vs_paid() {
        // Light/Standard are local effort levels.
        assert_eq!(
            tier_keystrokes(ReviewTier::Light, CliKind::Claude).unwrap(),
            "/code-review low\r"
        );
        // Complex is a LOCAL diverse-agent review — must NOT be the paid cloud path.
        let complex = tier_keystrokes(ReviewTier::Complex, CliKind::Claude).unwrap();
        assert!(complex.contains("diverse set of agents"));
        assert!(!complex.contains("ultra"));
        // The paid cloud review lives only on the Ultra button.
        assert_eq!(
            keystrokes(ReviewButton::Ultra, CliKind::Claude).unwrap(),
            "/code-review ultra\r"
        );
    }

    #[test]
    fn shell_has_no_macros() {
        assert!(keystrokes(ReviewButton::PostReview, CliKind::Shell).is_none());
        assert!(keystrokes(ReviewButton::Ultra, CliKind::Shell).is_none());
        assert!(tier_keystrokes(ReviewTier::Light, CliKind::Shell).is_none());
    }
}
