//! On-disk layout: history index + review artifacts. See ARCHITECTURE.md §3.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{CoreError, Result};
use crate::protocol::{CliKind, PrRecord, PrRef, SessionRec};

/// Owns the `<data-dir>/pear/` tree.
#[derive(Debug, Clone)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    /// Resolve the data dir: `PEAR_DATA_DIR` override, else the OS data dir.
    pub fn discover() -> Result<Store> {
        let root = if let Ok(custom) = std::env::var("PEAR_DATA_DIR") {
            PathBuf::from(custom)
        } else {
            let dirs = directories::ProjectDirs::from("dev", "pear", "pear")
                .ok_or_else(|| CoreError::Storage("cannot resolve OS data dir".into()))?;
            dirs.data_dir().to_path_buf()
        };
        Store::at(root)
    }

    /// Use an explicit root (handy for tests).
    pub fn at(root: impl Into<PathBuf>) -> Result<Store> {
        let root = root.into();
        fs::create_dir_all(root.join("reviews"))
            .map_err(|e| CoreError::Storage(format!("mkdir {}: {e}", root.display())))?;
        Ok(Store { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn history_path(&self) -> PathBuf {
        self.root.join("history.json")
    }

    fn pr_dir(&self, pr: &PrRef) -> PathBuf {
        self.root
            .join("reviews")
            .join(pr.slug())
            .join(pr.number.to_string())
    }

    /// Managed clone location for a PR's repo when it isn't found on the machine:
    /// `<data-dir>/repos/<owner>/<repo>`. Auto-created + populated on first open, so
    /// pear has no dependency on the user having the repo cloned anywhere specific.
    pub fn repo_clone_dir(&self, pr: &PrRef) -> PathBuf {
        self.root.join("repos").join(&pr.owner).join(&pr.repo)
    }

    /// Load the PR history (newest PR first). Missing/corrupt file -> empty.
    pub fn history(&self) -> Vec<PrRecord> {
        let Ok(bytes) = fs::read(self.history_path()) else {
            return Vec::new();
        };
        serde_json::from_slice(&bytes).unwrap_or_default()
    }

    fn write_history(&self, recs: &[PrRecord]) -> Result<()> {
        let json =
            serde_json::to_vec_pretty(recs).map_err(|e| CoreError::Storage(e.to_string()))?;
        fs::write(self.history_path(), json).map_err(|e| CoreError::Storage(e.to_string()))?;
        Ok(())
    }

    fn history_backup_path(&self) -> PathBuf {
        self.root.join("history.bak.json")
    }

    /// Clear the history, backing it up first so it can be restored (across runs —
    /// the backup is a file in the data dir). Returns the number of PRs cleared.
    pub fn clear_history(&self) -> Result<usize> {
        let current = self.history();
        if !current.is_empty() {
            let json = serde_json::to_vec_pretty(&current)
                .map_err(|e| CoreError::Storage(e.to_string()))?;
            fs::write(self.history_backup_path(), json)
                .map_err(|e| CoreError::Storage(e.to_string()))?;
        }
        self.write_history(&[])?;
        Ok(current.len())
    }

    /// Restore history from the last clear's backup. Returns the number restored
    /// (0 if there is no backup).
    pub fn restore_history(&self) -> Result<usize> {
        let Ok(bytes) = fs::read(self.history_backup_path()) else {
            return Ok(0);
        };
        let recs: Vec<PrRecord> = serde_json::from_slice(&bytes).unwrap_or_default();
        self.write_history(&recs)?;
        Ok(recs.len())
    }

    /// The id of the PR's most recently used session, if any.
    pub fn most_recent_session(&self, pr: &PrRef) -> Option<String> {
        self.history()
            .into_iter()
            .find(|r| r.pr == *pr)
            .and_then(|r| r.sessions.into_iter().next().map(|s| s.id))
    }

    /// Upsert a PR record on open. Updates title/cli/last_opened and, when
    /// `session_id` is given, adds it (or bumps it if already present). The PR is
    /// moved to the front; sessions are kept newest-first.
    pub fn record_open(
        &self,
        pr: &PrRef,
        title: &str,
        cli: CliKind,
        session_id: Option<&str>,
        now: &str,
    ) -> Result<()> {
        let mut recs = self.history();
        let mut rec = recs
            .iter()
            .position(|r| r.pr == *pr)
            .map(|i| recs.remove(i))
            .unwrap_or_else(|| PrRecord {
                pr: pr.clone(),
                title: title.to_string(),
                last_opened: now.to_string(),
                cli,
                sessions: Vec::new(),
            });

        if !title.is_empty() {
            rec.title = title.to_string();
        }
        rec.last_opened = now.to_string();
        rec.cli = cli;

        if let Some(id) = session_id {
            if let Some(s) = rec.sessions.iter_mut().find(|s| s.id == id) {
                s.last_opened = now.to_string();
            } else {
                rec.sessions.insert(
                    0,
                    SessionRec {
                        id: id.to_string(),
                        started: now.to_string(),
                        last_opened: now.to_string(),
                    },
                );
            }
            rec.sessions
                .sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
            rec.sessions.truncate(50);
        }

        recs.insert(0, rec);
        recs.truncate(200);
        self.write_history(&recs)
    }

    /// The most recently written review artifact for `pr`, as `(path, content)`.
    pub fn latest_review(&self, pr: &PrRef) -> Option<(PathBuf, String)> {
        let dir = self.pr_dir(pr);
        let mut newest: Option<PathBuf> = None;
        for entry in fs::read_dir(&dir).ok()?.flatten() {
            let path = entry.path();
            let is_review = path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("review-") && n.ends_with(".md"))
                .unwrap_or(false);
            if is_review {
                // review-<stamp>.md sorts lexicographically by time, so max() is newest.
                if newest.as_ref().map(|p| path > *p).unwrap_or(true) {
                    newest = Some(path);
                }
            }
        }
        let path = newest?;
        let content = fs::read_to_string(&path).ok()?;
        Some((path, content))
    }

    /// Write a review artifact for `pr`. Returns the path written.
    pub fn save_review(&self, pr: &PrRef, content: &str, stamp: &str) -> Result<PathBuf> {
        let dir = self.pr_dir(pr);
        fs::create_dir_all(&dir).map_err(|e| CoreError::Storage(e.to_string()))?;
        let path = dir.join(format!("review-{stamp}.md"));
        fs::write(&path, content).map_err(|e| CoreError::Storage(e.to_string()))?;
        Ok(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr() -> PrRef {
        PrRef {
            owner: "o".into(),
            repo: "r".into(),
            number: 5,
        }
    }

    #[test]
    fn history_upserts_and_tracks_sessions() {
        let tmp = tempfile::tempdir().unwrap();
        let s = Store::at(tmp.path()).unwrap();
        s.record_open(
            &pr(),
            "first",
            CliKind::Claude,
            Some("sess-A"),
            "2026-06-03T00:00:00Z",
        )
        .unwrap();
        s.record_open(
            &pr(),
            "second",
            CliKind::Claude,
            Some("sess-B"),
            "2026-06-03T01:00:00Z",
        )
        .unwrap();
        let h = s.history();
        assert_eq!(h.len(), 1, "same PR must dedupe");
        assert_eq!(h[0].title, "second");
        assert_eq!(h[0].sessions.len(), 2, "two distinct sessions tracked");
        assert_eq!(h[0].sessions[0].id, "sess-B", "newest session first");
        assert_eq!(s.most_recent_session(&pr()).as_deref(), Some("sess-B"));

        // Re-opening an existing session bumps it to the front, no duplicate.
        s.record_open(
            &pr(),
            "second",
            CliKind::Claude,
            Some("sess-A"),
            "2026-06-03T02:00:00Z",
        )
        .unwrap();
        let h2 = s.history();
        assert_eq!(h2[0].sessions.len(), 2, "no duplicate session");
        assert_eq!(h2[0].sessions[0].id, "sess-A", "bumped to front");
    }

    #[test]
    fn saves_review_artifact() {
        let tmp = tempfile::tempdir().unwrap();
        let s = Store::at(tmp.path()).unwrap();
        let p = s.save_review(&pr(), "# notes", "20260603-000000").unwrap();
        assert!(p.exists());
        assert_eq!(fs::read_to_string(p).unwrap(), "# notes");
    }
}
