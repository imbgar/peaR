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

/// One streamed thought: `(kind, label, detail)`. `detail` is the full content the UI
/// reveals on click (the whole command / input); empty when there's nothing more to show.
type Thought = (String, String, String);

/// Pull the thoughts (thinking + tool actions) out of one transcript JSONL line.
fn thoughts_in(line: &str) -> Vec<Thought> {
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
                        out.push(("thinking".to_string(), t.to_string(), String::new()));
                    }
                }
            }
            Some("tool_use") => {
                let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                let input = b.get("input");
                // Label: the human-readable description / primary arg.
                let primary = input.and_then(|i| {
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
                let label = match primary {
                    Some(d) => format!("{name}: {}", d.lines().next().unwrap_or(d)),
                    None => name.to_string(),
                };
                // Detail: the full command, else the whole input pretty-printed.
                let detail = input
                    .and_then(|i| i.get("command").and_then(|c| c.as_str()).map(String::from))
                    .or_else(|| input.map(|i| serde_json::to_string_pretty(i).unwrap_or_default()))
                    .unwrap_or_default();
                let detail: String = detail.chars().take(4000).collect();
                out.push(("action".to_string(), label, detail));
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
            detail: String::new(),
        });
        return;
    };

    let Ok(file) = std::fs::File::open(&path) else {
        return;
    };
    let mut reader = BufReader::new(file);

    // Backfill: read everything so far, emit the tail of it.
    let mut backlog: Vec<Thought> = Vec::new();
    let mut line = String::new();
    while reader.read_line(&mut line).unwrap_or(0) > 0 {
        backlog.extend(thoughts_in(&line));
        line.clear();
    }
    let start = backlog.len().saturating_sub(BACKFILL);
    for (kind, text, detail) in &backlog[start..] {
        sink(Event::Thought {
            tab,
            kind: kind.clone(),
            text: text.clone(),
            detail: detail.clone(),
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
                for (kind, text, detail) in thoughts_in(&line) {
                    sink(Event::Thought {
                        tab,
                        kind,
                        text,
                        detail,
                    });
                }
            }
            line.clear();
        }
        pos = reader.stream_position().unwrap_or(len);
    }
}
