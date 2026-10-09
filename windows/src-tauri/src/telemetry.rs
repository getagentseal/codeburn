//! Anonymous, consent-gated product telemetry for the tray app and its Capacity Dock.
//!
//! The Windows twin of `app/electron/telemetry.ts`: same endpoint, same envelope, same
//! sanitizer, same day granularity, so events from the two apps land in one table and can be
//! read side by side. `app.name` is what tells them apart.
//!
//! Privacy invariants (enforced here, not by the caller):
//!
//! - Nothing is sent before a decision has been made, and nothing is sent while the toggle
//!   is off.
//! - The tray can be installed on its own or beside the desktop app. When the desktop app's
//!   own state file exists, its decision and its install id are used and this app never
//!   writes that file: one decision covers both, and the two apps' events join on one id.
//!   Standalone, the decision lives in this app's own settings file and defaults off for
//!   EU / EEA / UK / CH and for an unknown region, on elsewhere.
//! - The only identifier is a random id minted locally. Switching the toggle off mints a
//!   fresh one so past and future data cannot be linked.
//! - Events carry a day-granularity date only, and every prop goes through the whitelist
//!   sanitizer below: every leaf is a short string, a finite number or a boolean, and the
//!   nesting, key count, array length and leaf count are all capped. No paths, no session
//!   content, no exact amounts.
//! - Debug builds never send (`CODEBURN_TELEMETRY_DEV=1` overrides, for end-to-end testing).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const TELEMETRY_ENDPOINT: &str = "https://api.codeburn.app/v1/telemetry";
pub const TELEMETRY_SCHEMA: u64 = 1;
/// What separates these rows from the desktop app's (`codeburn-desktop`) in one table.
pub const APP_NAME: &str = "codeburn-menubar";

/// EU-27 + EEA (IS, LI, NO) + UK + CH, the same conservative "default off" region the
/// desktop app uses.
const DEFAULT_OFF_COUNTRIES: [&str; 32] = [
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT",
    "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO",
    "GB", "CH",
];

/// Every event this app may send. An unknown name is dropped rather than forwarded, so a
/// frontend typo cannot invent a metric.
const EVENT_NAMES: [&str; 12] = [
    "app_open",
    "app_close",
    "popover_open",
    "settings_open",
    "update_click",
    "glance_open",
    "dock_enabled",
    "dock_disabled",
    "dock_provider_switch",
    "dock_drag_end",
    "usage_snapshot",
    "update_result",
];

const MAX_QUEUE: usize = 200;
/// The queue is a file this app rewrites, so it is bounded by size as well as by count: two
/// hundred daily snapshots would be tens of megabytes on disk, and the oldest of them are
/// the least worth keeping. Whichever cap is reached first drops from the front.
const MAX_QUEUE_BYTES: usize = 512 * 1_024;
/// An event nobody could send for a week is history: the day it carries has long since been
/// aggregated, and holding it only crowds out what happened since. The cutoff is computed in
/// UTC while the Windows day key is local, so an event can outlive the mark by a few hours,
/// which is well inside what a day-granularity metric can tell apart.
const MAX_EVENT_AGE_DAYS: i64 = 7;
const MAX_STRING: usize = 64;
const MAX_ARRAY: usize = 12;
const MAX_KEYS: usize = 16;
/// How deep a container may sit below the props object. The daily usage snapshot is the
/// deepest shape either app sends: props -> models[] -> model -> tasks[] -> task. Anything
/// deeper is dropped whole.
const MAX_DEPTH: usize = 5;
/// Belt and braces on top of the per-level caps: one event can never encode more than this
/// many leaf values, whatever shape it arrives in.
const MAX_LEAVES: usize = 1_000;

/// How often the queue is offered to the endpoint while sends are landing. The same beat the
/// desktop app keeps.
pub const FLUSH_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// The ceiling the doubling stops at, so an endpoint that has been down all day is still
/// asked twice an hour rather than never again.
const BACKOFF_MAX: Duration = Duration::from_secs(30 * 60);
pub const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
/// Quit waits for the last batch, so it gets a timeout somebody would not notice.
const QUIT_TIMEOUT: Duration = Duration::from_millis(1_500);
/// How long a burst of events is allowed to settle before the queue file is rewritten. Long
/// enough that a drag or a window opening pays for one write rather than a dozen, short
/// enough that a crash in between loses at most the last second or two.
pub const SAVE_DEBOUNCE: Duration = Duration::from_secs(2);

// Settings keys ---------------------------------------------------------------------------

/// This app's own consent, in `windows-settings.json` beside every other preference. Only
/// read and written when the desktop app's state file is absent.
const KEY_ENABLED: &str = "telemetryEnabled";
const KEY_ONBOARDED_AT: &str = "telemetryOnboardedAt";
const KEY_INSTALL_ID: &str = "telemetryInstallId";

// Consent -----------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConsentSource {
    /// The desktop app decided, and this app is only reading its answer.
    Desktop,
    /// A standalone tray install, which decides for itself.
    App,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Consent {
    pub source: ConsentSource,
    pub install_id: String,
    pub enabled: bool,
    pub onboarded: bool,
}

impl Consent {
    fn can_track(&self) -> bool {
        self.enabled && self.onboarded
    }
}

/// What the settings pane renders. `source` decides whether the toggle is live or a readout
/// of somebody else's decision.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryStatus {
    pub enabled: bool,
    pub onboarded: bool,
    pub source: ConsentSource,
    pub country: Option<String>,
    pub default_enabled: bool,
}

/// The desktop app's `telemetry.v1.json`, of which only these three fields matter here.
/// Read-only, always: the desktop app owns that file and rewrites it whole.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopState {
    pub install_id: String,
    pub enabled: bool,
    pub onboarded: bool,
}

/// `%APPDATA%\codeburn-desktop\telemetry.v1.json`, which is Electron's `userData` for that
/// app plus the file name its Telemetry class writes.
pub fn desktop_state_path() -> Option<PathBuf> {
    Some(
        dirs::config_dir()?
            .join("codeburn-desktop")
            .join("telemetry.v1.json"),
    )
}

/// A version this build does not understand, a missing id or a missing toggle all mean "the
/// desktop app has not decided", which sends the resolution on to this app's own settings
/// rather than guessing on the desktop app's behalf.
pub fn parse_desktop_state(bytes: &[u8]) -> Option<DesktopState> {
    let raw: Value = serde_json::from_slice(bytes).ok()?;
    let object = raw.as_object()?;
    if object.get("version").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let install_id = object.get("installId").and_then(Value::as_str)?;
    if install_id.is_empty() {
        return None;
    }
    let enabled = object.get("enabled").and_then(Value::as_bool)?;
    Some(DesktopState {
        install_id: install_id.to_owned(),
        enabled,
        onboarded: object
            .get("onboardedAt")
            .and_then(Value::as_str)
            .is_some_and(|at| !at.is_empty()),
    })
}

fn read_desktop_state() -> Option<DesktopState> {
    parse_desktop_state(&fs::read(desktop_state_path()?).ok()?)
}

/// An unknown region is the conservative case and defaults off, exactly as the desktop does.
pub fn default_enabled_for(country: Option<&str>) -> bool {
    match country {
        None => false,
        Some(code) => {
            let upper = code.to_ascii_uppercase();
            !DEFAULT_OFF_COUNTRIES.contains(&upper.as_str())
        }
    }
}

/// The region subtag of a BCP-47 or POSIX locale name: `en-GB`, `sr-Latn-RS`,
/// `de_AT.UTF-8`. Only a two-letter alpha subtag is a region here, so the UN M.49 forms
/// (`es-419`) come back as unknown rather than as a country nobody can join on.
pub fn country_from_locale(locale: &str) -> Option<String> {
    let trimmed = locale.split('.').next().unwrap_or("");
    let mut parts = trimmed.split(['-', '_']);
    // The first subtag is the language, never the region.
    parts.next()?;
    parts
        .find(|part| part.len() == 2 && part.chars().all(|c| c.is_ascii_alphabetic()))
        .map(|part| part.to_ascii_uppercase())
}

/// The one decision every send is gated on. `desktop` present and valid wins outright, so a
/// tray running beside the desktop app never asks its own question.
pub fn resolve_consent(
    desktop: Option<DesktopState>,
    tray: &Map<String, Value>,
    country: Option<&str>,
) -> Consent {
    if let Some(state) = desktop {
        return Consent {
            source: ConsentSource::Desktop,
            install_id: state.install_id,
            enabled: state.enabled,
            onboarded: state.onboarded,
        };
    }
    Consent {
        source: ConsentSource::App,
        install_id: tray
            .get(KEY_INSTALL_ID)
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(new_install_id),
        enabled: tray
            .get(KEY_ENABLED)
            .and_then(Value::as_bool)
            .unwrap_or_else(|| default_enabled_for(country)),
        onboarded: tray
            .get(KEY_ONBOARDED_AT)
            .and_then(Value::as_str)
            .is_some_and(|at| !at.is_empty()),
    }
}

