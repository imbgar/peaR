//! Bundled review skills. The `/pr-*` buttons dispatch slash commands that only
//! resolve if the skills are installed in the user's Claude. Rather than asking
//! users to run `/plugin install`, pear embeds the skill files at build time and
//! writes them into `~/.claude/skills/<name>/SKILL.md` on explicit consent.
//!
//! (The Light/Standard/Complex/Ultra tiers use the built-in `/code-review`, so they
//! work without this — only the custom `/pr-*` actions need it.)

use std::fs;
use std::path::PathBuf;

use crate::error::{CoreError, Result};

/// (skill name, SKILL.md body) embedded from `plugins/pear-review/skills/` at build time.
const SKILLS: &[(&str, &str)] = &[
    (
        "pr-post-review",
        include_str!("../../../plugins/pear-review/skills/pr-post-review/SKILL.md"),
    ),
    (
        "pr-copy",
        include_str!("../../../plugins/pear-review/skills/pr-copy/SKILL.md"),
    ),
    (
        "pr-distill",
        include_str!("../../../plugins/pear-review/skills/pr-distill/SKILL.md"),
    ),
    (
        "pr-walkthru",
        include_str!("../../../plugins/pear-review/skills/pr-walkthru/SKILL.md"),
    ),
    (
        "pr-explain",
        include_str!("../../../plugins/pear-review/skills/pr-explain/SKILL.md"),
    ),
    (
        "pr-video",
        include_str!("../../../plugins/pear-review/skills/pr-video/SKILL.md"),
    ),
];

fn skills_root() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").ok_or_else(|| CoreError::Storage("no HOME".into()))?;
    Ok(PathBuf::from(home).join(".claude").join("skills"))
}

/// True only if every bundled skill is present in `~/.claude/skills`.
pub fn skills_installed() -> bool {
    let Ok(root) = skills_root() else {
        return false;
    };
    SKILLS
        .iter()
        .all(|(name, _)| root.join(name).join("SKILL.md").exists())
}

/// Number of bundled skills (for status messages).
pub fn skills_count() -> usize {
    SKILLS.len()
}

/// Write the bundled skills into `~/.claude/skills/<name>/SKILL.md`. Returns how
/// many were written. Overwrites existing copies (keeps them current).
pub fn install_skills() -> Result<usize> {
    let root = skills_root()?;
    for (name, body) in SKILLS {
        let dir = root.join(name);
        fs::create_dir_all(&dir).map_err(|e| CoreError::Storage(e.to_string()))?;
        fs::write(dir.join("SKILL.md"), body).map_err(|e| CoreError::Storage(e.to_string()))?;
    }
    Ok(SKILLS.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embeds_all_six_skills() {
        assert_eq!(SKILLS.len(), 6);
        for (name, body) in SKILLS {
            assert!(name.starts_with("pr-"), "{name} not a pr- skill");
            assert!(body.contains("name:"), "{name} missing frontmatter");
        }
    }

    #[test]
    fn installs_into_a_root() {
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        let n = install_skills().unwrap();
        assert_eq!(n, 6);
        assert!(skills_installed());
        assert!(tmp
            .path()
            .join(".claude/skills/pr-post-review/SKILL.md")
            .exists());
    }
}
