// Linux builds compile the Windows-only dock, session and tray-status code but never
// call it (that platform runs its own SNI tray), so dead-code lints are for Windows only.
#![cfg_attr(not(windows), allow(dead_code))]

mod autostart;
mod cli;
mod config;
mod dock;
mod fx;
mod glance;
mod plan;
mod refresh;
mod session;
mod settings;
mod telemetry;
/// The spend-in-the-tray badge is a second tray icon, which only the Tauri tray backend
/// provides; Linux runs its own SNI tray (`tray_linux`) and has no equivalent, so the
/// whole module is compiled out there rather than sitting unused.
#[cfg(not(target_os = "linux"))]
mod tray_badge;
#[cfg(target_os = "linux")]
mod tray_linux;
mod tray_status;
mod update;
mod usage_guard;

use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};

static LAST_HIDDEN_MS: AtomicI64 = AtomicI64::new(0);

use tauri::{AppHandle, Emitter, Manager, WindowEvent};
#[cfg(target_os = "linux")]
use tauri::Listener;

#[cfg(not(target_os = "linux"))]
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

#[cfg(not(target_os = "linux"))]
static DOCK_MENU_ITEM: std::sync::OnceLock<CheckMenuItem<tauri::Wry>> = std::sync::OnceLock::new();
#[cfg(not(target_os = "linux"))]
static USAGE_MENU_ITEM: std::sync::OnceLock<MenuItem<tauri::Wry>> = std::sync::OnceLock::new();
#[cfg(not(target_os = "linux"))]
static THEME_MENU_ITEM: std::sync::OnceLock<MenuItem<tauri::Wry>> = std::sync::OnceLock::new();

use crate::cli::CodeburnCli;
use crate::config::CurrencyConfig;
use crate::fx::FxCache;

#[cfg(not(target_os = "linux"))]
const TRAY_ID: &str = "codeburn-tray";
/// Second tray icon that carries today's spend as text, sitting next to the logo. The
/// closest the Windows notification area gets to the macOS menubar title.
#[cfg(not(target_os = "linux"))]
const BADGE_TRAY_ID: &str = "codeburn-badge";
const POPOVER_LABEL: &str = "popover";

/// Shared application state. Wraps the CLI handle + currency config + FX cache so every
/// Tauri command sees the same instances. Interior Mutex keeps things simple; the state is
/// touched from the main thread (UI) and the Tokio runtime (CLI spawn, HTTP), both of
/// which go through `#[tauri::command]` async functions that acquire the lock briefly.
pub struct AppState {
    pub cli: Mutex<CodeburnCli>,
    pub config: Mutex<CurrencyConfig>,
    pub fx: FxCache,
    pub plan: plan::PlanClient,
    /// The Capacity Dock's slice of the last payload. It is kept here because the dock is a
    /// window with no payload of its own, and a second CLI run to give it one would double
    /// the cost of every refresh.
    pub glance: glance::GlanceCache,
}

/// What a second launch is asking the running app to do. An app with no window of its own
/// cannot be reached by clicking anything, so its own argv is the control channel: the
/// single-instance plugin hands the running process whatever the second launch was started
/// with. The desktop app (`app/`, which bundles this tray app) drives both from there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecondLaunch {
    /// A plain relaunch: the person started the app again, so show them the popover.
    ShowPopover,
    Quit,
    /// Re-read what is on disk. Written by whoever changed a preference file behind the app's
    /// back, which for the dock rail is the desktop app's Sidebar switch.
    ReloadSettings,
}

