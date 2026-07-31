//! Minimal GitHub REST client (decision D3). Blocking, dependency-light (`ureq`).
//!
//! Token resolution order:
//!   1. `PEAR_GITHUB_TOKEN`
//!   2. `GITHUB_TOKEN`
//!   3. `gh auth token` (so an existing `gh login` Just Works)

use std::process::Command;

use crate::error::{CoreError, Result};
use crate::protocol::{
    Comment, DiffComment, PrComments, PrMeta, PrRef, PrStatus, Reaction, ReviewThread,
};

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

/// Minimal standard base64 (with padding) — avoids a dependency for the one data-URL use
/// (proxied comment images, see `GitHub::fetch_image`).
pub fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// A PR diff plus how it was obtained. `note` is `Some` only when the diff media
/// type was refused (huge PR) and the text was rebuilt from the files API.
pub struct DiffReport {
    pub diff: String,
    pub note: Option<String>,
}

/// Rebuild unified-diff text from `GET /pulls/{n}/files` entries. Pure so the shape
/// the frontend parser depends on is pinned by tests, not by a live 3419-file PR.
///
/// Per entry: the `diff --git` header, status markers (`new file` / `deleted file` /
/// `rename from`+`rename to`) and the `patch` hunks verbatim. When GitHub omits
/// `patch`: a binary file (0 additions + 0 deletions) becomes the standard
/// `Binary files … differ` line; an oversized text file becomes an explicit
/// `omitted-patch:` marker the frontend parser turns into a "patch not available"
/// card — an empty body would read as "no changes", which is a lie.
pub fn files_to_diff(files: &[serde_json::Value]) -> String {
    let mut out = String::new();
    for f in files {
        let path = f["filename"].as_str().unwrap_or("");
        if path.is_empty() {
            continue;
        }
        let prev = f["previous_filename"].as_str().unwrap_or(path);
        let status = f["status"].as_str().unwrap_or("modified");
        out.push_str(&format!("diff --git a/{prev} b/{path}\n"));
        match status {
            "added" => out.push_str("new file mode 100644\n"),
            "removed" => out.push_str("deleted file mode 100644\n"),
            "renamed" => out.push_str(&format!("rename from {prev}\nrename to {path}\n")),
            _ => {}
        }
        match f["patch"].as_str() {
            Some(patch) => {
                if status == "added" {
                    out.push_str("--- /dev/null\n");
                } else {
                    out.push_str(&format!("--- a/{prev}\n"));
                }
                if status == "removed" {
                    out.push_str("+++ /dev/null\n");
                } else {
                    out.push_str(&format!("+++ b/{path}\n"));
                }
                out.push_str(patch);
                if !patch.ends_with('\n') {
                    out.push('\n');
                }
            }
            None => {
                let adds = f["additions"].as_u64().unwrap_or(0);
                let dels = f["deletions"].as_u64().unwrap_or(0);
                if adds == 0 && dels == 0 {
                    out.push_str(&format!("Binary files a/{prev} and b/{path} differ\n"));
                } else {
                    out.push_str(&format!(
                        "omitted-patch: +{adds} -{dels} (too large for the GitHub files API)\n"
                    ));
                }
            }
        }
    }
    out
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

    /// Fetch a GitHub-hosted image URL with auth → `(bytes, content_type)`. Private-repo comment
    /// attachments (`github.com/user-attachments/…`) require auth the webview doesn't have, so the
    /// frontend proxies them through here. Follows redirects to the signed asset host.
    pub fn fetch_image(&self, url: &str) -> Result<(Vec<u8>, String)> {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .build()
            .into();
        let mut resp = agent
            .get(url)
            .header("Authorization", &format!("Bearer {}", self.token))
            .header("User-Agent", UA)
            .call()
            .map_err(|e| CoreError::GitHub(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(CoreError::GitHub(format!(
                "HTTP {} fetching image",
                status.as_u16()
            )));
        }
        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        let bytes = resp
            .body_mut()
            .read_to_vec()
            .map_err(|e| CoreError::GitHub(e.to_string()))?;
        Ok((bytes, ct))
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
    /// Falls back to the paginated files API on a huge PR — see [`GitHub::pr_diff_report`].
    pub fn pr_diff(&self, pr: &PrRef) -> Result<String> {
        self.pr_diff_report(pr).map(|r| r.diff)
    }

    /// [`GitHub::pr_diff`] plus provenance. GitHub's diff media type refuses PRs over
    /// 300 files / 20k lines with HTTP 406 ("Consider using 'List pull requests files'
    /// API"), so on exactly that refusal the diff is REBUILT from the paginated files
    /// endpoint. `note` is set only on the fallback path, so the UI can say the diff
    /// is reconstructed (and possibly incomplete: that endpoint caps at 3000 files and
    /// omits `patch` for oversized ones) instead of presenting it as the real thing.
    pub fn pr_diff_report(&self, pr: &PrRef) -> Result<DiffReport> {
        match self.get_raw(
            &format!("/repos/{}/{}/pulls/{}", pr.owner, pr.repo, pr.number),
            "application/vnd.github.diff",
        ) {
            Ok(diff) => Ok(DiffReport { diff, note: None }),
            Err(CoreError::GitHub(msg)) if msg.starts_with("HTTP 406") => {
                self.pr_diff_via_files(pr)
            }
            Err(e) => Err(e),
        }
    }

    fn pr_diff_via_files(&self, pr: &PrRef) -> Result<DiffReport> {
        let mut files: Vec<serde_json::Value> = Vec::new();
        // GitHub documents a 3000-file ceiling on this endpoint; the page cap is just
        // a belt against an API that misbehaves and never returns a short page.
        for page in 1..=30 {
            let v = self.get(&format!(
                "/repos/{}/{}/pulls/{}/files?per_page=100&page={page}",
                pr.owner, pr.repo, pr.number
            ))?;
            let arr = v.as_array().cloned().unwrap_or_default();
            let n = arr.len();
            files.extend(arr);
            if n < 100 {
                break;
            }
        }
        let diff = files_to_diff(&files);
        // The PR's own count is the honesty check: when it exceeds what the files
        // endpoint would give us, say how much is missing rather than render a
        // 3000-file diff as if it were the whole PR.
        let total = self
            .get(&format!(
                "/repos/{}/{}/pulls/{}",
                pr.owner, pr.repo, pr.number
            ))
            .ok()
            .and_then(|meta| meta["changed_files"].as_u64())
            .unwrap_or(files.len() as u64);
        let note = if total > files.len() as u64 {
            format!(
                "huge PR: diff rebuilt from the files API — showing {} of {} files (GitHub caps the list)",
                files.len(),
                total
            )
        } else {
            format!(
                "huge PR: diff rebuilt from the files API ({} files; oversized patches omitted)",
                files.len()
            )
        };
        Ok(DiffReport {
            diff,
            note: Some(note),
        })
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

    /// POST a GraphQL query and return the raw response (`{ data, errors }`). GitHub's REST
    /// surface can't express review-thread resolved state or per-comment reaction rollups, so
    /// several methods go through GraphQL. Errors only on transport / non-2xx HTTP —
    /// GraphQL-level `errors` are left for the caller (`graphql` vs `graphql_partial`) to decide.
    fn gql_raw(&self, query: &str, variables: serde_json::Value) -> Result<serde_json::Value> {
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
        Ok(v)
    }

    /// Strict GraphQL: any GraphQL-level error fails the call. Returns the `data` object.
    fn graphql(&self, query: &str, variables: serde_json::Value) -> Result<serde_json::Value> {
        let v = self.gql_raw(query, variables)?;
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

    /// Lenient GraphQL: returns whatever `data` came back even if some fields errored (e.g. a
    /// single inaccessible PR in an aliased batch). Used by `pr_statuses`.
    fn graphql_partial(
        &self,
        query: &str,
        variables: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let v = self.gql_raw(query, variables)?;
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
        // The PR description IS the opening message of the conversation (that's where
        // GitHub shows it). Surface it as a synthetic first entry; its createdAt is the
        // PR's own, so the chronological sort below keeps it at the top. Skip an empty
        // description.
        let pr_body = p["body"].as_str().unwrap_or("");
        if !pr_body.trim().is_empty() {
            conversation.push(Comment {
                id: format!("pr-body:{}", p["id"].as_str().unwrap_or("")),
                author: p["author"]["login"].as_str().unwrap_or("ghost").to_string(),
                body: pr_body.to_string(),
                created_at: p["createdAt"].as_str().unwrap_or("").to_string(),
                mine: p["viewerDidAuthor"].as_bool().unwrap_or(false),
                reactions: Vec::new(),
                review_state: None,
                is_pr_body: true,
            });
        }
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

    /// Create AND submit a review in one shot (no pending review needed) — the GitHub
    /// "Review changes" flow. `event` is `APPROVE` | `REQUEST_CHANGES` | `COMMENT`.
    /// (REST: `POST /pulls/{n}/reviews` with `{event, body}`.)
    pub fn create_review(&self, pr: &PrRef, event: &str, body: &str) -> Result<()> {
        self.post_json(
            &format!(
                "/repos/{}/{}/pulls/{}/reviews",
                pr.owner, pr.repo, pr.number
            ),
            serde_json::json!({ "event": event, "body": body }),
        )
    }

    /// Reply to an existing inline review thread (GraphQL).
    pub fn reply_review_thread(&self, thread_id: &str, body: &str) -> Result<()> {
        self.graphql(
            "mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}",
            serde_json::json!({ "id": thread_id, "body": body }),
        )?;
        Ok(())
    }

    /// Resolve or unresolve an inline review thread (GraphQL, by node id).
    pub fn set_thread_resolved(&self, thread_id: &str, resolved: bool) -> Result<()> {
        let mutation = if resolved {
            "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}"
        } else {
            "mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id}}}"
        };
        self.graphql(mutation, serde_json::json!({ "id": thread_id }))?;
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

    /// Review/merge status for a batch of specific PRs, via one aliased GraphQL query per
    /// chunk. Lenient: an inaccessible PR (deleted/private) is skipped, not fatal.
    pub fn pr_statuses(&self, prs: &[PrRef]) -> Result<Vec<PrStatus>> {
        let mut out = Vec::new();
        for chunk in prs.chunks(40) {
            let mut q = String::from("query{\n");
            for (i, pr) in chunk.iter().enumerate() {
                q.push_str(&format!(
                    "  p{i}: repository(owner:\"{}\",name:\"{}\"){{ pullRequest(number:{}){{ {} }} }}\n",
                    gql_str(&pr.owner),
                    gql_str(&pr.repo),
                    pr.number,
                    PR_STATUS_FIELDS
                ));
            }
            q.push('}');
            let data = self.graphql_partial(&q, serde_json::json!({}))?;
            for i in 0..chunk.len() {
                if let Some(s) = parse_pr_status(&data[format!("p{i}")]["pullRequest"]) {
                    out.push(s);
                }
            }
        }
        Ok(out)
    }

    /// Search PRs (GitHub search syntax, e.g. `is:pr is:open author:octocat`), returning
    /// status records. Used by the Teams view to pull watched users' open PRs.
    ///
    /// Uses `graphql_partial`: a broad `author:` search spans every repo the token can see,
    /// and GitHub returns a top-level `errors` array (alongside valid `data`) for any result
    /// node in an org with OAuth/SAML access restrictions. The strict `graphql` helper would
    /// discard the whole response on those partial errors, so Teams would silently show
    /// nothing even when watched users have open PRs we *can* read.
    pub fn search_prs(&self, query: &str, limit: u32) -> Result<Vec<PrStatus>> {
        let q = format!(
            "query($q:String!,$n:Int!){{ search(query:$q,type:ISSUE,first:$n){{ \
             nodes{{ ... on PullRequest {{ {PR_STATUS_FIELDS} }} }} }} }}"
        );
        let data = self.graphql_partial(&q, serde_json::json!({ "q": query, "n": limit }))?;
        Ok(nodes(&data["search"])
            .iter()
            .filter_map(parse_pr_status)
            .collect())
    }

    /// Member logins of an org team (`/orgs/{org}/teams/{team}/members`). Needs org read.
    pub fn team_members(&self, org: &str, team: &str) -> Result<Vec<String>> {
        let v = self.get(&format!("/orgs/{org}/teams/{team}/members?per_page=100"))?;
        Ok(v.as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|m| m["login"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default())
    }
}

/// GraphQL field set shared by `pr_statuses` (aliased) and `search_prs` (search nodes).
const PR_STATUS_FIELDS: &str = "number title url state isDraft reviewDecision updatedAt \
     headRefOid author{login} comments{totalCount} commits{totalCount} \
     repository{owner{login} name}";

/// Sanitize a string for safe inline embedding in a GraphQL string literal (owner/repo are
/// already restricted to `[A-Za-z0-9._-]`, but belt-and-suspenders against injection).
fn gql_str(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect()
}

/// Parse a GraphQL PullRequest node into a `PrStatus` (None if it isn't a real PR node).
fn parse_pr_status(node: &serde_json::Value) -> Option<PrStatus> {
    let number = node["number"].as_u64()?;
    let owner = node["repository"]["owner"]["login"].as_str()?.to_string();
    let repo = node["repository"]["name"].as_str()?.to_string();
    Some(PrStatus {
        pr: PrRef {
            owner,
            repo,
            number,
        },
        title: node["title"].as_str().unwrap_or("").to_string(),
        author: node["author"]["login"].as_str().unwrap_or("").to_string(),
        state: node["state"].as_str().unwrap_or("OPEN").to_lowercase(),
        draft: node["isDraft"].as_bool().unwrap_or(false),
        review_decision: node["reviewDecision"].as_str().map(String::from),
        comments: node["comments"]["totalCount"].as_u64().unwrap_or(0),
        commits: node["commits"]["totalCount"].as_u64().unwrap_or(0),
        updated_at: node["updatedAt"].as_str().unwrap_or("").to_string(),
        url: node["url"].as_str().unwrap_or("").to_string(),
        head_oid: node["headRefOid"].as_str().map(String::from),
    })
}

/// One GraphQL query for everything the comments panel needs: PR conversation
/// (issue) comments + inline review threads, each with author, body, timestamp,
/// `viewerDidAuthor`, and reaction rollups; threads also carry resolved/outdated
/// state and their anchor (path/line/originalLine).
const PR_COMMENTS_QUERY: &str = r#"
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      id headRefOid body author{login} createdAt viewerDidAuthor
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
        is_pr_body: false,
    }
}

#[cfg(test)]
mod tests {
    use super::files_to_diff;
    use serde_json::json;

    #[test]
    fn a_files_entry_becomes_a_parseable_unified_diff() {
        let files = [json!({
            "filename": "src/app.ts",
            "status": "modified",
            "additions": 1,
            "deletions": 1,
            "patch": "@@ -1,2 +1,2 @@\n-old\n+new\n context"
        })];
        let d = files_to_diff(&files);
        assert!(
            d.starts_with("diff --git a/src/app.ts b/src/app.ts\n"),
            "{d}"
        );
        assert!(d.contains("--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n"));
        assert!(
            d.ends_with(" context\n"),
            "patch without a trailing newline gets one: {d:?}"
        );
    }

    #[test]
    fn statuses_emit_their_git_markers() {
        let files = [
            json!({"filename": "new.rs", "status": "added", "patch": "@@ -0,0 +1 @@\n+x"}),
            json!({"filename": "gone.rs", "status": "removed", "patch": "@@ -1 +0,0 @@\n-x"}),
            json!({"filename": "after.rs", "previous_filename": "before.rs", "status": "renamed",
                   "patch": "@@ -1 +1 @@\n-a\n+b"}),
        ];
        let d = files_to_diff(&files);
        assert!(
            d.contains("new file mode 100644\n--- /dev/null\n+++ b/new.rs\n"),
            "{d}"
        );
        assert!(
            d.contains("deleted file mode 100644\n--- a/gone.rs\n+++ /dev/null\n"),
            "{d}"
        );
        assert!(
            d.contains(
                "diff --git a/before.rs b/after.rs\nrename from before.rs\nrename to after.rs\n"
            ),
            "{d}"
        );
    }

    /// GitHub omits `patch` for two different reasons, and they must not render the
    /// same: a binary file gets the standard git line, an oversized text file gets
    /// the explicit omission marker — never an empty body that reads as "no changes".
    #[test]
    fn an_absent_patch_is_binary_or_an_explicit_omission_never_silence() {
        let files = [
            json!({"filename": "logo.png", "status": "modified", "additions": 0, "deletions": 0}),
            json!({"filename": "huge.lock", "status": "modified", "additions": 90000, "deletions": 4}),
        ];
        let d = files_to_diff(&files);
        assert!(
            d.contains("Binary files a/logo.png and b/logo.png differ\n"),
            "{d}"
        );
        assert!(
            d.contains("omitted-patch: +90000 -4 (too large for the GitHub files API)\n"),
            "{d}"
        );
        // Two file blocks, nothing silent between them.
        assert_eq!(d.matches("diff --git").count(), 2);
    }
}
