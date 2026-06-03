//! The engine owns all tab/session state and is the single place a [`Command`] is
//! turned into side effects + [`Event`]s. Frontends never touch sessions directly.
//!
//! Threading model: `handle` takes `&mut self`; wrap the engine in a `Mutex` on the
//! frontend side. Network-bound PR metadata is fetched on a worker thread so the
//! lock is never held across I/O (the `PrMeta` event may therefore arrive after
//! `TabOpened`, which the protocol allows).

use std::collections::HashMap;

use time::format_description::well_known::Rfc3339;
use time::macros::format_description;
use time::OffsetDateTime;

use crate::dispatch;
use crate::error::Result;
use crate::github::GitHub;
use crate::protocol::{
    CliKind, Command, Event, PanelPayload, PrRef, ReviewButton, ReviewTier, TabId,
};
use crate::session::{EventSink, Session};
use crate::store::Store;

struct Tab {
    session: Session,
    pr: Option<PrRef>,
    cli: CliKind,
    /// The Claude session id this tab is running (so we never resume a live one twice).
    session_id: Option<String>,
}

pub struct Engine {
    sink: EventSink,
    store: Store,
    github: Option<GitHub>,
    next: TabId,
    tabs: HashMap<TabId, Tab>,
    /// Claude `--permission-mode` for launches (see `CLAUDE_PERM_MODES`).
    claude_perm: String,
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
        Ok(Engine {
            sink,
            store,
            github,
            next: 1,
            tabs: HashMap::new(),
            claude_perm: "auto".to_string(),
        })
    }

    fn emit(&self, e: Event) {
        (self.sink)(e);
    }

    fn alloc(&mut self) -> TabId {
        let id = self.next;
        self.next += 1;
        id
    }

    /// Single entry point. Returns `Ok` even for "soft" failures (those are emitted
    /// as `Event::Notice`/`Event::Error` so the UI can surface them per-tab).
    pub fn handle(&mut self, cmd: Command) {
        match cmd {
            Command::OpenPr {
                pr,
                cli,
                cwd,
                fresh,
                session_id,
            } => self.open(Some(pr), cli, cwd, fresh, session_id),
            Command::OpenScratch { cli, cwd } => self.open(None, cli, cwd, false, None),
            Command::CloseTab { tab } => self.close(tab),
            Command::Input { tab, bytes } => self.input(tab, &bytes),
            Command::Resize { tab, cols, rows } => self.resize(tab, cols, rows),
            Command::Button { tab, button } => self.button(tab, button),
            Command::StartReview { tab, tier } => self.start_review(tab, tier),
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
            Command::LoadHistory => self.emit(Event::History {
                entries: self.store.history(),
            }),
            Command::ClearHistory => match self.store.clear_history() {
                Ok(n) => {
                    self.emit(Event::Notice {
                        tab: None,
                        message: format!("cleared {n} PR(s) — Restore to undo"),
                    });
                    self.emit(Event::History {
                        entries: self.store.history(),
                    });
                }
                Err(e) => self.emit(Event::Error {
                    tab: None,
                    message: format!("clear history: {e}"),
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
                    self.emit(Event::History {
                        entries: self.store.history(),
                    });
                }
                Err(e) => self.emit(Event::Error {
                    tab: None,
                    message: format!("restore history: {e}"),
                }),
            },
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
        let session = match Session::spawn(tab, &program, &args, spawn_cwd.as_deref(), 80, 24, sink)
        {
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
            },
        );
        self.emit(Event::TabOpened {
            tab,
            title,
            pr: pr.clone(),
            cli,
        });
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

            match self.github.clone() {
                Some(gh) => {
                    let sink = self.sink.clone();
                    let store = self.store.clone();
                    std::thread::spawn(move || match gh.pr_meta(&pr) {
                        Ok(meta) => {
                            // Update the title only (no session change).
                            let _ = store.record_open(&pr, &meta.title, cli, None, &now);
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
        // Dropping the Tab kills the PTY; the session's wait-thread emits TabClosed.
        if self.tabs.remove(&tab).is_none() {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: "close: unknown tab".into(),
            });
        }
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

    fn button(&mut self, tab: TabId, button: ReviewButton) {
        let cli = match self.tabs.get(&tab) {
            Some(t) => t.cli,
            None => {
                self.emit(Event::Notice {
                    tab: Some(tab),
                    message: "button: unknown tab".into(),
                });
                return;
            }
        };
        let Some(keys) = dispatch::keystrokes(button, cli) else {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: format!("{:?} has no macro for {:?}", button, cli),
            });
            return;
        };
        let err = self
            .tabs
            .get_mut(&tab)
            .and_then(|t| t.session.write_input(keys.as_bytes()).err());
        if let Some(e) = err {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: format!("button: {e}"),
            });
        }
    }

    fn start_review(&mut self, tab: TabId, tier: ReviewTier) {
        let cli = match self.tabs.get(&tab) {
            Some(t) => t.cli,
            None => {
                self.emit(Event::Notice {
                    tab: Some(tab),
                    message: "review: unknown tab".into(),
                });
                return;
            }
        };
        let Some(keys) = dispatch::tier_keystrokes(tier, cli) else {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: format!("{:?} review has no macro for {:?}", tier, cli),
            });
            return;
        };
        let err = self
            .tabs
            .get_mut(&tab)
            .and_then(|t| t.session.write_input(keys.as_bytes()).err());
        if let Some(e) = err {
            self.emit(Event::Notice {
                tab: Some(tab),
                message: format!("review: {e}"),
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