/// Quit outranks a reload: a launch that asks for both wants the process gone, and reloading
/// settings into a process about to exit is work nobody sees.
pub fn parse_second_launch(args: &[String]) -> SecondLaunch {
    // argv[0] is a path and can never equal either flag, so the whole vector is scanned
    // rather than assuming the plugin hands over the program name.
    if args.iter().any(|arg| arg == "--quit") {
        return SecondLaunch::Quit;
    }
    if args.iter().any(|arg| arg == "--reload-settings") {
        return SecondLaunch::ReloadSettings;
    }
    SecondLaunch::ShowPopover
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered before any other plugin so it can intercept a second launch.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // The plugin hands a second launch over with a synchronous SendMessage, so that
            // launch sits inside it until this returns, and the message can land while setup
            // still owns the main thread (a tray icon registering, the popover being built).
            // Showing or closing a window from there waits on an event loop that is not running
            // yet, this never returns, and every launch after it (the desktop app's next
            // `--quit` included) blocks behind the same message. So the request is only
            // recorded here and carried out once the loop is turning. `run_on_main_thread`
            // from the main thread itself runs the work in place, hence the thread.
            let request = parse_second_launch(&args);
            let handle = app.clone();
            std::thread::spawn(move || {
                let inner = handle.clone();
                let _ = handle.run_on_main_thread(move || match request {
                    SecondLaunch::ShowPopover => show_popover(&inner, None),
                    SecondLaunch::Quit => inner.exit(0),
                    SecondLaunch::ReloadSettings => reload_settings(&inner),
                });
            });
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // `--quit` with nothing running: this launch is the instance being asked to go,
            // so it goes without ever showing anything. It cannot be answered before the
            // builder runs, because handing the argv to an instance that IS running is the
            // single-instance plugin's job, and returning early meant the running app never
            // heard the request at all.
            if parse_second_launch(&std::env::args().collect::<Vec<_>>()) == SecondLaunch::Quit {
                app.handle().exit(0);
                return Ok(());
            }

            app.manage(AppState {
                cli: Mutex::new(CodeburnCli::resolve()),
                config: Mutex::new(CurrencyConfig::load_or_default()),
                fx: FxCache::new(),
                plan: plan::PlanClient::new(),
                glance: glance::GlanceCache::new(),
            });

            #[cfg(target_os = "windows")]
            warn_if_window_station_hidden();

            // Consent-gated anonymous telemetry. Nothing transmits until a decision has been
            // made, and the decision is the desktop app's whenever that app is installed.
            // `track` is silent until this has run, so it comes before anything that reports.
            telemetry::init(app.package_info().version.to_string());
            telemetry::track("app_open", serde_json::Value::Null);
            tauri::async_runtime::spawn(async {
                // The queue is offered on the beat rather than at launch, so starting up
                // never costs a request on its own. After a failed send the wait is the
                // backoff instead, so a dead endpoint is not hammered on a fixed beat.
                loop {
                    let wait = telemetry::instance()
                        .map(|telemetry| telemetry.next_flush_delay())
                        .unwrap_or(telemetry::FLUSH_INTERVAL);
                    tokio::time::sleep(wait).await;
                    // The debounced save has usually run by now; this is what covers the
                    // case where it did not.
                    telemetry::save_pending();
                    if let Some(telemetry) = telemetry::instance() {
                        telemetry.flush(telemetry::HTTP_TIMEOUT).await;
                    }
                }
            });

            // Session lock, display sleep and wake, which the background refresh loop reads
            // before it spends a Node process nobody could see the result of.
            session::start(app.handle());

            #[cfg(not(target_os = "linux"))]
            {
                build_tray_tauri(app.handle())?;
                restore_tray_status(app.handle());
            }

            #[cfg(target_os = "linux")]
            init_tray_linux(app.handle().clone(), tray_linux::LinuxTrayHandle::empty());

            if let Some(window) = app.get_webview_window(POPOVER_LABEL) {
                let _ = window.hide();
                #[cfg(target_os = "windows")]
                strip_window_frame(&window);
            }

            if dock::is_enabled() {
                if let Err(err) = dock::show(app.handle()) {
                    crate::log_line!("codeburn: failed to show the Capacity Dock: {err}");
                }
            }

            Ok(())
        })
        // The dock's right-click menu pops up from `dock::popup_context_menu`; its items report
        // here rather than to the tray handler.
        .on_menu_event(|app, event| match event.id.as_ref() {
            "dock_refresh" => {
                if let Some(window) = app.get_webview_window(dock::DOCK_LABEL) {
                    let _ = window.emit("codeburn://dock-refresh", ());
                }
            }
            "dock_hide" => set_dock_enabled(app, false),
            "dock_left" => dock::dock_to(app, dock::Edge::Left),
            "dock_right" => dock::dock_to(app, dock::Edge::Right),
            "dock_top" => dock::dock_to(app, dock::Edge::Top),
            "dock_bottom" => dock::dock_to(app, dock::Edge::Bottom),
            _ => {}
        })
        .on_window_event(|window, event| {
            // The dock is a persistent rail: it owns its own lifecycle and must survive both
            // the hide-on-blur and the hide-on-close that keep the popover alive. The
            // settings window is an ordinary window: it stays put when it loses focus, and
            // closing it destroys it rather than parking a webview nobody can see.
            if window.label() == dock::DOCK_LABEL || window.label() == settings::SETTINGS_LABEL {
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                    mark_hidden(window.app_handle());
                }
                WindowEvent::Focused(false) => {
                    let _ = window.hide();
                    mark_hidden(window.app_handle());
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::fetch_payload,
            commands::dock_glance,
            commands::cli_status,
            commands::currency,
            commands::set_currency,
            commands::open_terminal_command,
            commands::open_claude_login,
            commands::export_usage,
            commands::quit_app,
            commands::hide_popover,
            commands::set_tray_tooltip,
            commands::set_tray_badge,
            commands::set_tray_severity,
            commands::set_tray_usage,
            commands::app_version,
            commands::plan_usage,
            commands::launch_at_login,
            commands::set_launch_at_login,
            commands::dock_quota,
            commands::dock_set_layout,
            commands::dock_set_preferred,
            commands::dock_context_menu,
            commands::dock_close,
            commands::dock_begin_drag,
            commands::dock_prefs,
            commands::set_dock_prefs,
            commands::open_settings_window,
            commands::settings_section,
            commands::settings_load,
            commands::settings_patch,
            commands::terminals,
            commands::claude_config_dirs,
            commands::set_claude_config_dirs,
            commands::cursor_sync,
            commands::set_cursor_sync,
            commands::cursor_sync_env_off,
            commands::pick_directory,
            commands::daily_budgets,
            commands::set_daily_budget,
            commands::provider_key_providers,
            commands::set_provider_key,
            commands::usage_refresh_plan,
            commands::check_updates,
            commands::telemetry_track,
            commands::telemetry_status,
            commands::telemetry_set_enabled,
            commands::telemetry_consent,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            // `code` is `None` only when the last window closed on its own; an explicit
            // `app.exit(..)` (tray Quit, `commands::quit_app`) always carries `Some(_)` and
            // must be allowed through, or Quit does nothing.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                    return;
                }
                // The exit is going ahead, so this is the last chance to record how long the
                // session lasted and to offer the queue. Bounded, and it keeps whatever it
                // could not send for the next launch either way.
                telemetry::flush_on_quit();
            }
        });
}

#[cfg(not(target_os = "linux"))]
fn build_tray_tauri(app: &AppHandle) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };

    // Disabled by design: the mac's menu opens with what today cost, which is the one thing
    // worth knowing without opening anything. The frontend fills it in on every refresh.
    let usage = MenuItem::with_id(app, "usage", "Today", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open CodeBurn", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
    let theme = MenuItem::with_id(
        app,
        "toggle_theme",
        theme_menu_text(&theme_choice()),
        true,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
    let dock_settings = MenuItem::with_id(
        app,
        "dock_settings",
        "Capacity Dock Settings...",
        true,
        None::<&str>,
    )?;
    let capacity_dock = CheckMenuItem::with_id(
        app,
        "toggle_dock",
        "Show Capacity Dock",
        true,
        dock::is_enabled(),
        None::<&str>,
    )?;
    let report = MenuItem::with_id(app, "report", "Open Full Report", true, None::<&str>)?;
    let updates = MenuItem::with_id(app, "check_updates", "Check for Updates", true, None::<&str>)?;
    let about = MenuItem::with_id(app, "about", "About CodeBurn", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit CodeBurn", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    // Inside a Store package the update check never runs, so the item that opens its result
    // would only ever say there is nothing to check. It is not offered at all there.
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![
        &usage,
        &separator,
        &open,
        &refresh,
        &theme,
        &settings,
        &dock_settings,
        &capacity_dock,
        &report,
    ];
    if !update::is_packaged_app() {
        items.push(&updates);
    }
    items.extend([&separator as &dyn tauri::menu::IsMenuItem<tauri::Wry>, &about, &quit]);
    let menu = Menu::with_items(app, &items)?;
    // Both tray icons share one menu, so the handler needs the items themselves to keep the
    // checkmark in step with the persisted state and the usage row in step with the payload.
    let _ = DOCK_MENU_ITEM.set(capacity_dock);
    let _ = USAGE_MENU_ITEM.set(usage);
    let _ = THEME_MENU_ITEM.set(theme);

    tray.set_menu(Some(menu.clone()))?;
    tray.set_show_menu_on_left_click(false)?;
    let _ = tray.set_tooltip(Some("CodeBurn"));
    // A tray's menu handler is registered globally, not against that tray, so this one
    // answers for both icons and the badge below must not register a second copy: two
    // copies ran every item twice, which skipped a step of the theme cycle and left the
    // Capacity Dock item toggling itself back.
    tray.on_menu_event(on_tray_menu_event);
    tray.on_tray_icon_event(on_tray_icon_event);

    // The badge icon starts fully transparent and hidden; the frontend shows it once it has
    // today's spend. Registering it right after the logo puts it beside the logo in the tray.
    let blank = tauri::image::Image::new_owned(
        vec![0u8; (BLANK_ICON_SIZE * BLANK_ICON_SIZE * 4) as usize],
        BLANK_ICON_SIZE,
        BLANK_ICON_SIZE,
    );
    TrayIconBuilder::with_id(BADGE_TRAY_ID)
        .icon(blank)
        .tooltip("CodeBurn")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(on_tray_icon_event)
        .build(app)?
        .set_visible(false)?;

    Ok(())
}

#[cfg(not(target_os = "linux"))]
const BLANK_ICON_SIZE: u32 = 16;

#[cfg(not(target_os = "linux"))]
fn on_tray_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id.as_ref() {
        "quit" => app.exit(0),
        "open" => show_popover(app, None),
        "refresh" => {
            if let Some(window) = app.get_webview_window(POPOVER_LABEL) {
                let _ = window.emit("codeburn://refresh", ());
            }
        }
        "toggle_theme" => cycle_theme(app),
        "toggle_dock" => set_dock_enabled(app, !dock::is_enabled()),
        // Deep links into the settings window: General, General scrolled to its Capacity
        // Dock section, and About, exactly as the mac's three menu items land.
        "settings" => open_settings(app, "general"),
        "dock_settings" => open_settings(app, "general#dock"),
        "about" => open_settings(app, "about"),
        // The mac answers this with an NSAlert. Here the three results (up to date, update
        // available, check failed) belong on the About pane, which already has the version
        // and the button that installs what the check found, so the menu item opens that
        // pane and the anchor tells it to check straight away.
        "check_updates" => open_settings(app, "about#check"),
        "report" => {
            let _ = cli::spawn_in_terminal(app, &["report"]);
        }
        _ => {}
    }
}

/// Opens the settings window on a named pane. The popover is left alone: it hides itself on
/// blur, so the settings window taking focus is what closes it.
fn open_settings(app: &AppHandle, section: &str) {
    if let Err(err) = settings::open(app, Some(section)) {
        crate::log_line!("codeburn: failed to open the settings window: {err}");
    }
}

#[cfg(not(target_os = "linux"))]
fn on_tray_icon_event(tray: &tauri::tray::TrayIcon, event: TrayIconEvent) {
    match event {
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            position,
            ..
        }
        | TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            position,
            ..
        } => {
            toggle_popover(tray.app_handle(), Some((position.x as i32, position.y as i32)));
        }
        _ => {}
    }
}

