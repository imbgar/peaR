//! "Ask Claude" forked side-conversations — answer a bite-size question *without*
//! touching the tab's live PTY conversation.
//!
//! The engine spawns a headless `claude -p "<prompt>" --output-format stream-json` one-shot
//! on a worker thread. When the tab already runs a Claude session we resume + `--fork-session`
//! it, so the answer inherits the whole review's context (the PR, the diff, the discussion so
//! far) but branches into a throwaway session id that never disturbs the original. The reply
//! streams back as [`Event::Insight`] chunks the frontend renders in a dismissable card.
//!
//! If the fork can't start (no session yet, or Claude refuses to resume a busy session) and it
//! produced no output, we fall back once to a fresh `claude -p` in the tab's cwd — still fully
//! isolated; it can `gh pr diff` / read files itself.

use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use crate::protocol::{Event, TabId};
use crate::session::EventSink;

/// Cheap + fast model for these short asks (overridable later if wanted).
const MODEL: &str = "sonnet";

/// Outcome of a single `claude -p` run.
struct Run {
    /// Whether any answer text reached the card (so a failed *fork* with zero output can
    /// safely retry fresh, but a mid-stream failure keeps the partial answer).
    emitted: bool,
    /// `Some(msg)` if the process failed (spawn error / non-zero exit / reported error).
    error: Option<String>,
    /// The session id this one-shot ran under — the *forked* branch id (or the fresh
    /// one-shot's id on the fallback path). Lets the frontend later promote the card to a
    /// live tab by resuming this exact conversation.
    session: Option<String>,
}

/// Run an `AskInsight`: stream a forked (or fresh) `claude -p` reply for `tab`/`id`.
/// Spawned on its own thread by the engine — blocks until the one-shot finishes.
pub fn run(
    tab: TabId,
    id: String,
    prompt: String,
    session_id: Option<String>,
    cwd: Option<String>,
    sink: EventSink,
) {
    let forked = session_id.is_some();
    let first = run_once(
        &prompt,
        session_id.as_deref(),
        cwd.as_deref(),
        tab,
        &id,
        &sink,
    );

    // A fork that refused before emitting anything → retry as a fresh, context-less one-shot.
    let result = if forked && first.error.is_some() && !first.emitted {
        run_once(&prompt, None, cwd.as_deref(), tab, &id, &sink)
    } else {
        first
    };

    match result {
        Run {
            emitted: false,
            error: Some(msg),
            ..
        } => sink(Event::Insight {
            tab,
            id,
            kind: "error".into(),
            text: msg,
        }),
        // Emitted something (even if it later errored) or finished cleanly: close the card.
        // The `done` event carries the forked session id in `text` (empty if none), so the
        // frontend can offer to open this side-conversation as a live tab.
        Run { session, .. } => sink(Event::Insight {
            tab,
            id,
            kind: "done".into(),
            text: session.unwrap_or_default(),
        }),
    }
}

