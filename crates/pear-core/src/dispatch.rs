//! Maps review actions to the literal bytes written into a tab's PTY — the
//! "button/tier -> /slash macro" table from ARCHITECTURE.md §4.
//!
//! IMPORTANT: macros end with `\r` (carriage return), NOT `\n`. A terminal's Enter
//! key is CR; agent TUIs (Claude Code, etc.) run the PTY in raw mode and treat `\n`
//! as "insert a newline" rather than "submit". `\r` is what actually presses Enter.
//!
//! IMPORTANT: review macros must name the PR. The tab knows which PR it is, so we
//! pass that through and pin the agent to the EXACT pull request — `/code-review
//! <effort> <pr#>` and `gh pr diff <pr#>` — instead of "review this PR" (which made
//! the agent diff the checked-out branch against a possibly-stale local base, e.g.
//! `git diff master...HEAD` returning thousands of unrelated files).
//!
//! Returning `None` means "no terminal macro for this combo" — the engine turns that
//! into a `Notice` toast instead (e.g. a review launched in a plain shell).

use crate::protocol::{CliKind, PrRef, ReviewButton, ReviewTier};

/// `/code-review <effort> [<pr#>]`. The PR number targets THIS pull request. (Verified
/// working — these short slash commands submit fine.)
fn code_review(effort: &str, pr: Option<&PrRef>) -> String {
    match pr {
        Some(p) => format!("/code-review {effort} {}\r", p.number),
        None => format!("/code-review {effort}\r"),
    }
}

/// An aider `/ask` prompt, anchored to the PR (and `gh pr diff`) when we know it.
fn aider_ask(prompt: &str, pr: Option<&PrRef>) -> String {
    match pr {
        Some(p) => format!(
            "/ask For PR {}/{}#{} (get the exact diff with `gh pr diff {}`): {prompt}\r",
            p.owner, p.repo, p.number, p.number
        ),
        None => format!("/ask {prompt}\r"),
    }
}

/// Instruct the agent to persist the review it just produced as a markdown file.
fn save_review_prompt(pr: Option<&PrRef>) -> String {
    let name = pr
        .map(|p| format!("pr-review-{}.md", p.number))
        .unwrap_or_else(|| "pr-review.md".to_string());
    format!(
        "Save the full review you just produced — verbatim and uncondensed, every section — \
         to a markdown file `{name}` in this repo, then print the path.\r"
    )
}

/// Keystrokes for an action [`ReviewButton`] under `cli`, targeting `pr` (trailing CR).
pub fn keystrokes(button: ReviewButton, cli: CliKind, pr: Option<&PrRef>) -> Option<String> {
    use CliKind::*;
    use ReviewButton::*;
    let s = match (cli, button) {
        // The /pr-* skills self-detect the PR from the checked-out branch via `gh`.
        (Claude, PostReview) => "/pr-post-review\r".to_string(),
        (Claude, Distill) => "/pr-distill\r".to_string(),
        (Claude, WalkThrough) => "/pr-walkthru\r".to_string(),
        (Claude, Explain) => "/pr-explain\r".to_string(),
        (Claude, Video) => "/pr-video\r".to_string(),
        (Claude, Ultra) => code_review("ultra", pr), // paid cloud review of THIS PR
        (Claude, CopyContent) => "/pr-copy\r".to_string(),
        (Claude, SaveReview) => save_review_prompt(pr),

        (Codex, PostReview) => "/review post\r".to_string(),
        (Codex, Distill) => "/review summarize\r".to_string(),
        (Codex, WalkThrough) => "/explain the review\r".to_string(),
        (Codex, Explain) => "/explain this PR and its gaps\r".to_string(),
        (Codex, Video) => return None,
        (Codex, Ultra) => return None,
        (Codex, CopyContent) => "/review copy\r".to_string(),
        (Codex, SaveReview) => save_review_prompt(pr),

        (Aider, PostReview) => "/run gh pr review --comment -F -\r".to_string(),
        (Aider, Distill) => {
            "/ask Reduce the review to its most critical, blocking points.\r".to_string()
        }
        (Aider, WalkThrough) => {
            "/ask Walk me through the review you produced, point by point.\r".to_string()
        }
        (Aider, Explain) => aider_ask("explain its purpose and changes, then list gaps.", pr),
        (Aider, Video) => return None,
        (Aider, Ultra) => return None,
        (Aider, CopyContent) => "/run pbcopy\r".to_string(),
        (Aider, SaveReview) => format!("/ask {}", save_review_prompt(pr)),

        // Plain shell has no agent slash commands.
        (Shell, _) => return None,
    };
    Some(s)
}

