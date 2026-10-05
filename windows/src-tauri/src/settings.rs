//! The settings window and the preferences behind it, the Windows twin of the macOS
//! `Views/SettingsView.swift` scene.
//!
//! Three stores, split by who else needs to read the value:
//!
//! - `~/.config/codeburn/config.json` for anything the CLI also reads (the currency, the
//!   Claude config directories, the daily budget). Written through `config::update`, which
//!   holds the same lock the currency write already took.
//! - `~/.config/codeburn/windows-settings.json` for everything that only this app cares
//!   about (display metric, refresh cadences, terminal, theme, accent). A free-form object
//!   rather than a typed struct, so a new preference costs one line of TypeScript and no
//!   Rust at all.
//! - `%LOCALAPPDATA%\codeburn\provider-keys.dat` for pasted provider API keys, encrypted
//!   with DPAPI so the file is worthless on another machine or under another account.
//!   Off Windows there is no DPAPI and no keyring here, so that same file is a plain-text
//!   fallback: the key is readable by anything running as this user. It is written 0600 in a
//!   0700 directory, which keeps it away from the other accounts on the box and does nothing
//!   more than that. See `seal`.
//!
//! Every write emits `codeburn://settings-changed` with the whole settings object, because
//! the popover, the tray and the Capacity Dock all render from it and none of them polls.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const SETTINGS_LABEL: &str = "settings";

/// The mac's window size, in logical pixels.
const WINDOW_WIDTH: f64 = 880.0;
const WINDOW_HEIGHT: f64 = 620.0;
const MIN_WIDTH: f64 = 720.0;
const MIN_HEIGHT: f64 = 520.0;

/// Where a tray item or the popover asked the window to open. The page reads it once on
/// mount, because an event emitted while the webview is still loading has nobody to hear it.
static PENDING_SECTION: Mutex<Option<String>> = Mutex::new(None);

// Cross-process preference lock ---------------------------------------------------------
//
// windows-settings.json and windows-dock.json are each owned by two processes at once: this
// tray app and the Electron desktop app. Both do a read / modify / write to merge their own
// keys into whatever the other last stored. The atomic rename each already does stops a torn
// file, but not a lost update: two writers read the same state, change different keys, and the
// later rename erases the earlier writer's key. The user watches a dock placement, an enabled
// switch, a provider choice or a scale silently revert. This lock serializes the whole cycle
// so that never happens. It is the one place the protocol is written down; `dock.rs` and
// `app/electron/tray-settings.ts` point here rather than restating it.
//
// PROTOCOL (honoured identically by app/electron/tray-settings.ts):
//
//   Lock file:  sibling of the target named `.<stem>.lock` (windows-dock.json ->
//               `.windows-dock.lock`), the same `.config.lock` shape config.rs uses.
//   Body:       one line of JSON, `{"pid":<os pid>,"at":<unix ms>}`.
//   Acquire:    exclusive create (create_new / 'wx'). On success the holder keeps the handle
//               open for the whole cycle and returns a guard. On collision the existing lock
//               is taken over only if abandoned; otherwise the contender polls until a short
//               wait budget runs out and then FAILS loudly rather than writing behind the
//               holder, so a contended write is reported to the caller, never silently lost.
//   Abandoned:  its mtime is older than the stale window (a crashed holder never refreshes
//               it), OR its recorded pid is not our own and no longer alive. The pid probe is
//               the fast path for a crash: a dead holder is recovered on the first poll, well
//               inside the wait budget. The age gate is the backstop for a pid we cannot probe
//               or a reused one. A live holder is neither, which is the safety argument: a
//               fresh mtime plus a live pid are never taken, and the read/modify/write it
//               guards finishes in milliseconds, orders of magnitude inside the stale window.
//   Takeover:   removing an abandoned lock is itself arbitrated, by an exclusive create of
//               `<lock>.takeover`. Only its winner may unlink the lock, and only after
//               re-checking that the lock is still abandoned, so two contenders racing the
//               same stale lock cannot both end up holding it. See `reclaim`.
//   Release:    close the handle and unlink the lock, unless it now carries a different pid
//               (a successor's), which is left alone.
//
// Reads take no lock: every writer renames a whole file into place, so a reader sees the old
// file or the new one, never a torn one (the same reason config::read is lock-free). That is
// still the right trade, but it is not free on Windows: a rename over a file some other process
// has open can fail outright there rather than wait, so a read on either side can make a write
// on the other fail. `replace_file` is where that is absorbed.
//
// Lessons borrowed from src/cache-refresh-lock.ts: exclusive create as the arbiter, a pid +
// timestamp record, a staleness window so a dead holder cannot wedge the file forever, and a
// bounded wait that never blocks indefinitely.
pub(crate) mod prefs_lock {
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::thread::sleep;
    use std::time::{Duration, SystemTime};