// Sanitizing ---------------------------------------------------------------------------------

/// One event's leaf allowance, spent as the walk goes and never refilled.
struct LeafBudget {
    left: usize,
}

fn sanitize_value(value: &Value, depth: usize, budget: &mut LeafBudget) -> Option<Value> {
    match value {
        Value::String(text) => {
            if budget.left == 0 {
                return None;
            }
            budget.left -= 1;
            Some(Value::String(truncate(text)))
        }
        Value::Number(number) => {
            if budget.left == 0 {
                return None;
            }
            if !number.as_f64().is_some_and(f64::is_finite) {
                return None;
            }
            budget.left -= 1;
            Some(value.clone())
        }
        Value::Bool(flag) => {
            if budget.left == 0 {
                return None;
            }
            budget.left -= 1;
            Some(Value::Bool(*flag))
        }
        // Only leaves are allowed at the bottom; a container here is dropped whole rather
        // than truncated to something that reads like a complete answer.
        _ if depth >= MAX_DEPTH => None,
        Value::Array(entries) => {
            let mut items: Vec<Value> = Vec::new();
            for entry in entries.iter().take(MAX_ARRAY) {
                if let Some(clean) = sanitize_value(entry, depth + 1, budget) {
                    items.push(clean);
                }
            }
            (!items.is_empty()).then_some(Value::Array(items))
        }
        Value::Object(fields) => {
            let flat = sanitize_object(fields, depth + 1, budget);
            (!flat.is_empty()).then_some(Value::Object(flat))
        }
        Value::Null => None,
    }
}

fn truncate(text: &str) -> String {
    text.chars().take(MAX_STRING).collect()
}

/// Note on the key cap: `serde_json`'s map is ordered by key here, where the desktop app's
/// object is in insertion order, so an object with more than `MAX_KEYS` keys can keep a
/// different sixteen in each app. Nothing this app sends is anywhere near the cap, and the
/// caps exist to bound a payload rather than to choose between keys.
fn sanitize_object(
    fields: &Map<String, Value>,
    depth: usize,
    budget: &mut LeafBudget,
) -> Map<String, Value> {
    let mut out = Map::new();
    let mut keys = 0;
    for (key, value) in fields {
        if keys >= MAX_KEYS {
            break;
        }
        if let Some(clean) = sanitize_value(value, depth, budget) {
            out.insert(truncate(key), clean);
            keys += 1;
        }
    }
    out
}

/// Whitelist sanitizer. Keeps short strings, finite numbers and booleans, plus plain objects
/// and arrays of them nested up to `MAX_DEPTH`, each level capped by `MAX_KEYS` / `MAX_ARRAY`
/// and the whole event by `MAX_LEAVES`. Everything else is dropped. Port of `sanitizeProps`
/// in the desktop app: deep enough for the daily usage snapshot's model by task cross and
/// nothing more.
pub fn sanitize_props(props: &Value) -> Map<String, Value> {
    let Some(object) = props.as_object() else {
        return Map::new();
    };
    sanitize_object(object, 1, &mut LeafBudget { left: MAX_LEAVES })
}

/// The daily aggregate out of the CLI's menubar payload, when there is one. A CLI older
/// than the field carries nothing, and a `null` means the CLI had nothing worth reporting;
/// both are the same answer here. The object itself is opaque: the CLI decides what belongs
/// in it, and the sanitizer decides what survives.
pub fn snapshot_from_payload(payload: &Value) -> Option<&Value> {
    payload.get("telemetrySnapshot").filter(|value| value.is_object())
}

// Buckets ------------------------------------------------------------------------------------

/// The dock's size as a band rather than the exact slider position, which would be close to
/// an identifier on its own.
pub fn scale_bucket(scale: f64) -> &'static str {
    if !scale.is_finite() {
        return "unknown";
    }
    let percent = scale * 100.0;
    if percent < 80.0 {
        "60-79"
    } else if percent < 100.0 {
        "80-99"
    } else {
        "100-120"
    }
}

// The queue ----------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueuedEvent {
    pub name: String,
    pub day: String,
    pub props: Map<String, Value>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistedQueue {
    #[serde(default)]
    events: Vec<QueuedEvent>,
    /// The last day a `usage_snapshot` was queued, which is what caps it at one per day
    /// across restarts as well as within one run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_snapshot_day: Option<String>,
}

/// The queue, and the file behind it. Every change marks it dirty rather than rewriting the
/// file on the spot: the write is debounced (see `SAVE_DEBOUNCE`) so a burst of events costs
/// one write, and quit and the flush beat both make sure a dirty queue reaches the disk.
#[derive(Debug)]
pub struct Queue {
    path: Option<PathBuf>,
    events: Vec<QueuedEvent>,
    /// The batch a flush is posting right now. It is out of `events`, so nothing queued in
    /// the meantime joins it, but it is still written to the file: a save or a quit while a
    /// POST is in flight used to overwrite the file with everything that batch was missing.
    in_flight: Vec<QueuedEvent>,
    /// Running total of `events` as serialized, which is what `MAX_QUEUE_BYTES` bounds.
    bytes: usize,
    last_snapshot_day: Option<String>,
    dirty: bool,
    /// Set when the queue is emptied while a batch is out. That batch was recorded under the
    /// id being retired, so it is dropped when it comes back rather than restored and later
    /// sent under the fresh one.
    abandon_in_flight: bool,
}

impl Queue {
    pub fn load(path: Option<PathBuf>) -> Self {
        Self::load_at(path, now_secs())
    }

    /// `now` is a parameter so the age cutoff can be exercised without moving the clock.
    fn load_at(path: Option<PathBuf>, now: i64) -> Self {
        let persisted = path
            .as_deref()
            .and_then(|path| fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice::<PersistedQueue>(&bytes).ok())
            .unwrap_or_default();
        let mut events = persisted.events;
        let cutoff = day_key_utc(now - MAX_EVENT_AGE_DAYS * 86_400);
        // Day keys are `YYYY-MM-DD`, so they sort as dates. Anything shorter is junk from a
        // hand-edited file and sorts below every real day, which drops it too.
        events.retain(|event| event.day.as_str() >= cutoff.as_str());
        let mut queue = Queue {
            path,
            bytes: events.iter().map(event_bytes).sum(),
            events,
            in_flight: Vec::new(),
            last_snapshot_day: persisted.last_snapshot_day,
            dirty: false,
            abandon_in_flight: false,
        };
        // A file from an older build, or one that has been hand-edited, must not put this
        // run over either cap.
        queue.trim();
        queue
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    /// At most one snapshot per calendar day. Answers once: a caller told `true` has already
    /// spent the day's slot, which is why this both asks and records.
    pub fn claim_snapshot_day(&mut self, day: &str) -> bool {
        if self.last_snapshot_day.as_deref() == Some(day) {
            return false;
        }
        self.last_snapshot_day = Some(day.to_owned());
        self.dirty = true;
        true
    }

    /// The oldest event gives way at either cap, so the queue always carries the most recent
    /// window rather than freezing at whatever filled it first.
    pub fn push(&mut self, event: QueuedEvent) {
        self.bytes += event_bytes(&event);
        self.events.push(event);
        self.trim();
        self.dirty = true;
    }

    /// Drops from the front until the queue is inside both caps. The newest event is always
    /// kept, even if it is oversized on its own: dropping it would lose the only thing the
    /// caller just asked to record.
    fn trim(&mut self) {
        while self.events.len() > MAX_QUEUE
            || (self.bytes > MAX_QUEUE_BYTES && self.events.len() > 1)
        {
            let dropped = self.events.remove(0);
            self.bytes = self.bytes.saturating_sub(event_bytes(&dropped));
        }
    }

    /// The batch to send. It leaves the queue here, stays in the file while it is in flight,
    /// and comes back through `restore` if the send failed in a way worth retrying.
    pub fn take(&mut self) -> Vec<QueuedEvent> {
        self.in_flight = std::mem::take(&mut self.events);
        self.bytes = 0;
        self.abandon_in_flight = false;
        self.in_flight.clone()
    }

    /// Puts a failed batch back in front of whatever was queued while it was in flight, and
    /// drops the oldest of the two if together they overflow. A batch the toggle retired
    /// while it was out is dropped instead.
    pub fn restore(&mut self, mut batch: Vec<QueuedEvent>) {
        self.in_flight = Vec::new();
        if self.abandon_in_flight {
            self.abandon_in_flight = false;
            self.dirty = true;
            return;
        }
        batch.append(&mut self.events);
        self.bytes = batch.iter().map(event_bytes).sum();
        self.events = batch;
        self.trim();
        self.dirty = true;
    }

    /// The batch was accepted (or refused outright): it is gone from the queue and from the
    /// file with it.
    pub fn settle(&mut self) {
        self.in_flight = Vec::new();
        self.abandon_in_flight = false;
        self.dirty = true;
    }

    pub fn clear(&mut self) {
        // Only a batch that is actually out is disowned: the flag has to be off again for the
        // next one, or a later retry would be dropped for no reason.
        self.abandon_in_flight = !self.in_flight.is_empty();
        self.events.clear();
        self.in_flight.clear();
        self.bytes = 0;
        self.dirty = true;
    }

    #[cfg(test)]
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// The debounced write. A clean queue is already on disk, so this is the call every
    /// timer, the flush beat and quit can make without costing anything.
    pub fn save_if_dirty(&mut self) {
        if self.dirty {
            self.save();
        }
    }

    pub fn save(&mut self) {
        self.dirty = false;
        let Some(path) = self.path.as_deref() else {
            return;
        };
        // The batch in flight is written in front of the queue, where it came from, so a
        // process that dies mid-POST retries it on the next launch.
        let mut events = self.in_flight.clone();
        events.extend(self.events.iter().cloned());
        if let Err(err) = write_atomic(
            path,
            &PersistedQueue {
                events,
                last_snapshot_day: self.last_snapshot_day.clone(),
            },
        ) {
            crate::log_line!("codeburn: failed to persist the telemetry queue: {err}");
        }
    }
}

fn event_bytes(event: &QueuedEvent) -> usize {
    serde_json::to_vec(event).map(|bytes| bytes.len()).unwrap_or(0)
}

fn write_atomic(path: &Path, queue: &PersistedQueue) -> std::io::Result<()> {
    use std::io::Write;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let serialized = serde_json::to_vec(queue)?;
    let tmp = path.with_extension("tmp");
    let mut file = create_private(&tmp)?;
    file.write_all(&serialized)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, path)
}

