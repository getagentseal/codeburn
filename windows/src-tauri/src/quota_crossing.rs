//! Quota-crossing notices, the Windows twin of `mac/.../Data/QuotaCrossing.swift`: once per
//! cycle at the warning threshold, at 100%, and when the recent pace runs the window out
//! before it resets.
//!
//! The detector is pure: the fired set goes in and comes back out. `observe` is the monitor
//! around it, run on every fresh `codeburn quota` answer, so it adds no polling of its own.
//! The fired set lives in the tray's status file so a relaunch does not repeat a crossing
//! already announced.

use std::collections::BTreeSet;
use std::sync::Mutex;

use serde_json::Value;
use tauri::AppHandle;

use crate::quota_pace::{self, Forecast, Reading, Readings};

pub const DEFAULT_WARNING_PERCENT: u32 = 80;
const WARNING_PERCENT_OPTIONS: [u32; 3] = [70, 80, 90];
const LIMIT_PERCENT: f64 = 100.0;

/// One provider window as the crossing monitor sees it.
#[derive(Clone, Debug, PartialEq)]
pub struct Window {
    pub provider_name: String,
    /// The CLI's own label ("5-hour", "Weekly · Opus"), never translated.
    pub label: String,
    /// Share of the window used, 0..=100.
    pub percent: Option<f64>,
    pub resets_at: Option<f64>,
    /// When the recent-pace forecast says the window runs out.
    pub runs_out_at: Option<f64>,
}

impl Window {
    /// One cycle of one window. A window with no reset instant cannot tell one cycle from the
    /// next, so it notifies once and then stays quiet. The instant is bucketed to the minute
    /// because Claude's `resets_at` jitters by a second or two within one window, which would
    /// re-arm it.
    fn cycle_key(&self) -> String {
        let stamp = self
            .resets_at
            .map(|t| ((t / 60.0).round() as i64 * 60).to_string())
            .unwrap_or_else(|| "-".to_owned());
        format!("{}|{}|{}", self.provider_name, self.label, stamp)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Warning,
    Limit,
    RunsOut,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Warning => "warning",
            Level::Limit => "limit",
            Level::RunsOut => "runsOut",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub provider_name: String,
    pub window_label: String,
    pub level: Level,
    pub warning_percent: u32,
    pub runs_out_at: Option<f64>,
    pub resets_at: Option<f64>,
}

impl Event {
    pub fn title(&self, now: f64) -> String {
        let name = Value::from(self.provider_name.as_str());
        let label = Value::from(self.window_label.as_str());
        match self.level {
            Level::Warning => crate::i18n::format_message(
                "%1$@ · %2$@ at %3$lld%%",
                &[name, label, Value::from(self.warning_percent)],
            ),
            Level::Limit => {
                crate::i18n::format_message("%1$@ · %2$@ limit reached", &[name, label])
            }
            Level::RunsOut => crate::i18n::format_message(
                "%1$@ %2$@ runs out at %3$@",
                &[
                    name,
                    label,
                    Value::from(
                        self.runs_out_at
                            .map(|t| quota_pace::clock_label(t, now))
                            .unwrap_or_default(),
                    ),
                ],
            ),
        }
    }