    use anyhow::{anyhow, Result};

    const POLL: Duration = Duration::from_millis(50);
    const WAIT_BUDGET: Duration = Duration::from_millis(2_000);
    const STALE: Duration = Duration::from_secs(30);

    /// Held for the whole read/modify/write cycle. Dropping it closes the handle and removes
    /// the lock file, so a normal return, an early `?`, or a panic all release it.
    pub struct Guard {
        path: PathBuf,
        file: Option<fs::File>,
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            // Close our handle first: Windows will not unlink a file that is still open.
            self.file.take();
            // A lock that now carries someone else's pid has been taken over from us (only
            // ever possible if we outlived the stale window); leave the successor's alone.
            match holder_pid(&self.path) {
                Some(pid) if pid != std::process::id() => {}
                _ => {
                    let _ = fs::remove_file(&self.path);
                }
            }
        }
    }

    fn lock_path(target: &Path) -> PathBuf {
        let stem = target.file_stem().and_then(|s| s.to_str()).unwrap_or("prefs");
        target.with_file_name(format!(".{stem}.lock"))
    }

    fn body() -> String {
        let at = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("{{\"pid\":{},\"at\":{}}}", std::process::id(), at)
    }

    fn holder_pid(path: &Path) -> Option<u32> {
        let text = fs::read_to_string(path).ok()?;
        serde_json::from_str::<serde_json::Value>(&text)
            .ok()?
            .get("pid")?
            .as_u64()
            .map(|pid| pid as u32)
    }

    fn abandoned(path: &Path, stale: Duration) -> bool {
        match fs::metadata(path).and_then(|m| m.modified()) {
            Ok(mtime) => {
                if SystemTime::now().duration_since(mtime).map(|age| age > stale).unwrap_or(false) {
                    return true;
                }
            }
            // The file vanished between the failed create and this check; not abandoned, the
            // caller simply retries the create.
            Err(_) => return false,
        }
        match holder_pid(path) {
            Some(pid) if pid != std::process::id() => !pid_alive(pid),
            // Our own pid, or a body too young to be stale that we cannot parse a pid from.
            _ => false,
        }
    }

    /// Signal-0 style liveness. A false "alive" (a reused pid) only delays recovery to the age
    /// gate; a false "dead" would be the dangerous direction and is what the conservative
    /// branches below avoid.
    #[cfg(not(windows))]
    fn pid_alive(pid: u32) -> bool {
        // Declared directly rather than pulling in a crate, the same way config.rs externs
        // flock. `kill(pid, 0)` probes existence without delivering a signal.
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        let ret = unsafe { kill(pid as i32, 0) };
        // 0 => alive; EPERM (1) => alive under another user; ESRCH => gone.
        ret == 0 || std::io::Error::last_os_error().raw_os_error() == Some(1)
    }

    #[cfg(windows)]
    fn pid_alive(pid: u32) -> bool {
        // Declared directly so this needs no extra windows-sys feature. kernel32 is always
        // linked, so the symbols resolve without a `#[link]` attribute.
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut core::ffi::c_void;
            fn CloseHandle(handle: *mut core::ffi::c_void) -> i32;
            fn GetLastError() -> u32;
        }
        const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
        const ERROR_INVALID_PARAMETER: u32 = 87;
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if !handle.is_null() {
                CloseHandle(handle);
                return true;
            }
            // Access-denied and the like mean the process exists under a token we cannot open;
            // only a clearly invalid pid is proof it is gone.
            GetLastError() != ERROR_INVALID_PARAMETER
        }
    }

    fn takeover_path(lock: &Path) -> PathBuf {
        let mut name = lock.as_os_str().to_owned();
        name.push(".takeover");
        PathBuf::from(name)
    }

    /// Remove an abandoned lock, but only as the one process entitled to. Two contenders that
    /// both find the same stale lock would otherwise both unlink it: the first has already
    /// replaced it with a lock of its own, and the second's unlink deletes that fresh one, so
    /// both walk away holding the file. Windows usually hides this, because a lock a live
    /// holder still has open will not unlink at all, but this crate also builds for Linux and
    /// macOS, where the unlink always succeeds.
    ///
    /// So the removal is arbitrated by the same primitive the lock itself uses: an exclusive
    /// create of `<lock>.takeover`. Its winner alone may unlink, and only after re-checking
    /// staleness under that right, because a rival may have reclaimed already and now hold a
    /// lock that is not abandoned and not ours to remove. The takeover file is dropped on every
    /// path out, and never held across the wait; one left behind by a reclaimer that died is
    /// freed by the same staleness rule as the lock.
    ///
    /// Returns whether the caller should retry the exclusive create at once.
    fn reclaim(lock: &Path, stale: Duration) -> bool {
        let takeover = takeover_path(lock);
        match OpenOptions::new().write(true).create_new(true).open(&takeover) {
            Ok(mut file) => {
                let _ = file.write_all(body().as_bytes());
                let _ = file.flush();
                drop(file);
                let reclaimed = abandoned(lock, stale) && fs::remove_file(lock).is_ok();
                let _ = fs::remove_file(&takeover);
                reclaimed
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                // Somebody else is reclaiming, or a dead reclaimer left this behind. The lock
                // itself is never touched from here; the most this does is free the takeover
                // file for a later try.
                if abandoned(&takeover, stale) {
                    let _ = fs::remove_file(&takeover);
                }
                false
            }
            Err(_) => false,
        }
    }

    pub fn acquire(target: &Path) -> Result<Guard> {
        acquire_with(target, WAIT_BUDGET, POLL, STALE)
    }

    /// The timing is a parameter only so the tests can prove the wait and the takeover without
    /// sleeping for whole seconds; every caller in the app uses [`acquire`].
    pub fn acquire_with(
        target: &Path,
        wait: Duration,
        poll: Duration,
        stale: Duration,
    ) -> Result<Guard> {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let path = lock_path(target);
        let deadline = SystemTime::now() + wait;
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    // The body is advisory; even if this write fails we still hold the lock the
                    // exclusive create just won.
                    let _ = file.write_all(body().as_bytes());
                    let _ = file.flush();
                    return Ok(Guard { path, file: Some(file) });
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                    // A successful reclaim means the holder was genuinely abandoned and this
                    // process won the right to remove its lock; retry the create at once.
                    // Anything else (a live holder, a contender already reclaiming, an unlink
                    // that failed) falls through to the wait.
                    if abandoned(&path, stale) && reclaim(&path, stale) {
                        continue;
                    }
                    if SystemTime::now() >= deadline {
                        return Err(anyhow!(
                            "could not lock {} within {:?}; another process is writing these \
                             preferences, so nothing was changed",
                            path.display(),
                            wait
                        ));
                    }
                    sleep(poll);
                }
                Err(err) => return Err(err.into()),
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Two tests starting in the same microsecond would otherwise share a directory, and
        /// whichever finished first would delete the other's out from under it: SystemTime is
        /// only microsecond-resolution on macOS, so the clock alone does not separate them.
        static TEMP_SEQUENCE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

        fn temp_target() -> PathBuf {
            let dir = std::env::temp_dir().join(format!(
                "codeburn-prefs-lock-{}-{}-{}",
                std::process::id(),
                SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos(),
                TEMP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).unwrap();
            dir.join("windows-dock.json")
        }

        #[test]
        fn a_lock_is_taken_then_released() {
            let target = temp_target();
            let lock = lock_path(&target);
            {
                let _guard = acquire(&target).unwrap();
                assert!(lock.exists(), "the lock file exists while it is held");
                assert_eq!(holder_pid(&lock), Some(std::process::id()));
            }
            assert!(!lock.exists(), "the lock file is gone once the guard drops");
            let _ = fs::remove_dir_all(target.parent().unwrap());
        }

        #[test]
        fn a_stale_lock_is_taken_over() {
            let target = temp_target();
            let lock = lock_path(&target);
            // A live pid (our own), so only the age gate can free it. A tiny stale window plus a
            // sleep past it makes the lock look abandoned without touching its mtime by hand.
            fs::write(&lock, format!("{{\"pid\":{},\"at\":1}}", std::process::id())).unwrap();
            let stale = Duration::from_millis(40);
            sleep(Duration::from_millis(80));
            let guard = acquire_with(&target, Duration::from_millis(500), Duration::from_millis(20), stale);
            assert!(guard.is_ok(), "an abandoned lock older than the stale window is taken over");
            assert_eq!(holder_pid(&lock), Some(std::process::id()));
            drop(guard);
            let _ = fs::remove_dir_all(target.parent().unwrap());
        }

        #[test]
        fn a_dead_holders_lock_is_taken_over_without_waiting_for_the_age_gate() {
            let target = temp_target();
            let lock = lock_path(&target);
            // A pid far above anything the OS hands out, so it is not a live process: on Windows
            // OpenProcess reports it invalid, on Unix kill(0) reports ESRCH. With a fresh mtime
            // only the pid probe, not the age gate, can free it inside the wait budget.
            fs::write(&lock, "{\"pid\":2147483646,\"at\":1}").unwrap();
            let started = SystemTime::now();
            let guard = acquire_with(
                &target,
                Duration::from_millis(500),
                Duration::from_millis(20),
                Duration::from_secs(60),
            );
            assert!(guard.is_ok(), "a dead holder's lock is recovered by the pid probe");
            assert!(
                started.elapsed().unwrap() < Duration::from_millis(400),
                "recovery did not wait out the whole budget"
            );
            drop(guard);
            let _ = fs::remove_dir_all(target.parent().unwrap());
        }

        /// The takeover right, from the losing side: a lock that IS abandoned still may not be
        /// removed while another process holds the right to reclaim it, because that process may
        /// already have replaced it with a lock of its own.
        #[test]
        fn a_stale_lock_is_left_alone_while_someone_else_holds_the_takeover_right() {
            let target = temp_target();
            let lock = lock_path(&target);
            fs::write(&lock, format!("{{\"pid\":{},\"at\":1}}", std::process::id())).unwrap();
            let stale = Duration::from_millis(200);
            sleep(Duration::from_millis(220));
            // A takeover file with our own live pid and a fresh mtime: a reclaim in progress.
            // The wait below is kept well inside the stale window, so it is the takeover right
            // and not the takeover file's own age that decides this.
            fs::write(takeover_path(&lock), format!("{{\"pid\":{},\"at\":1}}", std::process::id()))
                .unwrap();

            let blocked = acquire_with(&target, Duration::from_millis(60), Duration::from_millis(10), stale);
            assert!(blocked.is_err(), "the stale lock is not stolen out from under the reclaimer");
            assert!(lock.exists(), "and it is still there for the reclaimer to replace");

            // Once the reclaimer is gone the same lock is taken over as it always was.
            fs::remove_file(takeover_path(&lock)).unwrap();
            let guard = acquire_with(&target, Duration::from_millis(500), Duration::from_millis(10), stale);
            assert!(guard.is_ok(), "with nobody reclaiming, the abandoned lock is taken over");
            drop(guard);
            let _ = fs::remove_dir_all(target.parent().unwrap());
        }

        #[test]
        fn a_live_lock_is_waited_for_then_fails_loudly() {
            let target = temp_target();
            // Our own pid reads as alive and a fresh mtime is inside a long window, so the lock
            // is never abandoned and the contender must give up rather than write behind it.
            let _held = acquire(&target).unwrap();
            let started = SystemTime::now();
            let err = acquire_with(
                &target,
                Duration::from_millis(200),
                Duration::from_millis(20),
                Duration::from_secs(60),
            );
            assert!(err.is_err(), "a live lock is not stolen; the contender fails");
            assert!(started.elapsed().unwrap() >= Duration::from_millis(180), "it waited the budget");
            drop(_held);
            let _ = fs::remove_dir_all(target.parent().unwrap());
        }
    }
}

