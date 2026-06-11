//! The engine owns all tab/session state and is the single place a [`Command`] is
//! turned into side effects + [`Event`]s. Frontends never touch sessions directly.
//!
//! Threading model: `handle` takes `&mut self`; wrap the engine in a `Mutex` on the
//! frontend side. Network-bound PR metadata is fetched on a worker thread so the
//! lock is never held across I/O (the `PrMeta` event may therefore arrive after
//! `TabOpened`, which the protocol allows).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;

use time::format_description::well_known::Rfc3339;
use time::macros::format_description;
use time::OffsetDateTime;

use crate::dispatch;
use crate::error::Result;
use crate::github::GitHub;
use crate::protocol::{
    CliKind, Command, Event, Layout, LayoutEntry, PaneTree, PanelPayload, PrRef, PrStatus,
    ReviewButton, ReviewTier, TabId, WinLayout,
};
use crate::session::{EventSink, Session};
use crate::store::Store;

struct Tab {
    session: Session,
    pr: Option<PrRef>,
    cli: CliKind,
    /// The Claude session id this tab is running (so we never resume a live one twice).
    session_id: Option<String>,
    /// Working dir the tab was spawned in (fallback when the live cwd can't be read).
    cwd: Option<String>,
    /// Display title (PR short label or `shell N`) — persisted for restore.
    title: String,
}

pub struct Engine {
    sink: EventSink,
    store: Store,
    github: Option<GitHub>,
    next: TabId,
    tabs: HashMap<TabId, Tab>,
    /// Tab open order (for persist-session layout; the HashMap is unordered).
    order: Vec<TabId>,
    /// Claude `--permission-mode` for launches (see `CLAUDE_PERM_MODES`).
    claude_perm: String,
    /// Per-engine launch knobs (model / Codex effort / approval / sandbox).
    launch: LaunchCfg,
    /// A session's wait-thread sends its `TabId` here when its process exits, so the
    /// engine can drop the dead tab (drained in `reap_dead`, called each `handle`).
    reaper_tx: Sender<TabId>,
    reaper_rx: Receiver<TabId>,
    /// Stop flags for active brain (thinking-tail) watchers, keyed by tab.
    brain_watchers: HashMap<TabId, Arc<AtomicBool>>,
}

/// Per-engine launch options chosen in the launcher (empty = engine default).
#[derive(Default)]
struct LaunchCfg {
    claude_model: Option<String>,
    codex_model: Option<String>,
    codex_effort: Option<String>,
    codex_approval: Option<String>,
    codex_sandbox: Option<String>,
}

/// Claude's real `--permission-mode` choices. Anything else falls back to `auto`.
const CLAUDE_PERM_MODES: [&str; 6] = [
    "acceptEdits",
    "auto",
    "bypassPermissions",
    "default",
    "dontAsk",
    "plan",
];

/// Map the stored permission mode to Claude launch flags (pass-through if valid).
fn claude_perm_args(mode: &str) -> Vec<String> {
    let m = if CLAUDE_PERM_MODES.contains(&mode) {
        mode
    } else {
        "auto"
    };
    vec!["--permission-mode".into(), m.to_string()]
}

impl Engine {
    /// Build an engine. Discovers the data dir; GitHub is optional (a missing token
    /// only disables PR metadata — scratch terminals still work).
    pub fn new(sink: EventSink) -> Result<Engine> {
        let store = Store::discover()?;
        let github = GitHub::from_env().ok();
        let (reaper_tx, reaper_rx) = mpsc::channel();
        Ok(Engine {
            sink,
            store,
            github,
            next: 1,
            tabs: HashMap::new(),
            order: Vec::new(),
            claude_perm: "auto".to_string(),
            launch: LaunchCfg::default(),
            reaper_tx,
            reaper_rx,
            brain_watchers: HashMap::new(),
        })
    }

    fn emit(&self, e: Event) {
        (self.sink)(e);
    }

    /// Emit `Event::History` on a worker thread — enriching each session with its message
    /// count reads transcript files, which we keep off the engine lock.
    fn emit_history(&self) {
        let store = self.store.clone();
        let sink = self.sink.clone();
        std::thread::spawn(move || {
            let (entries, favorites, queue) = history_payload(&store);
            sink(Event::History {
                entries,
                favorites,
                queue,
            });
        });
    }

    /// The GitHub client, resolving the token lazily and caching it. Lets PR metadata /
    /// diff recover after a `gh auth login` (or a Finder-launch PATH that only resolves
    /// `gh` once warmed) without restarting the app.
    fn github(&mut self) -> Option<GitHub> {
        if self.github.is_none() {
            self.github = GitHub::from_env().ok();
        }
        self.github.clone()
    }

    fn alloc(&mut self) -> TabId {
        let id = self.next;
        self.next += 1;
        id
    }