    pub fn body(&self, now: f64) -> String {
        match (self.level, self.resets_at) {
            (Level::RunsOut, Some(resets_at)) => crate::i18n::format_message(
                "At this pace. Resets %@.",
                &[Value::from(quota_pace::clock_label(resets_at, now))],
            ),
            _ => String::new(),
        }
    }
}

/// Which windows crossed a notify-worthy threshold, and the fired set to keep.
pub fn evaluate(
    windows: &[Window],
    fired: BTreeSet<String>,
    warning_percent: u32,
) -> (Vec<Event>, BTreeSet<String>) {
    let mut live = fired;
    for window in windows {
        // A window now on a different cycle is re-armed; absence is not a reset, so a
        // provider between fetches keeps what it has fired.
        let prefix = format!("{}|{}|", window.provider_name, window.label);
        let current = format!("{}|", window.cycle_key());
        live.retain(|key| !key.starts_with(&prefix) || key.starts_with(&current));
    }

    let mut events = Vec::new();
    for window in windows {
        let Some(percent) = window.percent.filter(|p| p.is_finite()) else {
            continue;
        };
        let cycle = window.cycle_key();
        if let (Some(runs_out_at), Some(resets_at)) = (window.runs_out_at, window.resets_at) {
            let key = format!("{cycle}|{}", Level::RunsOut.as_str());
            if runs_out_at < resets_at && percent < LIMIT_PERCENT && live.insert(key) {
                events.push(Event {
                    provider_name: window.provider_name.clone(),
                    window_label: window.label.clone(),
                    level: Level::RunsOut,
                    warning_percent,
                    runs_out_at: Some(runs_out_at),
                    resets_at: Some(resets_at),
                });
            }
        }
        let level = if percent >= LIMIT_PERCENT {
            Level::Limit
        } else if percent >= f64::from(warning_percent) {
            Level::Warning
        } else {
            continue;
        };
        let key = format!("{cycle}|{}", level.as_str());
        if !live.insert(key) {
            continue;
        }
        // Once the window is full the warning is water under the bridge: marking it fired
        // keeps a later reading from posting it after the louder one.
        if level == Level::Limit {
            live.insert(format!("{cycle}|{}", Level::Warning.as_str()));
        }
        events.push(Event {
            provider_name: window.provider_name.clone(),
            window_label: window.label.clone(),
            level,
            warning_percent,
            runs_out_at: None,
            resets_at: None,
        });
    }
    (events, live)
}

/// The windows the mac's monitor watches: Claude's four fixed windows (not the scoped weekly
/// limits), Codex's own windows (not the extra named limits or the credits), and every
/// window of Kimi, Gemini, Copilot and Antigravity.
fn watched(provider_id: &str, label: &str) -> bool {
    match provider_id {
        "claude" => matches!(
            label,
            "5-hour" | "Weekly" | "Weekly · Opus" | "Weekly · Sonnet"
        ),
        "codex" => !label.contains(" · "),
        "kimi" | "gemini" | "copilot" | "antigravity" => true,
        _ => false,
    }
}

fn unix_seconds(iso: &str) -> Option<f64> {
    let at = chrono::DateTime::parse_from_rfc3339(iso).ok()?;
    Some(at.timestamp_millis() as f64 / 1000.0)
}

fn iso(seconds: f64) -> Option<String> {
    let at = chrono::DateTime::from_timestamp_millis((seconds * 1000.0).round() as i64)?;
    Some(at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// Records each watched window's reading from this answer and writes its forecast into the
/// window (`runsOutAt`, or `lastsUntilReset`) for the popover. Returns the windows for the
/// detector.
fn annotate(providers: &mut Value, readings: &mut Readings, now: f64) -> Vec<Window> {
    let mut windows = Vec::new();
    for provider in providers.as_array_mut().into_iter().flatten() {
        if provider.get("available").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let id = provider
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let name = provider
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_owned();
        let Some(rows) = provider.get_mut("windows").and_then(Value::as_array_mut) else {
            continue;
        };
        for row in rows {
            let label = row
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            if !watched(&id, &label) {
                continue;
            }
            let percent = row.get("usedPct").and_then(Value::as_f64);
            let resets_at = row
                .get("resetsAt")
                .and_then(Value::as_str)
                .and_then(unix_seconds);
            let key = format!("{name}|{label}");
            let mut runs_out_at = None;
            if let (Some(percent), Some(resets_at)) = (percent.filter(|p| p.is_finite()), resets_at)
            {
                readings.record(
                    &key,
                    Reading {
                        percent,
                        resets_at,
                        observed_at: now,
                    },
                    now,
                );
                match readings.forecast(&key, resets_at, now) {
                    Some(Forecast::RunsOut(at)) => {
                        runs_out_at = Some(at);
                        if let (Some(obj), Some(at)) = (row.as_object_mut(), iso(at)) {
                            obj.insert("runsOutAt".into(), Value::from(at));
                        }
                    }
                    Some(Forecast::LastsUntilReset) => {
                        if let Some(obj) = row.as_object_mut() {
                            obj.insert("lastsUntilReset".into(), Value::Bool(true));
                        }
                    }
                    None => {}
                }
            }
            windows.push(Window {
                provider_name: name.clone(),
                label,
                percent,
                resets_at,
                runs_out_at,
            });
        }
    }
    windows
}

/// The settings window's alert switch (absent is on, so existing installs get the alert
/// without visiting Settings) and its threshold.
fn preferences() -> (bool, u32) {
    let settings = crate::settings::read();
    let enabled = settings.get("quotaCrossingAlerts").and_then(Value::as_bool) != Some(false);
    let percent = settings
        .get("quotaWarningPercent")
        .and_then(Value::as_u64)
        .and_then(|p| u32::try_from(p).ok())
        .filter(|p| WARNING_PERCENT_OPTIONS.contains(p))
        .unwrap_or(DEFAULT_WARNING_PERCENT);
    (enabled, percent)
}

static READINGS: Mutex<Option<Readings>> = Mutex::new(None);

/// Runs on every fresh quota answer: forecasts into `providers`, then the notices.
pub fn observe(app: &AppHandle, providers: &mut Value) {
    let now = chrono::Utc::now().timestamp_millis() as f64 / 1000.0;
    let windows = match READINGS.lock() {
        Ok(mut guard) => annotate(providers, guard.get_or_insert_with(Readings::default), now),
        Err(_) => return,
    };
    let (enabled, warning_percent) = preferences();
    let mut events = Vec::new();
    // Persisted before delivery: a crossing is one-shot even when the alert is off.
    let stored = crate::tray_status::write_status(|status| {
        let (fresh, fired) = evaluate(
            &windows,
            std::mem::take(&mut status.quota_crossings_fired),
            warning_percent,
        );
        status.quota_crossings_fired = fired;
        events = fresh;
    });
    if let Err(err) = stored {
        // Without the fired set every refresh would repeat the notice, so none is shown.
        crate::log_line!("codeburn: failed to persist quota crossings: {err}");
        return;
    }
    if !enabled {
        return;
    }
    use tauri_plugin_notification::NotificationExt;
    for event in events {
        let mut builder = app.notification().builder().title(event.title(now));
        let body = event.body(now);
        if !body.is_empty() {
            builder = builder.body(body);
        }
        if let Err(err) = builder.show() {
            crate::log_line!("codeburn: quota notification failed: {err}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::LocaleLock;

    const NOW: f64 = 1_800_000_000.0;
    const RESETS_AT: f64 = NOW + 3.0 * 86400.0;

    fn window(percent: f64) -> Window {
        Window {
            provider_name: "Claude".into(),
            label: "Weekly".into(),
            percent: Some(percent),
            resets_at: Some(RESETS_AT),
            runs_out_at: None,
        }
    }

    fn levels(events: &[Event]) -> Vec<Level> {
        events.iter().map(|e| e.level).collect()
    }

    #[test]
    fn warning_then_limit_fire_once_each_per_cycle() {
        let (first, fired) = evaluate(&[window(81.0)], BTreeSet::new(), DEFAULT_WARNING_PERCENT);
        assert_eq!(levels(&first), [Level::Warning]);
        let (again, fired) = evaluate(&[window(85.0)], fired, DEFAULT_WARNING_PERCENT);
        assert!(again.is_empty());
        let (limit, fired) = evaluate(&[window(100.0)], fired, DEFAULT_WARNING_PERCENT);
        assert_eq!(levels(&limit), [Level::Limit]);
        let mut next = window(82.0);
        next.resets_at = Some(RESETS_AT + 7.0 * 86400.0);
        let (rearmed, _) = evaluate(&[next], fired, DEFAULT_WARNING_PERCENT);
        assert_eq!(levels(&rearmed), [Level::Warning]);
    }

    #[test]
    fn a_full_window_marks_the_warning_fired_too() {
        let (first, fired) = evaluate(&[window(100.0)], BTreeSet::new(), DEFAULT_WARNING_PERCENT);
        assert_eq!(levels(&first), [Level::Limit]);
        let (later, _) = evaluate(&[window(90.0)], fired, DEFAULT_WARNING_PERCENT);
        assert!(later.is_empty());
    }

    #[test]
    fn absence_is_not_a_reset() {
        let (_, fired) = evaluate(&[window(81.0)], BTreeSet::new(), DEFAULT_WARNING_PERCENT);
        let (_, fired) = evaluate(&[], fired, DEFAULT_WARNING_PERCENT);
        let (back, _) = evaluate(&[window(81.0)], fired, DEFAULT_WARNING_PERCENT);
        assert!(back.is_empty());
    }

    #[test]
    fn reset_jitter_of_a_couple_of_seconds_stays_one_cycle() {
        let (first, fired) = evaluate(&[window(81.0)], BTreeSet::new(), DEFAULT_WARNING_PERCENT);
        let mut jittered = window(81.0);
        jittered.resets_at = Some(RESETS_AT + 2.0);
        let (second, fired) = evaluate(&[jittered], fired, DEFAULT_WARNING_PERCENT);
        let (back, _) = evaluate(&[window(81.0)], fired, DEFAULT_WARNING_PERCENT);
        assert_eq!(first.len(), 1);
        assert!(second.is_empty());
        assert!(back.is_empty());
    }

    #[test]
    fn a_window_that_runs_out_before_it_resets_says_so_once_per_cycle() {
        let _lock = LocaleLock::acquire("en");
        let mut early = window(50.0);
        early.runs_out_at = Some(RESETS_AT - 3600.0);
        let (first, fired) = evaluate(&[early.clone()], BTreeSet::new(), DEFAULT_WARNING_PERCENT);
        assert_eq!(levels(&first), [Level::RunsOut]);
        assert_eq!(
            first[0].title(NOW),
            format!(
                "Claude Weekly runs out at {}",
                quota_pace::clock_label(RESETS_AT - 3600.0, NOW)
            )
        );
        assert_eq!(
            first[0].body(NOW),
            format!(
                "At this pace. Resets {}.",
                quota_pace::clock_label(RESETS_AT, NOW)
            )
        );

        early.runs_out_at = Some(RESETS_AT - 7200.0);
        let (second, fired) = evaluate(&[early], fired, DEFAULT_WARNING_PERCENT);
        assert!(second.is_empty());

        let mut next_cycle = window(50.0);
        next_cycle.resets_at = Some(RESETS_AT + 7.0 * 86400.0);
        next_cycle.runs_out_at = Some(RESETS_AT);
        let (third, _) = evaluate(&[next_cycle], fired, DEFAULT_WARNING_PERCENT);
        assert_eq!(levels(&third), [Level::RunsOut]);
    }

    #[test]
    fn a_run_out_at_or_after_the_reset_or_a_full_window_says_nothing() {
        let mut lasts = window(50.0);
        lasts.runs_out_at = Some(RESETS_AT);
        let mut full = window(100.0);
        full.label = "5-hour".into();
        full.runs_out_at = Some(RESETS_AT - 3600.0);
        let (events, _) = evaluate(&[lasts, full], BTreeSet::new(), DEFAULT_WARNING_PERCENT);
        assert_eq!(levels(&events), [Level::Limit]);
    }

    #[test]
    fn the_warning_fires_at_the_chosen_threshold() {
        let _lock = LocaleLock::acquire("en");
        assert!(
            evaluate(&[window(75.0)], BTreeSet::new(), DEFAULT_WARNING_PERCENT)
                .0
                .is_empty()
        );
        let (lower, _) = evaluate(&[window(75.0)], BTreeSet::new(), 70);
        assert_eq!(
            lower.iter().map(|e| e.title(NOW)).collect::<Vec<_>>(),
            ["Claude · Weekly at 70%"]
        );
        assert!(evaluate(&[window(85.0)], BTreeSet::new(), 90).0.is_empty());
        let (limit, _) = evaluate(&[window(100.0)], BTreeSet::new(), 90);
        assert_eq!(limit[0].title(NOW), "Claude · Weekly limit reached");
    }

    #[test]
    fn annotate_watches_the_mac_windows_and_writes_the_forecast_back() {
        let resets = iso(NOW + 2.0 * 86400.0).unwrap();
        let providers = |percent: f64| {
            serde_json::json!([
                { "id": "claude", "name": "Claude", "available": true, "windows": [
                    { "label": "Weekly", "usedPct": percent, "resetsAt": resets },
                    { "label": "Weekly · Fable", "usedPct": percent, "resetsAt": resets },
                ]},
                { "id": "codex", "name": "Codex", "available": true, "windows": [
                    { "label": "5-hour", "usedPct": 10.0 },
                    { "label": "Monthly usage limit · 1 / 2 credits", "usedPct": 50.0 },
                ]},
                { "id": "cursor", "name": "Cursor", "available": true, "windows": [
                    { "label": "Monthly", "usedPct": 90.0, "resetsAt": resets },
                ]},
                { "id": "gemini", "name": "Gemini", "available": false, "windows": [
                    { "label": "Daily", "usedPct": 90.0, "resetsAt": resets },
                ]},
            ])
        };
        let mut readings = Readings::default();
        let mut first = providers(40.0);
        let windows = annotate(&mut first, &mut readings, NOW - 5.0 * 3600.0);
        assert_eq!(
            windows
                .iter()
                .map(|w| format!("{}|{}", w.provider_name, w.label))
                .collect::<Vec<_>>(),
            ["Claude|Weekly", "Codex|5-hour"]
        );
        assert_eq!(windows[1].resets_at, None);

        let mut second = providers(50.0);
        let windows = annotate(&mut second, &mut readings, NOW);
        // 10 points in 5 h: the remaining 50 take 25 h, before the reset.
        assert_eq!(windows[0].runs_out_at, Some(NOW + 25.0 * 3600.0));
        assert_eq!(
            second[0]["windows"][0]["runsOutAt"],
            Value::from(iso(NOW + 25.0 * 3600.0).unwrap())
        );
        assert!(second[0]["windows"][1].get("runsOutAt").is_none());

        let mut slow = providers(52.0);
        annotate(&mut slow, &mut readings, NOW + 3.0 * 3600.0);
        assert_eq!(slow[0]["windows"][0]["lastsUntilReset"], Value::Bool(true));
    }
}