/// Rename `temp` over `target`, retrying briefly on a Windows sharing violation.
///
/// The rename is what makes a write atomic to a reader, and readers of these files take no lock
/// on either side. On POSIX that costs nothing: a rename over an open file always succeeds, and
/// whoever had it open keeps reading the file they opened. Windows refuses instead, with
/// ERROR_ACCESS_DENIED or ERROR_SHARING_VIOLATION, whenever something else holds the target open
/// without having agreed to its deletion, and a scanner opening the file behind our back does it
/// just as well as one of our own processes. That failure is transient by nature, so it is
/// retried for a short bounded time rather than reported as a write that did not land, which is
/// the very lost update the lock around this exists to prevent.
///
/// The lock is already held by the time this runs, so the wait can only ever be on a reader,
/// never on another writer, and readers hold the file for microseconds. Once the budget is out
/// the error is returned unchanged. On POSIX this is a plain rename.
pub(crate) fn replace_file(temp: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        const RETRIES: u32 = 9;
        const PAUSE: std::time::Duration = std::time::Duration::from_millis(20);
        // ERROR_ACCESS_DENIED and ERROR_SHARING_VIOLATION, as raw OS codes: the io::ErrorKind
        // they map to is not stable enough to match on.
        const SHARING: [i32; 2] = [5, 32];
        for _ in 0..RETRIES {
            match fs::rename(temp, target) {
                Err(err) if err.raw_os_error().is_some_and(|code| SHARING.contains(&code)) => {
                    std::thread::sleep(PAUSE);
                }
                result => return result,
            }
        }
    }
    fs::rename(temp, target)
}

