//! One PTY-backed terminal per tab. Raw bytes only — VT parsing/rendering lives in
//! the frontend (`xterm.js`), so this module stays a thin, fast pipe.

use std::io::{Read, Write};
use std::sync::Arc;
use std::thread;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::error::{CoreError, Result};
use crate::protocol::{Event, TabId};

/// Sink the engine supplies so a session can emit `Output` / `TabClosed` events
/// from its background threads.
pub type EventSink = Arc<dyn Fn(Event) + Send + Sync>;

pub struct Session {
    pub tab: TabId,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl Session {
    /// Spawn `program` + `args` in a fresh PTY of `cols`x`rows`, in `cwd`
    /// (default: process cwd). The engine resolves the CLI and any session flags.
    pub fn spawn(
        tab: TabId,
        program: &str,
        args: &[String],
        cwd: Option<&str>,
        cols: u16,
        rows: u16,
        sink: EventSink,
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

        let mut cmd = CommandBuilder::new(program);
        for a in args {
            cmd.arg(a);
        }
        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }
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

        // Reap the child -> Event::TabClosed.
        let sink_exit = sink.clone();
        thread::Builder::new()
            .name(format!("pear-pty-wait-{tab}"))
            .spawn(move || {
                let code = child.wait().ok().map(|s| s.exit_code() as i32);
                (sink_exit)(Event::TabClosed { tab, code });
            })
            .map_err(CoreError::Io)?;

        Ok(Session {
            tab,
            writer,
            master: pair.master,
            killer,
        })
    }

    /// Forward keystrokes to the child's stdin.
    pub fn write_input(&mut self, bytes: &[u8]) -> Result<()> {
        self.writer.write_all(bytes)?;
        self.writer.flush()?;
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
