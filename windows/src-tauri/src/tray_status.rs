//! What the tray says without being clicked: the flame's colour and the number beside it,
//! and the files this app keeps beside them under its own data directory.
//!
//! Two jobs, both ported from the macOS status item (CodeBurnApp.swift refreshStatusButton and
//! Data/MenubarStatusCache.swift). The flame takes the worst connected provider's quota
//! severity, or yellow when today's spend is over the daily budget, and stays untinted the
//! rest of the time. The badge figure and the tooltip are written to disk on every refresh so
//! a relaunch shows the last known number instead of a blank tray for one CLI round trip.
//!
//! The `log` submodule is here because it writes to that same directory, next to status.json.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tauri::image::Image;

/// The tray logo, embedded so a tint can be applied without going back to disk.
const TRAY_PNG: &[u8] = include_bytes!("../icons/tray.png");

/// The quota severity ladder from QuotaSummary.Severity. Normal keeps the untinted logo, so
/// the tray only ever gains colour when there is something to say.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Normal,
    Warning,
    Critical,
    Danger,
}

impl Severity {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "normal" => Some(Self::Normal),
            "warning" => Some(Self::Warning),
            "critical" => Some(Self::Critical),
            "danger" => Some(Self::Danger),
            _ => None,
        }
    }

    /// The mac's systemYellow / systemOrange / systemRed.
    fn tint(self) -> Option<[u8; 3]> {
        match self {
            Self::Normal => None,
            Self::Warning => Some([0xFF, 0xCC, 0x00]),
            Self::Critical => Some([0xFF, 0x95, 0x00]),
            Self::Danger => Some([0xFF, 0x3B, 0x30]),
        }
    }
}

/// The tint the tray logo should carry. Severity wins; being over the daily budget only
/// colours a flame that quota left alone, exactly as the mac orders the two.
pub fn tint_for(severity: Severity, over_budget: bool) -> Option<[u8; 3]> {
    severity
        .tint()
        .or(if over_budget { Some([0xFF, 0xCC, 0x00]) } else { None })
}

/// The logo recoloured in place: alpha is the shape, so only the colour channels move. An
/// untinted request returns the artwork as shipped.
pub fn tray_icon(tint: Option<[u8; 3]>) -> Result<Image<'static>> {
    let image = Image::from_bytes(TRAY_PNG).context("failed to decode the tray icon")?;
    let (width, height) = (image.width(), image.height());
    let mut rgba = image.rgba().to_vec();
    if let Some(color) = tint {
        for pixel in rgba.chunks_exact_mut(4) {
            if pixel[3] == 0 {
                continue;
            }
            pixel[0] = color[0];
            pixel[1] = color[1];
            pixel[2] = color[2];
        }
    }
    Ok(Image::new_owned(rgba, width, height))
}

/// Today's spend limit, where the CLI's own config type keeps it: `budget.daily`, in the
/// display currency (`src/config.ts`). Read from Rust because the tray is judged against it
/// before any webview exists. Absent or zero means no budget.
pub fn daily_budget_display() -> Option<f64> {
    config_number(&["budget", "daily"])
}

/// What this app wrote before it learned the CLI's key: top level, and in dollars. Read once
/// so a limit set by an older build survives the move, after which
/// `settings::migrate_daily_budget` removes it.
pub fn legacy_daily_budget() -> Option<f64> {
    config_number(&["dailyBudget"])
}

/// The same alert measured in tokens, for the token display metrics. Only one of the two is
/// ever armed, since the metric decides which one the flame is judged against. The CLI has no
/// token budget of its own, so this one stays where this app put it.
pub fn daily_token_budget() -> Option<f64> {
    config_number(&["dailyTokenBudget"])
}

fn config_number(path: &[&str]) -> Option<f64> {
    let config = crate::config::read();
    let (first, rest) = path.split_first()?;
    let mut value = config.get(*first)?;
    for key in rest {
        value = value.get(key)?;
    }
    let number = value.as_f64()?;
    (number > 0.0).then_some(number)
}

/// The badge text and tooltip from the last successful refresh, and the quota crossings
/// already announced.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TrayStatus {
    #[serde(default)]
    pub badge: Option<String>,
    #[serde(default)]
    pub tooltip: Option<String>,
    #[serde(default)]
    pub quota_crossings_fired: BTreeSet<String>,
}

fn status_path() -> Option<PathBuf> {
    Some(dirs::data_local_dir()?.join("codeburn-menubar").join("status.json"))
}

/// The stored status, but only while it is younger than `max_age`. Age comes from the file's
/// mtime, as on the mac: a stale figure in the tray is worse than an empty one.
pub fn read_status(max_age: Duration) -> Option<TrayStatus> {
    read_status_from(&status_path()?, max_age)
}