// Preferences ---------------------------------------------------------------------------

fn settings_path() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".config/codeburn"))
        .unwrap_or_else(|| PathBuf::from(".codeburn"))
        .join("windows-settings.json")
}

pub fn read() -> Map<String, Value> {
    fs::read(settings_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

/// Merges `patch` into the stored settings and returns the result. A null value removes the
/// key, so the page can reset a preference to its default without knowing what that default
/// is.
pub fn patch(values: Map<String, Value>) -> Result<Map<String, Value>> {
    let path = settings_path();
    // Serialize the whole read/modify/write against the desktop app, which owns this file too.
    // The guard is held until the rename lands. See `prefs_lock` for the shared protocol.
    let _lock = prefs_lock::acquire(&path)?;
    let mut stored = read();
    for (key, value) in values {
        if value.is_null() {
            stored.remove(&key);
        } else {
            stored.insert(key, value);
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(&stored)?)?;
    replace_file(&tmp, &path)?;
    Ok(stored)
}

/// One event for every consumer: the popover retints and re-reads its cadence, the dock
/// re-reads its own keys, and the settings window itself stays in step with a change made
/// from the tray.
pub fn broadcast(app: &AppHandle, settings: &Map<String, Value>) {
    let _ = app.emit("codeburn://settings-changed", settings);
}

// Keys the CLI shares -------------------------------------------------------------------

/// The extra Claude config directories the CLI aggregates over, from
/// `Data/CLIClaudeConfig.swift`. An empty list removes the key so the CLI falls back to its
/// own default of `~/.claude`.
pub fn claude_config_dirs() -> Vec<String> {
    crate::config::read()
        .get("claudeConfigDirs")
        .and_then(Value::as_array)
        .map(|dirs| {
            dirs.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|dir| !dir.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub fn set_claude_config_dirs(dirs: &[String]) -> Result<()> {
    let cleaned: Vec<String> = dirs
        .iter()
        .map(|dir| dir.trim().to_owned())
        .filter(|dir| !dir.is_empty())
        .collect();
    crate::config::update(|obj| {
        if cleaned.is_empty() {
            obj.remove("claudeConfigDirs");
        } else {
            obj.insert("claudeConfigDirs".into(), serde_json::json!(cleaned));
        }
    })?;
    Ok(())
}

/// The CLI's automatic Cursor usage sync. Absent means on, so turning it on removes the key
/// rather than storing a `true` the CLI never needs.
pub fn cursor_sync() -> bool {
    crate::config::read().get("cursorSync").and_then(Value::as_bool) != Some(false)
}

/// The tray spawns the CLI with its own environment, so this is the override the CLI sees.
pub fn cursor_sync_env_off() -> bool {
    std::env::var("CODEBURN_CURSOR_SYNC").as_deref() == Ok("0")
}

pub fn set_cursor_sync(enabled: bool) -> Result<()> {
    crate::config::update(|obj| {
        if enabled {
            obj.remove("cursorSync");
        } else {
            obj.insert("cursorSync".into(), Value::Bool(false));
        }
    })?;
    Ok(())
}

/// The daily alert thresholds. Both live in the CLI's config because the tray reads them from
/// Rust, before any webview exists. Zero means off, which is stored as the key's absence
/// rather than a zero the CLI would have to special-case.
///
/// The spend limit goes where the CLI's own config type has always had it, `budget.daily` in
/// the display currency; the token limit has no CLI counterpart and stays at the top level.
pub fn set_daily_budget(key: &str, amount: Option<f64>) -> Result<()> {
    if key == "dailyBudget" {
        return set_cli_daily_budget(amount);
    }
    if key != "dailyTokenBudget" {
        return Err(anyhow!("unknown budget key `{key}`"));
    }
    let key = key.to_owned();
    crate::config::update(move |obj| match amount {
        Some(value) if value > 0.0 => {
            obj.insert(key, serde_json::json!(value));
        }
        _ => {
            obj.remove(&key);
        }
    })?;
    Ok(())
}

/// `budget` is an object of tiers on the CLI's side, so the whole object is read and written
/// back rather than one key, and an unset tier is removed rather than stored as a zero. The
/// app's old top-level key is dropped on the way past: the two never coexist.
fn set_cli_daily_budget(amount: Option<f64>) -> Result<()> {
    crate::config::update(move |obj| {
        obj.remove("dailyBudget");
        let mut budget = obj
            .get("budget")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        match amount {
            Some(value) if value > 0.0 => {
                budget.insert("daily".into(), serde_json::json!(value));
            }
            _ => {
                budget.remove("daily");
            }
        }
        if budget.is_empty() {
            obj.remove("budget");
        } else {
            obj.insert("budget".into(), Value::Object(budget));
        }
    })?;
    Ok(())
}

/// Moves a limit written by an older build onto the CLI's key, once. The old key was in
/// dollars and the new one is in the display currency, so the rate is applied on the way
/// across; a `budget.daily` that already exists wins, and the old key is removed either way so
/// this never runs twice. Returns the limit in the display currency.
pub fn migrate_daily_budget(rate: f64) -> Option<f64> {
    let stored = crate::tray_status::daily_budget_display();
    let Some(legacy) = crate::tray_status::legacy_daily_budget() else {
        return stored;
    };
    let display = stored.unwrap_or(legacy * rate);
    if let Err(err) = set_cli_daily_budget(Some(display)) {
        crate::log_line!("codeburn: failed to move the daily budget onto budget.daily: {err}");
        return Some(display);
    }
    Some(display)
}

// Provider API keys ---------------------------------------------------------------------

/// Keys the CLI's quota adapters read from the environment, from `src/quota/*.ts`. Only
/// providers listed here can be given a pasted key: anywhere else the key would be stored
/// and never used, which is worse than refusing it.
pub const KEY_VARS: &[(&str, &[&str])] = &[
    ("zai", &["ZAI_API_KEY"]),
    ("clinepass", &["CLINEPASS_API_KEY", "CLINE_API_KEY"]),
];

pub fn accepts_key(provider: &str) -> bool {
    KEY_VARS.iter().any(|(id, _)| *id == provider)
}

fn keys_path() -> Option<PathBuf> {
    Some(dirs::data_local_dir()?.join("codeburn").join("provider-keys.dat"))
}

fn load_keys() -> BTreeMap<String, String> {
    let Some(path) = keys_path() else {
        return BTreeMap::new();
    };
    let Ok(sealed) = fs::read(&path) else {
        return BTreeMap::new();
    };
    unseal(&sealed)
        .ok()
        .and_then(|plain| serde_json::from_slice(&plain).ok())
        .unwrap_or_default()
}

fn store_keys(keys: &BTreeMap<String, String>) -> Result<()> {
    let path = keys_path().context("no local app data directory")?;
    if let Some(parent) = path.parent() {
        create_private_dir(parent)?;
    }
    if keys.is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(());
    }
    let sealed = seal(&serde_json::to_vec(keys)?)?;
    // The temp file carries the same mode as the file it becomes: the rename does not change
    // it, so a lax mode here would be the mode the key ends up stored under.
    let tmp = path.with_extension("tmp");
    write_private(&tmp, &sealed)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

/// Owner-only, because on Unix the file inside is plain text. A 0600 file under a 0755
/// directory still tells every account on the box that a key exists and how long it is, and
/// leaves the entry there to be replaced.
fn create_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        // Not only on creation: an older build made this directory under the plain umask.
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Created 0600 rather than chmodded afterwards, so there is no moment in which the key sits
/// on disk under the umask's mode. The mode is set again for the case the file already
/// existed, where `mode` on the open is ignored.
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(bytes)?;
    file.sync_all()
}

/// Which providers have a stored key. Deliberately not the keys themselves: nothing outside
/// this module and the CLI spawn ever sees one, so a key cannot reach the webview, a log
/// line or an error message.
pub fn stored_key_providers() -> Vec<String> {
    load_keys().into_keys().collect()
}

/// An empty key clears the entry, which is how the settings window's Clear button works.
pub fn set_provider_key(provider: &str, key: &str) -> Result<()> {
    if !accepts_key(provider) {
        return Err(anyhow!(
            "the codeburn CLI does not read a pasted key for `{provider}`"
        ));
    }
    let mut keys = load_keys();
    let key = key.trim();
    if key.is_empty() {
        keys.remove(provider);
    } else {
        keys.insert(provider.to_owned(), key.to_owned());
    }
    store_keys(&keys)
}

/// The environment `codeburn quota` is spawned with. The CLI has no credential store of its
/// own, so a key pasted here reaches it the only way it can: as a variable on the child,
/// never on this process and never written to a command line.
pub fn quota_environment() -> Vec<(String, String)> {
    let stored = load_keys();
    let mut env = Vec::new();
    for (provider, vars) in KEY_VARS {
        let Some(key) = stored.get(*provider) else {
            continue;
        };
        for var in *vars {
            env.push(((*var).to_string(), key.clone()));
        }
    }
    env
}

/// DPAPI, the Windows counterpart of the mac's Keychain item: the ciphertext is bound to
/// this user on this machine, so a copied file decrypts nowhere else.
#[cfg(windows)]
fn seal(plain: &[u8]) -> Result<Vec<u8>> {
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    use windows_sys::Win32::Foundation::LocalFree;

    let input = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(anyhow!(
            "DPAPI could not protect the key: {}",
            std::io::Error::last_os_error()
        ));
    }
    let sealed =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe { LocalFree(output.pbData as _) };
    Ok(sealed)
}

#[cfg(windows)]
fn unseal(sealed: &[u8]) -> Result<Vec<u8>> {
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    use windows_sys::Win32::Foundation::LocalFree;

    let input = CRYPT_INTEGER_BLOB {
        cbData: sealed.len() as u32,
        pbData: sealed.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(anyhow!(
            "DPAPI could not read the stored key: {}",
            std::io::Error::last_os_error()
        ));
    }
    let plain =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe { LocalFree(output.pbData as _) };
    Ok(plain)
}

/// Linux support here is experimental and has no DPAPI equivalent that does not drag in a
/// keyring daemon, so the file is written in the clear.
///
/// This is a plain-text fallback and stays one: the only protection is the 0600 file in the
/// 0700 directory that `store_keys` writes, which stops another account reading the key and
/// stops nothing else. Anything running as this user can read it, as can anyone holding a
/// backup of the home directory. A real fix is a keyring, and that is a new dependency the
/// offline VM builds cannot fetch today.
///
/// The settings window does not say any of this yet: its footer promises DPAPI to everyone
/// (`settings/ProviderPane.tsx`), which is true on Windows and a lie here. That text needs a
/// platform-dependent branch before Linux is anything but experimental.
#[cfg(not(windows))]
fn seal(plain: &[u8]) -> Result<Vec<u8>> {
    Ok(plain.to_vec())
}

#[cfg(not(windows))]
fn unseal(sealed: &[u8]) -> Result<Vec<u8>> {
    Ok(sealed.to_vec())
}

// Directory picker ----------------------------------------------------------------------

/// The Windows counterpart of the mac's NSOpenPanel in ClaudeConfigDirsSection. This is the
/// shell's own folder browser rather than a dialog crate, which would be a new dependency
/// for one button. It is modal and must run on the thread that owns the app's windows.
#[cfg(windows)]
pub fn browse_for_folder(title: &str) -> Option<String> {
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{
        SHBrowseForFolderW, SHGetPathFromIDListW, BIF_NEWDIALOGSTYLE, BIF_RETURNONLYFSDIRS,
        BROWSEINFOW,
    };

    /// MAX_PATH, which is what SHGetPathFromIDListW writes into.
    const MAX_PATH: usize = 260;

    let title: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    let mut display = [0u16; MAX_PATH];
    let info = BROWSEINFOW {
        hwndOwner: std::ptr::null_mut(),
        pidlRoot: std::ptr::null_mut(),
        pszDisplayName: display.as_mut_ptr(),
        lpszTitle: title.as_ptr(),
        ulFlags: BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE,
        lpfn: None,
        lParam: 0,
        iImage: 0,
    };

    let pidl = unsafe { SHBrowseForFolderW(&info) };
    if pidl.is_null() {
        return None;
    }
    let mut path = [0u16; MAX_PATH];
    let ok = unsafe { SHGetPathFromIDListW(pidl, path.as_mut_ptr()) };
    unsafe { CoTaskMemFree(pidl as *const std::ffi::c_void) };
    if ok == 0 {
        return None;
    }
    let end = path.iter().position(|unit| *unit == 0).unwrap_or(path.len());
    Some(String::from_utf16_lossy(&path[..end]))
}

#[cfg(not(windows))]
pub fn browse_for_folder(title: &str) -> Option<String> {
    let _ = title;
    None
}

// The window ----------------------------------------------------------------------------

/// Opens the settings window on `section`, creating it if it is not already up. Closing it
/// destroys it, as the dock window is destroyed, so a settings window nobody is looking at
/// costs no webview.
pub fn open(app: &AppHandle, section: Option<&str>) -> tauri::Result<()> {
    if let Some(section) = section {
        if let Ok(mut pending) = PENDING_SECTION.lock() {
            *pending = Some(section.to_owned());
        }
    }

    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = window.unminimize();
        window.show()?;
        window.set_focus()?;
        // The page is already mounted, so it will never ask for the pending section.
        if let Some(section) = section {
            let _ = window.emit("codeburn://settings-section", section);
        }
        return Ok(());
    }

    // Built visible rather than shown afterwards: a window created hidden and then shown
    // came up invisible every time but the first, and the builder centres it before the
    // first frame anyway, so there is nothing to hide from.
    let window = WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::default())
        .title("CodeBurn Settings")
        .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .resizable(true)
        .decorations(true)
        .center()
        .build()?;
    window.set_focus()?;
    Ok(())
}

/// The section the window was opened on, taken rather than read: a later reload of the page
/// should land on General, not on the pane the tray asked for an hour ago.
pub fn take_pending_section() -> Option<String> {
    PENDING_SECTION.lock().ok().and_then(|mut p| p.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_sync_env_override_is_only_zero() {
        // Nothing else in this crate reads the variable, so setting it here races no test.
        let previous = std::env::var_os("CODEBURN_CURSOR_SYNC");
        std::env::set_var("CODEBURN_CURSOR_SYNC", "0");
        assert!(cursor_sync_env_off());
        std::env::set_var("CODEBURN_CURSOR_SYNC", "1");
        assert!(!cursor_sync_env_off());
        std::env::remove_var("CODEBURN_CURSOR_SYNC");
        assert!(!cursor_sync_env_off());
        if let Some(value) = previous {
            std::env::set_var("CODEBURN_CURSOR_SYNC", value);
        }
    }

    #[test]
    fn only_providers_the_cli_reads_from_the_environment_accept_a_key() {
        assert!(accepts_key("zai"));
        assert!(accepts_key("clinepass"));
        assert!(!accepts_key("claude"));
        assert!(!accepts_key("copilot"));
    }

    #[test]
    fn a_key_reaches_the_cli_under_every_name_that_adapter_reads() {
        let vars: Vec<&str> = KEY_VARS
            .iter()
            .filter(|(id, _)| *id == "clinepass")
            .flat_map(|(_, vars)| vars.iter().copied())
            .collect();
        assert_eq!(vars, vec!["CLINEPASS_API_KEY", "CLINE_API_KEY"]);
    }

    /// Runs on the Linux half of the CI matrix, which is the only place the plain-text
    /// fallback is reachable and so the only place the mode is the whole protection.
    #[cfg(unix)]
    #[test]
    fn a_plain_text_key_is_written_owner_only_inside_an_owner_only_directory() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join("codeburn-keys-mode-test");
        let _ = fs::remove_dir_all(&dir);
        // The mode an older build would have left behind, to prove it is tightened and not
        // merely set on the way in.
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();

        let path = dir.join("provider-keys.dat");
        // The same, for a temp file left over from a run that died before its rename.
        fs::write(&path, b"stale").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        create_private_dir(&dir).unwrap();
        write_private(&path, b"sk-test-value").unwrap();

        let mode = |p: &std::path::Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&path), 0o600);
        assert_eq!(fs::read(&path).unwrap(), b"sk-test-value");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_sealed_key_comes_back_unchanged() {
        let plain = br#"{"zai":"sk-test-value"}"#;
        let sealed = seal(plain).unwrap();
        assert_eq!(unseal(&sealed).unwrap(), plain.to_vec());
    }

    #[test]
    fn a_null_patch_value_removes_the_key_rather_than_storing_null() {
        let mut stored = Map::new();
        stored.insert("metric".into(), Value::String("tokens".into()));
        let mut patch = Map::new();
        patch.insert("metric".into(), Value::Null);
        for (key, value) in patch {
            if value.is_null() {
                stored.remove(&key);
            } else {
                stored.insert(key, value);
            }
        }
        assert!(stored.is_empty());
    }
}