    /// Single entry point. Returns `Ok` even for "soft" failures (those are emitted
    /// as `Event::Notice`/`Event::Error` so the UI can surface them per-tab).
    pub fn handle(&mut self, cmd: Command) {
        self.reap_dead();
        match cmd {
            Command::OpenPr {
                pr,
                cli,
                cwd,
                fresh,
                session_id,
            } => self.open(Some(pr), cli, cwd, fresh, session_id),
            Command::OpenScratch {
                cli,
                cwd,
                session_id,
            } => self.open(None, cli, cwd, false, session_id),
            Command::CloseTab { tab } => self.close(tab),
            Command::Input { tab, bytes } => self.input(tab, &bytes),
            Command::Resize { tab, cols, rows } => self.resize(tab, cols, rows),
            Command::Button { tab, button, agent } => self.button(tab, button, agent),
            Command::StartReview { tab, tier, agent } => self.start_review(tab, tier, agent),
            Command::StartCoReview {
                tab,
                first,
                claude_tier,
                codex_tier,
            } => self.start_co_review(tab, first, claude_tier, codex_tier),
            Command::StartTandemReview {
                tab,
                prs,
                claude_tier,
                co,
                first,
                codex_tier,
            } => self.start_tandem_review(tab, prs, claude_tier, co, first, codex_tier),
            Command::SaveReview { tab, content } => self.save_review(tab, &content),
            Command::LoadPanel { tab } => self.load_panel(tab),
            Command::SetClaudePermission { mode } => {
                let mode = if CLAUDE_PERM_MODES.contains(&mode.as_str()) {
                    mode
                } else {
                    "auto".into()
                };
                self.claude_perm = mode.clone();
                self.emit(Event::Notice {
                    tab: None,
                    message: format!("Claude permission mode: {mode}"),
                });
            }
            Command::SetLaunchConfig {
                claude_model,
                codex_model,
                codex_effort,
                codex_approval,
                codex_sandbox,
            } => {
                let norm = |o: Option<String>| o.filter(|s| !s.trim().is_empty());
                self.launch = LaunchCfg {
                    claude_model: norm(claude_model),
                    codex_model: norm(codex_model),
                    codex_effort: norm(codex_effort),
                    codex_approval: norm(codex_approval),
                    codex_sandbox: norm(codex_sandbox),
                };
            }
            Command::LoadHistory => self.emit_history(),
            Command::LoadDiff { tab } => self.load_diff(tab),
            Command::LoadComments { tab } => self.load_comments(tab),
            Command::ToggleReaction {
                tab,
                subject_id,
                content,
                add,
            } => self.comment_mutation(tab, move |gh, _pr| {
                gh.set_reaction(&subject_id, &content, add)
            }),
            Command::CreateReviewComment {
                tab,
                mode,
                body,
                commit_id,
                pr_node_id,
                review_id,
                path,
                line,
                side,
                start_line,
                start_side,
            } => self.comment_mutation(tab, move |gh, pr| {
                if mode == "single" {
                    gh.create_review_comment(
                        pr,
                        &commit_id,
                        &body,
                        &path,
                        line,
                        &side,
                        start_line,
                        start_side.as_deref(),
                    )
                } else {
                    gh.add_review_thread(
                        &pr_node_id,
                        review_id.as_deref(),
                        &body,
                        &path,
                        line,
                        &side,
                        start_line,
                        start_side.as_deref(),
                    )
                }
            }),
            Command::SubmitReview {
                tab,
                review_id,
                event,
                body,
            } => self.comment_mutation(tab, move |gh, _pr| {
                gh.submit_review(&review_id, &event, &body)
            }),
            Command::CreateReview { tab, event, body } => {
                self.comment_mutation(tab, move |gh, pr| gh.create_review(pr, &event, &body))
            }
            Command::ReplyReviewThread {
                tab,
                thread_id,
                body,
            } => self.comment_mutation(tab, move |gh, _pr| {
                gh.reply_review_thread(&thread_id, &body)
            }),
            Command::ResolveThread {
                tab,
                thread_id,
                resolved,
            } => self.comment_mutation(tab, move |gh, _pr| {
                gh.set_thread_resolved(&thread_id, resolved)
            }),
            Command::AskInsight { tab, id, prompt } => self.ask_insight(tab, id, prompt),
            Command::LoadRepoTree { tab } => self.load_repo_tree(tab),
            Command::WatchBrain { tab } => self.watch_brain(tab),
            Command::StopBrain { tab } => self.stop_brain(tab),
            Command::SaveLayout { active, windows } => self.persist_layout_with(active, windows),
            Command::LoadLayout { restore } => self.load_layout(restore),
            Command::ClearLayout => {
                let _ = self.store.clear_layout();
            }
            Command::LoadPrStatuses { prs } => self.load_pr_statuses(prs),
            Command::LoadWatches => self.emit(Event::Watches {
                watches: self.store.watches(),
            }),
            Command::WatchUser { login, on } => {
                let _ = self.store.toggle_watch_user(&login, on);
                self.emit(Event::Watches {
                    watches: self.store.watches(),
                });
            }
            Command::WatchTeam { org, team, on } => {
                let _ = self.store.toggle_watch_team(&org, &team, on);
                self.emit(Event::Watches {
                    watches: self.store.watches(),
                });
            }
            Command::LoadTeamPrs => self.load_team_prs(),
            Command::SummarizeDiff { tab, path } => self.summarize_diff(tab, path),
            Command::FetchImage { url } => self.fetch_image(url),
            Command::CheckSkills => self.emit(Event::SkillsStatus {
                installed: crate::skills_install::skills_installed(),
            }),
            Command::InstallSkills => match crate::skills_install::install_skills() {
                Ok(n) => {
                    self.emit(Event::Notice {
                        tab: None,
                        message: format!("installed {n} review skills into ~/.claude/skills — /pr-* buttons will work in new Claude tabs"),
                    });
                    self.emit(Event::SkillsStatus { installed: true });
                }
                Err(e) => self.emit(Event::Error {
                    tab: None,
                    message: format!("install skills: {e}"),
                }),
            },
            Command::ClearHistory => match self.store.clear_history() {
                Ok(n) => {
                    self.emit(Event::Notice {
                        tab: None,
                        message: format!("cleared {n} PR(s) — Restore to undo"),
                    });
                    self.emit_history();
                }
                Err(e) => self.emit(Event::Error {
                    tab: None,
                    message: format!("clear history: {e}"),
                }),
            },
            Command::DeleteHistory { pr } => match self.store.delete_entry(&pr) {
                Ok(_) => self.emit_history(),
                Err(e) => self.emit(Event::Error {
                    tab: None,
                    message: format!("delete history: {e}"),
                }),
            },
            Command::RestoreHistory => match self.store.restore_history() {
                Ok(0) => self.emit(Event::Notice {
                    tab: None,
                    message: "nothing to restore".into(),
                }),
                Ok(n) => {
                    self.emit(Event::Notice {
                        tab: None,
                        message: format!("restored {n} PR(s)"),
                    });
                    self.emit_history();
                }
                Err(e) => self.emit(Event::Error {
                    tab: None,
                    message: format!("restore history: {e}"),
                }),
            },
            Command::FavoriteRepo { owner, repo, on } => {
                match self.store.toggle_favorite_repo(&owner, &repo, on) {
                    Ok(()) => self.emit_history(),
                    Err(e) => self.emit(Event::Error {
                        tab: None,
                        message: format!("favorite repo: {e}"),
                    }),
                }
            }
            Command::FavoritePr { pr, on } => match self.store.toggle_favorite_pr(&pr, on) {
                Ok(()) => self.emit_history(),
                Err(e) => self.emit(Event::Error {
                    tab: None,
                    message: format!("favorite PR: {e}"),
                }),
            },
            Command::QueueAdd { pr, title } => {
                let now = now_rfc3339();
                match self.store.queue_add(&pr, &title, &now) {
                    Ok(()) => self.emit_history(),
                    Err(e) => self.emit(Event::Error {
                        tab: None,
                        message: format!("queue add: {e}"),
                    }),
                }
            }
            Command::QueueSetStatus { pr, status } => {
                match self.store.queue_set_status(&pr, &status) {
                    Ok(()) => self.emit_history(),
                    Err(e) => self.emit(Event::Error {
                        tab: None,
                        message: format!("queue status: {e}"),
                    }),
                }
            }
            Command::QueueRemove { pr } => match self.store.queue_remove(&pr) {
                Ok(()) => self.emit_history(),
                Err(e) => self.emit(Event::Error {
                    tab: None,
                    message: format!("queue remove: {e}"),
                }),
            },
            Command::QueueMove { pr, dir } => match self.store.queue_move(&pr, dir) {
                Ok(()) => self.emit_history(),
                Err(e) => self.emit(Event::Error {
                    tab: None,
                    message: format!("queue move: {e}"),
                }),
            },
            Command::QueueSetPriority { pr, on } => {
                let _ = self.store.queue_set_priority(&pr, on);
                self.emit_history();
            }
            Command::QueueSetFavorite { pr, on } => {
                let _ = self.store.queue_set_favorite(&pr, on);
                self.emit_history();
            }
        }
    }

