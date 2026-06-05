//! One PTY-backed terminal per tab. Raw bytes only — VT parsing/rendering lives in
//! the frontend (`xterm.js`), so this module stays a thin, fast pipe.

use std::io::{Read, Write};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::error::{CoreError, Result};
use crate::protocol::{Event, TabId};

/// Sink the engine supplies so a session can emit `Output` / `TabClosed` events
/// from its background threads.
pub type EventSink = Arc<dyn Fn(Event) + Send + Sync>;

pub struct Session {
    pub tab: TabId,
    /// Shared so a delayed-submit thread (see `write_then_submit`) can also write.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// The spawned child's OS pid, used to read its live cwd for persist-session.
    pid: Option<u32>,
}

impl Session {
    /// Spawn `program` + `args` in a fresh PTY of `cols`x`rows`, in `cwd`
    /// (default: process cwd). The engine resolves the CLI and any session flags.
    #[allow(clippy::too_many_arguments)] // a low-level spawn primitive; a params struct would add noise
    pub fn spawn(
        tab: TabId,
        program: &str,
        args: &[String],
        cwd: Option<&str>,
        cols: u16,
        rows: u16,
        sink: EventSink,
        reaper: Sender<TabId>,
    ) -> Result<Session> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| CoreError::Pty(e.to_string()))?;

        // A Finder/Dock launch inherits only the bare system PATH, so resolve the
        // program against the user's real login-shell PATH and inject that PATH into
        // the child so tools used *inside* the session (gh, git, node) also resolve.
        let path = crate::shellenv::login_path();
        let resolved = crate::shellenv::resolve_program(program, path);
        let mut cmd = CommandBuilder::new(&resolved);
        for a in args {
            cmd.arg(a);
        }
        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }
        cmd.env("PATH", path);
        cmd.env("TERM", "xterm-256color");

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| CoreError::Pty(e.to_string()))?;
        // Close the slave in the parent so EOF propagates correctly on exit.
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| CoreError::Pty(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| CoreError::Pty(e.to_string()))?;
        let killer = child.clone_killer();
        let pid = child.process_id();

        // Pump PTY output -> Event::Output.
        let sink_out = sink.clone();
        thread::Builder::new()
            .name(format!("pear-pty-read-{tab}"))
            .spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => (sink_out)(Event::Output {
                            tab,
                            bytes: buf[..n].to_vec(),
                        }),
                        Err(_) => break,
                    }
                }
            })
            .map_err(CoreError::Io)?;

        // Reap the child: signal the engine to drop the now-dead tab, THEN notify the
        // frontend. The reaper send keeps the engine's tab map authoritative even when a
        // process exits on its own (so resume never sees a stale "live" entry and forks).
        let sink_exit = sink.clone();
        thread::Builder::new()
            .name(format!("pear-pty-wait-{tab}"))
            .spawn(move || {
                let code = child.wait().ok().map(|s| s.exit_code() as i32);
                let _ = reaper.send(tab);
                (sink_exit)(Event::TabClosed { tab, code });
            })
            .map_err(CoreError::Io)?;

        Ok(Session {
            tab,
            writer: Arc::new(Mutex::new(writer)),
            master: pair.master,
            killer,
            pid,
        })
    }

    /// The child process's OS pid (for reading its live cwd; see `macproc`).
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Forward keystrokes to the child's stdin.
    pub fn write_input(&self, bytes: &[u8]) -> Result<()> {
        let mut w = self.writer.lock().unwrap();
        w.write_all(bytes)?;
        w.flush()?;
        Ok(())
    }

    /// Type `body`, then submit it with a SEPARATE, slightly-delayed Enter. A long
    /// prompt written in one burst can be buffered by the agent's input like a paste,
    /// so a trailing `\r` in the same write lands as a newline instead of a submit.
    /// Sending the Enter as its own keystroke a beat later makes it a clean submit.
    pub fn write_then_submit(&self, macro_bytes: &[u8]) -> Result<()> {
        // Strip a trailing CR — we re-send it as a separate, delayed keystroke below.
        let body = macro_bytes.strip_suffix(b"\r").unwrap_or(macro_bytes);
        self.write_input(body)?;
        let writer = self.writer.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            if let Ok(mut w) = writer.lock() {
                let _ = w.write_all(b"\r");
                let _ = w.flush();
            }
        });
        Ok(())
    }

    /// Update the PTY window size when the widget resizes.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| CoreError::Pty(e.to_string()))
    }

    /// Terminate the child process.
    pub fn kill(&mut self) {
        let _ = self.killer.kill();
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn self_exiting_process_signals_the_reaper() {
        let (tx, rx) = mpsc::channel();
        let sink: EventSink = Arc::new(|_| {});
        // Absolute path → skips PATH resolution; `exit 0` returns immediately. The
        // wait-thread should then signal the reaper with our tab id.
        let args = ["-c".to_string(), "exit 0".to_string()];
        // Explicit cwd="/" so this is independent of the ambient process cwd, which a
        // sibling test may have changed to a since-removed temp dir (-> spawn ENOENT).
        let _s =
            Session::spawn(42, "/bin/sh", &args, Some("/"), 80, 24, sink, tx).expect("spawn sh");
        let reaped = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("reaper should receive the tab id after the process exits");
        assert_eq!(reaped, 42);
    }
}
