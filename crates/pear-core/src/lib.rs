//! `pear-core` — the in-process, frontend-agnostic core of the pear PR control center.
//!
//! A frontend creates an [`Engine`] with an [`EventSink`], feeds it [`Command`]s, and
//! renders the [`Event`]s it emits. The same [`Command`]/[`Event`] protocol is what a
//! future daemon transport (ARCHITECTURE.md branch B1) would serialize — so swapping
//! the frontend or the transport never touches this crate.
//!
//! ```no_run
//! use std::sync::Arc;
//! use pear_core::{Engine, Command, CliKind};
//!
//! let sink = Arc::new(|event| println!("{event:?}"));
//! let mut engine = Engine::new(sink).unwrap();
//! engine.handle(Command::OpenScratch { cli: CliKind::Shell, cwd: None, session_id: None });
//! ```

pub mod brain;
pub mod dispatch;
pub mod engine;
pub mod error;
pub mod github;
pub mod insight;
pub mod macproc;
pub mod protocol;
pub mod session;
pub mod shellenv;
pub mod skills_install;
pub mod store;
pub mod summary;
pub mod workdir;

pub use engine::Engine;
pub use error::{CoreError, Result};
pub use github::GitHub;
pub use protocol::{
    CliKind, Command, Event, Layout, LayoutEntry, PrMeta, PrRecord, PrRef, ReviewButton,
    SessionRec, TabId,
};
pub use session::EventSink;
pub use store::Store;
