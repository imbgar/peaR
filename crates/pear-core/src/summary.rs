//! One-shot Claude **Haiku** summary of a PR diff — a one-line summary per changed file.
//!
//! Runs `claude --print --model haiku "<prompt>"` headless and parses `<path> :: <summary>`
//! lines from its output. Blocking; the engine calls it on a worker thread.

use std::io::Read;
use std::process::{Command, Stdio};

const MODEL: &str = "haiku";
/// Cap the diff sent to the model (latency/cost); larger PRs are truncated.
const MAX_DIFF: usize = 60_000;

/// Summarize each file in `diff` via Haiku. Returns `(path, summary)` pairs.
pub fn summarize_diff(diff: &str, cwd: Option<&str>) -> Result<Vec<(String, String)>, String> {
    let path = crate::shellenv::login_path();
    let program = crate::shellenv::resolve_program("claude", path);

    let clipped = if diff.len() > MAX_DIFF {
        // Trim on a char boundary so the prompt stays valid UTF-8.
        let mut end = MAX_DIFF;
        while end > 0 && !diff.is_char_boundary(end) {
            end -= 1;
        }
        &diff[..end]
    } else {
        diff
    };
    let prompt = format!(
        "For each file changed in this pull request diff, write ONE short, concrete sentence \
         summarizing what changed in that file. Output exactly one line per file in the format \
         `<path> :: <summary>` and output nothing else — no preamble, no bullet points.\n\n\
         {clipped}"
    );

    let mut cmd = Command::new(&program);
    cmd.arg("--print").arg("--model").arg(MODEL).arg(&prompt);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.env("PATH", path);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("couldn't launch claude: {e}"))?;
    let mut out = String::new();
    if let Some(mut so) = child.stdout.take() {
        let _ = so.read_to_string(&mut out);
    }
    let _ = child.wait();

    let pairs: Vec<(String, String)> = out
        .lines()
        .filter_map(|line| line.split_once("::"))
        .filter_map(|(p, s)| {
            // Strip any list markers the model added despite instructions.
            let p = p.trim().trim_start_matches(['-', '*', '•', ' ']).trim();
            let s = s.trim();
            (!p.is_empty() && !s.is_empty()).then(|| (p.to_string(), s.to_string()))
        })
        .collect();
    Ok(pairs)
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_path_summary_lines() {
        let out = "src/main.rs :: adds a flag\n- src/lib.rs :: removes dead code\njunk line\n";
        let pairs: Vec<(String, String)> = out
            .lines()
            .filter_map(|l| l.split_once("::"))
            .filter_map(|(p, s)| {
                let p = p.trim().trim_start_matches(['-', '*', '•', ' ']).trim();
                let s = s.trim();
                (!p.is_empty() && !s.is_empty()).then(|| (p.to_string(), s.to_string()))
            })
            .collect();
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[0], ("src/main.rs".into(), "adds a flag".into()));
        assert_eq!(pairs[1], ("src/lib.rs".into(), "removes dead code".into()));
    }
}