/// The queue holds an install id and a week of activity, so it is the owner's to read.
/// Windows inherits the ACL of `%LOCALAPPDATA%\codeburn-menubar`, which is already
/// user-only; Unix has to ask for the same thing.
#[cfg(unix)]
fn create_private(path: &Path) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn create_private(path: &Path) -> std::io::Result<fs::File> {
    fs::File::create(path)
}

fn queue_path() -> Option<PathBuf> {
    Some(
        dirs::data_local_dir()?
            .join("codeburn-menubar")
            .join("telemetry-queue.json"),
    )
}

// The envelope ---------------------------------------------------------------------------------

/// The exact shape the desktop app posts, field for field, so both apps land in one table.
pub fn envelope(
    install_id: &str,
    app_version: &str,
    country: Option<&str>,
    events: &[QueuedEvent],
) -> Value {
    serde_json::json!({
        "schema": TELEMETRY_SCHEMA,
        "installId": install_id,
        "app": {
            "name": APP_NAME,
            "version": app_version,
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "country": country,
        },
        "events": events,
    })
}

// Dates ------------------------------------------------------------------------------------------

/// `YYYY-MM-DD`, the desktop app's day key.
pub fn format_day(year: i64, month: u32, day: u32) -> String {
    format!("{year:04}-{month:02}-{day:02}")
}

/// Civil date from a Unix timestamp, by the usual days-from-epoch algorithm. Used for the
/// day key where the platform has no cheap local-time call, and by the tests, which need a
/// date that does not move with the machine's clock settings.
pub fn day_key_utc(unix_secs: i64) -> String {
    let days = unix_secs.div_euclid(86_400);
    // Shift the epoch to 0000-03-01 so leap days land at the end of the cycle.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    format_day(if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(target_os = "windows")]
fn today() -> String {
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;

    let mut time = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut time) };
    format_day(time.wYear as i64, time.wMonth as u32, time.wDay as u32)
}

