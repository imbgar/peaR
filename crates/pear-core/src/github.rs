//! Minimal GitHub REST client (decision D3). Blocking, dependency-light (`ureq`).
//!
//! Token resolution order:
//!   1. `PEAR_GITHUB_TOKEN`
//!   2. `GITHUB_TOKEN`
//!   3. `gh auth token` (so an existing `gh login` Just Works)

use std::process::Command;

use crate::error::{CoreError, Result};
use crate::protocol::{Comment, DiffComment, PrComments, PrMeta, PrRef, Reaction, ReviewThread};

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
    // Resolve `gh` against the login-shell PATH and inject that PATH — a Finder/Dock launch
    // inherits only the bare system PATH, so a plain `gh` (in Homebrew / `~/.local/bin`) isn't
    // found and the token can't be read. Mirrors the terminal-spawn PATH fix in `session.rs`.
    let path = crate::shellenv::login_path();
    let gh = crate::shellenv::resolve_program("gh", path);
    let out = Command::new(&gh)
        .args(["auth", "token"])
        .env("PATH", path)
        .output()
        .ok()?;
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

    /// POST a JSON body to a REST path, surfacing GitHub's error message on failure.
    fn post_json(&self, path: &str, body: serde_json::Value) -> Result<()> {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .build()
            .into();
        let mut resp = agent
            .post(format!("{API}{path}"))
            .header("Authorization", &format!("Bearer {}", self.token))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", UA)
            .send_json(&body)
            .map_err(|e| CoreError::GitHub(e.to_string()))?;
        let status = resp.status();
        if status.is_success() {
            Ok(())
        } else {
            let body = resp.body_mut().read_to_string().unwrap_or_default();
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

    /// POST a GraphQL query (GitHub's REST surface can't express review-thread
    /// resolved state or per-comment reaction rollups). Returns the `data` object,
    /// surfacing transport and GraphQL-level errors.
    fn graphql(&self, query: &str, variables: serde_json::Value) -> Result<serde_json::Value> {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .build()
            .into();
        let payload = serde_json::json!({ "query": query, "variables": variables });
        let mut resp = agent
            .post(format!("{API}/graphql"))
            .header("Authorization", &format!("Bearer {}", self.token))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", UA)
            .send_json(&payload)
            .map_err(|e| CoreError::GitHub(e.to_string()))?;
        let status = resp.status();
        let v = resp
            .body_mut()
            .read_json::<serde_json::Value>()
            .map_err(|e| CoreError::GitHub(e.to_string()))?;
        if !status.is_success() {
            return Err(CoreError::GitHub(format!(
                "HTTP {}: {}",
                status.as_u16(),
                v.to_string().chars().take(200).collect::<String>()
            )));
        }
        if let Some(errs) = v.get("errors").and_then(|e| e.as_array()) {
            if !errs.is_empty() {
                return Err(CoreError::GitHub(format!(
                    "graphql: {}",
                    errs.iter()
                        .filter_map(|e| e["message"].as_str())
                        .collect::<Vec<_>>()
                        .join("; ")
                        .chars()
                        .take(200)
                        .collect::<String>()
                )));
            }
        }
        Ok(v.get("data").cloned().unwrap_or(serde_json::Value::Null))
    }

    /// The PR's conversation comments + inline review threads (with resolved /
    /// outdated state and reaction rollups) in a single GraphQL round-trip.
    pub fn pr_comments(&self, pr: &PrRef) -> Result<PrComments> {
        let data = self.graphql(
            PR_COMMENTS_QUERY,
            serde_json::json!({ "owner": pr.owner, "repo": pr.repo, "number": pr.number }),
        )?;
        let p = &data["repository"]["pullRequest"];
        // The conversation timeline = issue comments + review *summaries*. A review
        // summary (Approve / Request changes / Comment-with-body) is a PullRequestReview,
        // not an issue comment, so it'd otherwise be invisible. Skip empty-bodied
        // COMMENTED/PENDING reviews (those are just containers for inline thread comments).
        let mut conversation: Vec<Comment> =
            nodes(&p["comments"]).iter().map(parse_comment).collect();
        for r in nodes(&p["reviews"]) {
            let state = r["state"].as_str().unwrap_or("");
            let empty_body = r["body"].as_str().unwrap_or("").trim().is_empty();
            if empty_body && (state == "COMMENTED" || state == "PENDING") {
                continue;
            }
            let mut c = parse_comment(r);
            c.review_state = Some(state.to_string());
            conversation.push(c);
        }
        // GitHub shows the conversation oldest→newest; RFC3339 sorts chronologically.
        conversation.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        let threads = nodes(&p["reviewThreads"])
            .iter()
            .map(|t| ReviewThread {
                id: t["id"].as_str().unwrap_or("").to_string(),
                path: t["path"].as_str().unwrap_or("").to_string(),
                line: t["line"].as_u64(),
                original_line: t["originalLine"].as_u64(),
                is_resolved: t["isResolved"].as_bool().unwrap_or(false),
                is_outdated: t["isOutdated"].as_bool().unwrap_or(false),
                comments: nodes(&t["comments"]).iter().map(parse_comment).collect(),
            })
            .collect();
        // The viewer's in-progress review (only ever one PENDING per viewer), for the
        // "Finish review" UI and to batch further comments into it.
        let pending = nodes(&p["reviews"]).iter().find(|r| {
            r["state"].as_str() == Some("PENDING") && r["viewerDidAuthor"].as_bool() == Some(true)
        });
        Ok(PrComments {
            conversation,
            threads,
            pr_node_id: p["id"].as_str().unwrap_or("").to_string(),
            head_sha: p["headRefOid"].as_str().unwrap_or("").to_string(),
            pending_review_id: pending.map(|r| r["id"].as_str().unwrap_or("").to_string()),
            pending_count: pending
                .map(|r| r["comments"]["totalCount"].as_u64().unwrap_or(0))
                .unwrap_or(0),
        })
    }

    /// Post a standalone inline review comment immediately (REST; needs the head SHA).
    /// `start_line`/`start_side` are set only for a multi-line range.
    #[allow(clippy::too_many_arguments)]
    pub fn create_review_comment(
        &self,
        pr: &PrRef,
        commit_id: &str,
        body: &str,
        path: &str,
        line: u64,
        side: &str,
        start_line: Option<u64>,
        start_side: Option<&str>,
    ) -> Result<()> {
        let mut payload = serde_json::json!({
            "body": body, "commit_id": commit_id, "path": path, "line": line, "side": side,
        });
        if let Some(sl) = start_line {
            payload["start_line"] = serde_json::json!(sl);
            payload["start_side"] = serde_json::json!(start_side.unwrap_or(side));
        }
        self.post_json(
            &format!(
                "/repos/{}/{}/pulls/{}/comments",
                pr.owner, pr.repo, pr.number
            ),
            payload,
        )
    }

    /// Add an inline review thread to a review (GraphQL). With `review_id` it appends
    /// to that pending review; otherwise it opens (or reuses) a pending review on the
    /// PR. `start_line`/`start_side` are set only for a multi-line range.
    #[allow(clippy::too_many_arguments)]
    pub fn add_review_thread(
        &self,
        pr_node_id: &str,
        review_id: Option<&str>,
        body: &str,
        path: &str,
        line: u64,
        side: &str,
        start_line: Option<u64>,
        start_side: Option<&str>,
    ) -> Result<()> {
        let mut input = serde_json::json!({
            "body": body, "path": path, "line": line, "side": side, "subjectType": "LINE",
        });
        match review_id {
            Some(id) => input["pullRequestReviewId"] = serde_json::json!(id),
            None => input["pullRequestId"] = serde_json::json!(pr_node_id),
        }
        if let Some(sl) = start_line {
            input["startLine"] = serde_json::json!(sl);
            input["startSide"] = serde_json::json!(start_side.unwrap_or(side));
        }
        self.graphql(
            "mutation($input:AddPullRequestReviewThreadInput!){addPullRequestReviewThread(input:$input){thread{id}}}",
            serde_json::json!({ "input": input }),
        )?;
        Ok(())
    }

    /// Submit the viewer's pending review with a verdict. `event` is one of
    /// `COMMENT` | `APPROVE` | `REQUEST_CHANGES`.
    pub fn submit_review(&self, review_id: &str, event: &str, body: &str) -> Result<()> {
        self.graphql(
            "mutation($id:ID!,$event:PullRequestReviewEvent!,$body:String){submitPullRequestReview(input:{pullRequestReviewId:$id,event:$event,body:$body}){clientMutationId}}",
            serde_json::json!({ "id": review_id, "event": event, "body": body }),
        )?;
        Ok(())
    }

    /// Reply to an existing inline review thread (GraphQL).
    pub fn reply_review_thread(&self, thread_id: &str, body: &str) -> Result<()> {
        self.graphql(
            "mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}",
            serde_json::json!({ "id": thread_id, "body": body }),
        )?;
        Ok(())
    }

    /// Add or remove a reaction on any reactable subject (comment node id).
    /// `content` is a `ReactionContent` enum value (e.g. `THUMBS_UP`).
    pub fn set_reaction(&self, subject_id: &str, content: &str, add: bool) -> Result<()> {
        let mutation = if add {
            "mutation($id:ID!,$c:ReactionContent!){addReaction(input:{subjectId:$id,content:$c}){clientMutationId}}"
        } else {
            "mutation($id:ID!,$c:ReactionContent!){removeReaction(input:{subjectId:$id,content:$c}){clientMutationId}}"
        };
        self.graphql(
            mutation,
            serde_json::json!({ "id": subject_id, "c": content }),
        )?;
        Ok(())
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

/// One GraphQL query for everything the comments panel needs: PR conversation
/// (issue) comments + inline review threads, each with author, body, timestamp,
/// `viewerDidAuthor`, and reaction rollups; threads also carry resolved/outdated
/// state and their anchor (path/line/originalLine).
const PR_COMMENTS_QUERY: &str = r#"
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      id headRefOid
      comments(first:100){ nodes {
        id author{login} body createdAt viewerDidAuthor
        reactionGroups{ content viewerHasReacted reactors{ totalCount } }
      } }
      reviews(first:100){ nodes {
        id author{login} body createdAt state viewerDidAuthor
        comments{ totalCount }
        reactionGroups{ content viewerHasReacted reactors{ totalCount } }
      } }
      reviewThreads(first:100){ nodes {
        id isResolved isOutdated path line originalLine
        comments(first:50){ nodes {
          id author{login} body createdAt viewerDidAuthor
          reactionGroups{ content viewerHasReacted reactors{ totalCount } }
        } }
      } }
    }
  }
}"#;

