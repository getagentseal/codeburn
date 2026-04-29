mod cli;
mod config;
mod fx;
#[cfg(target_os = "linux")]
mod tray_linux;

use std::sync::Mutex;

use tauri::{AppHandle, Manager, WindowEvent};
#[cfg(not(target_os = "linux"))]
use tauri::Emitter;
#[cfg(target_os = "linux")]
use tauri::Listener;

#[cfg(not(target_os = "linux"))]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
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
    #[cfg(target_os = "linux")]
    pub linux_tray: tray_linux::LinuxTrayHandle,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(target_os = "linux")]
            let linux_tray = tray_linux::LinuxTrayHandle::empty();

            let state = AppState {
                cli: Mutex::new(CodeburnCli::resolve()),
                config: Mutex::new(CurrencyConfig::load_or_default()),
                fx: FxCache::new(),
                #[cfg(target_os = "linux")]
                linux_tray: linux_tray.clone(),
            };
            app.manage(state);

            #[cfg(not(target_os = "linux"))]
            build_tray_tauri(app.handle())?;

            #[cfg(target_os = "linux")]
            init_tray_linux(app.handle().clone(), linux_tray);

            if let Some(window) = app.get_webview_window("popover") {
                let _ = window.hide();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Keep the popover alive between clicks. Hiding avoids spawn cost + preserves
                // scroll position + in-flight data. User exits via the in-popover quit button
                // or (on non-Linux) the tray menu.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::fetch_payload,
            commands::set_currency,
            commands::open_terminal_command,
            commands::quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(not(target_os = "linux"))]
fn build_tray_tauri(app: &AppHandle) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id("codeburn-tray") else {
        return Ok(());
    };

    let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
    let report = MenuItem::with_id(app, "report", "Open Full Report", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit CodeBurn", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&refresh, &report, &quit])?;

    tray.set_menu(Some(menu))?;
    tray.set_show_menu_on_left_click(false)?;

    tray.on_menu_event(|app, event| match event.id.as_ref() {
        "quit" => app.exit(0),
        "refresh" => {
            if let Some(window) = app.get_webview_window("popover") {
                let _ = window.emit("codeburn://refresh", ());
            }
        }
        "report" => {
            let _ = cli::spawn_in_terminal(app, &["report"]);
        }
        _ => {}
    });

    tray.on_tray_icon_event(|tray, event| {
        match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                position,
                ..
            } => {
                toggle_popover(tray.app_handle(), Some((position.x as i32, position.y as i32)));
            }
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                position,
                ..
            } => {
                toggle_popover(tray.app_handle(), Some((position.x as i32, position.y as i32)));
            }
            _ => {}
        }
    });

    Ok(())
}

#[cfg(target_os = "linux")]
fn init_tray_linux(app: AppHandle, handle: tray_linux::LinuxTrayHandle) {
    // Spawn the SNI tray on the Tokio runtime that Tauri already owns.
    let spawn_app = app.clone();
    let spawn_handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = tray_linux::spawn(spawn_app, spawn_handle).await {
            eprintln!("codeburn: failed to spawn Linux tray: {err}");
        }
    });

    // Left-click on the tray: show popover anchored to the click coordinates.
    let activate_app = app.clone();
    app.listen_any("codeburn://tray-activate", move |event| {
        let anchor = parse_click(event.payload());
        toggle_popover(&activate_app, anchor);
    });

    // Right-click / middle-click: same as left for now. Quit lives in the popover footer.
    let secondary_app = app.clone();
    app.listen_any("codeburn://tray-secondary", move |event| {
        let anchor = parse_click(event.payload());
        toggle_popover(&secondary_app, anchor);
    });
}

#[cfg(target_os = "linux")]
fn parse_click(payload: &str) -> Option<(i32, i32)> {
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    let x = value.get("x")?.as_i64()? as i32;
    let y = value.get("y")?.as_i64()? as i32;
    Some((x, y))
}

/// Show or hide the popover. When `anchor` is `Some((x, y))`, position the popover
/// centered horizontally on the click and just below it (Linux path, anchored to the
/// StatusNotifier Activate coordinates). When `None`, snap it to the top-right of the
/// primary monitor (non-Linux fallback + menu-driven invocations).
fn toggle_popover(app: &AppHandle, anchor: Option<(i32, i32)>) {
    let Some(window) = app.get_webview_window("popover") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    let _ = window.show();
    let _ = window.unminimize();
    position_popover(&window, anchor);
    let _ = window.set_focus();
}

fn position_popover(window: &tauri::WebviewWindow, anchor: Option<(i32, i32)>) {
    // Matches desktop/src-tauri/tauri.conf.json popover dimensions (logical pixels).
    const POPOVER_WIDTH_LOGICAL: f64 = 360.0;
    const POPOVER_HEIGHT_LOGICAL: f64 = 660.0;
    const MARGIN_LOGICAL: f64 = 8.0;
    const TOP_PANEL_LOGICAL: f64 = 36.0;

    let Ok(Some(monitor)) = window.primary_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    let screen = monitor.size();
    let pop_w = (POPOVER_WIDTH_LOGICAL * scale) as i32;
    let pop_h = (POPOVER_HEIGHT_LOGICAL * scale) as i32;
    let margin = (MARGIN_LOGICAL * scale) as i32;
    let panel = (TOP_PANEL_LOGICAL * scale) as i32;
    let screen_w = screen.width as i32;
    let screen_h = screen.height as i32;

    let usable_anchor = anchor.filter(|(ax, ay)| *ax > 0 || *ay > 0);

    let (x, y) = match usable_anchor {
        Some((click_x, click_y)) => {
            let desired_x = click_x - pop_w / 2;
            let max_x = (screen_w - pop_w - margin).max(margin);
            let clamped_x = desired_x.clamp(margin, max_x);
            let below_midpoint = click_y > screen_h / 2;
            let desired_y = if below_midpoint {
                click_y - pop_h - margin
            } else {
                click_y + margin
            };
            let max_y = (screen_h - pop_h - margin).max(margin);
            let clamped_y = desired_y.clamp(margin, max_y);
            (clamped_x, clamped_y)
        }
        None => {
            let x = (screen_w - pop_w - margin).max(0);
            (x, panel)
        }
    };

    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
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

    #[tauri::command]
    pub fn quit_app(app: AppHandle) {
        app.exit(0);
    }
}
