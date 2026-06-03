//! Core error type.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("no tab with id {0}")]
    NoSuchTab(u64),

    #[error("github: {0}")]
    GitHub(String),

    #[error(
        "no GitHub token available (set PEAR_GITHUB_TOKEN / GITHUB_TOKEN or run `gh auth login`)"
    )]
    NoToken,

    #[error("pty: {0}")]
    Pty(String),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("storage: {0}")]
    Storage(String),

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

pub type Result<T> = std::result::Result<T, CoreError>;