    fn open(
        &mut self,
        pr: Option<PrRef>,
        cli: CliKind,
        cwd: Option<String>,
        fresh: bool,
        session_id_req: Option<String>,
    ) {
        let tab = self.alloc();

        // Resolve a working directory: for PR tabs, the PR's local repo (so reviews
        // run inside a git repo). If it isn't found on the machine, fall back to a
        // managed clone dir that we auto-create + populate (no dependency on the
        // user's local layout). Otherwise the caller's cwd / process cwd.
        let resolved = pr
            .as_ref()
            .and_then(|p| crate::workdir::resolve(p, cwd.as_deref()));
        let managed = pr
            .as_ref()
            .filter(|_| resolved.is_none())
            .map(|p| self.store.repo_clone_dir(p));
        if let Some(m) = &managed {
            let _ = std::fs::create_dir_all(m);
        }
        let spawn_cwd = resolved
            .as_ref()
            .or(managed.as_ref())
            .map(|p| p.display().to_string())
            .or_else(|| cwd.clone());

        // Resolve program + args. Shell resolves $SHELL; Claude gets session flags
        // (resume the chosen/most-recent session, or start a fresh one).
        let (base_prog, base_args) = cli.program();
        let mut program = base_prog.to_string();
        if program.is_empty() {
            program = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        }
        let mut args: Vec<String> = base_args.iter().map(|s| s.to_string()).collect();
        if cli == CliKind::Claude {
            args.extend(claude_perm_args(&self.claude_perm));
            if let Some(m) = &self.launch.claude_model {
                args.push("--model".into());
                args.push(m.clone());
            }
        }
        if cli == CliKind::Codex {
            if let Some(m) = &self.launch.codex_model {
                args.push("-m".into());
                args.push(m.clone());
            }
            if let Some(e) = &self.launch.codex_effort {
                args.push("-c".into());
                args.push(format!("model_reasoning_effort=\"{e}\""));
            }
            if let Some(a) = &self.launch.codex_approval {
                args.push("-a".into());
                args.push(a.clone());
            }
            if let Some(s) = &self.launch.codex_sandbox {
                args.push("-s".into());
                args.push(s.clone());
            }
        }

        let mut session_id: Option<String> = None;
        let mut forked_live = false;
        if cli == CliKind::Claude {
            if let Some(p) = &pr {
                let mut chosen = if let Some(id) = session_id_req {
                    Some(id) // resume this exact session
                } else if !fresh {
                    self.store.most_recent_session(p) // resume the latest, if any
                } else {
                    None // explicit "New"
                };
                // Never resume a session that's already live in another tab — Claude
                // refuses a double-resume. Fork to a fresh session instead.
                if let Some(id) = &chosen {
                    if self
                        .tabs
                        .values()
                        .any(|t| t.session_id.as_deref() == Some(id.as_str()))
                    {
                        forked_live = true;
                        chosen = None;
                    }
                }
                match chosen {
                    Some(id) => {
                        args.push("--resume".into());
                        args.push(id.clone());
                        session_id = Some(id);
                    }
                    None => {
                        let id = new_uuid();
                        args.push("--session-id".into());
                        args.push(id.clone());
                        session_id = Some(id);
                    }
                }
            }
        }

        let sink = self.sink.clone();
        let session = match Session::spawn(
            tab,
            &program,
            &args,
            spawn_cwd.as_deref(),
            80,
            24,
            sink,
            self.reaper_tx.clone(),
        ) {
            Ok(s) => s,
            Err(e) => {
                self.emit(Event::Error {
                    tab: None,
                    message: format!("spawn failed: {e}"),
                });
                return;
            }
        };

        let title = match &pr {
            Some(p) => p.short_label(),
            None => format!("shell {tab}"),
        };
        self.tabs.insert(
            tab,
            Tab {
                session,
                pr: pr.clone(),
                cli,
                session_id: session_id.clone(),
                cwd: spawn_cwd.clone(),
                title: title.clone(),
            },
        );
        self.order.push(tab);
        self.emit(Event::TabOpened {
            tab,
            title,
            pr: pr.clone(),
            cli,
        });
        self.persist_layout(None);
        if forked_live {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: "that session is already open — started a new one".into(),
            });
        }

        // PR metadata + history, off the lock, on a worker thread.
        if let Some(pr) = pr {
            let now = now_rfc3339();
            // Record the open (adds/bumps the session) so it survives a missing token.
            let _ = self
                .store
                .record_open(&pr, &pr.full_label(), cli, session_id.as_deref(), &now);
            // Refresh the sidebar now — history is recorded on OPEN (not close), so the
            // just-opened PR should appear immediately. The gh-meta thread below
            // re-emits once the real title resolves.
            self.emit_history();

            // Working dir: either check out the PR branch in the found repo, or tell
            // the user we couldn't locate it (reviews won't have a repo otherwise).
            // Prepare the repo in the background: either checkout in the existing
            // local clone, or init+clone into the managed dir, then checkout the PR.
            let dir = resolved.clone().or_else(|| managed.clone());
            if let Some(dir) = dir {
                let disp = dir.display().to_string();
                let needs_clone = managed.is_some() && !dir.join(".git").exists();
                let owner = pr.owner.clone();
                let repo = pr.repo.clone();
                let n = pr.number;
                let s = self.sink.clone();
                self.emit(Event::Notice {
                    tab: Some(tab),
                    message: if needs_clone {
                        format!("cloning {owner}/{repo} → {disp}…")
                    } else {
                        format!("repo: {disp} · checking out PR #{n}…")
                    },
                });
                std::thread::spawn(move || {
                    if needs_clone {
                        // git init + remote so `gh pr checkout` can fetch into the dir
                        // (works even though the CLI is already running there).
                        let url = format!("https://github.com/{owner}/{repo}.git");
                        for args in [vec!["init", "-q"], vec!["remote", "add", "origin", &url]] {
                            let _ = std::process::Command::new("git")
                                .args(&args)
                                .current_dir(&dir)
                                .output();
                        }
                    }
                    let out = std::process::Command::new("gh")
                        .args(["pr", "checkout", &n.to_string()])
                        .current_dir(&dir)
                        .output();
                    let msg = match out {
                        Ok(o) if o.status.success() => format!("✓ PR #{n} ready in {disp}"),
                        Ok(o) => format!("prepare repo #{n} failed: {}", first_line(&o.stderr)),
                        Err(e) => format!("gh pr checkout: {e}"),
                    };
                    s(Event::Notice {
                        tab: Some(tab),
                        message: msg,
                    });
                });
            }

            match self.github() {
                Some(gh) => {
                    let sink = self.sink.clone();
                    let store = self.store.clone();
                    std::thread::spawn(move || match gh.pr_meta(&pr) {
                        Ok(meta) => {
                            // Update the title only (no session change), then re-emit
                            // history so the sidebar entry shows the real PR title.
                            let _ = store.record_open(&pr, &meta.title, cli, None, &now);
                            let (entries, favorites, queue) = history_payload(&store);
                            sink(Event::History {
                                entries,
                                favorites,
                                queue,
                            });
                            sink(Event::PrMeta { tab, meta });
                        }
                        Err(e) => sink(Event::Notice {
                            tab: Some(tab),
                            message: format!("PR metadata unavailable: {e}"),
                        }),
                    });
                }
                None => self.emit(Event::Notice {
                    tab: Some(tab),
                    message: "no GitHub token — PR metadata disabled (run `gh auth login`)".into(),
                }),
            }
        }
    }

    fn close(&mut self, tab: TabId) {
        // Dropping the Tab kills the PTY; the wait-thread then signals the reaper.
        // An unknown tab is normal here — the process may have self-exited and already
        // been reaped — so this is a silent no-op rather than an error.
        self.stop_brain(tab);
        let existed = self.tabs.remove(&tab).is_some();
        self.order.retain(|&t| t != tab);
        if existed {
            self.persist_layout(None);
        }
    }

    /// The tab's live working directory (a shell that `cd`'d → where it is now), falling
    /// back to the dir it was spawned in.
    fn live_cwd(&self, t: &Tab) -> Option<String> {
        t.session
            .pid()
            .and_then(crate::macproc::cwd_of)
            .or_else(|| t.cwd.clone())
    }

    /// Snapshot the open tabs (in order) + the focused one, and write them to disk so the
    /// next launch can restore the session. `active` is the focused tab, if known.
    fn persist_layout(&self, active: Option<TabId>) {
        let entries: Vec<LayoutEntry> = self
            .order
            .iter()
            .filter_map(|id| self.tabs.get(id).map(|t| (id, t)))
            .map(|(_, t)| LayoutEntry {
                pr: t.pr.clone(),
                cli: t.cli,
                session_id: t.session_id.clone(),
                cwd: self.live_cwd(t),
                title: t.title.clone(),
            })
            .collect();
        let active = active.and_then(|a| {
            self.order
                .iter()
                .filter(|id| self.tabs.contains_key(id))
                .position(|&id| id == a)
        });
        let _ = self.store.write_layout(&Layout {
            entries,
            active,
            windows: vec![],
        });
    }

    /// Persist the layout WITH the frontend's tile structure. The trees arrive with live
    /// `TabId`s as leaves; we order the entries by the trees' flattened leaf order, remap the
    /// trees to entry indices, and store both. A `None` tree falls back to the flat write.
    fn persist_layout_with(&self, active: Option<TabId>, windows: Option<Vec<WinLayout>>) {
        let Some(wins) = windows else {
            return self.persist_layout(active);
        };
        // Flattened leaf order across windows (left-to-right), keeping only live tabs.
        let mut order: Vec<TabId> = Vec::new();
        for w in &wins {
            collect_leaves(&w.tree, &mut order);
        }
        order.retain(|id| self.tabs.contains_key(id));
        // Safety net: append any live tab the trees forgot (shouldn't happen) so no session is lost.
        for id in &self.order {
            if self.tabs.contains_key(id) && !order.contains(id) {
                order.push(*id);
            }
        }
        let index_of: std::collections::HashMap<TabId, u64> = order
            .iter()
            .enumerate()
            .map(|(i, id)| (*id, i as u64))
            .collect();
        let entries: Vec<LayoutEntry> = order
            .iter()
            .filter_map(|id| self.tabs.get(id))
            .map(|t| LayoutEntry {
                pr: t.pr.clone(),
                cli: t.cli,
                session_id: t.session_id.clone(),
                cwd: self.live_cwd(t),
                title: t.title.clone(),
            })
            .collect();
        // Remap each window's tree from TabIds → entry indices, dropping any leaf whose tab died
        // (collapsing its split, mirroring the frontend's removeLeaf).
        let windows: Vec<WinLayout> = wins
            .iter()
            .filter_map(|w| {
                let tree = remap_tree(&w.tree, &index_of)?;
                Some(WinLayout {
                    tree,
                    focus: index_of.get(&w.focus).copied().unwrap_or(0),
                    root: index_of.get(&w.root).copied().unwrap_or(0),
                })
            })
            .collect();
        let active = active.and_then(|a| index_of.get(&a).map(|i| *i as usize));
        let _ = self.store.write_layout(&Layout {
            entries,
            active,
            windows,
        });
    }

    /// Restore the persisted layout — but only on a FRESH engine. If tabs are already open
    /// (the frontend reloaded / HMR'd against a live engine), re-emit the existing tabs to
    /// re-sync the UI instead of opening duplicates. `restore` is the persist preference;
    /// when off, a fresh engine opens nothing.
    /// Re-emit a live tab to a (re)syncing frontend: `TabOpened` + a replay of its buffered
    /// PTY output so the new xterm repaints instead of stalling.
    fn reemit_tab(&self, tab: TabId) {
        if let Some(t) = self.tabs.get(&tab) {
            self.emit(Event::TabOpened {
                tab,
                title: t.title.clone(),
                pr: t.pr.clone(),
                cli: t.cli,
            });
            let bytes = t.session.replay();
            if !bytes.is_empty() {
                self.emit(Event::Output { tab, bytes });
            }
        }
    }

    /// Map each saved layout entry to a live tab id (by session id, else pr+cli+title), in the
    /// saved order. `Some(ids)` only if every entry matched a distinct live tab and all live
    /// tabs were consumed — so the saved window tree's indices line up with the re-emit order.
    fn match_saved_to_live(&self, saved: &Layout) -> Option<Vec<TabId>> {
        let mut pool: Vec<TabId> = self.order.clone();
        let mut ordered: Vec<TabId> = Vec::with_capacity(saved.entries.len());
        for e in &saved.entries {
            let pos = pool.iter().position(|id| {
                self.tabs.get(id).is_some_and(|t| {
                    match (e.session_id.as_deref(), t.session_id.as_deref()) {
                        (Some(a), Some(b)) => a == b,
                        _ => t.pr == e.pr && t.cli == e.cli && t.title == e.title,
                    }
                })
            })?;
            ordered.push(pool.remove(pos));
        }
        pool.is_empty().then_some(ordered)
    }

    fn load_layout(&mut self, restore: bool) {
        if !self.tabs.is_empty() {
            // A frontend reload against a live engine. Re-emit the open tabs so the UI re-syncs.
            // Tile-aware: if the saved tree's entries map 1:1 to the live tabs (by session id,
            // else pr+cli+title), re-emit them in the saved order WITH `LayoutRestore` so the
            // reloaded frontend rebuilds its splits instead of flattening to one window per tab.
            let saved = self.store.read_layout();
            let ordered = (!saved.windows.is_empty() && saved.entries.len() == self.tabs.len())
                .then(|| self.match_saved_to_live(&saved))
                .flatten();
            if let Some(ordered) = ordered {
                self.emit(Event::LayoutRestore {
                    windows: saved.windows.clone(),
                    active: saved.active,
                });
                for tab in ordered {
                    self.reemit_tab(tab);
                }
                return;
            }
            // Fallback: flat re-sync in open order.
            for tab in self.order.clone() {
                self.reemit_tab(tab);
            }
            return;
        }
        if restore {
            let layout = self.store.read_layout();
            // Hand the frontend the saved tile structure BEFORE the TabOpened burst, so it can
            // rebuild windows/panes by mapping the Nth restored tab to entry index N. We open
            // entries in their stored order (which is the trees' flattened leaf order), so that
            // mapping holds. Empty `windows` → the frontend falls back to one window per tab.
            if !layout.windows.is_empty() {
                self.emit(Event::LayoutRestore {
                    windows: layout.windows.clone(),
                    active: layout.active,
                });
            }
            for e in layout.entries {
                self.open(e.pr, e.cli, e.cwd, false, e.session_id);
            }
        }
    }

    /// Drop tabs whose child process has exited on its own. Keeps the tab map
    /// authoritative so the resume "is this session still live?" check never sees a
    /// stale entry and spuriously forks. Drained at the start of every `handle`.
    fn reap_dead(&mut self) {
        let mut reaped = false;
        while let Ok(tab) = self.reaper_rx.try_recv() {
            self.stop_brain(tab);
            if self.tabs.remove(&tab).is_some() {
                self.order.retain(|&t| t != tab);
                reaped = true;
            }
        }
        if reaped {
            self.persist_layout(None);
        }
    }

    /// Count of live tabs — observability + tests.
    pub fn tab_count(&self) -> usize {
        self.tabs.len()
    }

    fn input(&mut self, tab: TabId, bytes: &[u8]) {
        match self.tabs.get_mut(&tab) {
            Some(t) => {
                if let Err(e) = t.session.write_input(bytes) {
                    self.emit(Event::Notice {
                        tab: Some(tab),
                        message: format!("input: {e}"),
                    });
                }
            }
            None => self.emit(Event::Notice {
                tab: Some(tab),
                message: "input: unknown tab".into(),
            }),
        }
    }

    fn resize(&mut self, tab: TabId, cols: u16, rows: u16) {
        if let Some(t) = self.tabs.get(&tab) {
            let _ = t.session.resize(cols, rows);
        }
    }

    fn button(&mut self, tab: TabId, button: ReviewButton, agent: Option<CliKind>) {
        let (cli, pr) = match self.tabs.get(&tab) {
            Some(t) => (agent.unwrap_or(t.cli), t.pr.clone()),
            None => {
                self.emit(Event::Notice {
                    tab: Some(tab),
                    message: "button: unknown tab".into(),
                });
                return;
            }
        };
        let Some(keys) = dispatch::keystrokes(button, cli, pr.as_ref()) else {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: format!("{:?} has no macro for {:?}", button, cli),
            });
            return;
        };
        let err = self
            .tabs
            .get_mut(&tab)
            .and_then(|t| t.session.write_then_submit(keys.as_bytes()).err());
        if let Some(e) = err {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: format!("button: {e}"),
            });
        }
    }

    fn start_review(&mut self, tab: TabId, tier: ReviewTier, agent: Option<CliKind>) {
        let (cli, pr) = match self.tabs.get(&tab) {
            Some(t) => (agent.unwrap_or(t.cli), t.pr.clone()),
            None => {
                self.emit(Event::Notice {
                    tab: Some(tab),
                    message: "review: unknown tab".into(),
                });
                return;
            }
        };
        let Some(keys) = dispatch::tier_keystrokes(tier, cli, pr.as_ref()) else {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: format!("{:?} review has no macro for {:?}", tier, cli),
            });
            return;
        };
        let err = self
            .tabs
            .get_mut(&tab)
            .and_then(|t| t.session.write_then_submit(keys.as_bytes()).err());
        if let Some(e) = err {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: format!("review: {e}"),
            });
        }
    }

    /// Type the `/pr-coreview` pipeline macro into a CLAUDE tab. The skill orchestrates
    /// both engines itself (claude reviews/distills, codex runs headless via `codex exec`),
    /// so unlike `start_review` there is no agent override — a non-claude tab is an error.
    fn start_co_review(
        &mut self,
        tab: TabId,
        first: CliKind,
        claude_tier: ReviewTier,
        codex_tier: ReviewTier,
    ) {
        let (cli, pr) = match self.tabs.get(&tab) {
            Some(t) => (t.cli, t.pr.clone()),
            None => {
                self.emit(Event::Notice {
                    tab: Some(tab),
                    message: "co-review: unknown tab".into(),
                });
                return;
            }
        };
        if cli != CliKind::Claude {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: format!("co-review needs a claude tab (this is {:?})", cli),
            });
            return;
        }
        let keys = dispatch::coreview_keystrokes(first, claude_tier, codex_tier, pr.as_ref());
        let err = self
            .tabs
            .get_mut(&tab)
            .and_then(|t| t.session.write_then_submit(keys.as_bytes()).err());
        if let Some(e) = err {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: format!("co-review: {e}"),
            });
        }
    }

    /// Type the `/pr-tandem` group-review macro into a CLAUDE tab (the skill maps the
    /// PRs' relationships, reviews each in group context, and — under `co` — runs the
    /// two-engine pipeline over the whole group). Claude-only, like `start_co_review`.
    fn start_tandem_review(
        &mut self,
        tab: TabId,
        prs: Vec<PrRef>,
        claude_tier: ReviewTier,
        co: bool,
        first: Option<CliKind>,
        codex_tier: Option<ReviewTier>,
    ) {
        let cli = match self.tabs.get(&tab) {
            Some(t) => t.cli,
            None => {
                self.emit(Event::Notice {
                    tab: Some(tab),
                    message: "tandem: unknown tab".into(),
                });
                return;
            }
        };
        if cli != CliKind::Claude {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: format!("tandem review needs a claude tab (this is {:?})", cli),
            });
            return;
        }
        if prs.is_empty() {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: "tandem: no PRs given".into(),
            });
            return;
        }
        let keys = dispatch::tandem_keystrokes(
            &prs,
            claude_tier,
            co,
            first.unwrap_or(CliKind::Claude),
            codex_tier.unwrap_or(claude_tier),
        );
        let err = self
            .tabs
            .get_mut(&tab)
            .and_then(|t| t.session.write_then_submit(keys.as_bytes()).err());
        if let Some(e) = err {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: format!("tandem: {e}"),
            });
        }
    }

    fn load_panel(&mut self, tab: TabId) {
        let pr = match self.tabs.get(&tab) {
            Some(t) => t.pr.clone(),
            None => {
                self.emit(Event::Notice {
                    tab: Some(tab),
                    message: "panel: unknown tab".into(),
                });
                return;
            }
        };
        let Some(pr) = pr else {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: "panel: tab is not a PR".into(),
            });
            return;
        };
        match self.store.latest_review(&pr) {
            Some((_, content)) => self.emit(Event::Panel {
                tab,
                payload: PanelPayload {
                    kind: "markdown".into(),
                    title: format!("Latest review — {}", pr.short_label()),
                    body: content,
                },
            }),
            None => self.emit(Event::Notice {
                tab: Some(tab),
                message: "no saved review yet for this PR".into(),
            }),
        }
    }

    /// Fetch the tab's PR diff + existing review comments (network-bound, on a worker
    /// thread so the engine lock isn't held across I/O) and emit `Event::Diff`.
    fn load_diff(&mut self, tab: TabId) {
        let pr = match self.tabs.get(&tab) {
            Some(t) => t.pr.clone(),
            None => {
                self.emit(Event::Notice {
                    tab: Some(tab),
                    message: "diff: unknown tab".into(),
                });
                return;
            }
        };
        let Some(pr) = pr else {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: "diff: this tab is not a PR".into(),
            });
            return;
        };
        let Some(gh) = self.github() else {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: "no GitHub token — diff unavailable (run `gh auth login`)".into(),
            });
            return;
        };
        self.emit(Event::Notice {
            tab: Some(tab),
            message: format!("loading diff for {}…", pr.short_label()),
        });
        let sink = self.sink.clone();
        std::thread::spawn(move || match gh.pr_diff(&pr) {
            Ok(diff) => {
                let comments = gh.pr_review_comments(&pr).unwrap_or_default();
                sink(Event::Diff {
                    tab,
                    diff,
                    comments,
                });
            }
            Err(e) => sink(Event::Notice {
                tab: Some(tab),
                message: format!("diff: {e}"),
            }),
        });
    }

    /// Fetch the tab's PR conversation comments + inline review threads (one GraphQL
    /// round-trip, on a worker thread) and emit `Event::Comments`.
    fn load_comments(&mut self, tab: TabId) {
        let pr = match self.tabs.get(&tab) {
            Some(t) => t.pr.clone(),
            None => {
                self.emit(Event::Notice {
                    tab: Some(tab),
                    message: "comments: unknown tab".into(),
                });
                return;
            }
        };
        let Some(pr) = pr else {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: "comments: this tab is not a PR".into(),
            });
            return;
        };
        let Some(gh) = self.github() else {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: "no GitHub token — comments unavailable (run `gh auth login`)".into(),
            });
            return;
        };
        let sink = self.sink.clone();
        std::thread::spawn(move || match gh.pr_comments(&pr) {
            Ok(comments) => sink(Event::Comments { tab, comments }),
            Err(e) => sink(Event::Notice {
                tab: Some(tab),
                message: format!("comments: {e}"),
            }),
        });
    }

    /// List the tab repo's tracked files (`git ls-files` in its live cwd) for the diff
    /// file-tree panel, on a worker thread. A non-repo / failure yields an empty list.
    fn load_repo_tree(&mut self, tab: TabId) {
        let cwd = self.tabs.get(&tab).and_then(|t| self.live_cwd(t));
        let Some(cwd) = cwd else {
            self.emit(Event::RepoTree {
                tab,
                files: Vec::new(),
            });
            return;
        };
        let sink = self.sink.clone();
        std::thread::spawn(move || {
            let files = git_ls_files(&cwd).unwrap_or_default();
            sink(Event::RepoTree { tab, files });
        });
    }

    /// Fetch review/merge status for a batch of PRs on a worker thread (drives the tree
    /// status widgets). A missing token or fetch error degrades to no badges.
    fn load_pr_statuses(&mut self, prs: Vec<PrRef>) {
        if prs.is_empty() {
            return;
        }
        let Some(gh) = self.github() else { return };
        let sink = self.sink.clone();
        std::thread::spawn(move || match gh.pr_statuses(&prs) {
            Ok(statuses) => sink(Event::PrStatuses { statuses }),
            Err(e) => sink(Event::Notice {
                tab: None,
                message: format!("pr status: {e}"),
            }),
        });
    }

    /// Fetch open PRs from every watched user (+ expanded team members) on a worker thread,
    /// each with status. One search per user (keeps under the search query-length cap).
    fn load_team_prs(&mut self) {
        let watches = self.store.watches();
        let Some(gh) = self.github() else {
            self.emit(Event::Notice {
                tab: None,
                message: "no GitHub token — teams unavailable (run `gh auth login`)".into(),
            });
            return;
        };
        let sink = self.sink.clone();
        std::thread::spawn(move || {
            let mut users = watches.users.clone();
            for slug in &watches.teams {
                if let Some((org, team)) = slug.split_once('/') {
                    if let Ok(members) = gh.team_members(org, team) {
                        users.extend(members);
                    }
                }
            }
            users.sort_by_key(|u| u.to_lowercase());
            users.dedup_by(|a, b| a.eq_ignore_ascii_case(b));

            let mut prs: Vec<PrStatus> = Vec::new();
            for u in &users {
                let q = format!("is:pr is:open archived:false sort:updated-desc author:{u}");
                if let Ok(mut found) = gh.search_prs(&q, 30) {
                    prs.append(&mut found);
                }
            }
            sink(Event::TeamPrs { prs });
        });
    }

    /// Summarize each changed file in the tab's PR diff via Haiku (worker thread).
    /// Proxy-fetch a GitHub-hosted image with auth (off the engine lock) and reply with a data URL
    /// the webview can render — for private-repo comment attachments it can't load itself.
    fn fetch_image(&mut self, url: String) {
        let Some(gh) = self.github() else { return };
        let sink = self.sink.clone();
        std::thread::spawn(move || {
            if let Ok((bytes, ct)) = gh.fetch_image(&url) {
                let data_url = format!("data:{ct};base64,{}", crate::github::base64_encode(&bytes));
                sink(Event::Image { url, data_url });
            }
            // On failure, stay silent — the <img> just remains broken.
        });
    }

    fn summarize_diff(&mut self, tab: TabId, path: Option<String>) {
        let pr = self.tabs.get(&tab).and_then(|t| t.pr.clone());
        let Some(pr) = pr else {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: "summary: this tab isn't a pull request".into(),
            });
            return;
        };
        let cwd = self.tabs.get(&tab).and_then(|t| self.live_cwd(t));
        let Some(gh) = self.github() else {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: "no GitHub token — diff summary unavailable".into(),
            });
            return;
        };
        let sink = self.sink.clone();
        std::thread::spawn(move || {
            let diff = match gh.pr_diff(&pr) {
                Ok(d) => d,
                Err(e) => {
                    sink(Event::Notice {
                        tab: Some(tab),
                        message: format!("summary: {e}"),
                    });
                    return;
                }
            };
            // Per-file button: slice to just that file's chunk (fall back to the whole diff).
            let diff = match path
                .as_deref()
                .and_then(|p| crate::summary::slice_diff_to_file(&diff, p))
            {
                Some(sliced) => sliced,
                None => diff,
            };
            match crate::summary::summarize_diff(&diff, cwd.as_deref()) {
                Ok(pairs) => sink(Event::DiffSummaries {
                    tab,
                    summaries: pairs
                        .into_iter()
                        .map(|(path, summary)| crate::protocol::FileSummary { path, summary })
                        .collect(),
                }),
                Err(e) => sink(Event::Notice {
                    tab: Some(tab),
                    message: format!("summary: {e}"),
                }),
            }
        });
    }

    /// Run a comment-write mutation (`op`) on a worker thread, then re-fetch the PR's
    /// comments and emit a fresh `Event::Comments` so the UI reflects authoritative
    /// state. Shared by reactions, new comments, replies, and review submission.
    fn comment_mutation<F>(&mut self, tab: TabId, op: F)
    where
        F: FnOnce(&GitHub, &PrRef) -> crate::error::Result<()> + Send + 'static,
    {
        let pr = match self.tabs.get(&tab).and_then(|t| t.pr.clone()) {
            Some(pr) => pr,
            None => {
                self.emit(Event::Notice {
                    tab: Some(tab),
                    message: "comment: this tab is not a PR".into(),
                });
                return;
            }
        };
        let Some(gh) = self.github() else {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: "no GitHub token — can't write (run `gh auth login`)".into(),
            });
            return;
        };
        let sink = self.sink.clone();
        std::thread::spawn(move || {
            if let Err(e) = op(&gh, &pr) {
                sink(Event::Notice {
                    tab: Some(tab),
                    message: format!("comment: {e}"),
                });
                return;
            }
            match gh.pr_comments(&pr) {
                Ok(comments) => sink(Event::Comments { tab, comments }),
                Err(e) => sink(Event::Notice {
                    tab: Some(tab),
                    message: format!("comments: {e}"),
                }),
            }
        });
    }

    /// Ask Claude a bite-size question off the main thread — spawn a forked headless
    /// `claude -p` one-shot and stream its reply back as `Event::Insight`s (see `insight`).
    /// Forks the tab's Claude session when it has one (so the answer carries the review's
    /// context); otherwise runs a fresh one-shot in the tab's live cwd.
    fn ask_insight(&mut self, tab: TabId, id: String, prompt: String) {
        let (session_id, cwd) = match self.tabs.get(&tab) {
            Some(t) => {
                // Only fork an actual Claude session; other engines get a fresh one-shot.
                let sid = if t.cli == CliKind::Claude {
                    t.session_id.clone()
                } else {
                    None
                };
                (sid, self.live_cwd(t))
            }
            None => (None, None),
        };
        let sink = self.sink.clone();
        std::thread::spawn(move || crate::insight::run(tab, id, prompt, session_id, cwd, sink));
    }

    /// Start streaming the tab's Claude session thinking to the brain panel. No-op if
    /// the tab has no session id (non-Claude / session-less) or is already watched.
    fn watch_brain(&mut self, tab: TabId) {
        if self.brain_watchers.contains_key(&tab) {
            return;
        }
        let Some(session_id) = self.tabs.get(&tab).and_then(|t| t.session_id.clone()) else {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: "brain: this tab has no Claude session to read".into(),
            });
            return;
        };
        let stop = Arc::new(AtomicBool::new(false));
        self.brain_watchers.insert(tab, stop.clone());
        let sink = self.sink.clone();
        std::thread::spawn(move || crate::brain::watch(session_id, tab, sink, stop));
    }

    /// Stop a tab's brain watcher (panel closed / tab switched / tab closed).
    fn stop_brain(&mut self, tab: TabId) {
        if let Some(stop) = self.brain_watchers.remove(&tab) {
            stop.store(true, Ordering::Relaxed);
        }
    }

    fn save_review(&mut self, tab: TabId, content: &str) {
        let Some(t) = self.tabs.get(&tab) else {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: "save: unknown tab".into(),
            });
            return;
        };
        let Some(pr) = t.pr.clone() else {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: "save: tab is not a PR".into(),
            });
            return;
        };
        match self.store.save_review(&pr, content, &now_file_stamp()) {
            Ok(path) => self.emit(Event::ReviewSaved {
                tab,
                path: path.display().to_string(),
            }),
            Err(e) => self.emit(Event::Error {
                tab: Some(tab),
                message: format!("save: {e}"),
            }),
        }
    }
}

fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn first_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .to_string()
}

/// Tracked files (repo-relative paths) under `cwd`, via `git ls-files`. `None` when the
/// dir isn't a git repo or git can't run. Resolves `git` against the login PATH so a
/// Finder-launched app finds it.
fn git_ls_files(cwd: &str) -> Option<Vec<String>> {
    let path = crate::shellenv::login_path();
    let git = crate::shellenv::resolve_program("git", path);
    let out = std::process::Command::new(&git)
        .args(["-C", cwd, "ls-files"])
        .env("PATH", path)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

/// Build the `Event::History` payload: history records with each session's message count
/// filled in (read from its transcript), the persisted favorites, and the review queue.
/// Reads files, so run it off the engine lock (see `emit_history`).
fn history_payload(
    store: &Store,
) -> (
    Vec<crate::protocol::PrRecord>,
    crate::protocol::Favorites,
    crate::protocol::Queue,
) {
    let mut entries = store.history();
    for r in &mut entries {
        for s in &mut r.sessions {
            s.messages = crate::brain::count_messages(&s.id);
        }
    }
    (entries, store.favorites(), store.queue())
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

fn now_file_stamp() -> String {
    let fmt = format_description!("[year][month][day]-[hour][minute][second]");
    OffsetDateTime::now_utc()
        .format(&fmt)
        .unwrap_or_else(|_| "review".into())
}

/// Collect a pane tree's leaf ids (left-to-right) — used to order entries by tile layout.
fn collect_leaves(tree: &PaneTree, out: &mut Vec<TabId>) {
    match tree {
        PaneTree::Leaf { i } => out.push(*i),
        PaneTree::Split { a, b, .. } => {
            collect_leaves(a, out);
            collect_leaves(b, out);
        }
    }
}

/// Remap a TabId-keyed pane tree to entry indices via `index_of`. Leaves whose tab is gone
/// drop out, collapsing their split (mirrors the frontend's `removeLeaf`); a whole-tree miss
/// returns `None`.
fn remap_tree(
    tree: &PaneTree,
    index_of: &std::collections::HashMap<TabId, u64>,
) -> Option<PaneTree> {
    match tree {
        PaneTree::Leaf { i } => index_of.get(i).map(|&idx| PaneTree::Leaf { i: idx }),
        PaneTree::Split { dir, ratio, a, b } => {
            match (remap_tree(a, index_of), remap_tree(b, index_of)) {
                (Some(a), Some(b)) => Some(PaneTree::Split {
                    dir: dir.clone(),
                    ratio: *ratio,
                    a: Box::new(a),
                    b: Box::new(b),
                }),
                (Some(n), None) | (None, Some(n)) => Some(n),
                (None, None) => None,
            }
        }
    }
}
