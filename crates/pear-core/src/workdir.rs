//! Resolve a PR to a local git repo directory so the CLI launches in the right
//! place (otherwise `/code-review` et al. fail with "not inside a git repository").
//!
//! Strategy: an explicit path wins; otherwise search a set of base dirs for a
//! directory named after the repo that contains a `.git`. Override/extend the
//! search roots with `PEAR_REPO_DIRS` (colon-separated).

use std::path::{Path, PathBuf};

use crate::protocol::PrRef;

/// Base directories searched for repos, in order.
pub fn search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(custom) = std::env::var("PEAR_REPO_DIRS") {
        for p in custom.split(':').filter(|s| !s.is_empty()) {
            dirs.push(PathBuf::from(p));
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        for sub in ["repos", "projects", "src", "code", "dev", "work"] {
            dirs.push(home.join(sub));
        }
    }
    dirs
}

fn is_git_repo(p: &Path) -> bool {
    p.join(".git").exists()
}

/// Resolve `pr` to a local git repo. `explicit` (a path the caller supplied) wins
/// if it's a git repo. Returns `None` if nothing local is found.
pub fn resolve(pr: &PrRef, explicit: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = explicit {
        let pb = PathBuf::from(p);
        if is_git_repo(&pb) {
            return Some(pb);
        }
    }
    for base in search_dirs() {
        // Prefer `<base>/<repo>`, then `<base>/<owner>/<repo>`.
        let by_repo = base.join(&pr.repo);
        if is_git_repo(&by_repo) {
            return Some(by_repo);
        }
        let by_owner = base.join(&pr.owner).join(&pr.repo);
        if is_git_repo(&by_owner) {
            return Some(by_owner);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_git_path_wins() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join(".git")).unwrap();
        let pr = PrRef {
            owner: "o".into(),
            repo: "r".into(),
            number: 1,
        };
        let got = resolve(&pr, tmp.path().to_str());
        assert_eq!(got.as_deref(), Some(tmp.path()));
    }

    #[test]
    fn non_git_explicit_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let pr = PrRef {
            owner: "o".into(),
            repo: "r".into(),
            number: 1,
        };
        // No .git inside, and (assuming) no repo named "r" in search dirs during test.
        assert!(resolve(&pr, tmp.path().to_str()).is_none_or(|p| p != tmp.path()));
    }
}
