//! Resolve a usable `PATH` for spawned CLIs.
//!
//! A macOS app launched from Finder/Dock inherits only the bare system PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`) and never sources the user's shell profile —
//! so `claude` / `codex` / `aider`, which live in `~/.local/bin`,
//! `/opt/homebrew/bin`, npm-global, etc., aren't found and the PTY spawn fails with
//! "No viable candidates found in PATH". We reconstruct the login-shell PATH once
//! and fold in common tool dirs, then (a) resolve the program to an absolute path and
//! (b) inject this PATH into the PTY env so tools *inside* the session resolve too.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static PATH: OnceLock<String> = OnceLock::new();

/// Enriched PATH = login-shell PATH ∪ launch PATH ∪ common user/tool bin dirs.
/// Computed once per process.
pub fn login_path() -> &'static str {
    PATH.get_or_init(build_path)
}

fn build_path() -> String {
    let mut dirs: Vec<String> = Vec::new();
    let push = |p: &str, dirs: &mut Vec<String>| {
        let p = p.trim();
        if !p.is_empty() && !dirs.iter().any(|d| d == p) {
            dirs.push(p.to_string());
        }
    };

    // 1) login+interactive shell PATH — sources .zprofile/.zshrc, where users
    //    (and the Claude Code installer) typically extend PATH.
    if let Some(p) = shell_path() {
        for d in p.split(':') {
            push(d, &mut dirs);
        }
    }
    // 2) whatever PATH we were launched with (bare under Finder, full from a terminal).
    if let Ok(p) = std::env::var("PATH") {
        for d in p.split(':') {
            push(d, &mut dirs);
        }
    }
    // 3) common install locations, added only when they exist on disk.
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for rel in [
            ".local/bin",
            ".claude/local",
            ".npm-global/bin",
            ".bun/bin",
            ".deno/bin",
            ".cargo/bin",
        ] {
            let d = home.join(rel);
            if d.is_dir() {
                push(&d.display().to_string(), &mut dirs);
            }
        }
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin"] {
        if Path::new(d).is_dir() {
            push(d, &mut dirs);
        }
    }
    dirs.join(":")
}

/// Probe the user's login+interactive shell for its `PATH`. Delimiter-wrapped so any
/// banner noise from rc files is ignored. `None` if the probe fails.
fn shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // -i (interactive) so .zshrc is sourced; -l (login) so .zprofile is too.
    let script = r#"printf '__PEAR_PATH__%s__PEAR_PATH__' "$PATH""#;
    let out = std::process::Command::new(&shell)
        .args(["-ilc", script])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let marker = "__PEAR_PATH__";
    let start = s.find(marker)? + marker.len();
    let rest = &s[start..];
    let end = rest.find(marker)?;
    let path = rest[..end].trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

/// Resolve `program` to an absolute path by searching `path` (a PATH-style string).
/// Returns `program` unchanged if it already contains a `/` or can't be found (the
/// spawn then surfaces a clear "not found" error).
pub fn resolve_program(program: &str, path: &str) -> String {
    if program.is_empty() || program.contains('/') {
        return program.to_string();
    }
    for dir in path.split(':') {
        if dir.is_empty() {
            continue;
        }
        let cand = Path::new(dir).join(program);
        if is_executable(&cand) {
            return cand.display().to_string();
        }
    }
    program.to_string()
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn login_path_is_populated_and_has_system_dirs() {
        let p = login_path();
        assert!(!p.is_empty());
        assert!(p.contains("/usr/bin"), "expected /usr/bin in {p}");
    }

    #[test]
    fn resolve_finds_executable_in_path() {
        let dir = std::env::temp_dir().join(format!("pear-shellenv-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("mytool");
        fs::write(&bin, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();

        let path = format!("/nonexistent:{}", dir.display());
        assert_eq!(resolve_program("mytool", &path), bin.display().to_string());
        // A non-executable sibling is not resolved.
        let plain = dir.join("readme");
        fs::write(&plain, "x").unwrap();
        assert_eq!(resolve_program("readme", &path), "readme");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_passes_through_paths_and_misses() {
        assert_eq!(resolve_program("/abs/claude", "/usr/bin"), "/abs/claude");
        assert_eq!(
            resolve_program("definitely-not-real", "/usr/bin"),
            "definitely-not-real"
        );
    }
}
