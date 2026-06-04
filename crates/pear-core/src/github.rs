//! Minimal GitHub REST client (decision D3). Blocking, dependency-light (`ureq`).
//!
//! Token resolution order:
//!   1. `PEAR_GITHUB_TOKEN`
//!   2. `GITHUB_TOKEN`
//!   3. `gh auth token` (so an existing `gh login` Just Works)

use std::process::Command;

use crate::error::{CoreError, Result};
use crate::protocol::{DiffComment, PrMeta, PrRef};

const API: &str = "https://api.github.com";
const UA: &str = concat!("pear/", env!("CARGO_PKG_VERSION"));

/// Resolve a GitHub token from env or the `gh` CLI. `None` if unavailable.
pub fn resolve_token() -> Option<String> {
    for var in ["PEAR_GITHUB_TOKEN", "GITHUB_TOKEN"] {
        if let Ok(t) = std::env::var(var) {
            if !t.trim().is_empty() {
                return Some(t.trim().to_string());
            }
        }
    }
    let out = Command::new("gh").args(["auth", "token"]).output().ok()?;
    if out.status.success() {
        let t = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !t.is_empty() {
            return Some(t);
        }
    }
    None
}

#[derive(Clone)]
pub struct GitHub {
    token: String,
}

impl GitHub {
    pub fn new(token: impl Into<String>) -> Self {
        GitHub {
            token: token.into(),
        }
    }

    /// Construct from the resolved token, or [`CoreError::NoToken`].
    pub fn from_env() -> Result<Self> {
        resolve_token().map(GitHub::new).ok_or(CoreError::NoToken)
    }

    fn get(&self, path: &str) -> Result<serde_json::Value> {
        // ureq 3.x treats non-2xx as `Err(StatusCode)` by default and drops the body;
        // disable that so we can still surface GitHub's error message on failure.
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .build()
            .into();
        let mut resp = agent
            .get(format!("{API}{path}"))
            .header("Authorization", &format!("Bearer {}", self.token))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", UA)
            .call()
            .map_err(|e| CoreError::GitHub(e.to_string()))?;
        let status = resp.status();
        if status.is_success() {
            resp.body_mut()
                .read_json::<serde_json::Value>()
                .map_err(|e| CoreError::GitHub(e.to_string()))
        } else {
            let body = resp.body_mut().read_to_string().unwrap_or_default();
            Err(CoreError::GitHub(format!(
                "HTTP {}: {}",
                status.as_u16(),
                body.chars().take(200).collect::<String>()
            )))
        }
    }

    /// Raw GET with a custom `Accept` (e.g. the diff media type). Returns the body text.
    fn get_raw(&self, path: &str, accept: &str) -> Result<String> {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .build()
            .into();
        let mut resp = agent
            .get(format!("{API}{path}"))
            .header("Authorization", &format!("Bearer {}", self.token))
            .header("Accept", accept)
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", UA)
            .call()
            .map_err(|e| CoreError::GitHub(e.to_string()))?;
        let status = resp.status();
        let body = resp
            .body_mut()
            .read_to_string()
            .map_err(|e| CoreError::GitHub(e.to_string()))?;
        if status.is_success() {
            Ok(body)
        } else {
            Err(CoreError::GitHub(format!(
                "HTTP {}: {}",
                status.as_u16(),
                body.chars().take(200).collect::<String>()
            )))
        }
    }

    /// The PR's unified diff (via GitHub's `application/vnd.github.diff` media type).
    pub fn pr_diff(&self, pr: &PrRef) -> Result<String> {
        self.get_raw(
            &format!("/repos/{}/{}/pulls/{}", pr.owner, pr.repo, pr.number),
            "application/vnd.github.diff",
        )
    }

    /// Existing inline review comments on the PR, anchored to file + line.
    pub fn pr_review_comments(&self, pr: &PrRef) -> Result<Vec<DiffComment>> {
        let v = self.get(&format!(
            "/repos/{}/{}/pulls/{}/comments?per_page=100",
            pr.owner, pr.repo, pr.number
        ))?;
        Ok(v.as_array()
            .map(|arr| {
                arr.iter()
                    .map(|c| DiffComment {
                        path: c["path"].as_str().unwrap_or("").to_string(),
                        line: c["line"].as_u64().or_else(|| c["original_line"].as_u64()),
                        author: c["user"]["login"].as_str().unwrap_or("").to_string(),
                        body: c["body"].as_str().unwrap_or("").to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Fetch metadata for a single PR.
    pub fn pr_meta(&self, pr: &PrRef) -> Result<PrMeta> {
        let v = self.get(&format!(
            "/repos/{}/{}/pulls/{}",
            pr.owner, pr.repo, pr.number
        ))?;
        Ok(PrMeta {
            pr: pr.clone(),
            title: v["title"].as_str().unwrap_or("").to_string(),
            author: v["user"]["login"].as_str().unwrap_or("").to_string(),
            state: v["state"].as_str().unwrap_or("unknown").to_string(),
            draft: v["draft"].as_bool().unwrap_or(false),
            url: v["html_url"].as_str().unwrap_or("").to_string(),
            additions: v["additions"].as_u64().unwrap_or(0),
            deletions: v["deletions"].as_u64().unwrap_or(0),
            changed_files: v["changed_files"].as_u64().unwrap_or(0),
        })
    }

    /// List open PRs for a repo (lightweight; for a future picker UI).
    pub fn list_open(&self, owner: &str, repo: &str) -> Result<Vec<PrMeta>> {
        let v = self.get(&format!(
            "/repos/{owner}/{repo}/pulls?state=open&per_page=50"
        ))?;
        let arr = v.as_array().cloned().unwrap_or_default();
        Ok(arr
            .into_iter()
            .map(|item| PrMeta {
                pr: PrRef {
                    owner: owner.to_string(),
                    repo: repo.to_string(),
                    number: item["number"].as_u64().unwrap_or(0),
                },
                title: item["title"].as_str().unwrap_or("").to_string(),
                author: item["user"]["login"].as_str().unwrap_or("").to_string(),
                state: item["state"].as_str().unwrap_or("open").to_string(),
                draft: item["draft"].as_bool().unwrap_or(false),
                url: item["html_url"].as_str().unwrap_or("").to_string(),
                additions: 0,
                deletions: 0,
                changed_files: 0,
            })
            .collect())
    }
}