#[cfg(target_os = "linux")]
fn init_tray_linux(app: AppHandle, handle: tray_linux::LinuxTrayHandle) {
    // Spawn the SNI tray on the Tokio runtime that Tauri already owns.
    let spawn_app = app.clone();
    let spawn_handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = tray_linux::spawn(spawn_app, spawn_handle).await {
            crate::log_line!("codeburn: failed to spawn Linux tray: {err}");
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

/// A process started from a service session (the QEMU guest agent's guest-exec, SSH, a
/// scheduled task) gets a window station nobody is looking at: the tray icon and every window,
/// dock included, report success and never reach the desktop. That exact trace cost a full
/// debugging round on the VM, and a release build launched that way is just as invisible, so
/// the line goes to the log on every startup rather than only in a debug build.
#[cfg(target_os = "windows")]
fn warn_if_window_station_hidden() {
    use windows_sys::Win32::System::StationsAndDesktops::{
        GetProcessWindowStation, GetUserObjectInformationW, UOI_FLAGS, USEROBJECTFLAGS,
    };
    const WSF_VISIBLE: u32 = 0x0001;

    let mut flags = USEROBJECTFLAGS {
        fInherit: 0,
        fReserved: 0,
        dwFlags: 0,
    };
    let mut needed = 0u32;
    let ok = unsafe {
        GetUserObjectInformationW(
            GetProcessWindowStation(),
            UOI_FLAGS,
            &mut flags as *mut USEROBJECTFLAGS as *mut std::ffi::c_void,
            std::mem::size_of::<USEROBJECTFLAGS>() as u32,
            &mut needed,
        )
    };
    if ok != 0 && flags.dwFlags & WSF_VISIBLE == 0 {
        crate::log_line!(
            "codeburn: running on a non-interactive window station (service session launch); \
             the tray icon and windows will never appear on the desktop"
        );
    }
}

/// The popover window paints nothing of its own: it is transparent, and the rounded card
/// inside it is the whole visible shape. So DWM has to keep its hands off the frame. Its
/// own rounding clips at the system radius rather than the card radius, and the 1 px
/// frame it draws around a rounded window traces that wrong shape in grey just outside
/// the card.
#[cfg(target_os = "windows")]
fn strip_window_frame(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE,
        DWMWCP_DONOTROUND,
    };
    /// DWMWA_COLOR_NONE: suppress the border rather than tint it.
    const COLOR_NONE: u32 = 0xFFFF_FFFE;
    let Ok(hwnd) = window.hwnd() else { return };
    let preference: u32 = DWMWCP_DONOTROUND as u32;
    // Both are no-ops before Windows 11 build 22000, where the frame is square anyway.
    unsafe {
        DwmSetWindowAttribute(
            hwnd.0 as _,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &preference as *const u32 as *const std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
        DwmSetWindowAttribute(
            hwnd.0 as _,
            DWMWA_BORDER_COLOR as u32,
            &COLOR_NONE as *const u32 as *const std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

/// Both tray icons carry the same tooltip, so the number is there whichever one the pointer
/// lands on.
fn apply_tray_tooltip(app: &AppHandle, text: &str) {
    #[cfg(not(target_os = "linux"))]
    for id in [TRAY_ID, BADGE_TRAY_ID] {
        if let Some(tray) = app.tray_by_id(id) {
            let _ = tray.set_tooltip(Some(text));
        }
    }
    #[cfg(target_os = "linux")]
    let _ = (app, text);
}

/// `text` is a short spend string ("$87", "142", "1.2K"); `None` hides the badge icon.
#[cfg(not(target_os = "linux"))]
fn apply_tray_badge(app: &AppHandle, text: Option<&str>, muted: bool) -> Result<(), String> {
    let Some(badge) = app.tray_by_id(BADGE_TRAY_ID) else {
        return Ok(());
    };
    match text.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => {
            let icon = tray_badge::render(
                t,
                tray_badge::small_icon_size(),
                tray_badge::taskbar_is_dark(),
                muted,
            );
            // Windows can only modify an icon that is currently shown, so show first
            // (re-adds the previous bitmap) and then swap the bitmap.
            badge.set_visible(true).map_err(|e| e.to_string())?;
            badge.set_icon(Some(icon)).map_err(|e| e.to_string())?;
        }
        None => {
            badge.set_visible(false).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn apply_tray_tint(app: &AppHandle, tint: Option<[u8; 3]>) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let icon = tray_status::tray_icon(tint).map_err(|e| e.to_string())?;
    tray.set_icon(Some(icon)).map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn apply_tray_tint(app: &AppHandle, tint: Option<[u8; 3]>) -> Result<(), String> {
    let _ = (app, tint);
    Ok(())
}

/// System, then Light, then Dark, then back. The mac has no counterpart: its windows follow
/// the system appearance and offer no choice at all.
fn next_theme(current: &str) -> &'static str {
    match current {
        "light" => "dark",
        "dark" => "system",
        _ => "light",
    }
}

/// The item names the state it moves to rather than the one it is in, because a menu item
/// reads as a verb.
fn theme_menu_text(current: &str) -> String {
    match next_theme(current) {
        "light" => "Switch to Light Theme".into(),
        "dark" => "Switch to Dark Theme".into(),
        _ => "Switch to System Theme".into(),
    }
}

fn theme_choice() -> String {
    settings::read()
        .get("theme")
        .and_then(serde_json::Value::as_str)
        .filter(|choice| matches!(*choice, "system" | "light" | "dark"))
        .unwrap_or("system")
        .to_owned()
}

/// Writing the preference rather than asking the popover to flip its own is what makes the
/// item work with no popover on screen: every window renders from the broadcast.
fn cycle_theme(app: &AppHandle) {
    let mut patch = serde_json::Map::new();
    patch.insert(
        "theme".into(),
        serde_json::json!(next_theme(&theme_choice())),
    );
    match settings::patch(patch) {
        Ok(merged) => {
            settings::broadcast(app, &merged);
            sync_theme_menu_item();
        }
        Err(err) => crate::log_line!("codeburn: failed to persist the theme: {err}"),
    }
}

/// Keeps the item honest when the theme changed somewhere else: the popover's More menu or
/// the settings window.
#[cfg(not(target_os = "linux"))]
pub fn sync_theme_menu_item() {
    if let Some(item) = THEME_MENU_ITEM.get() {
        let _ = item.set_text(theme_menu_text(&theme_choice()));
    }
}

#[cfg(target_os = "linux")]
pub fn sync_theme_menu_item() {}

#[cfg(not(target_os = "linux"))]
fn set_tray_usage_text(text: &str) {
    if let Some(item) = USAGE_MENU_ITEM.get() {
        let _ = item.set_text(text);
    }
}

#[cfg(target_os = "linux")]
fn set_tray_usage_text(text: &str) {
    let _ = text;
}

/// How long a persisted badge is worth showing after a relaunch, from the mac's
/// MenubarStatusCache. Past that the tray stays blank until the first CLI answer rather than
/// quoting a figure that may be hours old.
const STATUS_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(600);

/// Puts the last known badge and tooltip back before the first refresh lands, so a relaunch
/// does not blank the tray for the length of a CLI round trip.
#[cfg(not(target_os = "linux"))]
fn restore_tray_status(app: &AppHandle) {
    let Some(status) = tray_status::read_status(STATUS_MAX_AGE) else {
        return;
    };
    if let Some(tooltip) = status.tooltip.as_deref() {
        apply_tray_tooltip(app, tooltip);
    }
    // The number icon is opt-in; without the setting the tray shows the logo alone.
    let badge_wanted = settings::read()
        .get("trayBadge")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if let (true, Some(badge)) = (badge_wanted, status.badge.as_deref()) {
        // Never restored dimmed: whether a paired device answers is this session's question,
        // and the first refresh dims it again if it still cannot be reached.
        let _ = apply_tray_badge(app, Some(badge), false);
    }
}

/// A blur immediately followed by the tray click that caused it would re-open the popover;
/// ignore show requests inside this window after a hide.
const TOGGLE_DEBOUNCE_MS: i64 = 300;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Every path that hides the popover goes through here, so the debounce stamp and the
/// frontend's visibility signal can never drift apart. The frontend drops to its idle
/// refresh cadence on `codeburn://hidden` and comes back on `codeburn://shown`.
fn mark_hidden(app: &AppHandle) {
    LAST_HIDDEN_MS.store(now_ms(), Ordering::Relaxed);
    let _ = app.emit("codeburn://hidden", ());
}

/// Persists the dock preference, then brings the window in line with it. The checkmark is only
/// moved once the state is stored, so a failed write cannot leave the menu lying.
fn set_dock_enabled(app: &AppHandle, enabled: bool) {
    if let Err(err) = dock::set_enabled(enabled) {
        crate::log_line!("codeburn: failed to persist the Capacity Dock setting: {err}");
        return;
    }
    if enabled {
        if let Err(err) = dock::show(app) {
            crate::log_line!("codeburn: failed to show the Capacity Dock: {err}");
        }
    } else {
        dock::hide(app);
    }
    #[cfg(not(target_os = "linux"))]
    if let Some(item) = DOCK_MENU_ITEM.get() {
        let _ = item.set_checked(enabled);
    }
    // Reported here rather than from the settings pane because this is the one funnel: the
    // tray item, the settings toggle and the dock's own Hide item all arrive through it.
    telemetry::track(
        if enabled { "dock_enabled" } else { "dock_disabled" },
        dock::telemetry_props(),
    );
}

/// Brings every surface in line with what is on disk, for a preference this process did not
/// write. The dock rail is the one that needs it: the desktop app's Sidebar switch edits
/// `windows-dock.json` directly, and a running tray app would otherwise keep the rail it had
/// until the next launch.
fn reload_settings(app: &AppHandle) {
    let enabled = dock::is_enabled();
    if enabled {
        if let Err(err) = dock::show(app) {
            crate::log_line!("codeburn: failed to show the Capacity Dock: {err}");
        }
        // A rail that was already up may also have had its size or appearance changed.
        dock::prefs_changed(app);
    } else {
        dock::hide(app);
    }
    #[cfg(not(target_os = "linux"))]
    if let Some(item) = DOCK_MENU_ITEM.get() {
        let _ = item.set_checked(enabled);
    }
    settings::broadcast(app, &settings::read());
    sync_theme_menu_item();
}

fn toggle_popover(app: &AppHandle, anchor: Option<(i32, i32)>) {
    let Some(window) = app.get_webview_window(POPOVER_LABEL) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        mark_hidden(app);
        return;
    }
    let last = LAST_HIDDEN_MS.load(Ordering::Relaxed);
    if now_ms() - last < TOGGLE_DEBOUNCE_MS {
        return;
    }
    show_popover(app, anchor);
}

fn show_popover(app: &AppHandle, anchor: Option<(i32, i32)>) {
    let Some(window) = app.get_webview_window(POPOVER_LABEL) else {
        return;
    };
    // Position before showing so the first frame is already in place (no jump).
    position_popover(&window, anchor);
    let _ = window.show();
    let _ = window.unminimize();
    position_popover(&window, anchor);
    // A popover on screen is proof the session is unlocked and the displays are on, so a
    // notification this process never received cannot latch the refresh loop off.
    session::note_attended();
    let _ = window.set_focus();
    let _ = window.emit("codeburn://shown", ());
}

/// Places the popover against the taskbar / panel edge of the monitor that owns the click
/// (or the cursor, when the request came from a menu). The work area already excludes the
/// taskbar on Windows and panels on Linux, so we never need to guess their heights: the
/// card sits `GUTTER` inside the work area, horizontally centred on the anchor and
/// clamped to the screen.
fn position_popover(window: &tauri::WebviewWindow, anchor: Option<(i32, i32)>) {
    const CARD_WIDTH_LOGICAL: f64 = 360.0;
    const CARD_HEIGHT_LOGICAL: f64 = 660.0;
    /// Transparent margin the page paints the card shadow into, and the gap the card
    /// keeps from the work-area edge. One value for both: the shadow needs the room and
    /// the card needs the inset, so the window edge is exactly where the inset ends.
    const GUTTER_LOGICAL: f64 = 12.0;
    const POPOVER_WIDTH_LOGICAL: f64 = CARD_WIDTH_LOGICAL + 2.0 * GUTTER_LOGICAL;
    const POPOVER_HEIGHT_LOGICAL: f64 = CARD_HEIGHT_LOGICAL + 2.0 * GUTTER_LOGICAL;
    const MARGIN_LOGICAL: f64 = 0.0;

    let point = anchor
        .filter(|(x, y)| *x > 0 || *y > 0)
        .map(|(x, y)| (x as f64, y as f64))
        .or_else(|| window.cursor_position().ok().map(|p| (p.x, p.y)));

    let monitor = point
        .and_then(|(x, y)| window.monitor_from_point(x, y).ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };

    let scale = monitor.scale_factor();
    let pop_w = (POPOVER_WIDTH_LOGICAL * scale).round() as i32;
    let pop_h = (POPOVER_HEIGHT_LOGICAL * scale).round() as i32;
    let margin = (MARGIN_LOGICAL * scale).round() as i32;

    let area = monitor.work_area();
    let area_x = area.position.x;
    let area_y = area.position.y;
    let area_w = area.size.width as i32;
    let area_h = area.size.height as i32;
    let screen = monitor.size();
    let screen_pos = monitor.position();

    let (anchor_x, anchor_y) = point
        .map(|(x, y)| (x as i32, y as i32))
        .unwrap_or((area_x + area_w - pop_w / 2 - margin, area_y + area_h));

    let min_x = area_x + margin;
    let max_x = (area_x + area_w - pop_w - margin).max(min_x);
    let x = (anchor_x - pop_w / 2).clamp(min_x, max_x);

    // Which edge holds the taskbar? Whichever side the work area was trimmed on. If the
    // taskbar is at the top (or the anchor is in the top half with no bottom taskbar) the
    // popover drops down from the top edge; otherwise it rises from the bottom edge.
    let trimmed_top = area_y > screen_pos.y;
    let trimmed_bottom = (area_y + area_h) < (screen_pos.y + screen.height as i32);
    let anchor_in_top_half = anchor_y < screen_pos.y + (screen.height as i32) / 2;
    let open_downward = trimmed_top || (!trimmed_bottom && anchor_in_top_half);

    let y = if open_downward {
        area_y + margin
    } else {
        (area_y + area_h - pop_h - margin).max(area_y + margin)
    };

    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

mod commands {
    use super::{AppState, POPOVER_LABEL};
    use serde_json::Value;
    use tauri::{AppHandle, Emitter, Manager, State};

    // Every argument is one field of the payload query; a struct would only move the
    // count into the frontend's invoke call.
    #[allow(clippy::too_many_arguments)]
    #[tauri::command]
    pub async fn fetch_payload(
        app: AppHandle,
        period: String,
        provider: String,
        days: Vec<String>,
        scope: String,
        claude_config_source: Option<String>,
        include_optimize: bool,
        state: State<'_, AppState>,
    ) -> Result<Value, String> {
        let cli = state.cli.lock().map_err(|e| e.to_string())?.clone();
        let payload = cli
            .fetch_menubar_payload(
                &period,
                &provider,
                &days,
                &scope,
                claude_config_source.as_deref(),
                include_optimize,
            )
            .await
            .map_err(|e| e.to_string())?;
        // The anchor for the unchanged-roots guard is taken after an answer, never before
        // one: a fetch that failed must not make a later unchanged tick look successful.
        crate::usage_guard::record_success();
        // The dock draws part of this answer and has no way of its own to ask for it. Only a
        // glance that actually moved is broadcast, so a poll that found the same sessions and
        // the same totals costs the dock no render.
        let is_today = crate::glance::is_today_key(&period, &provider, &days, &scope);
        if let Some(glance) = state.glance.record(&payload, is_today) {
            let _ = app.emit("codeburn://glance", &glance);
        }
        // The CLI computes the daily aggregate; this app only forwards it, at most once a
        // day, and only when the desktop app is not the one that decided (it sends its own
        // from the same payload). An older CLI carries no such field and nothing is sent.
        if let Some(snapshot) = crate::telemetry::snapshot_from_payload(&payload) {
            crate::telemetry::track("usage_snapshot", snapshot.clone());
        }
        Ok(payload)
    }

    /// What the Capacity Dock's glance bubble draws, from whatever the last payload carried.
    /// `None` means nothing has been fetched yet in this run, which is the dock's cue to ask
    /// for one payload itself rather than sit empty until a popover is opened.
    #[tauri::command]
    pub fn dock_glance(state: State<'_, AppState>) -> Option<crate::glance::Glance> {
        state.glance.snapshot()
    }

    /// Re-resolves the CLI each call so a freshly installed `codeburn` is picked up
    /// without restarting the tray app.
    #[tauri::command]
    pub async fn cli_status(state: State<'_, AppState>) -> Result<crate::cli::CliStatus, String> {
        let fresh = crate::cli::CodeburnCli::resolve();
        let status = fresh.status().await;
        if status.found {
            if let Ok(mut guard) = state.cli.lock() {
                *guard = fresh;
            }
        }
        Ok(status)
    }

    /// The currency the CLI config names, with a live rate. Both windows ask for this on
    /// mount: without it the popover opened in dollars every launch however the currency was
    /// set, because nothing read the stored code back.
    #[tauri::command]
    pub async fn currency(state: State<'_, AppState>) -> Result<crate::fx::CurrencyApplied, String> {
        let code = crate::config::read()
            .get("currency")
            .and_then(|currency| currency.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("USD")
            .to_string();
        let usd = crate::fx::CurrencyApplied {
            code: "USD".into(),
            symbol: "$".into(),
            rate: 1.0,
        };
        if code == "USD" {
            return Ok(usd);
        }
        // No rate means no honest conversion, so the figures stay in the dollars the CLI
        // reports rather than being multiplied by a guess.
        match state.fx.rate_for(&code).await {
            Some(rate) => Ok(crate::fx::CurrencyApplied {
                symbol: crate::fx::symbol_for(&code),
                code,
                rate,
            }),
            None => Ok(usd),
        }
    }

    #[tauri::command]
    pub async fn set_currency(
        app: AppHandle,
        code: String,
        state: State<'_, AppState>,
    ) -> Result<crate::fx::CurrencyApplied, String> {
        let symbol = crate::fx::symbol_for(&code);
        let rate = state
            .fx
            .rate_for(&code)
            .await
            .ok_or_else(|| format!("Exchange rate for {code} is unavailable right now"))?;
        state
            .config
            .lock()
            .map_err(|e| e.to_string())?
            .set_currency(&code, &symbol)
            .map_err(|e| e.to_string())?;
        let applied = crate::fx::CurrencyApplied { code, symbol, rate };
        // The settings window and the popover both show money, and either can be the one
        // that changed it.
        let _ = app.emit("codeburn://currency-changed", &applied);
        Ok(applied)
    }

    /// Opens one of the CLI's read-only reports in a console. The argv is not the page's to
    /// choose: only the subcommands the UI has buttons for are forwarded, so a compromised
    /// page cannot turn this into "run codeburn with whatever arguments I like".
    #[tauri::command]
    pub fn open_terminal_command(app: AppHandle, args: Vec<String>) -> Result<(), String> {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        if !crate::cli::is_allowed_subcommand(&args) {
            return Err("unsupported command".into());
        }
        crate::cli::spawn_in_terminal(&app, &args).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn open_claude_login(app: AppHandle) -> Result<(), String> {
        crate::cli::spawn_claude_login(&app).map_err(|e| e.to_string())
    }

    /// Export straight into the Downloads folder and reveal what came out, the mac's
    /// `runExport`: `~/Downloads/codeburn-<stamp>`, a folder of CSVs or one JSON file, then
    /// the file manager opens with it selected. No console window and nothing left in the
    /// working directory, which is what the old "export through a terminal" did.
    ///
    /// The stamp is formatted by the page because a local `yyyy-MM-dd-HHmmss` in Rust would
    /// mean either a new dependency or a hand-rolled timezone conversion. It never reaches a
    /// shell, but it does become a directory name, so it is checked here rather than trusted:
    /// digits and hyphens only, and the length the format produces.
    #[tauri::command]
    pub async fn export_usage(format: String, stamp: String) -> Result<String, String> {
        if !matches!(format.as_str(), "csv" | "json") {
            return Err("unknown export format".into());
        }
        if stamp.len() != 17 || !stamp.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
            return Err("invalid export timestamp".into());
        }
        let downloads = dirs::download_dir()
            .or_else(|| dirs::home_dir().map(|home| home.join("Downloads")))
            .ok_or_else(|| "could not find your Downloads folder".to_string())?;
        // CSV writes a folder of one-table-per-file CSVs; JSON writes a single file, which
        // wants the extension the mac gives it.
        let name = match format.as_str() {
            "json" => format!("codeburn-{stamp}.json"),
            _ => format!("codeburn-{stamp}"),
        };
        let output = downloads.join(name);
        let cli = crate::cli::CodeburnCli::resolve();
        cli.export_to(&format, &output)
            .await
            .map_err(|e| e.to_string())?;
        crate::cli::reveal_in_file_manager(&output).map_err(|e| e.to_string())?;
        Ok(output.to_string_lossy().to_string())
    }

    #[tauri::command]
    pub fn quit_app(app: AppHandle) {
        app.exit(0);
    }

    #[tauri::command]
    pub fn hide_popover(app: AppHandle) {
        if let Some(window) = app.get_webview_window(POPOVER_LABEL) {
            let _ = window.hide();
            super::mark_hidden(&app);
        }
    }

    /// The tray cannot render text on Windows, so today's spend lives in the tooltip.
    #[tauri::command]
    pub fn set_tray_tooltip(app: AppHandle, text: String) {
        super::apply_tray_tooltip(&app, &text);
        let stored = text.clone();
        if let Err(err) = crate::tray_status::write_status(|status| status.tooltip = Some(stored)) {
            crate::log_line!("codeburn: failed to persist the tray tooltip: {err}");
        }
    }

    /// Tints the tray logo from the worst connected provider's quota severity, falling back
    /// to the daily-budget warning. `today_cost` is the figure the hero shows, in dollars, so
    /// the limit is converted out of the display currency the CLI's `budget.daily` holds.
    #[tauri::command]
    pub async fn set_tray_severity(
        app: AppHandle,
        state: State<'_, AppState>,
        severity: String,
        today_cost: Option<f64>,
        today_tokens: Option<f64>,
    ) -> Result<(), String> {
        let severity = crate::tray_status::Severity::parse(&severity)
            .ok_or_else(|| format!("unknown quota severity `{severity}`"))?;
        // Either alert can be armed, and the mac tints the flame when the armed one is
        // passed, so both are checked rather than only the one the metric happens to show.
        let over = |value: Option<f64>, limit: Option<f64>| match (value, limit) {
            (Some(value), Some(limit)) => value >= limit,
            _ => false,
        };
        let budget_usd = match crate::tray_status::daily_budget_display() {
            Some(display) => {
                let rate = display_rate(&state).await;
                Some(if rate > 0.0 { display / rate } else { display })
            }
            // Not migrated yet: the old key was already in dollars.
            None => crate::tray_status::legacy_daily_budget(),
        };
        let over_budget =
            over(today_cost, budget_usd) || over(today_tokens, crate::tray_status::daily_token_budget());
        super::apply_tray_tint(&app, crate::tray_status::tint_for(severity, over_budget))
    }

    /// The usage row at the top of the tray menu: disabled, and there only to say what today
    /// cost without opening the popover.
    #[tauri::command]
    pub fn set_tray_usage(text: String) {
        super::set_tray_usage_text(&text);
    }

    /// `text` is a short spend string ("$87", "142", "1.2K"); `None` hides the badge icon.
    /// `muted` says a paired device did not report under combined scope, so the figure is
    /// short of what the reader's machines actually spent.
    #[tauri::command]
    pub fn set_tray_badge(
        app: AppHandle,
        text: Option<String>,
        muted: Option<bool>,
    ) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        {
            // Unreachable from the UI: the frontend hides the control wherever the badge is
            // unsupported (lib/platform.ts). Saying so beats reporting a success that never
            // happened.
            let _ = (app, text, muted);
            Err("the tray spend badge needs a second tray icon, which the Linux SNI tray does not provide".to_string())
        }
        #[cfg(not(target_os = "linux"))]
        {
            let stored = text.clone();
            if let Err(err) = crate::tray_status::write_status(|status| status.badge = stored) {
                crate::log_line!("codeburn: failed to persist the tray badge: {err}");
            }
            super::apply_tray_badge(&app, text.as_deref(), muted.unwrap_or(false))
        }
    }

    #[tauri::command]
    pub fn app_version(app: AppHandle) -> String {
        app.package_info().version.to_string()
    }

    #[tauri::command]
    pub fn launch_at_login() -> bool {
        crate::autostart::is_enabled()
    }

    #[tauri::command]
    pub fn set_launch_at_login(enabled: bool) -> Result<bool, String> {
        crate::autostart::set_enabled(enabled).map_err(|e| e.to_string())?;
        Ok(crate::autostart::is_enabled())
    }

    #[tauri::command]
    pub async fn plan_usage(state: State<'_, AppState>) -> Result<crate::plan::PlanUsage, String> {
        state.plan.fetch().await.map_err(|e| e.to_string())
    }

    /// Two windows run their own copy of the quota store, the popover and the dock, and one
    /// cadence therefore asks twice within a second of itself. This collapses that into one
    /// CLI run: whoever asks second waits for the run in flight and is answered from it. The
    /// cache lives only for a few seconds, far below the store's own interactive floor, so a
    /// Retry a reader presses is still a live answer. It is keyed on the profiles mode,
    /// because a combined answer cannot serve a rail just switched to separate rings.
    const QUOTA_COALESCE: std::time::Duration = std::time::Duration::from_secs(10);
    static QUOTA_CACHE: std::sync::Mutex<Option<(crate::cli::DockQuota, bool, std::time::Instant)>> =
        std::sync::Mutex::new(None);
    static QUOTA_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn cached_quota(separate: bool) -> Option<crate::cli::DockQuota> {
        let guard = QUOTA_CACHE.lock().ok()?;
        let (answer, cached_separate, taken) = guard.as_ref()?;
        (taken.elapsed() < QUOTA_COALESCE && *cached_separate == separate).then(|| answer.clone())
    }

    #[tauri::command]
    pub async fn dock_quota(state: State<'_, AppState>) -> Result<crate::cli::DockQuota, String> {
        // Per-profile reads are opt-in: only a rail in separate mode pays for them.
        let separate = crate::dock::read_prefs().get("claudeProfiles").and_then(|v| v.as_str()) == Some("separate");
        if let Some(fresh) = cached_quota(separate) {
            return Ok(fresh);
        }
        let _gate = QUOTA_GATE.lock().await;
        // The run we queued behind has just answered; that answer is this one.
        if let Some(fresh) = cached_quota(separate) {
            return Ok(fresh);
        }
        let cli = state.cli.lock().map_err(|e| e.to_string())?.clone();
        let answer = cli.fetch_quota(separate).await;
        if let Ok(mut guard) = QUOTA_CACHE.lock() {
            *guard = Some((answer.clone(), separate, std::time::Instant::now()));
        }
        Ok(answer)
    }

    /// The page only knows its row count, hover state and the bubble's measured height; the
    /// geometry that turns those into a window lives in `dock`. Synchronous on purpose: the
    /// replies must arrive in request order or a stale frame could land after a newer one.
    #[tauri::command]
    pub fn dock_set_layout(
        app: AppHandle,
        request: crate::dock::LayoutRequest,
    ) -> Result<crate::dock::DockFrame, String> {
        let window = app
            .get_webview_window(crate::dock::DOCK_LABEL)
            .ok_or_else(|| "dock window is not open".to_string())?;
        crate::dock::apply_layout(&window, request).ok_or_else(|| "no monitor".to_string())
    }

    /// The page decides when a press became a drag (3 px, as on the mac); from here the
    /// cursor poll moves the window and settles it on release.
    #[tauri::command]
    pub fn dock_begin_drag(app: AppHandle, x: i32, y: i32) {
        crate::dock::begin_drag(&app, (x, y));
    }

    #[tauri::command]
    pub fn dock_set_preferred(id: String) -> Result<(), String> {
        crate::dock::set_preferred_provider(&id).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn dock_context_menu(app: AppHandle) -> Result<(), String> {
        crate::dock::popup_context_menu(&app).map_err(|e| e.to_string())
    }

    /// The page's half of the dismiss handshake: the rail has finished retracting, so the
    /// window can go. Rust takes it anyway shortly after asking, in case this never comes.
    ///
    /// `generation` is the number the dismiss carried. A dock switched off and straight back on
    /// reuses the window that was retracting, and that retract still finishes and still answers;
    /// without a number to check it against, the answer would destroy the rail the user has just
    /// switched back on.
    #[tauri::command]
    pub fn dock_close(app: AppHandle, generation: Option<u64>) {
        crate::dock::close(&app, generation);
    }

    /// Everything the Capacity Dock reads out of `windows-dock.json`: whether it is on, its
    /// scale, appearance, gauge shape and provider set. One free-form object, so a new dock
    /// preference costs no Rust.
    #[tauri::command]
    pub fn dock_prefs() -> Value {
        Value::Object(crate::dock::read_prefs())
    }

    /// Writes dock preferences and brings the window in line with them. `enabled` is the one
    /// key with a side effect, since it creates or destroys the dock window; everything else
    /// only has to reach the page, which the event does.
    ///
    /// `async` matters: a synchronous command runs on the main thread, and building a window
    /// from there waits on the event loop that is already busy running this call, so the dock
    /// simply never came back. On the async runtime the build is dispatched and answered.
    #[tauri::command]
    pub async fn set_dock_prefs(
        app: AppHandle,
        patch: serde_json::Map<String, Value>,
    ) -> Result<Value, String> {
        let enabled = patch.get("enabled").and_then(Value::as_bool);
        let mut merged = crate::dock::patch_prefs(patch).map_err(|e| e.to_string())?;
        if let Some(enabled) = enabled {
            super::set_dock_enabled(&app, enabled);
            // `set_dock_enabled` persists the key itself, so read it back rather than
            // reporting the value we asked for and a failed write nobody saw.
            merged = crate::dock::read_prefs();
        }
        // The rail's own window is sized from the scale, so the geometry has to be redone
        // here; the page re-renders from the event.
        crate::dock::prefs_changed(&app);
        let value = Value::Object(merged);
        let _ = app.emit("codeburn://dock-settings-changed", &value);
        Ok(value)
    }

    /// The popover's More menu comes through here; the tray items call `settings::open`
    /// directly from the menu handler. `async` for the same reason as `set_dock_prefs`: a
    /// window cannot be built from the main thread while a command is holding it.
    #[tauri::command]
    pub async fn open_settings_window(
        app: AppHandle,
        section: Option<String>,
    ) -> Result<(), String> {
        crate::settings::open(&app, section.as_deref()).map_err(|e| e.to_string())
    }

    /// The pane the window was opened on, asked for once by the page on mount. An event
    /// cannot do this job: it would be emitted while the webview is still loading.
    #[tauri::command]
    pub fn settings_section() -> Option<String> {
        crate::settings::take_pending_section()
    }

    #[tauri::command]
    pub fn settings_load() -> Value {
        Value::Object(crate::settings::read())
    }

    #[tauri::command]
    pub fn settings_patch(
        app: AppHandle,
        patch: serde_json::Map<String, Value>,
    ) -> Result<Value, String> {
        let merged = crate::settings::patch(patch).map_err(|e| e.to_string())?;
        crate::settings::broadcast(&app, &merged);
        crate::sync_theme_menu_item();
        Ok(Value::Object(merged))
    }

    /// The consoles the settings window offers, each marked with whether it is on this
    /// machine, so the "(not installed)" hint stays honest.
    #[tauri::command]
    pub fn terminals() -> Vec<crate::cli::TerminalOption> {
        crate::cli::terminals()
    }

    #[tauri::command]
    pub fn claude_config_dirs() -> Vec<String> {
        crate::settings::claude_config_dirs()
    }

    #[tauri::command]
    pub fn cursor_sync() -> bool {
        crate::settings::cursor_sync()
    }

    #[tauri::command]
    pub fn cursor_sync_env_off() -> bool {
        crate::settings::cursor_sync_env_off()
    }

    #[tauri::command]
    pub fn set_cursor_sync(enabled: bool) -> Result<bool, String> {
        crate::settings::set_cursor_sync(enabled).map_err(|e| e.to_string())?;
        Ok(crate::settings::cursor_sync())
    }

    /// The shell's folder browser, which is modal and has to run where the app's windows
    /// live. `None` is a cancelled dialog, not a failure.
    #[tauri::command]
    pub async fn pick_directory(app: AppHandle, title: String) -> Result<Option<String>, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(crate::settings::browse_for_folder(&title));
        })
        .map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(None))
            .await
            .map_err(|e| e.to_string())
    }

    /// Persisted to the CLI's own config so every `codeburn` run honours the list, whether
    /// this app spawned it or the user typed it in a terminal.
    #[tauri::command]
    pub fn set_claude_config_dirs(app: AppHandle, dirs: Vec<String>) -> Result<Vec<String>, String> {
        crate::settings::set_claude_config_dirs(&dirs).map_err(|e| e.to_string())?;
        let stored = crate::settings::claude_config_dirs();
        let _ = app.emit("codeburn://claude-configs-changed", &stored);
        Ok(stored)
    }

    /// The rate the display currency is worth against the dollar, from the cache the currency
    /// command already fills. A missing rate falls back to 1, which is the same answer the
    /// currency command gives: figures stay in the dollars the CLI reports rather than being
    /// multiplied by a guess.
    async fn display_rate(state: &AppState) -> f64 {
        let code = crate::config::read()
            .get("currency")
            .and_then(|currency| currency.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("USD")
            .to_string();
        if code == "USD" {
            return 1.0;
        }
        state.fx.rate_for(&code).await.unwrap_or(1.0)
    }

    /// Both daily alert thresholds. `None` on either means that alert is off.
    ///
    /// The spend limit comes back twice: `cost` in dollars, which is what the payload is
    /// measured in, and `costDisplay` in the currency it is stored and edited in. The
    /// migration off the old top-level key happens here, on the first read after an upgrade.
    #[tauri::command]
    pub async fn daily_budgets(state: State<'_, AppState>) -> Result<Value, String> {
        let rate = display_rate(&state).await;
        let display = crate::settings::migrate_daily_budget(rate);
        Ok(serde_json::json!({
            "cost": display.map(|amount| if rate > 0.0 { amount / rate } else { amount }),
            "costDisplay": display,
            "tokens": crate::tray_status::daily_token_budget(),
        }))
    }

    #[tauri::command]
    pub async fn set_daily_budget(
        app: AppHandle,
        state: State<'_, AppState>,
        key: String,
        amount: Option<f64>,
    ) -> Result<(), String> {
        crate::settings::set_daily_budget(&key, amount).map_err(|e| e.to_string())?;
        if let Ok(budgets) = daily_budgets(state).await {
            let _ = app.emit("codeburn://budget-changed", budgets);
        }
        Ok(())
    }

    /// Which providers have a key stored, never the keys themselves.
    #[tauri::command]
    pub fn provider_key_providers() -> Vec<String> {
        crate::settings::stored_key_providers()
    }

    #[tauri::command]
    pub fn set_provider_key(provider: String, key: String) -> Result<Vec<String>, String> {
        crate::settings::set_provider_key(&provider, &key).map_err(|e| e.to_string())?;
        Ok(crate::settings::stored_key_providers())
    }

    /// How long the page's background usage loop should wait before its next tick, and what
    /// the machine is running on. Asked once per tick rather than worked out in the page:
    /// the power state is a Win32 read, and it changes under a loop already armed.
    #[tauri::command]
    pub fn usage_refresh_plan(mode: i64, popover_open: bool) -> crate::refresh::RefreshPlan {
        crate::refresh::plan(mode, popover_open)
    }

    /// Whether there is a newer app or CLI, and how the reader installs it. Without `force`
    /// a cached answer inside the two-day interval is returned without touching the network,
    /// so every mount can ask. Nothing here installs anything: see `update.rs`.
    #[tauri::command]
    pub async fn check_updates(
        app: AppHandle,
        force: bool,
        state: State<'_, AppState>,
    ) -> Result<crate::update::UpdateStatus, String> {
        let cli = state.cli.lock().map_err(|e| e.to_string())?.clone();
        Ok(crate::update::check(&app, &cli, force).await)
    }

    /// One event from a page. The module decides whether it may be recorded at all: an
    /// unknown name, junk props or a missing consent decision are dropped there, so a page
    /// never has to know what the current decision is before it reports something.
    ///
    /// Async, like the three below it: a synchronous command runs on the thread that drives
    /// the windows, and these read the settings file, the desktop app's state file and
    /// (before the save was debounced) rewrote the queue, all while the UI waited.
    #[tauri::command]
    pub async fn telemetry_track(name: String, props: Option<Value>) {
        crate::telemetry::track(&name, props.unwrap_or(Value::Null));
    }

    /// What the settings pane's toggle renders: the decision in effect and which app made
    /// it. A `desktop` source means this app is reading the desktop app's file and the
    /// toggle is a readout rather than a control.
    #[tauri::command]
    pub async fn telemetry_status() -> Option<crate::telemetry::TelemetryStatus> {
        crate::telemetry::instance().map(|telemetry| telemetry.status())
    }

    #[tauri::command]
    pub async fn telemetry_set_enabled(enabled: bool) -> Option<crate::telemetry::TelemetryStatus> {
        crate::telemetry::instance().map(|telemetry| telemetry.set_enabled(enabled))
    }

    /// The one-time consent notice's Accept or Decline. Records that the question was asked
    /// either way, which is what unlocks sending.
    #[tauri::command]
    pub async fn telemetry_consent(enabled: bool) -> Option<crate::telemetry::TelemetryStatus> {
        crate::telemetry::instance().map(|telemetry| telemetry.complete_consent(enabled))
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_second_launch, SecondLaunch};

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_owned()).collect()
    }

    #[test]
    fn a_plain_relaunch_shows_the_popover() {
        assert_eq!(
            parse_second_launch(&argv(&[r"C:\Program Files\CodeBurn Menubar\CodeBurn Menubar.exe"])),
            SecondLaunch::ShowPopover
        );
    }

    #[test]
    fn quit_and_reload_are_recognised_past_the_program_name() {
        assert_eq!(parse_second_launch(&argv(&["codeburn-menubar.exe", "--quit"])), SecondLaunch::Quit);
        assert_eq!(
            parse_second_launch(&argv(&["codeburn-menubar.exe", "--reload-settings"])),
            SecondLaunch::ReloadSettings
        );
    }

    #[test]
    fn quit_outranks_reload_settings() {
        assert_eq!(
            parse_second_launch(&argv(&["exe", "--reload-settings", "--quit"])),
            SecondLaunch::Quit
        );
    }

    #[test]
    fn an_unknown_flag_is_still_a_relaunch() {
        assert_eq!(parse_second_launch(&argv(&["exe", "--quit-later", "-q"])), SecondLaunch::ShowPopover);
    }

    /// A path that happens to end in the flag's spelling is still a path, and an exact match
    /// is what keeps it from being read as one.
    #[test]
    fn only_an_exact_flag_counts() {
        assert_eq!(parse_second_launch(&argv(&[r"C:\tools\--quit\app.exe"])), SecondLaunch::ShowPopover);
    }
}