fn read_status_from(path: &std::path::Path, max_age: Duration) -> Option<TrayStatus> {
    let age = SystemTime::now()
        .duration_since(fs::metadata(path).ok()?.modified().ok()?)
        .ok()?;
    if age > max_age {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Merges one field into the stored status. Both fields are written by separate refresh
/// paths, so neither may clear the other.
pub fn write_status(update: impl FnOnce(&mut TrayStatus)) -> Result<()> {
    let path = status_path().context("no local app data directory")?;
    let mut status = match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => TrayStatus::default(),
    };
    update(&mut status);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, serde_json::to_vec(&status)?)?;
    Ok(())
}

// The diagnostics log ---------------------------------------------------------------------

/// Where a release build's complaints go.
///
/// `main.rs` builds the release binary for the Windows GUI subsystem, which has no console
/// attached: an `eprintln!` there writes into a handle that does not exist, so nothing the
/// app has ever reported in the field was readable. These lines go to
/// `<local app data>\codeburn-menubar\codeburn.log` instead, and still to stderr in a debug
/// build, where there is a console to read them on.
pub mod log {
    use std::fs;
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Rolled at this size rather than trimmed, so the lines dropped are the oldest ones and
    /// not the ones that explain what just happened. One previous file is kept, which bounds
    /// the pair at twice this.
    const MAX_LOG_BYTES: u64 = 256 * 1024;

    fn log_path() -> Option<PathBuf> {
        Some(
            dirs::data_local_dir()?
                .join("codeburn-menubar")
                .join("codeburn.log"),
        )
    }

    /// One timestamped line. Every failure here is swallowed: a logger that propagates a full
    /// disk turns a message about one broken thing into a second broken thing.
    pub fn write(message: &str) {
        #[cfg(debug_assertions)]
        eprintln!("{message}");
        if let Some(path) = log_path() {
            let _ = append_line(&path, now_secs(), message);
        }
    }

    fn append_line(path: &Path, secs: u64, message: &str) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        roll_if_full(path, MAX_LOG_BYTES);
        let mut file = fs::OpenOptions::new().create(true).append(true).open(path)?;
        writeln!(file, "{} {}", timestamp(secs), message.trim_end())
    }

    /// The full log becomes `codeburn.log.1`, replacing the previous one. A rename cannot lose
    /// a line the way copy-and-truncate can, and it still works on the full disk that is one
    /// of the reasons to be logging at all.
    fn roll_if_full(path: &Path, max_bytes: u64) {
        let full = fs::metadata(path)
            .map(|meta| meta.len() >= max_bytes)
            .unwrap_or(false);
        if full {
            let _ = fs::rename(path, path.with_extension("log.1"));
        }
    }

    fn now_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_secs())
            .unwrap_or(0)
    }

    /// `2026-09-02 14:25:31Z`. The date is derived here rather than by taking on a date crate
    /// for one format string, which also leaves the offline VM builds nothing new to fetch.
    fn timestamp(secs: u64) -> String {
        let (year, month, day) = civil_from_days((secs / 86_400) as i64);
        let time = secs % 86_400;
        let hours = time / 3600;
        let minutes = (time % 3600) / 60;
        let seconds = time % 60;
        format!("{year:04}-{month:02}-{day:02} {hours:02}:{minutes:02}:{seconds:02}Z")
    }

    /// Hinnant's civil_from_days, with the era shifted so day zero is 1970-01-01. March is
    /// taken as the first month of the year, which is what puts the leap day at the end of the
    /// cycle and leaves the arithmetic without a branch for it.
    fn civil_from_days(days: i64) -> (i64, u32, u32) {
        let shifted = days + 719_468;
        let era = shifted.div_euclid(146_097);
        let day_of_era = shifted.rem_euclid(146_097);
        let year_of_era =
            (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
        let year = year_of_era + era * 400;
        let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
        let shifted_month = (5 * day_of_year + 2) / 153;
        let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
        let month = if shifted_month < 10 {
            shifted_month + 3
        } else {
            shifted_month - 9
        } as u32;
        (if month <= 2 { year + 1 } else { year }, month, day)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn temp_log(name: &str) -> PathBuf {
            let path = std::env::temp_dir().join(name);
            let _ = fs::remove_file(&path);
            let _ = fs::remove_file(path.with_extension("log.1"));
            path
        }

        #[test]
        fn a_timestamp_is_the_civil_date_in_utc() {
            assert_eq!(timestamp(0), "1970-01-01 00:00:00Z");
            assert_eq!(timestamp(1_000_000_000), "2001-09-09 01:46:40Z");
            // 2024-02-29, the leap day the shifted-month arithmetic exists for.
            assert_eq!(timestamp(1_709_208_896), "2024-02-29 12:14:56Z");
            assert_eq!(timestamp(1_735_689_599), "2024-12-31 23:59:59Z");
        }

        #[test]
        fn a_line_is_appended_under_its_timestamp() {
            let path = temp_log("codeburn-log-append.log");
            append_line(&path, 0, "codeburn: first").unwrap();
            append_line(&path, 61, "codeburn: second\n").unwrap();
            assert_eq!(
                fs::read_to_string(&path).unwrap(),
                "1970-01-01 00:00:00Z codeburn: first\n1970-01-01 00:01:01Z codeburn: second\n"
            );
            let _ = fs::remove_file(path);
        }

        #[test]
        fn a_full_log_is_rolled_rather_than_grown_without_end() {
            let path = temp_log("codeburn-log-roll.log");
            fs::write(&path, "x".repeat(64)).unwrap();
            roll_if_full(&path, 128);
            assert!(path.is_file(), "a log under the cap is left where it is");

            roll_if_full(&path, 64);
            assert!(!path.exists(), "the full log moved aside");
            let rolled = path.with_extension("log.1");
            assert_eq!(fs::read_to_string(&rolled).unwrap().len(), 64);

            append_line(&path, 0, "codeburn: after the roll").unwrap();
            assert_eq!(
                fs::read_to_string(&path).unwrap(),
                "1970-01-01 00:00:00Z codeburn: after the roll\n"
            );
            let _ = fs::remove_file(path);
            let _ = fs::remove_file(rolled);
        }

        #[test]
        fn a_second_roll_replaces_the_previous_file_rather_than_piling_up() {
            let path = temp_log("codeburn-log-roll-twice.log");
            fs::write(&path, "old").unwrap();
            roll_if_full(&path, 1);
            fs::write(&path, "new").unwrap();
            roll_if_full(&path, 1);
            let rolled = path.with_extension("log.1");
            assert_eq!(fs::read_to_string(&rolled).unwrap(), "new");
            assert!(!path.exists());
            let _ = fs::remove_file(rolled);
        }
    }
}