/// `connection.nodes` as a slice (empty if missing/null).
fn nodes(conn: &serde_json::Value) -> &[serde_json::Value] {
    conn["nodes"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or(&[])
}

/// Map a GraphQL `ReactionContent` enum to its emoji.
fn reaction_emoji(content: &str) -> &'static str {
    match content {
        "THUMBS_UP" => "👍",
        "THUMBS_DOWN" => "👎",
        "LAUGH" => "😄",
        "HOORAY" => "🎉",
        "CONFUSED" => "😕",
        "HEART" => "❤️",
        "ROCKET" => "🚀",
        "EYES" => "👀",
        _ => "❓",
    }
}

/// Parse a comment node's non-empty reaction groups into reaction rollups.
fn parse_reactions(node: &serde_json::Value) -> Vec<Reaction> {
    node["reactionGroups"]
        .as_array()
        .map(|groups| {
            groups
                .iter()
                .filter_map(|g| {
                    let count = g["reactors"]["totalCount"].as_u64().unwrap_or(0);
                    if count == 0 {
                        return None;
                    }
                    let content = g["content"].as_str().unwrap_or("").to_string();
                    Some(Reaction {
                        emoji: reaction_emoji(&content).to_string(),
                        content,
                        count,
                        me: g["viewerHasReacted"].as_bool().unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Parse a GraphQL comment node (issue comment or review comment — same shape).
fn parse_comment(node: &serde_json::Value) -> Comment {
    Comment {
        id: node["id"].as_str().unwrap_or("").to_string(),
        author: node["author"]["login"]
            .as_str()
            .unwrap_or("ghost")
            .to_string(),
        body: node["body"].as_str().unwrap_or("").to_string(),
        created_at: node["createdAt"].as_str().unwrap_or("").to_string(),
        mine: node["viewerDidAuthor"].as_bool().unwrap_or(false),
        reactions: parse_reactions(node),
        review_state: None,
    }
}
