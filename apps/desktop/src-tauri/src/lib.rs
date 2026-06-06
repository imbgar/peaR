//! Tauri backend: a *thin* shim over `pear-core`.
//!
//! Responsibilities, deliberately minimal:
//!   - own a `Mutex<Engine>` as managed state,
//!   - expose one command (`pear_command`) that forwards a `Command` to the engine,
//!   - bridge engine `Event`s to the webview via `app.emit("pear:event", ..)`.
//!
//! All real behaviour lives in `pear-core`, so a future daemon/TUI frontend (see
//! ARCHITECTURE.md branch paths) reuses everything below the IPC line unchanged.

use std::sync::{Arc, Mutex};

use pear_core::{Command, Engine, Event};
use tauri::{Emitter, Manager, State};

/// Frontend -> core. The webview calls `invoke("pear_command", { command })`.
#[tauri::command]
fn pear_command(state: State<'_, Mutex<Engine>>, command: Command) -> Result<(), String> {
    state.lock().map_err(|e| e.to_string())?.handle(command);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init());
    // Auto-update (desktop only): the updater checks a GitHub-hosted manifest and
    // installs the new bundle in place; process lets the frontend relaunch after.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }
    builder
        .setup(|app| {
            // The sink forwards every engine Event to the webview as "pear:event".
            let handle = app.handle().clone();
            let sink: pear_core::EventSink = Arc::new(move |event: Event| {
                let _ = handle.emit("pear:event", event);
            });
            let engine = Engine::new(sink).map_err(|e| format!("engine init: {e}"))?;
            app.manage(Mutex::new(engine));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![pear_command])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
