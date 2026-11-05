//! Run-out forecast for a quota window from its recent readings, the Windows twin of the
//! `forecast` half of `mac/.../Data/QuotaPace.swift`. A whole-window average gives no ETA: a
//! quiet morning hides a busy afternoon, so only the recent pace dates one.
//!
//! Instants are Unix seconds, as `TimeInterval` is on the mac, so the arithmetic and the
//! tests read the same on both sides.

use std::collections::HashMap;

use chrono::{DateTime, TimeZone};

/// A reading taken further than this before its reset marks a long window.
const SHORT_WINDOW_MAX_SECS: f64 = 6.0 * 3600.0;
/// A reading whose reset sits further than this from the window's own is another cycle.
const SAME_CYCLE_TOLERANCE_SECS: f64 = 120.0;
const SHORT_WINDOW_LOOKBACK_SECS: f64 = 3600.0;
pub const LONG_WINDOW_LOOKBACK_SECS: f64 = 6.0 * 3600.0;
const MINIMUM_FORECAST_SPAN_SECS: f64 = 10.0 * 60.0;
const MINIMUM_FORECAST_RISE: f64 = 2.0;

/// One poll's reading of one window, `percent` in 0..=100.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Reading {
    pub percent: f64,
    pub resets_at: f64,
    pub observed_at: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Forecast {
    RunsOut(f64),
    LastsUntilReset,
}

/// When the window runs out at the pace of its recent readings. None when the readings are
/// too few, too close together or too flat to date it, and when the window is already full.
pub fn forecast(readings: &[Reading], resets_at: f64, now: f64) -> Option<Forecast> {
    let mut cycle: Vec<Reading> = readings
        .iter()
        .filter(|r| {
            (r.resets_at - resets_at).abs() <= SAME_CYCLE_TOLERANCE_SECS && r.observed_at <= now
        })
        .copied()
        .collect();
    cycle.sort_by(|a, b| a.observed_at.total_cmp(&b.observed_at));
    let is_long_window = cycle
        .iter()
        .any(|r| r.resets_at - r.observed_at > SHORT_WINDOW_MAX_SECS);
    if let Some(fall) = (1..cycle.len())
        .rev()
        .find(|&i| cycle[i].percent < cycle[i - 1].percent)
    {
        cycle.drain(..fall);
    }
    let lookback = if is_long_window {
        LONG_WINDOW_LOOKBACK_SECS
    } else {
        SHORT_WINDOW_LOOKBACK_SECS
    };
    cycle.retain(|r| r.observed_at >= now - lookback);
    let (first, last) = (cycle.first()?, cycle.last()?);
    if last.percent >= 100.0 {
        return None;
    }
    let elapsed = last.observed_at - first.observed_at;
    let rise = last.percent - first.percent;
    if cycle.len() < 2 || elapsed < MINIMUM_FORECAST_SPAN_SECS || rise < MINIMUM_FORECAST_RISE {
        return None;
    }
    let eta = last.observed_at + (100.0 - last.percent) * elapsed / rise;
    Some(if eta >= resets_at {
        Forecast::LastsUntilReset
    } else {
        Forecast::RunsOut(eta)
    })
}

/// The last six hours of readings per window, in memory only: the forecast never looks
/// further back.
#[derive(Default)]
pub struct Readings(HashMap<String, Vec<Reading>>);

impl Readings {
    pub fn record(&mut self, key: &str, reading: Reading, now: f64) {
        let list = self.0.entry(key.to_owned()).or_default();
        if list.last().map(|r| r.observed_at) == Some(reading.observed_at) {
            return;
        }
        list.push(reading);
        list.retain(|r| r.observed_at >= now - LONG_WINDOW_LOOKBACK_SECS);
    }

    pub fn forecast(&self, key: &str, resets_at: f64, now: f64) -> Option<Forecast> {
        forecast(self.0.get(key)?, resets_at, now)
    }
}

/// "15:40" when `at` falls today, "Tue 09:10" otherwise, in local time.
pub fn clock_label(at: f64, now: f64) -> String {
    clock_label_in(&chrono::Local, at, now)
}

