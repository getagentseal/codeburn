mod cli;
mod config;
mod fx;

use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};

use crate::cli::CodeburnCli;
use crate::config::CurrencyConfig;
use crate::fx::FxCache;

/// Shared application state. Wraps the CLI handle + currency config + FX cache so every
/// Tauri command sees the same instances. Interior Mutex keeps things simple; the state is
/// touched from the main thread (UI) and the Tokio runtime (CLI spawn, HTTP), both of
/// which go through `#[tauri::command]` async functions that acquire the lock briefly.
pub struct AppState {
    pub cli: Mutex<CodeburnCli>,
    pub config: Mutex<CurrencyConfig>,
    pub fx: FxCache,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state = AppState {
                cli: Mutex::new(CodeburnCli::resolve()),
                config: Mutex::new(CurrencyConfig::load_or_default()),
                fx: FxCache::new(),
            };
            app.manage(state);

            build_tray(app.handle())?;

            // Hide the popover window on launch; the tray icon click toggles it.
            if let Some(window) = app.get_webview_window("popover") {
                let _ = window.hide();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Keep the popover alive between clicks. Hiding avoids spawn cost + preserves
                // scroll position + in-flight data. User exits via the tray menu instead.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::fetch_payload,
            commands::set_currency,
            commands::open_terminal_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let dashboard = MenuItem::with_id(app, "dashboard", "Show Dashboard", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
    let report = MenuItem::with_id(app, "report", "Open Full Report", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit CodeBurn", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&dashboard, &refresh, &report, &quit])?;

    TrayIconBuilder::with_id("codeburn-tray")
        .tooltip("CodeBurn")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "dashboard" => toggle_popover(app),
            "refresh" => {
                // Nudge the webview so it re-requests the payload. The front-end listens for
                // this event and kicks off a new fetch_payload command.
                if let Some(window) = app.get_webview_window("popover") {
                    let _ = window.emit("codeburn://refresh", ());
                }
            }
            "report" => {
                let _ = cli::spawn_in_terminal(app, &["report"]);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_popover(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn toggle_popover(app: &AppHandle) {
    let Some(window) = app.get_webview_window("popover") else {
        return;
    };
    match window.is_visible() {
        Ok(true) => {
            let _ = window.hide();
        }
        _ => {
            position_popover_top_right(&window);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// Snap the popover to the top-right of the primary monitor, just below the GNOME
/// top panel. Linux window managers generally ignore the tray icon's screen position,
/// so there is no reliable anchor to attach to. Top-right keeps the window visually
/// close to the StatusNotifier area on every desktop we target (GNOME, KDE, Unity).
fn position_popover_top_right(window: &tauri::WebviewWindow) {
    // Matches desktop/src-tauri/tauri.conf.json popover width (logical pixels).
    const POPOVER_WIDTH_LOGICAL: f64 = 360.0;
    const MARGIN_LOGICAL: f64 = 12.0;
    const TOP_PANEL_LOGICAL: f64 = 36.0;

    let Ok(Some(monitor)) = window.primary_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    let popover_w = (POPOVER_WIDTH_LOGICAL * scale) as u32;
    let margin = (MARGIN_LOGICAL * scale) as u32;
    let panel = (TOP_PANEL_LOGICAL * scale) as u32;
    let screen = monitor.size();
    let x = screen.width.saturating_sub(popover_w).saturating_sub(margin);
    let y = panel;
    let _ = window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
}

mod commands {
    use super::AppState;
    use serde_json::Value;
    use tauri::{AppHandle, State};

    #[tauri::command]
    pub async fn fetch_payload(
        period: String,
        provider: String,
        include_optimize: bool,
        state: State<'_, AppState>,
    ) -> Result<Value, String> {
        let cli = state.cli.lock().map_err(|e| e.to_string())?.clone();
        cli.fetch_menubar_payload(&period, &provider, include_optimize)
            .await
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn set_currency(
        code: String,
        state: State<'_, AppState>,
    ) -> Result<crate::fx::CurrencyApplied, String> {
        let symbol = crate::fx::symbol_for(&code);
        let rate = state.fx.rate_for(&code).await.unwrap_or(1.0);
        state
            .config
            .lock()
            .map_err(|e| e.to_string())?
            .set_currency(&code, &symbol)
            .map_err(|e| e.to_string())?;
        Ok(crate::fx::CurrencyApplied { code, symbol, rate })
    }

    #[tauri::command]
    pub fn open_terminal_command(app: AppHandle, args: Vec<String>) -> Result<(), String> {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        crate::cli::spawn_in_terminal(&app, &args).map_err(|e| e.to_string())
    }
}