/// `crate::log_line!("codeburn: ...")`, so a call site reads as the `eprintln!` it replaces.
#[macro_export]
macro_rules! log_line {
    ($($arg:tt)*) => {
        $crate::tray_status::log::write(&format!($($arg)*))
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn severity_tints_only_once_there_is_something_to_say() {
        assert_eq!(tint_for(Severity::Normal, false), None);
        assert_eq!(tint_for(Severity::Warning, false), Some([0xFF, 0xCC, 0x00]));
        assert_eq!(tint_for(Severity::Critical, false), Some([0xFF, 0x95, 0x00]));
        assert_eq!(tint_for(Severity::Danger, false), Some([0xFF, 0x3B, 0x30]));
    }

    #[test]
    fn the_budget_only_colours_a_flame_quota_left_alone() {
        assert_eq!(tint_for(Severity::Normal, true), Some([0xFF, 0xCC, 0x00]));
        assert_eq!(tint_for(Severity::Danger, true), Some([0xFF, 0x3B, 0x30]));
    }

    #[test]
    fn an_unknown_severity_is_rejected_rather_than_guessed() {
        assert_eq!(Severity::parse("danger"), Some(Severity::Danger));
        assert_eq!(Severity::parse("DANGER"), None);
        assert_eq!(Severity::parse(""), None);
    }

    fn temp_status(name: &str, contents: &str) -> PathBuf {
        let path = std::env::temp_dir().join(name);
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn a_fresh_status_file_is_read_back() {
        let path = temp_status("codeburn-status-fresh.json", r#"{"badge":"$12","tooltip":"t"}"#);
        let status = read_status_from(&path, Duration::from_secs(600)).unwrap();
        assert_eq!(status.badge.as_deref(), Some("$12"));
        assert_eq!(status.tooltip.as_deref(), Some("t"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn an_expired_or_unreadable_status_file_is_ignored() {
        let stale = temp_status("codeburn-status-stale.json", r#"{"badge":"$12"}"#);
        assert!(read_status_from(&stale, Duration::ZERO).is_none());
        let torn = temp_status("codeburn-status-torn.json", "{not json");
        assert!(read_status_from(&torn, Duration::from_secs(600)).is_none());
        assert!(read_status_from(std::path::Path::new("no-such-status.json"), Duration::from_secs(600)).is_none());
        let _ = fs::remove_file(stale);
        let _ = fs::remove_file(torn);
    }

    #[test]
    fn tinting_moves_colour_but_keeps_the_shape() {
        let plain = tray_icon(None).unwrap();
        let tinted = tray_icon(Some([0xFF, 0x3B, 0x30])).unwrap();
        assert_eq!(plain.width(), tinted.width());
        assert_eq!(plain.rgba().len(), tinted.rgba().len());
        let alpha = |image: &Image<'_>| image.rgba().iter().skip(3).step_by(4).map(|a| *a as u64).sum::<u64>();
        assert_eq!(alpha(&plain), alpha(&tinted));
        assert!(
            tinted
                .rgba()
                .chunks_exact(4)
                .filter(|p| p[3] > 0)
                .all(|p| p[0] == 0xFF && p[1] == 0x3B && p[2] == 0x30),
            "every visible pixel takes the tint"
        );
    }
}