fn clock_label_in<Tz: TimeZone>(tz: &Tz, at: f64, now: f64) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let local =
        |secs: f64| DateTime::from_timestamp(secs.floor() as i64, 0).map(|t| t.with_timezone(tz));
    let (Some(at), Some(now)) = (local(at), local(now)) else {
        return String::new();
    };
    let format = if at.date_naive() == now.date_naive() {
        "%H:%M"
    } else {
        "%a %H:%M"
    };
    at.format(format).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: f64 = 1_800_000_000.0;

    fn reading(percent: f64, minutes_ago: f64, resets_at: f64) -> Reading {
        Reading {
            percent,
            resets_at,
            observed_at: NOW - minutes_ago * 60.0,
        }
    }

    #[test]
    fn forecast_arithmetic_on_a_fixed_series() {
        let resets_at = NOW + 3.0 * 3600.0;
        let readings = [
            reading(40.0, 30.0, resets_at),
            reading(45.0, 20.0, resets_at),
            reading(50.0, 0.0, resets_at),
        ];
        // 10 points in 30 min: the remaining 50 take 150 min.
        assert_eq!(
            forecast(&readings, resets_at, NOW),
            Some(Forecast::RunsOut(NOW + 150.0 * 60.0))
        );
    }

    #[test]
    fn forecast_needs_two_points_of_rise() {
        let resets_at = NOW + 3.0 * 3600.0;
        let flat = [
            reading(40.0, 30.0, resets_at),
            reading(41.9, 0.0, resets_at),
        ];
        assert_eq!(forecast(&flat, resets_at, NOW), None);
        let rising = [
            reading(40.0, 30.0, resets_at),
            reading(42.0, 0.0, resets_at),
        ];
        assert!(forecast(&rising, resets_at, NOW).is_some());
    }

    #[test]
    fn forecast_needs_two_readings_ten_minutes_apart() {
        let resets_at = NOW + 3.0 * 3600.0;
        assert_eq!(
            forecast(&[reading(50.0, 0.0, resets_at)], resets_at, NOW),
            None
        );
        let close = [reading(40.0, 9.0, resets_at), reading(50.0, 0.0, resets_at)];
        assert_eq!(forecast(&close, resets_at, NOW), None);
    }

    #[test]
    fn forecast_looks_back_an_hour_on_short_windows() {
        let resets_at = NOW + 3.0 * 3600.0;
        // The 0% reading 90 min ago falls outside the hour; only the last 10 points in 30 min
        // count.
        let readings = [
            reading(0.0, 90.0, resets_at),
            reading(40.0, 30.0, resets_at),
            reading(50.0, 0.0, resets_at),
        ];
        assert_eq!(
            forecast(&readings, resets_at, NOW),
            Some(Forecast::RunsOut(NOW + 150.0 * 60.0))
        );
    }

    #[test]
    fn forecast_looks_back_six_hours_on_long_windows() {
        let resets_at = NOW + 2.0 * 86400.0;
        let readings = [
            reading(10.0, 7.0 * 60.0, resets_at),
            reading(40.0, 5.0 * 60.0, resets_at),
            reading(50.0, 0.0, resets_at),
        ];
        // 10 points in 5 h: the remaining 50 take 25 h, before the reset.
        assert_eq!(
            forecast(&readings, resets_at, NOW),
            Some(Forecast::RunsOut(NOW + 25.0 * 3600.0))
        );
    }

    #[test]
    fn forecast_drops_readings_before_the_last_fall() {
        let resets_at = NOW + 3.0 * 3600.0;
        let readings = [
            reading(80.0, 50.0, resets_at),
            reading(10.0, 40.0, resets_at),
            reading(20.0, 0.0, resets_at),
        ];
        // 10 points in 40 min from the fall: the remaining 80 take 320 min, after the reset.
        assert_eq!(
            forecast(&readings, resets_at, NOW),
            Some(Forecast::LastsUntilReset)
        );
    }

    #[test]
    fn forecast_keeps_only_the_same_cycle() {
        let resets_at = NOW + 3.0 * 3600.0;
        let readings = [
            reading(0.0, 40.0, resets_at - 5.0 * 3600.0),
            reading(40.0, 30.0, resets_at + 90.0),
            reading(50.0, 0.0, resets_at),
        ];
        // The 0% reading is the previous cycle; the 90 s reset jitter is not.
        assert_eq!(
            forecast(&readings, resets_at, NOW),
            Some(Forecast::RunsOut(NOW + 150.0 * 60.0))
        );
    }

    #[test]
    fn forecast_lasts_until_reset() {
        let resets_at = NOW + 3600.0;
        let readings = [
            reading(40.0, 30.0, resets_at),
            reading(50.0, 0.0, resets_at),
        ];
        assert_eq!(
            forecast(&readings, resets_at, NOW),
            Some(Forecast::LastsUntilReset)
        );
    }

    #[test]
    fn forecast_says_nothing_at_the_limit() {
        let resets_at = NOW + 3600.0;
        let readings = [
            reading(80.0, 30.0, resets_at),
            reading(100.0, 0.0, resets_at),
        ];
        assert_eq!(forecast(&readings, resets_at, NOW), None);
    }

    #[test]
    fn readings_keep_six_hours_and_skip_a_repeated_fetch() {
        let resets_at = NOW + 2.0 * 86400.0;
        let mut store = Readings::default();
        store.record(
            "Claude|Weekly",
            reading(10.0, 7.0 * 60.0, resets_at),
            NOW - 7.0 * 3600.0,
        );
        store.record("Claude|Weekly", reading(40.0, 5.0 * 60.0, resets_at), NOW);
        store.record("Claude|Weekly", reading(50.0, 0.0, resets_at), NOW);
        store.record("Claude|Weekly", reading(50.0, 0.0, resets_at), NOW);
        assert_eq!(store.0["Claude|Weekly"].len(), 2);
        assert_eq!(
            store.forecast("Claude|Weekly", resets_at, NOW),
            Some(Forecast::RunsOut(NOW + 25.0 * 3600.0))
        );
        assert_eq!(store.forecast("Codex|5-hour", resets_at, NOW), None);
    }

    #[test]
    fn clock_label_names_the_weekday_only_off_today() {
        // Noon UTC.
        let now = 1_800_000_000.0 - 1_800_000_000.0 % 86400.0 + 12.0 * 3600.0;
        let utc = chrono::Utc;
        assert_eq!(
            clock_label_in(&utc, now + 3.0 * 3600.0 + 40.0 * 60.0 + 59.0, now),
            "15:40"
        );
        let weekday = DateTime::from_timestamp(now as i64 + 2 * 86400, 0)
            .unwrap()
            .format("%a")
            .to_string();
        assert_eq!(
            clock_label_in(&utc, now + 2.0 * 86400.0 - 3.0 * 3600.0 + 10.0 * 60.0, now),
            format!("{weekday} 09:10")
        );
    }
}