/// Keystrokes to launch a review at `tier` under `cli`, targeting `pr` (trailing CR).
///
/// For Claude: light → `/code-review low <pr#>` (fast), standard → `/code-review high
/// <pr#>` (deep single pass), complex → a *local* diverse multi-agent review pinned to
/// `gh pr diff <pr#>`. The paid *cloud* review (`/code-review ultra`) is intentionally
/// NOT a tier — it's the money-marked `ReviewButton::Ultra` instead.
pub fn tier_keystrokes(tier: ReviewTier, cli: CliKind, pr: Option<&PrRef>) -> Option<String> {
    use CliKind::*;
    use ReviewTier::*;
    let s = match (cli, tier) {
        (Claude, Light) => code_review("low", pr),
        (Claude, Standard) => code_review("high", pr),
        (Claude, Complex) => match pr {
            Some(p) => format!(
                "deeply review pull request {}/{}#{} across a diverse set of agents. \
                 Use `gh pr diff {}` for the exact diff and `gh pr view {}` for intent — \
                 do not diff the local branch against its base, it may be stale.\r",
                p.owner, p.repo, p.number, p.number, p.number
            ),
            None => "deeply review this PR across a diverse set of agents\r".to_string(),
        },

        (Codex, Light) => "/review\r".to_string(),
        (Codex, Standard) => "/review deep\r".to_string(),
        (Codex, Complex) => "/review deep\r".to_string(),

        (Aider, Light) => aider_ask("give a quick review — only the obvious issues.", pr),
        (Aider, Standard) => aider_ask("review thoroughly: correctness, security, tests.", pr),
        (Aider, Complex) => aider_ask("review from multiple angles; be exhaustive.", pr),

        (Shell, _) => return None,
    };
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr() -> PrRef {
        PrRef {
            owner: "imbgar".into(),
            repo: "peaR".into(),
            number: 42,
        }
    }

    #[test]
    fn claude_macros_submit_with_cr() {
        for b in [
            ReviewButton::PostReview,
            ReviewButton::Distill,
            ReviewButton::WalkThrough,
            ReviewButton::Explain,
            ReviewButton::Video,
        ] {
            let k = keystrokes(b, CliKind::Claude, None).unwrap();
            assert!(k.ends_with('\r'), "{b:?} must end with CR (Enter), not LF");
            assert!(!k.contains('\n'), "{b:?} must not contain LF");
            assert!(k.starts_with("/pr-"), "{b:?} not a /pr- macro");
        }
    }

    #[test]
    fn tiers_and_ultra_split_local_vs_paid() {
        // Light/Standard are local effort levels.
        assert_eq!(
            tier_keystrokes(ReviewTier::Light, CliKind::Claude, None).unwrap(),
            "/code-review low\r"
        );
        // Complex is a LOCAL diverse-agent review — must NOT be the paid cloud path.
        let complex = tier_keystrokes(ReviewTier::Complex, CliKind::Claude, None).unwrap();
        assert!(complex.contains("diverse set of agents"));
        assert!(!complex.contains("ultra"));
        // The paid cloud review lives only on the Ultra button.
        assert_eq!(
            keystrokes(ReviewButton::Ultra, CliKind::Claude, None).unwrap(),
            "/code-review ultra\r"
        );
    }

    #[test]
    fn reviews_name_the_pr() {
        let p = pr();
        // Tiers + ultra append the PR number to /code-review.
        assert_eq!(
            tier_keystrokes(ReviewTier::Standard, CliKind::Claude, Some(&p)).unwrap(),
            "/code-review high 42\r"
        );
        assert_eq!(
            keystrokes(ReviewButton::Ultra, CliKind::Claude, Some(&p)).unwrap(),
            "/code-review ultra 42\r"
        );
        // Complex names the PR and pins the agent to the exact diff.
        let complex = tier_keystrokes(ReviewTier::Complex, CliKind::Claude, Some(&p)).unwrap();
        assert!(
            complex.contains("imbgar/peaR#42"),
            "complex must name the PR"
        );
        assert!(
            complex.contains("gh pr diff 42"),
            "complex must pin the exact diff"
        );
    }

    #[test]
    fn shell_has_no_macros() {
        assert!(keystrokes(ReviewButton::PostReview, CliKind::Shell, None).is_none());
        assert!(keystrokes(ReviewButton::Ultra, CliKind::Shell, None).is_none());
        assert!(tier_keystrokes(ReviewTier::Light, CliKind::Shell, None).is_none());
    }
}
