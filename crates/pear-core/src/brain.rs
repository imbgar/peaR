//! "Claude's brain" — tail a Claude Code session transcript and stream its *thinking*
//! (and tool actions) out as `Event::Thought`s for the brain panel.
//!
//! Claude Code writes each session to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.
//! Rather than reconstruct the encoded-cwd dir, we glob for the unique `<session-id>.jsonl`
//! across all project dirs. Each JSONL line is a turn; assistant turns carry a `content`
//! array whose blocks include `{type:"thinking", thinking:"…"}` and `{type:"tool_use", …}`.

use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::protocol::{Event, TabId};
use crate::session::EventSink;

/// How many existing thoughts to backfill when the panel opens mid-session.
const BACKFILL: usize = 40;

/// Locate the transcript file for `session_id` (unique UUID) under `~/.claude/projects`.
fn transcript_for(session_id: &str) -> Option<PathBuf> {
    let projects = std::env::var_os("HOME")
        .map(PathBuf::from)?
        .join(".claude/projects");
    for proj in std::fs::read_dir(projects).ok()?.flatten() {
        let cand = proj.path().join(format!("{session_id}.jsonl"));
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// Pull the thoughts (thinking + tool actions) out of one transcript JSONL line.
fn thoughts_in(line: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return out;
    };
    let content = v.get("message").and_then(|m| m.get("content"));
    let Some(blocks) = content.and_then(|c| c.as_array()) else {
        return out;
    };
    for b in blocks {
        match b.get("type").and_then(|t| t.as_str()) {
            Some("thinking") => {
                if let Some(t) = b.get("thinking").and_then(|t| t.as_str()) {
                    if !t.trim().is_empty() {
                        out.push(("thinking".to_string(), t.to_string()));
                    }
                }
            }
            Some("tool_use") => {
                let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                // Surface what the tool is actually doing, not just its name. Bash carries a
                // "description"/"command"; Read/Edit a "file_path"; Grep a "pattern"; etc.
                let detail = b.get("input").and_then(|i| {
                    [
                        "description",
                        "command",
                        "file_path",
                        "pattern",
                        "query",
                        "prompt",
                    ]
                    .iter()
                    .find_map(|k| i.get(*k).and_then(|d| d.as_str()))
                });
                let text = match detail {
                    Some(d) => {
                        let first = d.lines().next().unwrap_or(d);
                        let snip: String = first.chars().take(90).collect();
                        format!("{name}: {snip}")
                    }
                    None => name.to_string(),
                };
                out.push(("action".to_string(), text));
            }
            _ => {}
        }
    }
    out
}

/// Tail the `session_id` transcript until `stop` is set, emitting `Event::Thought`s for
/// `tab`. Waits for the file to appear (Claude writes it after its first turn), backfills
/// the last [`BACKFILL`] thoughts, then follows appended lines.
pub fn watch(session_id: String, tab: TabId, sink: EventSink, stop: Arc<AtomicBool>) {
    // Wait (up to ~30s) for the transcript to exist.
    let mut path = None;
    for _ in 0..150 {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        if let Some(p) = transcript_for(&session_id) {
            path = Some(p);
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let Some(path) = path else {
        sink(Event::Thought {
            tab,
            kind: "note".into(),
            text: "no transcript yet — start a turn in this tab".into(),
        });
        return;
    };

    let Ok(file) = std::fs::File::open(&path) else {
        return;
    };
    let mut reader = BufReader::new(file);

    // Backfill: read everything so far, emit the tail of it.
    let mut backlog: Vec<(String, String)> = Vec::new();
    let mut line = String::new();
    while reader.read_line(&mut line).unwrap_or(0) > 0 {
        backlog.extend(thoughts_in(&line));
        line.clear();
    }
    let start = backlog.len().saturating_sub(BACKFILL);
    for (kind, text) in &backlog[start..] {
        sink(Event::Thought {
            tab,
            kind: kind.clone(),
            text: text.clone(),
        });
    }
    let mut pos = reader.stream_position().unwrap_or(0);

    // Follow: poll for appended content.
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(300));
        let Ok(file) = std::fs::File::open(&path) else {
            return;
        };
        let len = file.metadata().map(|m| m.len()).unwrap_or(pos);
        if len <= pos {
            continue;
        }
        let mut reader = BufReader::new(file);
        if reader.seek(SeekFrom::Start(pos)).is_err() {
            return;
        }
        let mut line = String::new();
        while reader.read_line(&mut line).unwrap_or(0) > 0 {
            if line.ends_with('\n') {
                for (kind, text) in thoughts_in(&line) {
                    sink(Event::Thought { tab, kind, text });
                }
            }
            line.clear();
        }
        pos = reader.stream_position().unwrap_or(len);
    }
}