/// One `claude -p` invocation. `resume` = the session id to resume + fork (None = fresh).
/// Streams assistant text out as `chunk` insights and returns how it went.
fn run_once(
    prompt: &str,
    resume: Option<&str>,
    cwd: Option<&str>,
    tab: TabId,
    id: &str,
    sink: &EventSink,
) -> Run {
    let path = crate::shellenv::login_path();
    let program = crate::shellenv::resolve_program("claude", path);

    let mut cmd = Command::new(&program);
    cmd.arg("--print")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--model")
        .arg(MODEL);
    if let Some(sid) = resume {
        cmd.arg("--resume").arg(sid).arg("--fork-session");
    }
    // The prompt as a trailing positional (avoids any `-p <value>` ambiguity).
    cmd.arg(prompt);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.env("PATH", path);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Run {
                emitted: false,
                error: Some(format!("couldn't launch claude: {e}")),
                session: None,
            }
        }
    };

    // Drain stderr on a side thread so a chatty error stream can't deadlock the pipe.
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    if let Some(mut err) = child.stderr.take() {
        let buf = stderr_buf.clone();
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = err.read_to_string(&mut s);
            if let Ok(mut g) = buf.lock() {
                *g = s;
            }
        });
    }

    let mut emitted = false;
    let mut reported_error: Option<String> = None;
    let mut session: Option<String> = None;
    if let Some(out) = child.stdout.take() {
        let reader = BufReader::new(out);
        for line in reader.lines().map_while(std::result::Result::ok) {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            for piece in parse_line(line) {
                match piece {
                    // Every line carries the run's (forked) session id; last-seen wins.
                    Piece::Session(s) => session = Some(s),
                    Piece::Text(t) => {
                        if !t.is_empty() {
                            emitted = true;
                            sink(Event::Insight {
                                tab,
                                id: id.to_string(),
                                kind: "chunk".into(),
                                text: t,
                            });
                        }
                    }
                    // The terminal `result` text — only used if no assistant blocks streamed
                    // (a leaner stream-json that skips per-turn assistant lines).
                    Piece::Final(t) => {
                        if !emitted && !t.is_empty() {
                            emitted = true;
                            sink(Event::Insight {
                                tab,
                                id: id.to_string(),
                                kind: "chunk".into(),
                                text: t,
                            });
                        }
                    }
                    Piece::Error(e) => reported_error = Some(e),
                }
            }
        }
    }

    let status = child.wait();
    let bad_exit = matches!(&status, Ok(s) if !s.success());
    let error = reported_error.or_else(|| {
        if bad_exit || status.is_err() {
            let detail = stderr_buf
                .lock()
                .ok()
                .map(|g| g.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "claude exited with an error".to_string());
            // Keep it to the last, most relevant line.
            Some(detail.lines().last().unwrap_or(&detail).to_string())
        } else {
            None
        }
    });

    Run {
        emitted,
        error,
        session,
    }
}

/// A meaningful piece pulled from one stream-json line.
enum Piece {
    /// The run's session id (the forked branch's id).
    Session(String),
    /// Streamed assistant answer text.
    Text(String),
    /// The terminal `result` text — a fallback used only if no `Text` was streamed.
    Final(String),
    /// A reported failure.
    Error(String),
}

/// Parse one stream-json line into answer text and/or an error. We read assistant message
/// text blocks as they arrive (the streaming answer) and treat the terminal `result` line
/// as a fallback (when no assistant text was seen) or as the error signal.
fn parse_line(line: &str) -> Vec<Piece> {
    let mut out = Vec::new();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return out;
    };
    if let Some(s) = v.get("session_id").and_then(|s| s.as_str()) {
        out.push(Piece::Session(s.to_string()));
    }
    match v.get("type").and_then(|t| t.as_str()) {
        Some("assistant") => {
            let blocks = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array());
            if let Some(blocks) = blocks {
                for b in blocks {
                    if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                            out.push(Piece::Text(t.to_string()));
                        }
                    }
                }
            }
        }
        Some("result") => {
            let is_error = v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false)
                || v.get("subtype").and_then(|s| s.as_str()) == Some("error_max_turns");
            let result_text = v.get("result").and_then(|r| r.as_str()).unwrap_or("");
            if is_error {
                let msg = if result_text.is_empty() {
                    "claude couldn't answer".to_string()
                } else {
                    result_text.to_string()
                };
                out.push(Piece::Error(msg));
            } else if !result_text.is_empty() {
                // Usually duplicates the assistant blocks we already streamed — `run_once`
                // only uses it when nothing else came through.
                out.push(Piece::Final(result_text.to_string()));
            }
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assistant_text_blocks_become_chunks() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"},{"type":"text","text":" world"}]}}"#;
        let pieces = parse_line(line);
        let texts: Vec<_> = pieces
            .iter()
            .filter_map(|p| match p {
                Piece::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(texts, vec!["hello", " world"]);
    }

    #[test]
    fn errored_result_becomes_error() {
        let line = r#"{"type":"result","is_error":true,"result":"rate limited"}"#;
        let pieces = parse_line(line);
        assert!(matches!(pieces.as_slice(), [Piece::Error(m)] if m == "rate limited"));
    }

    #[test]
    fn successful_result_is_fallback_only() {
        // A success result yields a `Final` (used only when no assistant text streamed).
        let line =
            r#"{"type":"result","subtype":"success","is_error":false,"result":"hello world"}"#;
        let pieces = parse_line(line);
        assert!(matches!(pieces.as_slice(), [Piece::Final(t)] if t == "hello world"));
    }

    #[test]
    fn non_json_line_is_ignored() {
        assert!(parse_line("not json at all").is_empty());
    }
}