/// Off Windows the day key is UTC. The desktop app's is local, so an install on both, in a
/// timezone far from UTC, can disagree about which day an event near midnight belongs to.
/// That is a day-granularity metric being off by a day at the boundary, which is the whole
/// cost of not carrying a timezone database here.
#[cfg(not(target_os = "windows"))]
fn today() -> String {
    day_key_utc(now_secs())
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

// The install id -----------------------------------------------------------------------------

/// A random v4 UUID, the same shape the desktop app's `randomUUID` produces.
pub fn new_install_id() -> String {
    let mut bytes = [0u8; 16];
    fill_random(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

#[cfg(target_os = "windows")]
fn fill_random(bytes: &mut [u8; 16]) {
    use windows_sys::Win32::Security::Cryptography::{
        BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
    };

    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        fill_random_fallback(bytes);
    }
}

#[cfg(not(target_os = "windows"))]
fn fill_random(bytes: &mut [u8; 16]) {
    if !fill_from_device(Path::new("/dev/urandom"), bytes) {
        fill_random_fallback(bytes);
    }
}

/// `/dev/urandom` is a character device: it never reaches an end, so reading the whole
/// "file" never returns. Take exactly the bytes wanted and stop.
///
/// Compiled on Windows as well, where nothing calls it outside the tests, so the reader the
/// Linux build depends on is exercised by the run that happens on this machine.
#[cfg(any(not(target_os = "windows"), test))]
fn fill_from_device(path: &Path, bytes: &mut [u8; 16]) -> bool {
    use std::io::Read;

    std::fs::File::open(path)
        .and_then(|mut device| device.read_exact(bytes))
        .is_ok()
}

/// Only reached when the OS refused to hand over randomness, which it does not do in
/// practice. An id that is merely hard to guess is still better than a fixed one, and the
/// alternative is having no id and so no telemetry at all.
fn fill_random_fallback(bytes: &mut [u8; 16]) {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let mut state = (nanos as u64) ^ (std::process::id() as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    for chunk in bytes.chunks_mut(8) {
        // SplitMix64, which is enough to spread one clock reading over sixteen bytes.
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        for (slot, byte) in chunk.iter_mut().zip(z.to_le_bytes()) {
            *slot = byte;
        }
    }
}

// Backoff ---------------------------------------------------------------------------------------

/// How long to wait before the next attempt after `failures` consecutive failed sends: the
/// flush beat, doubled per failure up to `BACKOFF_MAX`, spread by up to a quarter of itself.
/// A dead endpoint used to be re-POSTed on a fixed five-minute beat forever, by every install
/// at once.
///
/// `jitter` is a fraction in `0.0..1.0`, handed in so the schedule can be read back exactly.
pub fn backoff_delay(failures: u32, jitter: f64) -> Duration {
    if failures == 0 {
        return FLUSH_INTERVAL;
    }
    let doubled = FLUSH_INTERVAL
        .as_secs()
        .saturating_mul(1u64 << failures.saturating_sub(1).min(16));
    let base = doubled.min(BACKOFF_MAX.as_secs());
    let spread = (base as f64 * 0.25 * jitter.clamp(0.0, 1.0)) as u64;
    Duration::from_secs(base + spread)
}

/// A fraction in `0.0..1.0` from the clock. No cryptographic claim here: this only has to
/// stop a fleet of trays from coming back in lockstep.
fn jitter_fraction() -> f64 {
    let mut bytes = [0u8; 16];
    fill_random_fallback(&mut bytes);
    let sample = u64::from_le_bytes(bytes[0..8].try_into().unwrap_or_default());
    (sample >> 11) as f64 / (1u64 << 53) as f64
}

// The client ------------------------------------------------------------------------------------

pub struct Telemetry {
    inner: Mutex<Inner>,
    app_version: String,
    country: Option<String>,
    endpoint: String,
    /// False in a debug build without `CODEBURN_TELEMETRY_DEV=1`: the queue still fills, so
    /// the wiring can be exercised, but nothing leaves the machine.
    may_send: bool,
    opened_at: SystemTime,
    /// Consecutive failed sends, which is what the retry delay is computed from.
    failures: AtomicU32,
    /// One POST at a time. The beat and the quit flush can land together, and two takes
    /// would put one batch out of reach of the other's restore.
    flushing: AtomicBool,
    /// Set while a debounced save is already on its way, so a burst of events schedules one.
    save_scheduled: AtomicBool,
}

struct Inner {
    consent: Consent,
    queue: Queue,
}

impl Telemetry {
    /// Reads consent and whatever a previous run left queued. Mints and stores this app's
    /// own install id on a standalone install that has none yet, and never touches the
    /// desktop app's file.
    pub fn new(app_version: String) -> Self {
        let country = user_country();
        let consent = resolve_consent(
            read_desktop_state(),
            &crate::settings::read(),
            country.as_deref(),
        );
        if consent.source == ConsentSource::App {
            persist_install_id(&consent.install_id);
        }
        Telemetry {
            inner: Mutex::new(Inner {
                consent,
                queue: Queue::load(queue_path()),
            }),
            app_version,
            country,
            endpoint: TELEMETRY_ENDPOINT.to_owned(),
            may_send: !cfg!(debug_assertions)
                || std::env::var("CODEBURN_TELEMETRY_DEV").as_deref() == Ok("1"),
            opened_at: SystemTime::now(),
            failures: AtomicU32::new(0),
            flushing: AtomicBool::new(false),
            save_scheduled: AtomicBool::new(false),
        }
    }

    /// How long the flush beat waits before offering the queue again. Steady while sends are
    /// landing, and backing off once they are not.
    pub fn next_flush_delay(&self) -> Duration {
        backoff_delay(self.failures.load(Ordering::Relaxed), jitter_fraction())
    }

    pub fn status(&self) -> TelemetryStatus {
        let consent = self.reresolve();
        TelemetryStatus {
            enabled: consent.enabled,
            onboarded: consent.onboarded,
            source: consent.source,
            country: self.country.clone(),
            default_enabled: default_enabled_for(self.country.as_deref()),
        }
    }

    /// Re-reads the desktop app's file, because it can appear or change while this app runs:
    /// the desktop app can be installed after the tray, and its consent screen is answered
    /// in a different process.
    fn reresolve(&self) -> Consent {
        let stored = crate::settings::read();
        let mut fresh = resolve_consent(read_desktop_state(), &stored, self.country.as_deref());
        let Ok(mut inner) = self.inner.lock() else {
            return fresh;
        };
        // A settings file that could not be written leaves this app's id unstored, and
        // resolving mints a fresh one every time it is asked. Keep the one this run already
        // has instead, so a failed write does not scatter a session over several ids.
        if fresh.source == ConsentSource::App
            && inner.consent.source == ConsentSource::App
            && !stored.contains_key(KEY_INSTALL_ID)
        {
            fresh.install_id = inner.consent.install_id.clone();
        }
        inner.consent = fresh.clone();
        fresh
    }

    /// The settings toggle. Off mints a fresh install id and empties the queue, so nothing
    /// already recorded is sent and nothing later can be tied to what came before. Refused
    /// while the desktop app is the source: its file is that app's to write.
    pub fn set_enabled(&self, enabled: bool) -> TelemetryStatus {
        let consent = self.reresolve();
        if consent.source == ConsentSource::Desktop {
            return self.status();
        }
        let mut patch = Map::new();
        patch.insert(KEY_ENABLED.into(), Value::Bool(enabled));
        if !enabled {
            patch.insert(KEY_INSTALL_ID.into(), Value::String(new_install_id()));
            if let Ok(mut inner) = self.inner.lock() {
                inner.queue.clear();
                inner.queue.save();
            }
        }
        self.patch_settings(patch);
        self.status()
    }

    /// The one-time consent notice's answer. Records that the question was asked, whichever
    /// way it was answered, which is what unlocks sending.
    pub fn complete_consent(&self, enabled: bool) -> TelemetryStatus {
        let consent = self.reresolve();
        if consent.source == ConsentSource::Desktop {
            return self.status();
        }
        let mut patch = Map::new();
        patch.insert(KEY_ENABLED.into(), Value::Bool(enabled));
        patch.insert(KEY_ONBOARDED_AT.into(), Value::String(iso_now()));
        if !enabled {
            patch.insert(KEY_INSTALL_ID.into(), Value::String(new_install_id()));
        }
        self.patch_settings(patch);
        let status = self.status();
        if status.enabled {
            self.track("app_open", &Value::Null);
        }
        status
    }

    fn patch_settings(&self, patch: Map<String, Value>) {
        if let Err(err) = crate::settings::patch(patch) {
            crate::log_line!("codeburn: failed to store the telemetry decision: {err}");
        }
    }

    /// Queues one event. An unknown name, junk props or a missing decision are all dropped
    /// here rather than reaching the wire.
    pub fn track(&self, name: &str, props: &Value) {
        self.track_on(name, props, &today());
    }

    fn track_on(&self, name: &str, props: &Value, day: &str) {
        if !EVENT_NAMES.contains(&name) {
            return;
        }
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if !inner.consent.can_track() {
            return;
        }
        // The desktop app sends the snapshot from its own process when it is the one that
        // decided; two apps sending the same aggregate under one install id would double
        // every figure in it.
        if name == "usage_snapshot" {
            if inner.consent.source == ConsentSource::Desktop {
                return;
            }
            if !inner.queue.claim_snapshot_day(day) {
                return;
            }
        }
        inner.queue.push(QueuedEvent {
            name: name.to_owned(),
            day: day.to_owned(),
            props: sanitize_props(props),
        });
        drop(inner);
        self.schedule_save();
    }

    /// A save rewrites the whole file, so an event marks the queue dirty and the write is
    /// left to the timer below, to the flush beat or to quit. One timer at a time: a burst
    /// of events extends nothing and costs one write.
    fn schedule_save(&self) {
        // Only the process-wide instance has a timer to hang this on. A `Telemetry` built
        // for a test writes when its owner asks it to.
        if instance().is_none() || self.save_scheduled.swap(true, Ordering::SeqCst) {
            return;
        }
        tauri::async_runtime::spawn(async {
            tokio::time::sleep(SAVE_DEBOUNCE).await;
            if let Some(telemetry) = instance() {
                telemetry.save_scheduled.store(false, Ordering::SeqCst);
                telemetry.save_if_dirty();
            }
        });
    }

    /// Writes the queue if anything has changed since the last write. Cheap enough for the
    /// flush beat and for quit to call unconditionally.
    pub fn save_if_dirty(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.queue.save_if_dirty();
        }
    }

    /// Session length, in whole minutes, for the last flush before the process goes.
    pub fn track_close(&self) {
        let minutes = self
            .opened_at
            .elapsed()
            .map(|elapsed| (elapsed.as_secs_f64() / 60.0).round())
            .unwrap_or_default();
        self.track("app_close", &serde_json::json!({ "sessionMinutes": minutes }));
    }

    /// Best-effort batch POST. A 4xx drops the batch, because retrying a payload the server
    /// has already refused would wedge the queue at its cap; a 5xx or a dead network keeps
    /// it for the next beat.
    pub async fn flush(&self, timeout: Duration) -> bool {
        if !self.may_send {
            return false;
        }
        // Also where a decision made elsewhere is picked up: the desktop app can be
        // installed, or answer its consent screen, while this app is already running.
        self.reresolve();
        // The beat and the quit flush can arrive together, and a second take would put the
        // first batch out of reach of its own restore. One at a time.
        if self.flushing.swap(true, Ordering::SeqCst) {
            return false;
        }
        let sent = self.flush_batch(timeout).await;
        self.flushing.store(false, Ordering::SeqCst);
        sent
    }

    async fn flush_batch(&self, timeout: Duration) -> bool {
        let (install_id, batch) = {
            let Ok(mut inner) = self.inner.lock() else {
                return false;
            };
            if !inner.consent.can_track() || inner.queue.is_empty() {
                return false;
            }
            (inner.consent.install_id.clone(), inner.queue.take())
        };
        let body = envelope(
            &install_id,
            &self.app_version,
            self.country.as_deref(),
            &batch,
        );
        let outcome = post(&self.endpoint, &body, timeout).await;
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        match outcome {
            Outcome::Sent => {
                inner.queue.settle();
                inner.queue.save();
                self.failures.store(0, Ordering::Relaxed);
                true
            }
            Outcome::Rejected => {
                crate::log_line!(
                    "codeburn: the telemetry endpoint refused a batch of {} events; dropping it",
                    batch.len()
                );
                inner.queue.settle();
                inner.queue.save();
                // The endpoint answered, so it is up: only the payload was refused, and the
                // next batch is a different payload. Nothing to back off from.
                self.failures.store(0, Ordering::Relaxed);
                false
            }
            Outcome::Retry => {
                inner.queue.restore(batch);
                inner.queue.save();
                self.failures.fetch_add(1, Ordering::Relaxed);
                false
            }
        }
    }

    /// Visible for tests.
    #[cfg(test)]
    pub fn queue_len(&self) -> usize {
        self.inner.lock().map(|inner| inner.queue.len()).unwrap_or(0)
    }
}

enum Outcome {
    Sent,
    /// A 4xx: this batch will never be accepted.
    Rejected,
    /// A 5xx, a timeout or no network: worth another beat.
    Retry,
}

/// One client for the life of the process: building one per POST threw away the connection
/// pool and the TLS session with it, so every five-minute beat paid for a fresh handshake.
/// The timeout is per request instead, because quit asks for a shorter one.
static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();

fn client() -> Option<&'static reqwest::Client> {
    // Plain HTTP is refused outright, redirect included, as everywhere else this app talks
    // to the network: see fx.rs and update.rs.
    CLIENT
        .get_or_init(|| reqwest::Client::builder().https_only(true).build().ok())
        .as_ref()
}

async fn post(endpoint: &str, body: &Value, timeout: Duration) -> Outcome {
    let Some(client) = client() else {
        return Outcome::Retry;
    };
    match client.post(endpoint).timeout(timeout).json(body).send().await {
        Ok(response) => {
            let status = response.status();
            if status.is_success() {
                Outcome::Sent
            } else if status.is_client_error() {
                Outcome::Rejected
            } else {
                Outcome::Retry
            }
        }
        Err(_) => Outcome::Retry,
    }
}

fn iso_now() -> String {
    let secs = now_secs();
    let seconds_of_day = secs.rem_euclid(86_400);
    format!(
        "{}T{:02}:{:02}:{:02}Z",
        day_key_utc(secs),
        seconds_of_day / 3_600,
        (seconds_of_day % 3_600) / 60,
        seconds_of_day % 60
    )
}

fn persist_install_id(install_id: &str) {
    let stored = crate::settings::read();
    if stored.get(KEY_INSTALL_ID).and_then(Value::as_str) == Some(install_id) {
        return;
    }
    let mut patch = Map::new();
    patch.insert(KEY_INSTALL_ID.into(), Value::String(install_id.to_owned()));
    if let Err(err) = crate::settings::patch(patch) {
        crate::log_line!("codeburn: failed to store the telemetry install id: {err}");
    }
}

#[cfg(target_os = "windows")]
fn user_country() -> Option<String> {
    use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;

    // LOCALE_NAME_MAX_LENGTH.
    let mut buffer = [0u16; 85];
    let written = unsafe { GetUserDefaultLocaleName(buffer.as_mut_ptr(), buffer.len() as i32) };
    if written <= 0 {
        return None;
    }
    // The count includes the terminating null.
    let name = String::from_utf16_lossy(&buffer[..(written as usize - 1)]);
    country_from_locale(&name)
}

#[cfg(not(target_os = "windows"))]
fn user_country() -> Option<String> {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|key| std::env::var(key).ok())
        .filter(|locale| !locale.is_empty())
        .as_deref()
        .and_then(country_from_locale)
}

