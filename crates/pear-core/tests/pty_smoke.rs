//! End-to-end: a scratch shell tab echoes input back through the PTY as `Output`.

use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use pear_core::{CliKind, Command, Engine, Event};

#[test]
fn shell_tab_echoes_input() {
    // Isolate the data dir so we don't touch the real history.json.
    let tmp = tempfile::tempdir().unwrap();
    std::env::set_var("PEAR_DATA_DIR", tmp.path());

    let (tx, rx) = mpsc::channel::<Event>();
    let sink = Arc::new(move |e: Event| {
        let _ = tx.send(e);
    });

    let mut engine = Engine::new(sink).unwrap();
    engine.handle(Command::OpenScratch {
        cli: CliKind::Shell,
        cwd: None,
        session_id: None,
    });

    // Grab the tab id from the TabOpened event.
    let tab = loop {
        match rx.recv_timeout(Duration::from_secs(2)).expect("TabOpened") {
            Event::TabOpened { tab, .. } => break tab,
            _ => continue,
        }
    };

    engine.handle(Command::Input {
        tab,
        bytes: b"echo pearcheck123\n".to_vec(),
    });

    // Collect output for up to 3s, looking for the echoed marker.
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut seen = String::new();
    while Instant::now() < deadline {
        if let Ok(Event::Output { bytes, .. }) = rx.recv_timeout(Duration::from_millis(250)) {
            seen.push_str(&String::from_utf8_lossy(&bytes));
            if seen.contains("pearcheck123") {
                break;
            }
        }
    }
    assert!(
        seen.contains("pearcheck123"),
        "shell did not echo marker; got: {seen:?}"
    );

    engine.handle(Command::CloseTab { tab });
}
