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

/// TEMP (vibrancy tuner): swap the native NSVisualEffectView material at runtime so we can pick
/// a default. macOS-only; clears the prior effect view first to avoid stacking.
#[tauri::command]
#[allow(unused_variables)]
fn set_vibrancy_material(window: tauri::WebviewWindow, material: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{
            apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial as M, NSVisualEffectState,
        };
        let mat = match material.as_str() {
            "under_window" => M::UnderWindowBackground,
            "under_page" => M::UnderPageBackground,
            "sidebar" => M::Sidebar,
            "fullscreen_ui" => M::FullScreenUI,
            "content" => M::ContentBackground,
            "window_bg" => M::WindowBackground,
            "popover" => M::Popover,
            "menu" => M::Menu,
            "header" => M::HeaderView,
            "titlebar" => M::Titlebar,
            _ => M::HudWindow,
        };
        let _ = clear_vibrancy(&window);
        apply_vibrancy(&window, mat, Some(NSVisualEffectState::Active), None)
            .map_err(|e| format!("{e:?}"))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // The sink forwards every engine Event to the webview as "pear:event".
            let handle = app.handle().clone();
            let sink: pear_core::EventSink = Arc::new(move |event: Event| {
                let _ = handle.emit("pear:event", event);
            });
            let engine = Engine::new(sink).map_err(|e| format!("engine init: {e}"))?;
            app.manage(Mutex::new(engine));

            // macOS: frosted native vibrancy behind the (transparent) webview — the Ghostty-style
            // translucent background. Best-effort; a failure just leaves an opaque window.
            #[cfg(target_os = "macos")]
            if let Some(win) = app.get_webview_window("main") {
                use window_vibrancy::{
                    apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
                };
                let _ = apply_vibrancy(
                    &win,
                    NSVisualEffectMaterial::HudWindow,
                    Some(NSVisualEffectState::Active),
                    None,
                );
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pear_command,
            set_vibrancy_material
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
