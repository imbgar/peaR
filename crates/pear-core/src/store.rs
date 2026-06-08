//! On-disk layout: history index + review artifacts. See ARCHITECTURE.md §3.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{CoreError, Result};
use crate::protocol::{CliKind, Favorites, Layout, PrRecord, PrRef, Queue, QueueItem, SessionRec};

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

    fn favorites_path(&self) -> PathBuf {
        self.root.join("favorites.json")
    }

    /// Load the favorited repos + PRs (missing/corrupt -> empty).
    pub fn favorites(&self) -> Favorites {
        fs::read(self.favorites_path())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn write_favorites(&self, f: &Favorites) -> Result<()> {
        let json = serde_json::to_vec_pretty(f).map_err(|e| CoreError::Storage(e.to_string()))?;
        fs::write(self.favorites_path(), json).map_err(|e| CoreError::Storage(e.to_string()))?;
        Ok(())
    }

    /// Favorite / unfavorite a repo (`"owner/repo"` key). Idempotent.
    pub fn toggle_favorite_repo(&self, owner: &str, repo: &str, on: bool) -> Result<()> {
        let key = format!("{owner}/{repo}");
        let mut f = self.favorites();
        f.repos.retain(|r| r != &key);
        if on {
            f.repos.push(key);
        }
        self.write_favorites(&f)
    }

    /// Favorite / unfavorite a single PR. Idempotent.
    pub fn toggle_favorite_pr(&self, pr: &PrRef, on: bool) -> Result<()> {
        let mut f = self.favorites();
        f.prs.retain(|p| p != pr);
        if on {
            f.prs.push(pr.clone());
        }
        self.write_favorites(&f)
    }

    fn queue_path(&self) -> PathBuf {
        self.root.join("queue.json")
    }

    /// Load the review queue (missing/corrupt -> empty).
    pub fn queue(&self) -> Queue {
        fs::read(self.queue_path())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn write_queue(&self, q: &Queue) -> Result<()> {
        let json = serde_json::to_vec_pretty(q).map_err(|e| CoreError::Storage(e.to_string()))?;
        fs::write(self.queue_path(), json).map_err(|e| CoreError::Storage(e.to_string()))?;
        Ok(())
    }

    /// Add a PR to the queue (status `queued`) — no-op if already present.
    pub fn queue_add(&self, pr: &PrRef, title: &str, now: &str) -> Result<()> {
        let mut q = self.queue();
        if q.items.iter().any(|i| &i.pr == pr) {
            return Ok(());
        }
        q.items.push(QueueItem {
            pr: pr.clone(),
            title: title.to_string(),
            status: "queued".into(),
            added: now.to_string(),
        });
        self.write_queue(&q)
    }

    /// Set a queued PR's status (`queued` | `active` | `done`).
    pub fn queue_set_status(&self, pr: &PrRef, status: &str) -> Result<()> {
        let mut q = self.queue();
        if let Some(item) = q.items.iter_mut().find(|i| &i.pr == pr) {
            item.status = status.to_string();
        }
        self.write_queue(&q)
    }

    /// Remove a PR from the queue.
    pub fn queue_remove(&self, pr: &PrRef) -> Result<()> {
        let mut q = self.queue();
        q.items.retain(|i| &i.pr != pr);
        self.write_queue(&q)
    }

    /// Reorder a queued PR by `dir` (-1 = up, +1 = down), clamped to the ends.
    pub fn queue_move(&self, pr: &PrRef, dir: i64) -> Result<()> {
        let mut q = self.queue();
        let Some(i) = q.items.iter().position(|x| &x.pr == pr) else {
            return Ok(());
        };
        let j = i as i64 + dir;
        if j >= 0 && (j as usize) < q.items.len() {
            q.items.swap(i, j as usize);
            self.write_queue(&q)?;
        }
        Ok(())
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

    /// Remove a single PR's history entry. Returns true if it was present.
    pub fn delete_entry(&self, pr: &PrRef) -> Result<bool> {
        let mut recs = self.history();
        let before = recs.len();
        recs.retain(|r| r.pr != *pr);
        let removed = recs.len() != before;
        if removed {
            self.write_history(&recs)?;
        }
        Ok(removed)
    }

    fn layout_path(&self) -> PathBuf {
        self.root.join("session.json")
    }

    /// Persist the open-tab layout for restore on next launch.
    pub fn write_layout(&self, layout: &Layout) -> Result<()> {
        let json =
            serde_json::to_vec_pretty(layout).map_err(|e| CoreError::Storage(e.to_string()))?;
        fs::write(self.layout_path(), json).map_err(|e| CoreError::Storage(e.to_string()))
    }

    /// Load the persisted layout (missing/corrupt -> empty).
    pub fn read_layout(&self) -> Layout {
        fs::read(self.layout_path())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// Forget the persisted layout (persist toggled off).
    pub fn clear_layout(&self) -> Result<()> {
        match fs::remove_file(self.layout_path()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(CoreError::Storage(e.to_string())),
        }
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
                        messages: 0, // filled in on history load (engine::history_payload)
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

    #[test]
    fn layout_round_trips_tile_structure() {
        use crate::protocol::{LayoutEntry, PaneTree, WinLayout};
        let tmp = tempfile::tempdir().unwrap();
        let s = Store::at(tmp.path()).unwrap();
        let entry = |t: &str| LayoutEntry {
            pr: None,
            cli: CliKind::Shell,
            session_id: None,
            cwd: None,
            title: t.into(),
        };
        let layout = Layout {
            entries: vec![entry("a"), entry("b")],
            active: Some(1),
            windows: vec![WinLayout {
                tree: PaneTree::Split {
                    dir: "row".into(),
                    ratio: 0.7,
                    a: Box::new(PaneTree::Leaf { i: 0 }),
                    b: Box::new(PaneTree::Leaf { i: 1 }),
                },
                focus: 1,
                root: 0,
            }],
        };
        s.write_layout(&layout).unwrap();
        let got = s.read_layout();
        assert_eq!(got.entries.len(), 2);
        assert_eq!(got.active, Some(1));
        assert_eq!(got.windows.len(), 1);
        match &got.windows[0].tree {
            PaneTree::Split { dir, ratio, a, b } => {
                assert_eq!(dir, "row");
                assert!((ratio - 0.7).abs() < 1e-9);
                assert!(matches!(**a, PaneTree::Leaf { i: 0 }));
                assert!(matches!(**b, PaneTree::Leaf { i: 1 }));
            }
            _ => panic!("expected a split at the window root"),
        }
        assert_eq!(got.windows[0].focus, 1);
        assert_eq!(got.windows[0].root, 0);
    }

    #[test]
    fn legacy_flat_layout_reads_with_empty_windows() {
        // A pre-tiling layout.json (no `windows` key) must still deserialize.
        let tmp = tempfile::tempdir().unwrap();
        let s = Store::at(tmp.path()).unwrap();
        fs::write(
            s.layout_path(),
            br#"{"entries":[{"pr":null,"cli":"shell","title":"x"}],"active":0}"#,
        )
        .unwrap();
        let got = s.read_layout();
        assert_eq!(got.entries.len(), 1);
        assert!(got.windows.is_empty(), "missing windows → flat restore");
    }
}