// The process-wide instance -----------------------------------------------------------------

static INSTANCE: OnceLock<Telemetry> = OnceLock::new();

/// Called once from `setup`. Every later call is a no-op, so a second one cannot reset the
/// session clock or lose a queue.
pub fn init(app_version: String) -> &'static Telemetry {
    INSTANCE.get_or_init(|| Telemetry::new(app_version))
}

pub fn instance() -> Option<&'static Telemetry> {
    INSTANCE.get()
}

/// The call every surface uses. Silent before `init`, which is what a tray icon built before
/// setup finishes would otherwise trip over.
pub fn track(name: &str, props: Value) {
    if let Some(telemetry) = instance() {
        telemetry.track(name, &props);
    }
}

/// Writes the queue if the debounce timer has not got to it yet. The flush beat calls this
/// before every send, so a dirty queue reaches the disk within the beat even if the process
/// dies before the next event.
pub fn save_pending() {
    if let Some(telemetry) = instance() {
        telemetry.save_if_dirty();
    }
}

/// The last flush, on the way out. Bounded so quitting never waits on a slow network.
///
/// The order matters. `app_close` is recorded, then everything on hand is written, and only
/// then is the batch offered: a POST that is still in flight when the process goes is on
/// disk either way, where the next launch picks it up.
pub fn flush_on_quit() {
    let Some(telemetry) = instance() else {
        return;
    };
    telemetry.track_close();
    telemetry.save_if_dirty();
    tauri::async_runtime::block_on(async {
        telemetry.flush(QUIT_TIMEOUT).await;
    });
    telemetry.save_if_dirty();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tray(pairs: &[(&str, Value)]) -> Map<String, Value> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect()
    }

    fn temp_queue(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join("codeburn-telemetry-tests")
            .join(name)
    }

    /// The day every queue fixture is written for, and a clock reading on that day, so the
    /// age cutoff is measured against the fixture rather than against the machine's date.
    const FIXTURE_DAY: &str = "2026-09-03";
    const FIXTURE_NOW: i64 = 1_788_393_600;

    // Consent -----------------------------------------------------------------------------

    #[test]
    fn the_desktop_apps_decision_wins_and_carries_its_install_id() {
        let desktop = parse_desktop_state(
            br#"{"version":1,"installId":"desk-1","enabled":true,"onboardedAt":"2026-01-01T00:00:00Z"}"#,
        );
        let consent = resolve_consent(
            desktop,
            &tray(&[
                (KEY_ENABLED, Value::Bool(false)),
                (KEY_INSTALL_ID, Value::String("tray-1".into())),
            ]),
            Some("US"),
        );
        assert_eq!(consent.source, ConsentSource::Desktop);
        assert_eq!(consent.install_id, "desk-1");
        assert!(consent.enabled);
        assert!(consent.onboarded);
    }

    #[test]
    fn a_desktop_file_without_a_decision_is_not_a_decision() {
        let desktop = parse_desktop_state(br#"{"version":1,"installId":"desk-1","enabled":true}"#);
        let consent = resolve_consent(desktop, &Map::new(), Some("US"));
        assert_eq!(consent.source, ConsentSource::Desktop);
        assert!(!consent.onboarded);
    }

    #[test]
    fn an_unreadable_or_future_desktop_file_falls_through_to_this_app() {
        assert_eq!(parse_desktop_state(b"not json"), None);
        assert_eq!(
            parse_desktop_state(br#"{"version":2,"installId":"desk-1","enabled":true}"#),
            None
        );
        assert_eq!(parse_desktop_state(br#"{"version":1,"enabled":true}"#), None);
        assert_eq!(
            parse_desktop_state(br#"{"version":1,"installId":"","enabled":true}"#),
            None
        );
    }

    #[test]
    fn a_standalone_install_uses_its_own_stored_decision() {
        let consent = resolve_consent(
            None,
            &tray(&[
                (KEY_ENABLED, Value::Bool(true)),
                (KEY_ONBOARDED_AT, Value::String("2026-01-01T00:00:00Z".into())),
                (KEY_INSTALL_ID, Value::String("tray-1".into())),
            ]),
            Some("DE"),
        );
        assert_eq!(consent.source, ConsentSource::App);
        assert_eq!(consent.install_id, "tray-1");
        assert!(consent.enabled);
        assert!(consent.onboarded);
    }

    #[test]
    fn a_standalone_install_with_no_stored_decision_takes_the_region_default() {
        let eu = resolve_consent(None, &Map::new(), Some("FR"));
        assert_eq!(eu.source, ConsentSource::App);
        assert!(!eu.enabled);
        assert!(!eu.onboarded);

        let elsewhere = resolve_consent(None, &Map::new(), Some("US"));
        assert!(elsewhere.enabled);
        assert!(!elsewhere.onboarded);
    }

    #[test]
    fn an_unknown_region_defaults_off() {
        assert!(!default_enabled_for(None));
        assert!(!default_enabled_for(Some("gb")));
        assert!(!default_enabled_for(Some("CH")));
        assert!(default_enabled_for(Some("us")));
        assert!(default_enabled_for(Some("JP")));
    }

    #[test]
    fn a_fresh_standalone_install_is_given_an_id_of_its_own() {
        let first = resolve_consent(None, &Map::new(), Some("US")).install_id;
        let second = resolve_consent(None, &Map::new(), Some("US")).install_id;
        assert_eq!(first.len(), 36);
        assert_ne!(first, second);
    }

    #[test]
    fn the_region_comes_from_the_locales_region_subtag() {
        assert_eq!(country_from_locale("en-GB"), Some("GB".into()));
        assert_eq!(country_from_locale("de_AT.UTF-8"), Some("AT".into()));
        assert_eq!(country_from_locale("sr-Latn-RS"), Some("RS".into()));
        assert_eq!(country_from_locale("en"), None);
        assert_eq!(country_from_locale("es-419"), None);
        assert_eq!(country_from_locale(""), None);
    }

    #[test]
    fn consent_needs_both_a_decision_and_a_toggle_that_is_on() {
        let onboarded_off = Consent {
            source: ConsentSource::App,
            install_id: "id".into(),
            enabled: false,
            onboarded: true,
        };
        let undecided_on = Consent {
            source: ConsentSource::App,
            install_id: "id".into(),
            enabled: true,
            onboarded: false,
        };
        assert!(!onboarded_off.can_track());
        assert!(!undecided_on.can_track());
    }

    // The queue ---------------------------------------------------------------------------

    fn event(name: &str) -> QueuedEvent {
        on_day(name, FIXTURE_DAY)
    }

    fn on_day(name: &str, day: &str) -> QueuedEvent {
        QueuedEvent {
            name: name.to_owned(),
            day: day.to_owned(),
            props: Map::new(),
        }
    }

    /// An event at the sanitizer's ceiling: a thousand leaves of sixty-four characters, which
    /// is the largest thing `track` can put in the queue.
    fn fat_event() -> QueuedEvent {
        let mut props = Map::new();
        for key in 0..MAX_LEAVES {
            props.insert(format!("k{key:04}"), Value::String("x".repeat(MAX_STRING)));
        }
        QueuedEvent {
            name: "usage_snapshot".into(),
            day: FIXTURE_DAY.into(),
            props,
        }
    }

    #[test]
    fn the_queue_is_capped_and_keeps_the_most_recent_events() {
        let mut queue = Queue::load(None);
        for index in 0..(MAX_QUEUE + 10) {
            queue.push(on_day(&format!("popover_open{index}"), FIXTURE_DAY));
        }
        assert_eq!(queue.len(), MAX_QUEUE);
        assert_eq!(queue.events[0].name, "popover_open10");
        assert_eq!(
            queue.events[MAX_QUEUE - 1].name,
            format!("popover_open{}", MAX_QUEUE + 9)
        );
    }

    #[test]
    fn a_restored_batch_goes_back_in_front_and_still_respects_the_cap() {
        let mut queue = Queue::load(None);
        queue.push(event("app_open"));
        let batch = queue.take();
        assert!(queue.is_empty());
        queue.push(event("popover_open"));
        queue.restore(batch);
        assert_eq!(queue.len(), 2);
        assert_eq!(queue.events[0].name, "app_open");
        assert_eq!(queue.events[1].name, "popover_open");

        // A batch that comes back to a queue which filled while it was in flight is the
        // older of the two, so it is the one that gives way at the cap.
        let mut full = Queue::load(None);
        for _ in 0..MAX_QUEUE {
            full.push(event("popover_open"));
        }
        full.restore(vec![event("app_open"), event("app_open")]);
        assert_eq!(full.len(), MAX_QUEUE);
        assert_eq!(full.events[0].name, "popover_open");
    }

    #[test]
    fn the_queue_survives_a_restart() {
        let path = temp_queue("queue-roundtrip.json");
        let _ = fs::remove_file(&path);
        let mut queue = Queue::load_at(Some(path.clone()), FIXTURE_NOW);
        queue.push(event("app_open"));
        assert!(queue.claim_snapshot_day(FIXTURE_DAY));
        queue.save();

        let reloaded = Queue::load_at(Some(path.clone()), FIXTURE_NOW);
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded.events[0].name, "app_open");
        assert_eq!(reloaded.last_snapshot_day.as_deref(), Some(FIXTURE_DAY));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn an_oversized_file_from_an_older_build_is_trimmed_on_load() {
        let path = temp_queue("queue-oversized.json");
        let _ = fs::remove_file(&path);
        let events: Vec<QueuedEvent> = (0..(MAX_QUEUE + 5))
            .map(|index| on_day(&format!("popover_open{index}"), FIXTURE_DAY))
            .collect();
        write_atomic(
            &path,
            &PersistedQueue {
                events,
                last_snapshot_day: None,
            },
        )
        .unwrap();

        let queue = Queue::load_at(Some(path.clone()), FIXTURE_NOW);
        assert_eq!(queue.len(), MAX_QUEUE);
        assert_eq!(queue.events[0].name, "popover_open5");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn the_queue_is_bounded_by_bytes_as_well_as_by_count() {
        let fat = fat_event();
        let each = event_bytes(&fat);
        assert!(each > 0 && each * 10 > MAX_QUEUE_BYTES, "the fixture has to reach the cap");

        let mut queue = Queue::load(None);
        for _ in 0..10 {
            queue.push(fat.clone());
        }
        assert!(queue.len() < 10, "the byte cap bites long before the count cap");
        assert!(queue.bytes <= MAX_QUEUE_BYTES);

        // One event larger than the whole cap is still kept: dropping it would lose the very
        // thing the caller just recorded, and the next push will drop it in turn.
        let mut huge = fat_event();
        for key in 0..40_000 {
            huge.props
                .insert(format!("k{key:05}"), Value::String("x".repeat(MAX_STRING)));
        }
        assert!(event_bytes(&huge) > MAX_QUEUE_BYTES);
        let mut lone = Queue::load(None);
        lone.push(huge);
        assert_eq!(lone.len(), 1);
        lone.push(event("app_open"));
        assert_eq!(lone.len(), 1);
        assert_eq!(lone.events[0].name, "app_open");
    }

    #[test]
    fn a_file_left_over_the_byte_cap_is_trimmed_on_load() {
        let path = temp_queue("queue-oversized-bytes.json");
        let _ = fs::remove_file(&path);
        write_atomic(
            &path,
            &PersistedQueue {
                events: (0..10).map(|_| fat_event()).collect(),
                last_snapshot_day: None,
            },
        )
        .unwrap();

        let queue = Queue::load_at(Some(path.clone()), FIXTURE_NOW);
        assert!(queue.len() < 10);
        assert!(queue.bytes <= MAX_QUEUE_BYTES);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn events_older_than_a_week_are_dropped_on_load() {
        let a_week_on = FIXTURE_NOW + MAX_EVENT_AGE_DAYS * 86_400;
        assert_eq!(day_key_utc(a_week_on), "2026-09-10");

        let path = temp_queue("queue-stale.json");
        let _ = fs::remove_file(&path);
        write_atomic(
            &path,
            &PersistedQueue {
                events: vec![
                    on_day("app_open", "2026-08-20"),
                    on_day("popover_open", "2026-09-02"),
                    // The cutoff day itself is inside the week and stays.
                    on_day("settings_open", FIXTURE_DAY),
                    on_day("glance_open", "2026-09-10"),
                    // Junk from a hand-edited file sorts below every real day and goes.
                    on_day("update_click", ""),
                ],
                last_snapshot_day: None,
            },
        )
        .unwrap();

        let queue = Queue::load_at(Some(path.clone()), a_week_on);
        assert_eq!(queue.len(), 2);
        assert_eq!(queue.events[0].name, "settings_open");
        assert_eq!(queue.events[1].name, "glance_open");
        // Nothing has changed since the read, so a load does not schedule a write of its own.
        assert!(!queue.is_dirty());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_batch_in_flight_stays_in_the_file_until_it_lands() {
        let path = temp_queue("queue-in-flight.json");
        let _ = fs::remove_file(&path);
        let mut queue = Queue::load_at(Some(path.clone()), FIXTURE_NOW);
        queue.push(event("popover_open"));
        queue.save();

        // The beat takes the batch, and quit records app_close and writes while the POST is
        // still out. The write used to be the whole file, batch and all, gone.
        let batch = queue.take();
        assert_eq!(batch.len(), 1);
        assert!(queue.is_empty());
        queue.push(event("app_close"));
        queue.save();
        let reloaded = Queue::load_at(Some(path.clone()), FIXTURE_NOW);
        assert_eq!(reloaded.len(), 2);
        assert_eq!(reloaded.events[0].name, "popover_open");
        assert_eq!(reloaded.events[1].name, "app_close");

        // The send lands: the batch leaves the file, what came after it stays.
        queue.settle();
        queue.save();
        let after = Queue::load_at(Some(path.clone()), FIXTURE_NOW);
        assert_eq!(after.len(), 1);
        assert_eq!(after.events[0].name, "app_close");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_batch_out_when_the_toggle_went_off_is_dropped_rather_than_requeued() {
        let mut queue = Queue::load(None);
        queue.push(event("popover_open"));
        let batch = queue.take();
        // The settings toggle goes off while the POST is out: the id it was recorded under is
        // being retired, so the batch must not come back under the new one.
        queue.clear();
        queue.restore(batch);
        assert!(queue.is_empty());
        assert!(queue.in_flight.is_empty());

        // The next batch is not affected by the one before it.
        queue.push(event("app_open"));
        let next = queue.take();
        queue.restore(next);
        assert_eq!(queue.len(), 1);

        // Nor is a batch taken after a clear that had nothing in flight to disown.
        queue.clear();
        queue.push(event("popover_open"));
        let later = queue.take();
        queue.restore(later);
        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn a_save_only_writes_when_something_changed() {
        let path = temp_queue("queue-dirty.json");
        let _ = fs::remove_file(&path);
        let mut queue = Queue::load_at(Some(path.clone()), FIXTURE_NOW);
        assert!(!queue.is_dirty());
        queue.save_if_dirty();
        assert!(!path.exists(), "a clean queue is already on disk");

        queue.push(event("app_open"));
        assert!(queue.is_dirty());
        queue.save_if_dirty();
        assert!(!queue.is_dirty());
        assert_eq!(Queue::load_at(Some(path.clone()), FIXTURE_NOW).len(), 1);

        // A second save with nothing in between must not touch the file at all.
        fs::remove_file(&path).unwrap();
        queue.save_if_dirty();
        assert!(!path.exists());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_missing_or_corrupt_queue_file_starts_empty_rather_than_failing() {
        let path = temp_queue("queue-corrupt.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{not json").unwrap();
        assert!(Queue::load(Some(path.clone())).is_empty());
        let _ = fs::remove_file(&path);
        assert!(Queue::load(Some(path)).is_empty());
    }

    #[test]
    fn the_snapshot_day_can_only_be_claimed_once() {
        let mut queue = Queue::load(None);
        assert!(queue.claim_snapshot_day("2026-09-03"));
        assert!(!queue.claim_snapshot_day("2026-09-03"));
        assert!(queue.claim_snapshot_day("2026-09-04"));
        assert!(!queue.claim_snapshot_day("2026-09-04"));
    }

    // Sanitizing ---------------------------------------------------------------------------

    #[test]
    fn leaves_are_short_strings_finite_numbers_and_booleans() {
        let props = serde_json::json!({
            "edge": "left",
            "scale": 0.8,
            "pinned": true,
            "long": "x".repeat(200),
            "nothing": null,
        });
        let clean = sanitize_props(&props);
        assert_eq!(clean.get("edge").unwrap(), "left");
        assert_eq!(clean.get("scale").unwrap(), 0.8);
        assert_eq!(clean.get("pinned").unwrap(), true);
        assert_eq!(clean.get("long").unwrap().as_str().unwrap().len(), MAX_STRING);
        assert!(clean.get("nothing").is_none());
    }

    #[test]
    fn the_snapshots_shape_survives_the_walk() {
        // props -> models[] -> model -> tasks[] -> task is the deepest thing either app
        // sends, and it has to come through whole.
        let props = serde_json::json!({
            "costBucket": "1-10",
            "models": [{ "name": "sonnet", "tasks": [{ "category": "code", "turnsBucket": "10-50" }] }],
            "sessions": { "countBucket": "5-20" },
        });
        let clean = sanitize_props(&props);
        assert_eq!(clean["sessions"]["countBucket"], "5-20");
        assert_eq!(clean["models"][0]["tasks"][0]["turnsBucket"], "10-50");
    }

    #[test]
    fn a_container_past_the_depth_cap_is_dropped_whole() {
        // One level deeper than the snapshot: the task's own object has nowhere to go.
        let props = serde_json::json!({
            "models": [{ "tasks": [{ "deeper": { "no": 1 }, "kept": "yes" }] }],
        });
        let clean = sanitize_props(&props);
        let task = &clean["models"][0]["tasks"][0];
        assert_eq!(task["kept"], "yes");
        assert!(task.get("deeper").is_none());
    }

    #[test]
    fn arrays_are_capped_and_an_empty_container_is_dropped_rather_than_sent() {
        let props = serde_json::json!({
            "rows": (0..20).map(|index| serde_json::json!({ "id": index })).collect::<Vec<_>>(),
            "nulls": [null, null],
            "empty": {},
        });
        let clean = sanitize_props(&props);
        assert_eq!(clean["rows"].as_array().unwrap().len(), MAX_ARRAY);
        assert!(clean.get("nulls").is_none());
        assert!(clean.get("empty").is_none());
    }

    #[test]
    fn one_event_can_never_encode_more_leaves_than_the_budget() {
        let rows: Vec<Value> = (0..MAX_ARRAY)
            .map(|_| {
                let mut row = Map::new();
                for key in 0..MAX_KEYS {
                    row.insert(format!("k{key:02}"), Value::from(1));
                }
                Value::Object(row)
            })
            .collect();
        let mut props = Map::new();
        // Sixteen keys of twelve rows of sixteen leaves is 3072, well past the budget.
        for key in 0..MAX_KEYS {
            props.insert(format!("g{key:02}"), Value::Array(rows.clone()));
        }
        let clean = sanitize_props(&Value::Object(props));
        let leaves: usize = clean
            .values()
            .map(|group| {
                group
                    .as_array()
                    .map(|rows| rows.iter().map(|row| row.as_object().map_or(0, Map::len)).sum())
                    .unwrap_or(0)
            })
            .sum();
        assert_eq!(leaves, MAX_LEAVES);
    }

    #[test]
    fn props_that_are_not_an_object_sanitize_to_nothing() {
        assert!(sanitize_props(&Value::Null).is_empty());
        assert!(sanitize_props(&serde_json::json!([1, 2])).is_empty());
        assert!(sanitize_props(&Value::String("nope".into())).is_empty());
    }

    // The envelope --------------------------------------------------------------------------

    #[test]
    fn the_envelope_matches_the_desktop_apps_field_for_field() {
        let events = vec![QueuedEvent {
            name: "popover_open".into(),
            day: "2026-09-03".into(),
            props: sanitize_props(&serde_json::json!({ "pane": "general" })),
        }];
        let body = envelope("install-1", "0.9.23", Some("GB"), &events);
        assert_eq!(body["schema"], 1);
        assert_eq!(body["installId"], "install-1");
        assert_eq!(body["app"]["name"], "codeburn-menubar");
        assert_eq!(body["app"]["version"], "0.9.23");
        assert_eq!(body["app"]["platform"], std::env::consts::OS);
        assert_eq!(body["app"]["arch"], std::env::consts::ARCH);
        assert_eq!(body["app"]["country"], "GB");
        assert_eq!(body["events"][0]["name"], "popover_open");
        assert_eq!(body["events"][0]["day"], "2026-09-03");
        assert_eq!(body["events"][0]["props"]["pane"], "general");
        // Nothing beyond those five keys, and nothing beyond those three per event.
        assert_eq!(body.as_object().unwrap().len(), 4);
        assert_eq!(body["app"].as_object().unwrap().len(), 5);
        assert_eq!(body["events"][0].as_object().unwrap().len(), 3);
    }

    #[test]
    fn an_unknown_region_is_sent_as_null_rather_than_omitted() {
        let body = envelope("install-1", "0.9.23", None, &[]);
        assert!(body["app"]["country"].is_null());
    }

    // Dates and buckets ----------------------------------------------------------------------

    #[test]
    fn the_day_key_is_a_padded_calendar_date() {
        assert_eq!(day_key_utc(0), "1970-01-01");
        assert_eq!(day_key_utc(1_772_000_000), "2026-02-25");
        assert_eq!(day_key_utc(951_868_800), "2000-03-01");
        assert_eq!(day_key_utc(-1), "1969-12-31");
    }

    #[test]
    fn the_snapshot_is_taken_from_the_payload_only_when_the_cli_carries_one() {
        // The shape the CLI's menubar-json payload will carry. Opaque here, so the fixture
        // only has to be an object.
        let with_snapshot = serde_json::json!({
            "current": { "cost": 1.5 },
            "telemetrySnapshot": { "costBucket": "1-10", "providers": 3 },
        });
        let snapshot = snapshot_from_payload(&with_snapshot).unwrap();
        assert_eq!(snapshot["costBucket"], "1-10");
        assert_eq!(sanitize_props(snapshot).len(), 2);

        // An older CLI, and a CLI with nothing to report.
        assert!(snapshot_from_payload(&serde_json::json!({ "current": {} })).is_none());
        assert!(snapshot_from_payload(&serde_json::json!({ "telemetrySnapshot": null })).is_none());
        assert!(snapshot_from_payload(&serde_json::json!({ "telemetrySnapshot": 7 })).is_none());
    }

    #[test]
    fn the_dock_scale_is_reported_as_a_band() {
        assert_eq!(scale_bucket(0.6), "60-79");
        assert_eq!(scale_bucket(0.75), "60-79");
        assert_eq!(scale_bucket(0.8), "80-99");
        assert_eq!(scale_bucket(1.0), "100-120");
        assert_eq!(scale_bucket(1.2), "100-120");
        assert_eq!(scale_bucket(f64::NAN), "unknown");
    }

    // Tracking -------------------------------------------------------------------------------

    /// A client with no settings file behind it: consent is handed in, so these exercise
    /// `track` without touching the real `windows-settings.json`.
    fn client(consent: Consent, path: Option<PathBuf>) -> Telemetry {
        Telemetry {
            inner: Mutex::new(Inner {
                consent,
                queue: Queue::load(path),
            }),
            app_version: "0.0.0".into(),
            country: Some("US".into()),
            endpoint: TELEMETRY_ENDPOINT.to_owned(),
            may_send: false,
            opened_at: SystemTime::now(),
            failures: AtomicU32::new(0),
            flushing: AtomicBool::new(false),
            save_scheduled: AtomicBool::new(false),
        }
    }

    fn consented(source: ConsentSource) -> Consent {
        Consent {
            source,
            install_id: "id".into(),
            enabled: true,
            onboarded: true,
        }
    }

    #[test]
    fn nothing_is_queued_before_a_decision_or_while_the_toggle_is_off() {
        let undecided = client(
            Consent {
                onboarded: false,
                ..consented(ConsentSource::App)
            },
            None,
        );
        undecided.track("popover_open", &Value::Null);
        assert_eq!(undecided.queue_len(), 0);

        let opted_out = client(
            Consent {
                enabled: false,
                ..consented(ConsentSource::App)
            },
            None,
        );
        opted_out.track("popover_open", &Value::Null);
        assert_eq!(opted_out.queue_len(), 0);
    }

    #[test]
    fn an_event_this_build_does_not_know_is_dropped() {
        let telemetry = client(consented(ConsentSource::App), None);
        telemetry.track("prompt_text", &serde_json::json!({ "text": "secret" }));
        assert_eq!(telemetry.queue_len(), 0);
    }

    #[test]
    fn the_snapshot_is_queued_once_a_day_and_never_when_the_desktop_app_decided() {
        let standalone = client(consented(ConsentSource::App), None);
        let snapshot = serde_json::json!({ "costBucket": "1-10" });
        standalone.track_on("usage_snapshot", &snapshot, "2026-09-03");
        standalone.track_on("usage_snapshot", &snapshot, "2026-09-03");
        assert_eq!(standalone.queue_len(), 1);
        standalone.track_on("usage_snapshot", &snapshot, "2026-09-04");
        assert_eq!(standalone.queue_len(), 2);

        let beside_desktop = client(consented(ConsentSource::Desktop), None);
        beside_desktop.track_on("usage_snapshot", &snapshot, "2026-09-03");
        assert_eq!(beside_desktop.queue_len(), 0);
        // Everything else still goes: only the aggregate is the desktop app's to send.
        beside_desktop.track_on("popover_open", &Value::Null, "2026-09-03");
        assert_eq!(beside_desktop.queue_len(), 1);
    }

    #[test]
    fn a_queued_event_carries_the_day_and_sanitized_props_only() {
        let telemetry = client(consented(ConsentSource::App), None);
        telemetry.track_on(
            "dock_disabled",
            &serde_json::json!({ "edge": "left", "scaleBucket": "80-99", "dropped": null }),
            "2026-09-03",
        );
        let inner = telemetry.inner.lock().unwrap();
        let queued = &inner.queue.events[0];
        assert_eq!(queued.name, "dock_disabled");
        assert_eq!(queued.day, "2026-09-03");
        assert_eq!(queued.props.len(), 2);
        assert_eq!(queued.props.get("edge").unwrap(), "left");
    }

    #[test]
    fn update_result_is_allowed_and_an_unknown_name_is_not() {
        let telemetry = client(consented(ConsentSource::App), None);
        telemetry.track_on("update_results", &Value::Null, "2026-09-03");
        assert_eq!(telemetry.queue_len(), 0);
        let props = serde_json::json!({ "from": "0.9.26", "to": "0.9.27", "outcome": "ok" });
        telemetry.track_on("update_result", &props, "2026-09-03");
        assert_eq!(telemetry.queue_len(), 1);
    }

    #[test]
    fn a_debug_build_queues_but_does_not_send() {
        let telemetry = client(consented(ConsentSource::App), None);
        telemetry.track_on("popover_open", &Value::Null, "2026-09-03");
        assert_eq!(telemetry.queue_len(), 1);
        // may_send is false here, so flush refuses before it ever builds a request.
        assert!(!tauri::async_runtime::block_on(
            telemetry.flush(Duration::from_millis(1))
        ));
        assert_eq!(telemetry.queue_len(), 1);
    }

    #[test]
    fn a_burst_of_events_costs_one_write_rather_than_one_each() {
        let path = temp_queue("queue-burst.json");
        let _ = fs::remove_file(&path);
        let telemetry = client(consented(ConsentSource::App), Some(path.clone()));
        telemetry.track_on("popover_open", &Value::Null, FIXTURE_DAY);
        telemetry.track_on("settings_open", &Value::Null, FIXTURE_DAY);
        telemetry.track_on("glance_open", &Value::Null, FIXTURE_DAY);
        assert_eq!(telemetry.queue_len(), 3);
        // Nothing on disk yet: the write is the debounce timer's, or quit's.
        assert!(!path.exists());

        // What `flush_on_quit` does before it offers the batch, and what the timer does when
        // the burst settles.
        telemetry.save_if_dirty();
        let saved = Queue::load_at(Some(path.clone()), FIXTURE_NOW);
        assert_eq!(saved.len(), 3);
        assert_eq!(saved.events[0].name, "popover_open");
        assert_eq!(saved.events[2].name, "glance_open");
        let _ = fs::remove_file(&path);
    }

    // Randomness -----------------------------------------------------------------------------

    #[test]
    fn the_device_read_takes_sixteen_bytes_and_stops() {
        // A regular file stands in for the character device, which is what a Windows run has
        // to use: the point of the test is that a longer source is read exactly once, up to
        // the sixteen bytes wanted, rather than to its end.
        let path = temp_queue("urandom-stand-in.bin");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, vec![0xABu8; 4_096]).unwrap();
        let mut bytes = [0u8; 16];
        assert!(fill_from_device(&path, &mut bytes));
        assert_eq!(bytes, [0xABu8; 16]);

        // A source that cannot fill the buffer, and one that is not there at all, both say so
        // rather than leaving a half-filled id behind.
        fs::write(&path, b"short").unwrap();
        assert!(!fill_from_device(&path, &mut bytes));
        fs::remove_file(&path).unwrap();
        assert!(!fill_from_device(&path, &mut bytes));
    }

    /// The Linux and macOS path in full, `/dev/urandom` included. It has to return at all,
    /// which is the bug this replaced, and it has to give a different answer each time.
    #[test]
    #[cfg(not(target_os = "windows"))]
    fn the_unix_fill_returns_and_varies() {
        let mut first = [0u8; 16];
        let mut second = [0u8; 16];
        fill_random(&mut first);
        fill_random(&mut second);
        assert_ne!(first, second);
        assert!(first.iter().any(|byte| *byte != 0));
    }

    #[test]
    fn the_install_id_is_a_v4_uuid() {
        let id = new_install_id();
        assert_eq!(id.len(), 36);
        assert_eq!(id.as_bytes()[14], b'4');
        assert!(matches!(id.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
    }

    // Backoff ---------------------------------------------------------------------------------

    #[test]
    fn a_failing_endpoint_is_asked_less_and_less_often() {
        // No failure is the plain beat, and the first retry still gets it.
        assert_eq!(backoff_delay(0, 0.0), FLUSH_INTERVAL);
        assert_eq!(backoff_delay(1, 0.0), FLUSH_INTERVAL);
        assert_eq!(backoff_delay(2, 0.0), FLUSH_INTERVAL * 2);
        assert_eq!(backoff_delay(3, 0.0), FLUSH_INTERVAL * 4);
        // Doubling stops at the ceiling rather than walking off to never.
        assert_eq!(backoff_delay(4, 0.0), BACKOFF_MAX);
        assert_eq!(backoff_delay(1_000, 0.0), BACKOFF_MAX);
    }

    #[test]
    fn the_backoff_is_spread_so_a_fleet_does_not_come_back_in_lockstep() {
        // Jitter only ever adds, and never more than a quarter of the wait.
        assert_eq!(backoff_delay(2, 1.0), FLUSH_INTERVAL * 2 + FLUSH_INTERVAL / 2);
        assert!(backoff_delay(3, 0.5) > backoff_delay(3, 0.0));
        assert!(backoff_delay(3, 0.5) < backoff_delay(3, 1.0));
        // An out-of-range fraction is clamped rather than trusted.
        assert_eq!(backoff_delay(2, -1.0), backoff_delay(2, 0.0));
        assert_eq!(backoff_delay(2, 9.0), backoff_delay(2, 1.0));
        for _ in 0..64 {
            assert!((0.0..1.0).contains(&jitter_fraction()));
        }
    }

    #[test]
    fn a_send_that_could_not_be_made_lengthens_the_wait_and_a_send_that_lands_resets_it() {
        let telemetry = client(consented(ConsentSource::App), None);
        assert_eq!(telemetry.failures.load(Ordering::Relaxed), 0);
        telemetry.failures.store(3, Ordering::Relaxed);
        assert!(telemetry.next_flush_delay() >= FLUSH_INTERVAL * 4);
        telemetry.failures.store(0, Ordering::Relaxed);
        assert!(telemetry.next_flush_delay() >= FLUSH_INTERVAL);
        assert!(telemetry.next_flush_delay() < FLUSH_INTERVAL * 2);
    }
}
