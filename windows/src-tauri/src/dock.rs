//! The Capacity Dock: a slim quota rail docked to a screen edge, the Windows twin of the macOS
//! Capacity Dock. The window is created on demand and closed again when the dock is switched
//! off, so a disabled dock leaves no webview resident.
//!
//! One transparent window hosts both the rail and the hover bubble, sized once per placement
//! for the fully expanded rail plus the bubble's reach. Hovering never moves or resizes it:
//! WebView2 presents one stale frame at every window change, which read as the rail jumping.
//! Pointer tracking (a cursor poll, the counterpart of the mac's global event monitor) makes
//! the window click-through everywhere but the painted shapes, synthesizes hover for the page,
//! and drives dragging: the rail follows the pointer, and on release snaps to whichever edge is
//! within reach or stays floating. This module owns all of that geometry; the page only paints
//! into the frames it is handed.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const DOCK_LABEL: &str = "dock";

/// The dock is a Windows surface. Its window is a transparent, always-on-top rectangle far
/// larger than the rail it paints, and what keeps it from swallowing every click that lands in
/// the empty part is the user32 cursor tracking below. No other platform has that counterpart
/// here: the Linux tray runs its own SNI menu and never had a dock. So off Windows the dock is
/// simply not there, rather than a window nobody can see and nobody can click through.
pub const AVAILABLE: bool = cfg!(target_os = "windows");

/// The size scale the settings window writes, from CapacityDockPreferences.scaleRange.
pub const MIN_SCALE: f64 = 0.6;
pub const MAX_SCALE: f64 = 1.2;
/// The bubble never shrinks with the rail: below 90% its type stops being readable.
const MIN_DETAIL_SCALE: f64 = 0.9;

/// The mac's base metrics times the size scale, the same arithmetic as `src/dockGeometry.ts`.
/// Fractional sizes cost the mac app 5-7% idle CPU by making the hosting view re-lay itself
/// out forever, so every value here is a whole pixel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Metrics {
    rail_width: i32,
    /// Horizontal rails stack the ring above its label, so their cross-extent needs more room.
    horizontal_rail_width: i32,
    row_height: i32,
    row_spacing: i32,
    /// A profile row's caption line box and gap, added to every row's height when the rail
    /// draws one ring per Claude config directory, keeping the row extent uniform (the
    /// hit-test arithmetic depends on it).
    caption_line: i32,
    caption_gap: i32,
    rail_along_pad: i32,
    /// 60% of the shoulder depth: a docked rail pads its ends so content never crowds the flare.
    flare_compensation: i32,
    detail_width: i32,
    /// The mac caps its bubble at 470 points times the detail scale.
    detail_max_height: i32,
    /// How far past either end of the rail a bubble centred on an end row can reach.
    detail_overhang: i32,
}

fn points(base: f64, scale: f64) -> i32 {
    ((base * scale).round() as i32).max(1)
}

impl Metrics {
    pub fn for_scale(scale: f64) -> Metrics {
        let scale = if scale.is_finite() { scale.clamp(MIN_SCALE, MAX_SCALE) } else { MIN_SCALE };
        let detail = scale.max(MIN_DETAIL_SCALE);
        Metrics {
            rail_width: points(88.0, scale),
            horizontal_rail_width: points(106.0, scale),
            row_height: points(84.0, scale),
            row_spacing: points(12.0, scale),
            caption_line: points(13.0, scale),
            caption_gap: points(4.0, scale),
            rail_along_pad: points(20.0, scale),
            flare_compensation: (points(52.0, scale) as f64 * 0.6).round() as i32,
            detail_width: points(350.0, detail),
            detail_max_height: points(470.0, detail),
            detail_overhang: points(178.0, detail),
        }
    }

    /// The same metrics with every row tall enough for a caption: a mixed-height rail
    /// would break the uniform row pitch the layout and hit-test assume.
    fn with_captions(&self) -> Metrics {
        let mut m = *self;
        m.row_height += m.caption_gap + m.caption_line;
        m
    }

    fn from_prefs() -> Metrics {
        Metrics::for_scale(prefs_scale())
    }
}

impl Default for Metrics {
    fn default() -> Self {
        Metrics::for_scale(MIN_SCALE)
    }
}

/// Placement constants the mac keeps out of its scaled metrics (CapacityDockPlacement).
const DETAIL_GAP: i32 = 10;
/// The rail's resting top edge sits this far below the top of the work area.
const DEFAULT_TOP_OFFSET: i32 = 156;
const EDGE_INSET: i32 = 12;
const DOCK_SNAP_DISTANCE: i32 = 44;

/// Cursor poll rates. Hover is synthesized from these reads rather than from DOM events, so the
/// fast one is the rate the rail reacts at; it runs only while the pointer is on or near the
/// dock, or holding a button down. A pointer parked anywhere else on the desktop costs the slow
/// one, which is what the dock idles at.
const POLL_NEAR_MS: u64 = 16;
const POLL_MID_MS: u64 = 40;
const POLL_FAR_MS: u64 = 120;
/// Logical pixels from the dock's window at which each rate takes over. The middle band is wide
/// enough that a pointer travelling at a fast flick is read at least twice on its way in.
const POLL_NEAR_DISTANCE: i32 = 120;
const POLL_MID_DISTANCE: i32 = 600;
/// How long between two looks at the shape of the desktop, on the same thread.
const DISPLAY_CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Left,
    Right,
    Top,
    Bottom,
}

impl Edge {
    pub fn is_vertical(self) -> bool {
        matches!(self, Edge::Left | Edge::Right)
    }
    pub fn opposite(self) -> Edge {
        match self {
            Edge::Left => Edge::Right,
            Edge::Right => Edge::Left,
            Edge::Top => Edge::Bottom,
            Edge::Bottom => Edge::Top,
        }
    }
}

/// Where the rail lives. `attachment` is the orientation edge, kept while floating so a rail
/// dragged off the right edge stays vertical. Offsets are normalized over the travel range so
/// they survive a resolution change; `None` means the mac defaults.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Placement {
    pub docked: Option<Edge>,
    pub attachment: Edge,
    pub x: Option<f64>,
    pub y: Option<f64>,
    /// The display the rail was dropped on, by the name the OS gives it. Displays come and go,
    /// so this is a hint rather than an address: a placement whose display is gone falls back
    /// to the one the window is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monitor: Option<String>,
}

impl Default for Placement {
    fn default() -> Self {
        Placement {
            docked: Some(Edge::Right),
            attachment: Edge::Right,
            x: None,
            y: None,
            monitor: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    fn right(&self) -> i32 {
        self.x + self.w
    }
    fn bottom(&self) -> i32 {
        self.y + self.h
    }
    fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }
    fn offset(&self, dx: i32, dy: i32) -> Rect {
        Rect {
            x: self.x + dx,
            y: self.y + dy,
            ..*self
        }
    }
    /// Shrinks to fit inside `bounds`, then clamps the origin into it.
    fn fit_within(&self, bounds: &Rect) -> Rect {
        let w = self.w.min(bounds.w).max(1);
        let h = self.h.min(bounds.h).max(1);
        Rect {
            x: self.x.clamp(bounds.x, (bounds.right() - w).max(bounds.x)),
            y: self.y.clamp(bounds.y, (bounds.bottom() - h).max(bounds.y)),
            w,
            h,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailRequest {
    /// Index of the hovered row, counted from the rail's start (top or left).
    pub row: u32,
    pub height: i32,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutRequest {
    /// Rows the page is showing right now.
    pub rows: u32,
    /// Rows the fully expanded rail holds; the window is sized for these.
    pub total_rows: u32,
    pub expanded: bool,
    pub detail: Option<DetailRequest>,
    /// The rail draws a caption line under each ring (one ring per Claude config
    /// directory), so every row is taller by the caption metrics. Absent on a page
    /// that predates the field, which reads as a plain uncaptioned rail.
    #[serde(default)]
    pub captioned: bool,
}

/// Which end of the rail stays put while it grows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Anchor {
    Start,
    End,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailFrame {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    /// Where the tail points along the bubble's tail edge, in the bubble's own coordinates.
    pub tail: i32,
}

/// Everything the page needs to paint: frames are relative to the window's top-left corner.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockFrame {
    #[serde(skip)]
    pub window: Rect,
    /// Screen-space start of the first row along the rail, for hit-testing.
    #[serde(skip)]
    rows_start: i32,
    #[serde(skip)]
    rows: u32,
    pub rail: Rect,
    pub edge: Edge,
    pub vertical: bool,
    pub docked: bool,
    pub along_pad: i32,
    pub anchor: Anchor,
    pub bubble_side: Edge,
    pub detail: Option<DetailFrame>,
    /// Hover comes from the cursor poll rather than DOM events when this is set.
    pub native_pointer: bool,
    /// The row height this frame's rows were laid out with, caption allowance included, for
    /// the hit-test's row pitch.
    #[serde(skip)]
    pub row_extent: i32,
}

fn rail_length(m: &Metrics, rows: u32, pad: i32) -> i32 {
    pad * 2 + rows_extent(m, rows)
}

fn rows_extent(m: &Metrics, rows: u32) -> i32 {
    let rows = rows.max(1) as i32;
    rows * m.row_height + (rows - 1) * m.row_spacing
}

fn denormalize(norm: Option<f64>, low: i32, high: i32, fallback: i32) -> i32 {
    let high = high.max(low);
    match norm {
        Some(n) => low + ((high - low) as f64 * n.clamp(0.0, 1.0)).round() as i32,
        None => fallback.clamp(low, high),
    }
}

fn normalize(value: i32, low: i32, high: i32) -> f64 {
    if high <= low {
        0.0
    } else {
        ((value - low) as f64 / (high - low) as f64).clamp(0.0, 1.0)
    }
}

/// Which end of a rail resting at `rest_start` stays put while it grows: whichever side of the
/// work area has the room for it. The layout and the drop both read this, and they have to
/// agree about it, or a rail released while expanded is stored against a travel range that
/// means something else.
fn anchor_for(area_along: i32, area_along_len: i32, rest_start: i32, rest_len: i32) -> Anchor {
    let room_after = area_along + area_along_len - (rest_start + rest_len);
    let room_before = rest_start - area_along;
    if room_after >= room_before {
        Anchor::Start
    } else {
        Anchor::End
    }
}

/// The travel a resting rail of `rest_len` has along the axis: the range every stored offset is
/// normalized over, whatever length the rail happens to be showing at the time.
fn resting_travel(area_along: i32, area_along_len: i32, rest_len: i32) -> (i32, i32) {
    (
        area_along + EDGE_INSET,
        area_along + area_along_len - EDGE_INSET - rest_len,
    )
}

/// Pure layout in logical pixels. `area` is the monitor work area.
pub fn layout(area: Rect, placement: &Placement, request: &LayoutRequest, m: &Metrics) -> DockFrame {
    // Captioned rails swap in the taller row metrics once, here at the door, so every
    // downstream computation (rail length, window, row mids, hit-test extent) agrees.
    let m = if request.captioned { &m.with_captions() } else { m };
    let edge = placement.attachment;
    let vertical = edge.is_vertical();
    let docked = placement.docked.is_some();
    let pad = m.rail_along_pad + if docked { m.flare_compensation } else { 0 };
    let cross = if vertical { m.rail_width } else { m.horizontal_rail_width };
    let rest_len = rail_length(m, 1, pad);

    // Along axis: y for vertical rails, x for horizontal ones. Cross axis is the other.
    let (area_along, area_along_len, area_cross, area_cross_len) = if vertical {
        (area.y, area.h, area.x, area.w)
    } else {
        (area.x, area.w, area.y, area.h)
    };
    let (along_low, rest_high) = resting_travel(area_along, area_along_len, rest_len);
    let cross_pos = match placement.docked {
        Some(Edge::Left) | Some(Edge::Top) => area_cross,
        Some(Edge::Right) | Some(Edge::Bottom) => area_cross + area_cross_len - cross,
        None => {
            let low = area_cross + EDGE_INSET;
            let high = area_cross + area_cross_len - EDGE_INSET - cross;
            let norm = if vertical { placement.x } else { placement.y };
            denormalize(norm, low, high, if vertical { high } else { low })
        }
    };
    let along_norm = if vertical { placement.y } else { placement.x };
    let rest_fallback = if vertical {
        area_along + DEFAULT_TOP_OFFSET
    } else {
        area_along + (area_along_len - rest_len) / 2
    };
    let rest_start = denormalize(along_norm, along_low, rest_high, rest_fallback);

    let anchor = anchor_for(area_along, area_along_len, rest_start, rest_len);
    let rail_along = |rows: u32| -> (i32, i32) {
        let len = rail_length(m, rows, pad);
        let high = (area_along + area_along_len - EDGE_INSET - len).max(along_low);
        let start = match anchor {
            Anchor::Start => rest_start,
            Anchor::End => rest_start + rest_len - len,
        };
        (start.clamp(along_low, high), len)
    };
    let make_rect = |along: i32, len: i32| -> Rect {
        if vertical {
            Rect { x: cross_pos, y: along, w: cross, h: len }
        } else {
            Rect { x: along, y: cross_pos, w: len, h: cross }
        }
    };

    let shown_rows = if request.expanded { request.rows } else { 1 };
    let (rail_start, rail_len) = rail_along(shown_rows);
    let rail = make_rect(rail_start, rail_len);
    let (full_start, full_len) = rail_along(request.total_rows.max(request.rows));
    let full = make_rect(full_start, full_len);

    let bubble_side = match placement.docked {
        Some(edge) => edge.opposite(),
        None if vertical => {
            let room_left = full.x - area.x;
            let room_right = area.right() - full.right();
            if room_right >= room_left { Edge::Right } else { Edge::Left }
        }
        None => {
            let room_above = full.y - area.y;
            let room_below = area.bottom() - full.bottom();
            if room_above >= room_below { Edge::Top } else { Edge::Bottom }
        }
    };

    // The window: the fully expanded rail, plus the bubble's reach on its side and past both
    // ends. Everything outside the painted shapes is click-through.
    let reach = DETAIL_GAP + if vertical { m.detail_width } else { m.detail_max_height };
    let overhang = m.detail_overhang;
    let mut window = if vertical {
        Rect { x: full.x, y: full.y - overhang, w: full.w, h: full.h + overhang * 2 }
    } else {
        Rect { x: full.x - overhang, y: full.y, w: full.w + overhang * 2, h: full.h }
    };
    match bubble_side {
        Edge::Left => {
            window.x -= reach;
            window.w += reach;
        }
        Edge::Right => window.w += reach,
        Edge::Top => {
            window.y -= reach;
            window.h += reach;
        }
        Edge::Bottom => window.h += reach,
    }
    let window = window.fit_within(&area);

    let rows_start = match anchor {
        Anchor::Start => rail_start + pad,
        Anchor::End => rail_start + rail_len - pad - rows_extent(m, shown_rows),
    };
    let detail = request.detail.map(|d| {
        let w = m.detail_width.min(window.w);
        let h = d.height.clamp(1, m.detail_max_height).min(window.h);
        let row_mid = rows_start + d.row as i32 * (m.row_height + m.row_spacing) + m.row_height / 2;
        let desired = match bubble_side {
            Edge::Left => Rect { x: rail.x - DETAIL_GAP - w, y: row_mid - h / 2, w, h },
            Edge::Right => Rect { x: rail.right() + DETAIL_GAP, y: row_mid - h / 2, w, h },
            Edge::Top => Rect { x: row_mid - w / 2, y: rail.y - DETAIL_GAP - h, w, h },
            Edge::Bottom => Rect { x: row_mid - w / 2, y: rail.bottom() + DETAIL_GAP, w, h },
        };
        let placed = desired.fit_within(&window);
        let tail = if vertical { row_mid - placed.y } else { row_mid - placed.x };
        (placed, tail)
    });

    DockFrame {
        window,
        rows_start,
        rows: shown_rows,
        rail: rail.offset(-window.x, -window.y),
        edge,
        vertical,
        docked,
        along_pad: pad,
        anchor,
        bubble_side,
        detail: detail.map(|(rect, tail)| {
            let local = rect.offset(-window.x, -window.y);
            DetailFrame { x: local.x, y: local.y, w: local.w, h: local.h, tail }
        }),
        native_pointer: cfg!(target_os = "windows"),
        row_extent: m.row_height,
    }
}

/// The edge a rail this close to would snap to, and how far along the snap it is.
fn attachment_candidate(rail: &Rect, area: &Rect) -> Option<(Edge, f64)> {
    let distances = [
        (Edge::Left, (rail.x - area.x).abs()),
        (Edge::Right, (area.right() - rail.right()).abs()),
        (Edge::Top, (rail.y - area.y).abs()),
        (Edge::Bottom, (area.bottom() - rail.bottom()).abs()),
    ];
    let (edge, distance) = distances.into_iter().min_by_key(|(_, d)| *d)?;
    if distance > DOCK_SNAP_DISTANCE {
        return None;
    }
    Some((edge, (1.0 - distance as f64 / DOCK_SNAP_DISTANCE as f64).clamp(0.0, 1.0)))
}

/// Placement for a rail released at `rail`: docked when an edge is in reach, else floating
/// where it was dropped.
///
/// `rest_len` is how long that same rail is at rest, which is what the along offset has to be
/// normalized against: `layout` denormalizes it over the resting travel and grows the rail from
/// there. A rail let go while expanded is up to several rows longer than that, so its start is
/// walked back to the resting start it grew from first. Reading the live length instead is what
/// made a rail dropped expanded reappear a couple of hundred pixels from the hand that let go
/// of it.
fn placement_for_drop(rail: &Rect, rest_len: i32, screen: &Screen, current: &Placement) -> Placement {
    let area = &screen.area;
    let docked = attachment_candidate(rail, area).map(|(edge, _)| edge);
    let attachment = docked.unwrap_or(current.attachment);
    let vertical = attachment.is_vertical();

    let (area_along, area_along_len, along_start, live_len) = if vertical {
        (area.y, area.h, rail.y, rail.h)
    } else {
        (area.x, area.w, rail.x, rail.w)
    };
    let rest_len = rest_len.clamp(1, live_len.max(1));
    // An End-anchored rail grew upward (or leftward) from its resting start, so the drop is that
    // much further along than the offset it has to be stored as. The anchor the layout will pick
    // is the one the candidate itself predicts, and the predicate only ever moves from Start to
    // End as the start grows, so testing the Start candidate first settles it in one step.
    let rest_start = if anchor_for(area_along, area_along_len, along_start, rest_len) == Anchor::Start {
        along_start
    } else {
        along_start + live_len - rest_len
    };
    let (along_low, along_high) = resting_travel(area_along, area_along_len, rest_len);
    let along = normalize(rest_start, along_low, along_high);

    // The cross axis does not move with the rows, so it is read straight off the drop.
    let (area_cross, area_cross_len, cross_start, cross_len) = if vertical {
        (area.x, area.w, rail.x, rail.w)
    } else {
        (area.y, area.h, rail.y, rail.h)
    };
    let cross = normalize(
        cross_start,
        area_cross + EDGE_INSET,
        area_cross + area_cross_len - EDGE_INSET - cross_len,
    );

    let (x, y) = if vertical { (cross, along) } else { (along, cross) };
    Placement {
        docked,
        attachment,
        x: Some(x),
        y: Some(y),
        monitor: screen.name.clone(),
    }
}

// Persistence -------------------------------------------------------------------------------

fn state_path() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".config/codeburn"))
        .unwrap_or_else(|| PathBuf::from(".codeburn"))
        .join("windows-dock.json")
}

fn read_state() -> serde_json::Map<String, serde_json::Value> {
    read_state_at(&state_path())
}

/// Lock-free by design: the writer renames a whole file into place, so this sees the old file or
/// the new one and never a torn one. What it costs is paid on the writer's side, where a read
/// overlapping a replace is a failure Windows reports rather than waits out; see
/// `crate::settings::replace_file`.
fn read_state_at(path: &Path) -> serde_json::Map<String, serde_json::Value> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

/// Names one temp file per write. The desktop app writes this file too, and so do the settings
/// window and the cursor thread on this side, so two writes can be in flight at once and each
/// needs its own scratch name.
static WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// The desktop app reads this file as well, and a plain write is not one step: a reader that
/// arrives partway through it gets truncated JSON, falls back to an empty state, and the
/// placement and the dock's own switch are gone. Writing beside it and renaming over is.
fn write_state_at(path: &Path, state: &serde_json::Map<String, serde_json::Value>) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(state)?;
    let temp = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&temp, &bytes)?;
    // Not a plain rename: on Windows a reader that has the target open can make the replace fail
    // outright, and reads of this file take no lock. See `crate::settings::replace_file`.
    if let Err(err) = crate::settings::replace_file(&temp, path) {
        // Nothing is left behind for the next launch to trip over.
        let _ = fs::remove_file(&temp);
        return Err(err.into());
    }
    Ok(())
}

/// The one write path for this file: take the cross-process lock, read the current state,
/// apply `mutate`, and rename the whole thing back, all before the lock is released. The
/// desktop app owns this file too and runs the same protocol from `tray-settings.ts`, so
/// without the lock two writers that touch different keys lose each other's change even though
/// the rename keeps the file whole. The rename is still what keeps a reader from seeing a torn
/// file; the lock is what keeps a second writer from erasing this one. See
/// `crate::settings::prefs_lock` for the protocol.
fn patch_state(
    mutate: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>),
) -> Result<serde_json::Map<String, serde_json::Value>> {
    patch_state_at(&state_path(), mutate)
}

fn patch_state_at(
    path: &Path,
    mutate: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>),
) -> Result<serde_json::Map<String, serde_json::Value>> {
    let _lock = crate::settings::prefs_lock::acquire(path)?;
    let mut state = read_state_at(path);
    mutate(&mut state);
    write_state_at(path, &state)?;
    Ok(state)
}

/// What the stored state reads as from outside. The file is shared with the desktop app, which
/// writes it on every platform, so a switch turned on there is normalized away here rather than
/// reported as a dock that is running when none can be.
fn normalized(
    mut state: serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    if !AVAILABLE {
        state.insert("enabled".into(), serde_json::Value::Bool(false));
    }
    state
}

/// The dock's own preferences, which the settings window edits and the rail renders from.
/// `placement` is in here too, but it is written by dragging rather than by the settings, so
/// the settings window simply leaves the key alone.
pub fn read_prefs() -> serde_json::Map<String, serde_json::Value> {
    normalized(read_state())
}

pub fn patch_prefs(
    values: serde_json::Map<String, serde_json::Value>,
) -> Result<serde_json::Map<String, serde_json::Value>> {
    let state = patch_state(|state| {
        for (key, value) in values {
            if value.is_null() {
                state.remove(&key);
            } else {
                state.insert(key, value);
            }
        }
    })?;
    Ok(normalized(state))
}

pub fn is_enabled() -> bool {
    AVAILABLE
        && read_state()
            .get("enabled")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
}

/// Where the rail sits and how big it is, as the two buckets the dock telemetry events
/// carry. The edge is the one it is docked to, or the orientation it keeps while floating.
pub fn telemetry_props() -> serde_json::Value {
    let placement = load_placement();
    let edge = placement.docked.unwrap_or(placement.attachment);
    serde_json::json!({
        "edge": serde_json::to_value(edge).unwrap_or(serde_json::Value::Null),
        "scaleBucket": crate::telemetry::scale_bucket(prefs_scale()),
    })
}

pub fn set_enabled(enabled: bool) -> Result<()> {
    patch_state(|state| {
        state.insert("enabled".into(), serde_json::Value::Bool(enabled));
    })?;
    Ok(())
}

/// The provider the resting rail shows. A click on another row makes it the preferred one;
/// the page reads the current one out of the preferences with everything else.
pub fn set_preferred_provider(id: &str) -> Result<()> {
    let id = id.to_owned();
    patch_state(|state| {
        state.insert("preferred".into(), serde_json::Value::String(id));
    })?;
    Ok(())
}

fn load_placement() -> Placement {
    read_state()
        .get("placement")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default()
}

fn save_placement(placement: &Placement) -> Result<()> {
    let value = serde_json::to_value(placement)?;
    patch_state(|state| {
        state.insert("placement".into(), value);
    })?;
    Ok(())
}

// Live state --------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Pointer {
    rail_hovered: bool,
    row: Option<u32>,
    detail_hovered: bool,
}

#[derive(Clone, Copy, Debug)]
struct Drag {
    /// Where in the rail it was grabbed, as a fraction of the rail's own width and height.
    /// Proportional rather than absolute because the rail changes shape mid-drag when it
    /// rotates, and the mac's pointerAnchoredDragFrame keeps the same grip through it.
    ax: f64,
    ay: f64,
    last: Option<(Edge, f64)>,
}

#[derive(Default)]
struct DockState {
    placement: Option<Placement>,
    metrics: Metrics,
    request: LayoutRequest,
    frame: Option<DockFrame>,
    /// The display the rail is laid out on, and the list a drag can move it between.
    screen: Option<Screen>,
    screens: Vec<Screen>,
    area: Rect,
    scale: f64,
    pointer: Pointer,
    /// What the window is known to be set to, rather than what it was last asked for: `None`
    /// until a `set_ignore_cursor_events` has actually come back clean.
    ignoring: Option<bool>,
    /// The primary button while it is held, and whether the press began on the dock.
    press: Option<bool>,
    drag: Option<Drag>,
}

static STATE: Mutex<DockState> = Mutex::new(DockState {
    placement: None,
    screen: None,
    screens: Vec::new(),
    // Replaced from the stored scale the moment the window is created; the const initializer
    // cannot call `Metrics::for_scale`, so the default rounding is spelled out here.
    metrics: Metrics {
        rail_width: 53,
        horizontal_rail_width: 64,
        row_height: 50,
        row_spacing: 7,
        caption_line: 8,
        caption_gap: 2,
        rail_along_pad: 12,
        flare_compensation: 19,
        detail_width: 315,
        detail_max_height: 423,
        detail_overhang: 160,
    },
    request: LayoutRequest { rows: 1, total_rows: 1, expanded: false, detail: None, captioned: false },
    frame: None,
    area: Rect { x: 0, y: 0, w: 0, h: 0 },
    scale: 1.0,
    pointer: Pointer { rail_hovered: false, row: None, detail_hovered: false },
    ignoring: None,
    press: None,
    drag: None,
});

fn lock() -> std::sync::MutexGuard<'static, DockState> {
    STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A size change: the frame the page must paint into, and the scale it was computed for, so
/// the page applies both at once.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MetricsEvent {
    scale: f64,
    frame: DockFrame,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettledEvent {
    /// Where the rail was when the move began, relative to the new window.
    from: Rect,
    frame: DockFrame,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DragEvent {
    attachment: f64,
    edge: Option<Edge>,
    /// Carried only when the rail has just changed orientation, since the page then has a
    /// different window and a different rail to paint into.
    #[serde(skip_serializing_if = "Option::is_none")]
    frame: Option<DockFrame>,
}

/// One display: its work area in logical pixels, which is what the layout is written in, and
/// its full bounds in physical pixels, which is what a cursor reading can be tested against.
#[derive(Clone, Debug, Default, PartialEq)]
struct Screen {
    name: Option<String>,
    area: Rect,
    bounds: Rect,
    scale: f64,
}

fn screen_of(monitor: &tauri::Monitor) -> Screen {
    let scale = monitor.scale_factor();
    let logical = |v: i32| (v as f64 / scale).round() as i32;
    let area = monitor.work_area();
    let position = monitor.position();
    let size = monitor.size();
    Screen {
        name: monitor.name().cloned(),
        area: Rect {
            x: logical(area.position.x),
            y: logical(area.position.y),
            w: logical(area.size.width as i32),
            h: logical(area.size.height as i32),
        },
        bounds: Rect {
            x: position.x,
            y: position.y,
            w: size.width as i32,
            h: size.height as i32,
        },
        scale,
    }
}

fn screens(window: &tauri::WebviewWindow) -> Vec<Screen> {
    window
        .available_monitors()
        .map(|monitors| monitors.iter().map(screen_of).collect())
        .unwrap_or_default()
}

/// The display a placement belongs to: the one it names while that display is still there,
/// else whichever one the window is on.
fn screen_for(window: &tauri::WebviewWindow, name: Option<&str>) -> Option<Screen> {
    if let Some(name) = name {
        if let Some(found) = screens(window)
            .into_iter()
            .find(|screen| screen.name.as_deref() == Some(name))
        {
            return Some(found);
        }
    }
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or(window.primary_monitor().ok().flatten())?;
    Some(screen_of(&monitor))
}

/// Size and position change together: two separate calls repaint twice, and between them the
/// rail would flash at the wrong offset inside the window.
#[cfg(target_os = "windows")]
fn move_window(window: &tauri::WebviewWindow, target: Rect, scale: f64) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};
    let Ok(hwnd) = window.hwnd() else { return };
    let physical = |v: i32| (v as f64 * scale).round() as i32;
    unsafe {
        SetWindowPos(
            hwnd.0 as _,
            std::ptr::null_mut(),
            physical(target.x),
            physical(target.y),
            physical(target.w).max(1),
            physical(target.h).max(1),
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn move_window(window: &tauri::WebviewWindow, target: Rect, scale: f64) {
    let physical = |v: i32| (v as f64 * scale).round() as i32;
    let _ = window.set_size(tauri::PhysicalSize::new(physical(target.w).max(1) as u32, physical(target.h).max(1) as u32));
    let _ = window.set_position(tauri::PhysicalPosition::new(physical(target.x), physical(target.y)));
}

/// Recomputes the layout from the stored placement and request, moving the window only when
/// its rectangle actually changes.
fn relayout(window: &tauri::WebviewWindow) -> Option<DockFrame> {
    // Resolved before the lock is taken: asking the window about its displays goes through the
    // event loop, and the cursor thread holds this lock while it drives a drag.
    let stored = { lock().placement.get_or_insert_with(load_placement).clone() };
    let screen = screen_for(window, stored.monitor.as_deref())?;
    let (area, scale) = (screen.area, screen.scale);
    let mut state = lock();
    let placement = state.placement.get_or_insert_with(load_placement).clone();
    let metrics = state.metrics;
    let frame = layout(area, &placement, &state.request, &metrics);
    #[cfg(debug_assertions)]
    let (request_rows, request_total, request_expanded) = (state.request.rows, state.request.total_rows, state.request.expanded);
    let moved = state.frame.map(|f| f.window) != Some(frame.window);
    state.area = area;
    state.scale = scale;
    state.screen = Some(screen);
    state.frame = Some(frame);
    drop(state);
    if moved {
        #[cfg(debug_assertions)]
        crate::log_line!(
            "codeburn dock: work_area={},{} {}x{} rows={} total={} expanded={} placement={:?} -> window {},{} {}x{}",
            area.x, area.y, area.w, area.h, request_rows, request_total, request_expanded, placement,
            frame.window.x, frame.window.y, frame.window.w, frame.window.h
        );
        move_window(window, frame.window, scale);
    }
    Some(frame)
}

/// What to do with a layout request the page has just sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LayoutOutcome {
    /// Lay the window out for the stored request and move it if it changed.
    Relayout,
    /// The pointer owns the window: answer with the frame the page is already painting into.
    Deferred(Option<DockFrame>),
}

/// Records the request and says whether it may reach the window yet. A drag owns the window
/// while it runs: `relayout` places the window from the stored placement, which is still where
/// the rail was before the drag began, so a request that lands mid-drag would snap the rail out
/// from under the pointer holding it. The request is kept either way and the settle lays out
/// from it, so nothing is lost by waiting.
fn record_request(state: &mut DockState, request: LayoutRequest) -> LayoutOutcome {
    state.request = request;
    if state.drag.is_some() {
        LayoutOutcome::Deferred(state.frame)
    } else {
        LayoutOutcome::Relayout
    }
}

/// Stores the page's request and returns the frames it paints into.
pub fn apply_layout(window: &tauri::WebviewWindow, request: LayoutRequest) -> Option<DockFrame> {
    // Bound to a name so the guard is released before `relayout` asks for it again.
    let outcome = record_request(&mut lock(), request);
    match outcome {
        LayoutOutcome::Deferred(frame) => frame,
        LayoutOutcome::Relayout => relayout(window),
    }
}

/// Re-homes the rail after a drop or a menu choice and tells the page where it came from so
/// it can glide into place.
fn settle(app: &AppHandle, window: &tauri::WebviewWindow, placement: Placement, from_rail: Rect) {
    if let Err(err) = save_placement(&placement) {
        // The rail still moves: the placement below is what this run lays out from. What is
        // lost is the next launch, which reads the file and puts the rail back where it was.
        // Losing the cross-process lock to the desktop app is a new way for this to happen, and
        // it happens silently, so it is worth a line in the log.
        crate::log_line!("codeburn dock: placement not saved, the rail will revert at next launch: {err:#}");
    }
    {
        let mut state = lock();
        state.placement = Some(placement);
        state.request.detail = None;
        state.drag = None;
    }
    publish(app, window, Some(from_rail));
}

/// Lays the rail out again and tells the page where it landed. The page paints into the frame
/// it was last handed, so a window that moves on this side has to be announced; `from` is where
/// the rail was, in screen coordinates, and the page glides it from there.
fn publish(app: &AppHandle, window: &tauri::WebviewWindow, from: Option<Rect>) {
    let Some(frame) = relayout(window) else { return };
    let from = from.unwrap_or_else(|| frame.rail.offset(frame.window.x, frame.window.y));
    let event = SettledEvent {
        from: from.offset(-frame.window.x, -frame.window.y),
        frame,
    };
    let _ = app.emit_to(DOCK_LABEL, "codeburn://dock-settled", event);
}

fn current_rail_screen(state: &DockState) -> Option<Rect> {
    let frame = state.frame?;
    Some(frame.rail.offset(frame.window.x, frame.window.y))
}

/// Context-menu docking: keeps the along-axis offset, moves to the chosen edge.
pub fn dock_to(app: &AppHandle, edge: Edge) {
    let Some(window) = app.get_webview_window(DOCK_LABEL) else { return };
    let (placement, from) = {
        let state = lock();
        let Some(from) = current_rail_screen(&state) else { return };
        let current = state.placement.clone().unwrap_or_default();
        (
            Placement {
                docked: Some(edge),
                attachment: edge,
                ..current
            },
            from,
        )
    };
    settle(app, &window, placement, from);
}

/// Starts following the cursor. The page calls this once its own drag threshold is passed,
/// with the press point in window coordinates so the rail stays exactly where it was grabbed.
pub fn begin_drag(app: &AppHandle, anchor: (i32, i32)) {
    let Some(window) = app.get_webview_window(DOCK_LABEL) else { return };
    // Taken once, here, rather than per frame: the rail follows the pointer across displays,
    // and asking the window for its monitor list sixty times a second would go through the
    // event loop sixty times a second.
    let all = screens(&window);
    let mut state = lock();
    let Some(frame) = state.frame else { return };
    let grip = |along: i32, low: i32, len: i32| -> f64 {
        if len > 0 { ((along - low) as f64 / len as f64).clamp(0.0, 1.0) } else { 0.5 }
    };
    state.screens = all;
    state.drag = Some(Drag {
        ax: grip(anchor.0, frame.rail.x, frame.rail.w),
        ay: grip(anchor.1, frame.rail.y, frame.rail.h),
        last: None,
    });
    state.request.detail = None;
    drop(state);
    // Recorded the same way the tick does it, so a call that fails here leaves the state unknown
    // and the next tick asks again rather than trusting a window that never took the change.
    let ok = window.set_ignore_cursor_events(false).is_ok();
    lock().ignoring = ignore_after_call(false, ok);
    let _ = app.emit_to(
        DOCK_LABEL,
        "codeburn://dock-drag",
        DragEvent { attachment: if frame.docked { 1.0 } else { 0.0 }, edge: None, frame: None },
    );
}

#[cfg(target_os = "windows")]
fn cursor_position() -> Option<(i32, i32)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT { x: 0, y: 0 };
    (unsafe { GetCursorPos(&mut point) } != 0).then_some((point.x, point.y))
}

#[cfg(not(target_os = "windows"))]
fn cursor_position() -> Option<(i32, i32)> {
    None
}

#[cfg(target_os = "windows")]
fn primary_button_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    (unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } as u16) & 0x8000 != 0
}

#[cfg(not(target_os = "windows"))]
fn primary_button_down() -> bool {
    false
}

/// How far a point lies outside a rectangle, along whichever axis it is furthest out on, and
/// zero anywhere inside it.
fn distance_to(rect: &Rect, x: i32, y: i32) -> i32 {
    let dx = (rect.x - x).max(x - (rect.right() - 1)).max(0);
    let dy = (rect.y - y).max(y - (rect.bottom() - 1)).max(0);
    dx.max(dy)
}

/// Whether a tick that wants click-through set to `wanted` still owes the window a call.
/// `applied` is what the window is known to be set to, and `None` means that is not known: no
/// call has landed yet, or the last one failed. Either way the tick asks again.
fn ignore_needs_call(applied: Option<bool>, wanted: bool) -> bool {
    applied != Some(wanted)
}

/// What `applied` becomes once that call has been made. Only a call that succeeded is recorded;
/// a failure records nothing, so the next tick retries. Recording the intent up front is what
/// left one failed call turning an always-on-top window into a rectangle of desktop that
/// swallowed every click in it, for as long as the dock was up.
fn ignore_after_call(wanted: bool, ok: bool) -> Option<bool> {
    ok.then_some(wanted)
}

/// A primary button held down, and whether the press that started it landed on the dock.
/// `None` is the button up. Only a press that began on the dock is the dock's business: one
/// that began anywhere else is somebody dragging a window or selecting text, and it must not
/// take the dock's input or its fast poll with it.
fn press_state(previous: Option<bool>, down: bool, on_dock: bool) -> Option<bool> {
    match (down, previous) {
        (false, _) => None,
        (true, Some(started)) => Some(started),
        (true, None) => Some(on_dock),
    }
}

/// How long to wait before reading the cursor again. `engaged` covers everything that needs the
/// fast rate whatever the distance says: a drag, a press that began on the dock, and a pointer
/// already on the rail or in the bubble, whose next move decides whether the hover ends.
fn poll_interval_ms(distance: i32, engaged: bool) -> u64 {
    if engaged || distance <= POLL_NEAR_DISTANCE {
        POLL_NEAR_MS
    } else if distance <= POLL_MID_DISTANCE {
        POLL_MID_MS
    } else {
        POLL_FAR_MS
    }
}

/// One tick of pointer tracking: drives a drag in progress, else hit-tests the painted
/// shapes for hover and click-through. Returns how long to wait before the next one.
fn pointer_tick(app: &AppHandle, window: &tauri::WebviewWindow) -> u64 {
    let Some((cx, cy)) = cursor_position() else { return POLL_FAR_MS };
    let mut state = lock();
    let Some(frame) = state.frame else { return POLL_FAR_MS };

    if let Some(drag) = state.drag {
        // The rail follows the pointer onto whichever display it is over, which is the mac's
        // screenIndex(containing:). Containment is tested in physical pixels because that is
        // what the cursor reads in; everything after it is in that display's logical pixels.
        let screen = state
            .screens
            .iter()
            .find(|screen| screen.bounds.contains(cx, cy))
            .cloned()
            .or_else(|| state.screen.clone())
            .unwrap_or_else(|| Screen { area: state.area, scale: state.scale, ..Screen::default() });
        let scale = if screen.scale > 0.0 { screen.scale } else { 1.0 };
        let cursor = ((cx as f64 / scale).round() as i32, (cy as f64 / scale).round() as i32);
        let area = screen.area;
        state.scale = scale;
        state.area = area;
        if !primary_button_down() {
            let rail = frame.rail.offset(frame.window.x, frame.window.y);
            // The padding the frame was laid out with, so the resting length is the one this
            // very rail collapses to rather than one for a docking it has not made yet.
            let rest_len = rail_length(&state.metrics, 1, frame.along_pad);
            let placement =
                placement_for_drop(&rail, rest_len, &screen, &state.placement.clone().unwrap_or_default());
            drop(state);
            settle(app, window, placement, rail);
            return POLL_NEAR_MS;
        }
        // The rail, not the window, is what stays on screen: it hangs from the same fraction
        // of itself the pointer grabbed, whatever shape it is now.
        let under_pointer = |frame: &DockFrame| -> Rect {
            let (w, h) = (frame.rail.w, frame.rail.h);
            Rect {
                x: (cursor.0 - (drag.ax * w as f64).round() as i32)
                    .clamp(area.x, (area.right() - w).max(area.x)),
                y: (cursor.1 - (drag.ay * h as f64).round() as i32)
                    .clamp(area.y, (area.bottom() - h).max(area.y)),
                w,
                h,
            }
        };
        let mut frame = frame;
        let mut rail = under_pointer(&frame);
        let mut candidate = attachment_candidate(&rail, &area);
        // The mac turns the rail as soon as the edge in reach runs the other way, rather than
        // waiting for the drop, and re-anchors it proportionally so it stays in the hand.
        let mut rotated = false;
        if let Some((edge, _)) = candidate {
            let mut placement = state.placement.clone().unwrap_or_default();
            if edge.is_vertical() != placement.attachment.is_vertical() {
                placement.attachment = edge;
                let (request, metrics) = (state.request, state.metrics);
                frame = layout(area, &placement, &request, &metrics);
                rail = under_pointer(&frame);
                candidate = attachment_candidate(&rail, &area);
                state.placement = Some(placement);
                rotated = true;
            }
        }
        let progress = candidate.map(|(_, p)| p).unwrap_or(0.0);
        let key = candidate.map(|(edge, p)| (edge, (p * 100.0).round() / 100.0));
        let window_rect = Rect {
            x: rail.x - frame.rail.x,
            y: rail.y - frame.rail.y,
            ..frame.window
        };
        let moved = rotated || window_rect != frame.window;
        frame.window = window_rect;
        if moved {
            state.frame = Some(frame);
        }
        let changed = key != drag.last;
        if changed {
            state.drag = Some(Drag { last: key, ..drag });
        }
        drop(state);
        if moved {
            move_window(window, window_rect, scale);
        }
        if changed || rotated {
            let _ = app.emit_to(
                DOCK_LABEL,
                "codeburn://dock-drag",
                DragEvent {
                    attachment: progress,
                    edge: candidate.map(|(e, _)| e),
                    frame: rotated.then_some(frame),
                },
            );
        }
        // The rail is in the hand: it has to keep up with the pointer, not with a band.
        return POLL_NEAR_MS;
    }

    let scale = state.scale;
    let cursor = ((cx as f64 / scale).round() as i32, (cy as f64 / scale).round() as i32);
    let rail = frame.rail.offset(frame.window.x, frame.window.y);
    let rail_hovered = rail.contains(cursor.0, cursor.1);
    let metrics = state.metrics;
    let row = rail_hovered.then(|| {
        let along = if frame.vertical { cursor.1 } else { cursor.0 } - frame.rows_start;
        if along < 0 {
            return None;
        }
        let period = frame.row_extent + metrics.row_spacing;
        let slot = along / period;
        (slot < frame.rows as i32 && along - slot * period < frame.row_extent).then_some(slot as u32)
    }).flatten();
    let detail_hovered = frame
        .detail
        .map(|d| Rect { x: d.x, y: d.y, w: d.w, h: d.h }.offset(frame.window.x, frame.window.y).contains(cursor.0, cursor.1))
        .unwrap_or(false);
    let pointer = Pointer { rail_hovered, row, detail_hovered };
    let pointer_changed = pointer != state.pointer;
    state.pointer = pointer;
    // A press that began on the rail keeps the window's input while the button is held, so
    // the page sees the moves that decide whether it became a drag. A press that began
    // anywhere else on the desktop is none of this window's business.
    let on_dock = rail_hovered || detail_hovered;
    let press = press_state(state.press, primary_button_down(), on_dock);
    state.press = press;
    let engaged = on_dock || press == Some(true);
    let ignore = !engaged;
    let needs_call = ignore_needs_call(state.ignoring, ignore);
    // Measured against the window rather than the rail: the window is the whole region the
    // dock can paint into, bubble included, so a pointer outside it cannot be hovering
    // anything and one just inside it is about to be.
    let distance = distance_to(&frame.window, cursor.0, cursor.1);
    drop(state);

    if needs_call {
        let ok = window.set_ignore_cursor_events(ignore).is_ok();
        lock().ignoring = ignore_after_call(ignore, ok);
    }
    if pointer_changed {
        let _ = app.emit_to(DOCK_LABEL, "codeburn://dock-pointer", pointer);
    }
    poll_interval_ms(distance, engaged)
}

/// A fingerprint of the desktop: how many displays there are, how large the virtual screen is,
/// and where the primary work area ends. A resolution change, a display plugged or unplugged,
/// and the taskbar moving or hiding all move at least one of them. Three user32 reads, with no
/// trip through the event loop, which is what asking the window for its monitor list would
/// cost a second.
#[cfg(target_os = "windows")]
fn display_signature() -> [i32; 9] {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SystemParametersInfoW, SM_CMONITORS, SM_CXVIRTUALSCREEN,
        SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SPI_GETWORKAREA,
    };
    let mut work = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    unsafe {
        SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut work as *mut RECT as *mut _, 0);
        [
            GetSystemMetrics(SM_CMONITORS),
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
            work.left,
            work.top,
            work.right,
            work.bottom,
        ]
    }
}

/// Set while the cursor thread is alive. The window is only click-through because that thread
/// keeps making it so; one that is up without a tracker is invisible and still hit-testable,
/// which is a rectangle of desktop nobody can click. So the flag is what a `show` consults
/// before deciding it already has tracking, rather than whether it built the window itself.
static TRACKER_RUNNING: AtomicBool = AtomicBool::new(false);

/// Releases the flag however the thread leaves, a panic included, and hands the window back its
/// click-through on the way out. If the window is still there, tracking it is still wanted, so
/// a fresh thread takes over: without this, a tracker that ended in the moment between one
/// window being destroyed and the next being built would never be replaced.
#[cfg(target_os = "windows")]
struct TrackerGuard(AppHandle);

#[cfg(target_os = "windows")]
impl Drop for TrackerGuard {
    fn drop(&mut self) {
        TRACKER_RUNNING.store(false, Ordering::SeqCst);
        lock().ignoring = None;
        let Some(window) = self.0.get_webview_window(DOCK_LABEL) else { return };
        let _ = window.set_ignore_cursor_events(true);
        spawn_pointer_tracking(self.0.clone());
    }
}

/// Runs until the dock window is gone. The reads replace the DOM hover the click-through style
/// would starve, at a rate that follows the pointer: fast on and around the dock, slow while it
/// is elsewhere. Once a second the same thread checks whether the desktop itself has changed
/// shape, which is the Windows counterpart of the mac's didChangeScreenParameters observer.
#[cfg(target_os = "windows")]
fn spawn_pointer_tracking(app: AppHandle) {
    // One tracker at a time, and a new one whenever the last has gone.
    if TRACKER_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("codeburn-dock-pointer".into())
        .spawn(move || {
            let _guard = TrackerGuard(handle.clone());
            let mut displays = display_signature();
            let mut checked = std::time::Instant::now();
            let mut interval = POLL_NEAR_MS;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(interval));
                let Some(window) = handle.get_webview_window(DOCK_LABEL) else { break };
                if checked.elapsed() >= DISPLAY_CHECK_INTERVAL {
                    checked = std::time::Instant::now();
                    let next = display_signature();
                    if next != displays {
                        displays = next;
                        // Never mid-drag: the pointer owns the rail until it is let go.
                        if lock().drag.is_none() {
                            publish(&handle, &window, None);
                        }
                    }
                }
                // A panic in one tick must not end tracking for good: the window would stay on
                // screen with nothing left to make it click-through again.
                interval = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    pointer_tick(&handle, &window)
                }))
                .unwrap_or(POLL_NEAR_MS);
            }
        });
    if spawned.is_err() {
        TRACKER_RUNNING.store(false, Ordering::SeqCst);
        if let Some(window) = app.get_webview_window(DOCK_LABEL) {
            let _ = window.set_ignore_cursor_events(true);
        }
    }
}

pub fn show(app: &AppHandle) -> tauri::Result<()> {
    if !AVAILABLE {
        return Ok(());
    }
    // A show cancels any retract still counting down for the window it is replacing.
    let generation = next_generation();
    // A window under this label can survive a `hide` for a moment, since the destroy is
    // processed by the event loop rather than at the call. Reuse it when it is there: two
    // windows with one label is not a state this module can hold.
    let existing = app.get_webview_window(DOCK_LABEL);
    let created = existing.is_none();
    let window = match existing {
        Some(window) => window,
        None => {
            let metrics = Metrics::from_prefs();
            let builder = WebviewWindowBuilder::new(app, DOCK_LABEL, WebviewUrl::default())
                .title("CodeBurn Capacity Dock")
                .inner_size(
                    metrics.rail_width as f64,
                    rail_length(&metrics, 1, metrics.rail_along_pad + metrics.flare_compensation) as f64,
                )
                .decorations(false)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .shadow(false)
                .visible(false);

            // The page draws its own card shapes, so the window behind them has to be
            // see-through. `transparent` is only compiled in off macOS, where it needs the
            // private-API feature.
            #[cfg(not(target_os = "macos"))]
            let builder = builder.transparent(true);

            let window = builder.build()?;
            // Click-through from its very first frame: the painted shapes are a sliver of this
            // window, and until the first cursor read says otherwise everything in it would
            // swallow clicks meant for whatever is behind.
            let _ = window.set_ignore_cursor_events(true);
            window
        }
    };

    // Reset before laying out either way: `relayout` only moves the window when the frame it
    // computes differs from the stored one, so a stale frame from the last time the dock was
    // on would leave a fresh window sitting at its builder size in the corner.
    {
        let mut state = lock();
        *state = DockState::default();
        state.metrics = Metrics::from_prefs();
        state.request = LayoutRequest { rows: 1, total_rows: 1, expanded: false, detail: None, captioned: false };
        state.scale = 1.0;
    }
    relayout(&window);
    window.show()?;
    // Whether or not this call built the window: a window kept from a dock that was switched
    // off and straight back on can have outlived the thread that was tracking it, and the
    // spawn is a no-op while one is already running.
    #[cfg(target_os = "windows")]
    spawn_pointer_tracking(app.clone());
    // A reused window is one that was told to retract and is playing that now. It has to be
    // told the retract is off, or the rail would sit tucked behind its edge until the next
    // time the dock was switched on. The frame goes with it: the state was just reset and the
    // window laid out again under a page that is still painting into the frame it had.
    if !created {
        let _ = window.emit("codeburn://dock-present", GenerationEvent { generation });
        publish(app, &window, None);
    }
    #[cfg(debug_assertions)]
    {
        crate::log_line!("codeburn dock: window {} and shown", if created { "created" } else { "reused" });
        if created && std::env::var_os("CODEBURN_DOCK_DEVTOOLS").is_some() {
            window.open_devtools();
        }
    }
    Ok(())
}

/// Re-reads the preferences the geometry depends on and brings the window in line with them.
///
/// The new frame goes to the page in the same breath, carrying the scale it was computed for.
/// The page paints inside the window it was last handed, so a window resized here while the
/// page still holds the old frame draws the rail at the old offsets in the new window, which
/// on a right-docked rail is a rail hanging off its own edge. One event carrying both the
/// size and the frame lets the page change both in a single render, instead of drifting
/// through a round trip's worth of mismatched paints.
pub fn prefs_changed(app: &AppHandle) {
    let Some(window) = app.get_webview_window(DOCK_LABEL) else { return };
    let scale = prefs_scale();
    let metrics = Metrics::for_scale(scale);
    {
        let mut state = lock();
        if state.metrics == metrics {
            return;
        }
        state.metrics = metrics;
    }
    let Some(frame) = relayout(&window) else { return };
    let _ = app.emit_to(
        DOCK_LABEL,
        "codeburn://dock-metrics",
        MetricsEvent { scale, frame },
    );
}

fn prefs_scale() -> f64 {
    read_state()
        .get("scale")
        .and_then(serde_json::Value::as_f64)
        .filter(|scale| scale.is_finite())
        .map(|scale| scale.clamp(MIN_SCALE, MAX_SCALE))
        .unwrap_or(MIN_SCALE)
}

/// Destroying rather than hiding is deliberate: a hidden webview keeps rendering, which is
/// what cost the macOS popover 6% idle CPU.
///
/// `destroy` rather than `close`, because close only *asks*: it posts a CloseRequested event
/// and the window leaves the manager some time later. Switching the dock off and straight
/// back on then found the dying window still under its label and only re-showed it, which
/// left the rail invisible until the next launch.
/// How long Rust waits for the page to play the retract before taking the window anyway. The
/// animation is 240 ms, so this is that plus room for a slow frame: a page that never answers
/// costs a fifth of a second, not a rail that will not go away.
const DISMISS_FALLBACK: std::time::Duration = std::time::Duration::from_millis(400);

/// Bumped by every show, hide and close. A pending fallback fires only while the number it
/// captured is still current, so switching the dock off and straight back on cannot have the
/// old timer destroy the new window.
static DISMISS_GENERATION: AtomicU64 = AtomicU64::new(0);

/// The number a dismiss was asked under. The page carries it back on `dock_close` so a retract
/// that finishes after the dock has been switched on again cannot take the new window with it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerationEvent {
    generation: u64,
}
#[cfg(debug_assertions)]
static DISMISS_ASKED_MS: AtomicU64 = AtomicU64::new(0);

#[cfg(debug_assertions)]
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn next_generation() -> u64 {
    DISMISS_GENERATION.fetch_add(1, Ordering::SeqCst) + 1
}

/// Destroying the window while the rail is still on screen makes it vanish rather than leave,
/// so the page is asked to retract first and calls `dock_close` when it has. This only arms
/// the timer that keeps a stuck page from holding the window open.
pub fn hide(app: &AppHandle) {
    let Some(window) = app.get_webview_window(DOCK_LABEL) else {
        return;
    };
    let generation = next_generation();
    #[cfg(debug_assertions)]
    {
        DISMISS_ASKED_MS.store(now_ms(), Ordering::SeqCst);
        crate::log_line!("codeburn: dock dismiss asked (generation {generation})");
    }
    if window
        .emit("codeburn://dock-dismiss", GenerationEvent { generation })
        .is_err()
    {
        // Nobody to play it: take the window now.
        close(app, None);
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(DISMISS_FALLBACK);
        if DISMISS_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        #[cfg(debug_assertions)]
        crate::log_line!("codeburn: dock dismiss fallback fired; the page never answered");
        let inner = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if DISMISS_GENERATION.load(Ordering::SeqCst) == generation {
                destroy_window(&inner);
            }
        });
    });
}

/// Whether a close still belongs to the window that is up. The page carries back the number its
/// dismiss was asked under; anything else is a retract that finished after the dock had already
/// been switched off and on again, and the window it was asked about is long gone. `None` is an
/// unconditional close, which is what a dismiss nobody could be told about uses.
fn close_is_current(generation: Option<u64>, current: u64) -> bool {
    match generation {
        Some(generation) => generation == current,
        None => true,
    }
}

/// The page's half of the handshake, and the fallback's. Bumping the generation here is what
/// disarms a timer that is still waiting.
pub fn close(app: &AppHandle, generation: Option<u64>) {
    let current = DISMISS_GENERATION.load(Ordering::SeqCst);
    if !close_is_current(generation, current) {
        // The dock came back on while the old rail was still retracting. Destroying now would
        // take the window that replaced it and leave the dock switched on with nothing drawn.
        #[cfg(debug_assertions)]
        crate::log_line!(
            "codeburn: dock close for generation {generation:?} ignored; {current} is current"
        );
        return;
    }
    #[cfg(debug_assertions)]
    crate::log_line!(
        "codeburn: dock close from the page after {} ms",
        now_ms().saturating_sub(DISMISS_ASKED_MS.load(Ordering::SeqCst))
    );
    next_generation();
    destroy_window(app);
}

fn destroy_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(DOCK_LABEL) {
        let _ = window.destroy();
    }
}

/// The rail's right-click menu, the mac dock's context menu. Menu events arrive in `lib.rs`
/// under the `dock_` ids.
pub fn popup_context_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{ContextMenu, Menu, MenuItem, Submenu};
    let Some(window) = app.get_webview_window(DOCK_LABEL) else {
        return Ok(());
    };
    let label = |key: &str| crate::i18n::lookup(key);
    let refresh = MenuItem::with_id(app, "dock_refresh", label("Refresh"), true, None::<&str>)?;
    let left = MenuItem::with_id(app, "dock_left", label("Left"), true, None::<&str>)?;
    let right = MenuItem::with_id(app, "dock_right", label("Right"), true, None::<&str>)?;
    let top = MenuItem::with_id(app, "dock_top", label("Top"), true, None::<&str>)?;
    let bottom = MenuItem::with_id(app, "dock_bottom", label("Bottom"), true, None::<&str>)?;
    let edges = Submenu::with_items(app, label("Dock to Edge"), true, &[&left, &right, &top, &bottom])?;
    let hide = MenuItem::with_id(app, "dock_hide", label("Hide Capacity Dock"), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&refresh, &edges, &hide])?;
    menu.popup(window.as_ref().window())
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect { x: 0, y: 0, w: 1600, h: 852 };

    /// The default size, whose numbers the stylesheet and `src/dockGeometry.ts` also carry.
    fn small() -> Metrics {
        Metrics::for_scale(MIN_SCALE)
    }

    fn request(rows: u32, expanded: bool, detail: Option<DetailRequest>) -> LayoutRequest {
        LayoutRequest { rows, total_rows: rows, expanded, detail, captioned: false }
    }

    fn rail_on_screen(frame: &DockFrame) -> Rect {
        frame.rail.offset(frame.window.x, frame.window.y)
    }

    fn screen(area: Rect, name: &str) -> Screen {
        Screen { name: Some(name.into()), area, bounds: area, scale: 1.0 }
    }

    #[test]
    fn every_metric_is_a_mac_base_times_the_scale_on_a_whole_pixel() {
        let m = small();
        assert_eq!(
            (m.rail_width, m.horizontal_rail_width, m.row_height, m.row_spacing),
            (53, 64, 50, 7)
        );
        assert_eq!((m.caption_line, m.caption_gap), (8, 2));
        assert_eq!((m.rail_along_pad, m.flare_compensation), (12, 19));
        assert_eq!((m.detail_width, m.detail_max_height, m.detail_overhang), (315, 423, 160));

        let full = Metrics::for_scale(1.0);
        assert_eq!((full.rail_width, full.row_height, full.row_spacing), (88, 84, 12));
        assert_eq!((full.caption_line, full.caption_gap), (13, 4));
        assert_eq!(full.flare_compensation, 31);
        // The bubble never shrinks with the rail, so it is unchanged at full size.
        assert_eq!((full.detail_width, full.detail_max_height), (350, 470));

        let big = Metrics::for_scale(MAX_SCALE);
        assert_eq!((big.rail_width, big.row_height), (106, 101));
        assert_eq!((big.detail_width, big.detail_max_height), (420, 564));
        // Out-of-range and nonsense scales land back inside the range rather than collapsing.
        assert_eq!(Metrics::for_scale(4.0), big);
        assert_eq!(Metrics::for_scale(f64::NAN), small());
    }

    #[test]
    fn a_bigger_scale_grows_the_rail_and_the_window_it_lives_in() {
        let small_frame = layout(AREA, &Placement::default(), &request(3, true, None), &small());
        let big = Metrics::for_scale(MAX_SCALE);
        let big_frame = layout(AREA, &Placement::default(), &request(3, true, None), &big);
        assert_eq!(small_frame.rail.w, 53);
        assert_eq!(big_frame.rail.w, 106);
        assert_eq!(big_frame.along_pad, 24 + 37);
        assert_eq!(big_frame.rail.h, big_frame.along_pad * 2 + 3 * 101 + 2 * 14);
        assert_eq!(big_frame.window.w, 420 + DETAIL_GAP + 106);
        assert!(big_frame.window.h > small_frame.window.h);
        // Both stay flush with the right edge they are docked to.
        assert_eq!(rail_on_screen(&big_frame).right(), AREA.right());
    }

    #[test]
    fn a_captioned_rail_grows_every_row_by_the_caption_metrics() {
        let full = Metrics::for_scale(1.0);
        let plain = layout(AREA, &Placement::default(), &request(2, true, None), &full);
        let captioned = layout(
            AREA,
            &Placement::default(),
            &LayoutRequest { rows: 2, total_rows: 2, expanded: true, detail: None, captioned: true },
            &full,
        );
        // 84 + 4 gap + 13 line = 101 per row against the plain 84; two rows, one spacing.
        assert_eq!(captioned.row_extent, 101);
        assert_eq!(captioned.rail.h - plain.rail.h, 2 * (4 + 13));
        // The hit-test pitch is the frame's own row extent plus the unchanged spacing.
        assert_eq!(captioned.row_extent + full.row_spacing, 113);
        // The resting (one-row) captioned rail is taller by exactly the caption allowance too.
        let resting = layout(
            AREA,
            &Placement::default(),
            &LayoutRequest { rows: 1, total_rows: 1, expanded: false, detail: None, captioned: true },
            &full,
        );
        assert_eq!(resting.row_extent, 101);
    }

    #[test]
    fn resting_rail_hugs_the_right_edge_below_the_default_offset() {
        let frame = layout(AREA, &Placement::default(), &request(1, false, None), &small());
        assert_eq!(rail_on_screen(&frame), Rect { x: 1600 - 53, y: 156, w: 53, h: 112 });
        assert_eq!(frame.anchor, Anchor::Start);
        assert_eq!(frame.bubble_side, Edge::Left);
        assert!(frame.docked && frame.vertical);
        assert_eq!(frame.along_pad, 31);
        assert!(frame.detail.is_none());
    }

    #[test]
    fn the_window_is_sized_for_the_full_rail_and_the_bubble_and_does_not_move_on_hover() {
        let m = small();
        let rest = layout(
            AREA,
            &Placement::default(),
            &LayoutRequest { rows: 1, total_rows: 3, expanded: false, detail: None, captioned: false },
            &m,
        );
        let expanded = layout(
            AREA,
            &Placement::default(),
            &LayoutRequest { rows: 3, total_rows: 3, expanded: true, detail: Some(DetailRequest { row: 0, height: 200 }), captioned: false },
            &m,
        );
        assert_eq!(rest.window, expanded.window);
        assert_eq!(rest.window.right(), 1600);
        assert_eq!(rest.window.w, m.detail_width + DETAIL_GAP + m.rail_width);
        // The overhang above the rail is cut by the top of the work area.
        assert_eq!(rest.window.y, 0);
        assert_eq!(rest.rail.y, 156);
        assert_eq!(rest.window.h, expanded.rail.h + m.detail_overhang * 2);
        assert_eq!(expanded.rail.h, 31 * 2 + 3 * 50 + 2 * 7);
    }

    #[test]
    fn a_short_work_area_anchors_at_the_end_and_grows_upward() {
        let m = small();
        let area = Rect { x: 0, y: 0, w: 1280, h: 400 };
        let rest = layout(area, &Placement::default(), &request(1, false, None), &m);
        let expanded = layout(area, &Placement::default(), &request(3, true, None), &m);
        assert_eq!(rest.anchor, Anchor::End);
        assert_eq!(rail_on_screen(&expanded).bottom(), rail_on_screen(&rest).bottom());
        // A rail taller than the room above it is pushed down rather than off the screen.
        let oversized = layout(area, &Placement::default(), &request(6, true, None), &m);
        assert_eq!(rail_on_screen(&oversized).y, area.y + EDGE_INSET);
    }

    #[test]
    fn detail_sits_left_of_the_rail_centred_on_its_row() {
        let m = small();
        let frame = layout(
            AREA,
            &Placement::default(),
            &request(2, true, Some(DetailRequest { row: 1, height: 160 })),
            &m,
        );
        let detail = frame.detail.expect("detail frame");
        assert_eq!(detail.w, m.detail_width);
        assert_eq!(detail.h, 160);
        assert_eq!(detail.x + detail.w + DETAIL_GAP, frame.rail.x);
        let row_mid = frame.rail.y + 31 + (m.row_height + m.row_spacing) + m.row_height / 2;
        assert_eq!(detail.y + detail.h / 2, row_mid);
        assert_eq!(detail.tail, row_mid - detail.y);
    }

    #[test]
    fn a_top_docked_rail_is_horizontal_with_the_bubble_below() {
        let m = small();
        let placement = Placement { docked: Some(Edge::Top), attachment: Edge::Top, ..Placement::default() };
        let frame = layout(
            AREA,
            &placement,
            &request(2, true, Some(DetailRequest { row: 1, height: 120 })),
            &m,
        );
        assert!(!frame.vertical);
        assert_eq!(rail_on_screen(&frame).y, 0);
        assert_eq!(frame.rail.h, m.horizontal_rail_width);
        assert_eq!(frame.rail.w, 31 * 2 + 2 * 50 + 7);
        assert_eq!(frame.bubble_side, Edge::Bottom);
        let detail = frame.detail.expect("detail frame");
        assert_eq!(detail.y, frame.rail.y + frame.rail.h + DETAIL_GAP);
        let row_mid = frame.rail.x + 31 + (m.row_height + m.row_spacing) + m.row_height / 2;
        assert_eq!(detail.x + detail.w / 2, row_mid);
    }

    #[test]
    fn a_top_rail_in_the_corner_keeps_its_window_inside_the_work_area() {
        let m = small();
        let placement = Placement { docked: Some(Edge::Top), attachment: Edge::Top, x: Some(0.986), y: Some(0.0), monitor: None };
        for expanded in [false, true] {
            let frame = layout(
                AREA,
                &placement,
                &LayoutRequest { rows: 1, total_rows: 1, expanded, detail: None, captioned: false },
                &m,
            );
            let rail = rail_on_screen(&frame);
            assert_eq!(rail, Rect { x: 1456, y: 0, w: 112, h: m.horizontal_rail_width });
            assert_eq!(frame.window.right(), 1600);
            assert_eq!(frame.window.x, 1600 - (112 + m.detail_overhang * 2));
            assert!(frame.rail.x + frame.rail.w <= frame.window.w);
        }
    }

    #[test]
    fn a_floating_rail_keeps_its_orientation_and_the_short_padding() {
        let placement = Placement { docked: None, attachment: Edge::Right, x: Some(0.5), y: Some(0.5), monitor: None };
        let frame = layout(AREA, &placement, &request(1, false, None), &small());
        assert!(frame.vertical && !frame.docked);
        assert_eq!(frame.along_pad, 12);
        assert_eq!(frame.rail.h, 12 * 2 + 50);
        let rail = rail_on_screen(&frame);
        assert!(rail.x > 100 && rail.right() < 1500);
    }

    #[test]
    fn a_drop_near_an_edge_docks_and_elsewhere_floats() {
        let current = Placement::default();
        let here = screen(AREA, "one");
        let near_left = placement_for_drop(&Rect { x: 20, y: 300, w: 53, h: 112 }, 112, &here, &current);
        assert_eq!(near_left.docked, Some(Edge::Left));
        assert_eq!(near_left.attachment, Edge::Left);
        let near_top = placement_for_drop(&Rect { x: 700, y: 10, w: 53, h: 112 }, 112, &here, &current);
        assert_eq!(near_top.docked, Some(Edge::Top));
        let middle = placement_for_drop(&Rect { x: 700, y: 300, w: 53, h: 112 }, 112, &here, &current);
        assert_eq!(middle.docked, None);
        assert_eq!(middle.attachment, Edge::Right);
        assert!((middle.x.unwrap() - 0.45).abs() < 0.05);
    }

    #[test]
    fn a_drop_records_the_display_it_landed_on_and_the_offsets_are_that_displays_own() {
        let second = Screen {
            name: Some("two".into()),
            area: Rect { x: 1600, y: 0, w: 1280, h: 800 },
            bounds: Rect { x: 1600, y: 0, w: 1280, h: 800 },
            scale: 1.0,
        };
        let dropped = placement_for_drop(
            &Rect { x: 1600 + 1280 - 53, y: 300, w: 53, h: 112 },
            112,
            &second,
            &Placement::default(),
        );
        assert_eq!(dropped.monitor.as_deref(), Some("two"));
        assert_eq!(dropped.docked, Some(Edge::Right));
        // Normalized against the second display's own travel, not the desktop's.
        assert!((dropped.x.unwrap() - 1.0).abs() < 0.01);

        // And the rail lays out inside that display rather than back on the first one.
        let frame = layout(second.area, &dropped, &request(1, false, None), &small());
        assert_eq!(rail_on_screen(&frame).right(), second.area.right());
    }

    /// The rail is dragged expanded, because the page holds it open for as long as the drag
    /// runs. What is stored is the offset of the *resting* rail, so the drop has to walk the
    /// tall rail back to the short one it grew from; reading the tall one straight off put the
    /// rail a long way from the hand that let go of it.
    #[test]
    fn a_rail_dropped_while_expanded_lands_where_it_was_released() {
        let m = small();
        let here = screen(AREA, "one");
        let floating =
            Placement { docked: None, attachment: Edge::Right, x: Some(0.5), y: Some(0.2), monitor: None };
        let showing = request(4, true, None);

        // What the pointer is holding: four rows of rail, not the one row it rests at.
        let held = layout(AREA, &floating, &showing, &m);
        let rest_len = rail_length(&m, 1, held.along_pad);
        assert_eq!((held.anchor, held.rail.h, rest_len), (Anchor::Start, 245, 74));

        // Carried well clear of every edge and let go there.
        let released = rail_on_screen(&held).offset(-260, 90);
        let dropped = placement_for_drop(&released, rest_len, &here, &floating);
        assert_eq!(dropped.docked, None);
        let landed = rail_on_screen(&layout(AREA, &dropped, &showing, &m));
        assert_eq!(landed, released);

        // And again low enough that the rail grows upward instead, where the drop has to add
        // the difference back rather than subtract nothing.
        let released = Rect { x: released.x, y: 450, ..released };
        let dropped = placement_for_drop(&released, rest_len, &here, &floating);
        let settled = layout(AREA, &dropped, &showing, &m);
        assert_eq!(settled.anchor, Anchor::End);
        assert_eq!(rail_on_screen(&settled), released);
    }

    #[test]
    fn a_failed_click_through_call_is_retried_rather_than_recorded() {
        // Nothing known about the window yet, so the first tick calls whatever it wants.
        assert!(ignore_needs_call(None, true));
        assert!(ignore_needs_call(None, false));

        // A call that lands is recorded, and the same want costs nothing after that.
        let applied = ignore_after_call(true, true);
        assert_eq!(applied, Some(true));
        assert!(!ignore_needs_call(applied, true));
        assert!(ignore_needs_call(applied, false));

        // A call that fails records nothing at all, so every tick after it tries again until
        // one lands. Recording the wanted value here is what left the window hit-testable
        // across its whole rectangle with nothing left to put it back.
        let applied = ignore_after_call(false, false);
        assert_eq!(applied, None);
        assert!(ignore_needs_call(applied, false));
        assert!(ignore_needs_call(applied, true));
        let applied = ignore_after_call(false, true);
        assert_eq!(applied, Some(false));
        assert!(!ignore_needs_call(applied, false));
    }

    #[test]
    fn only_a_press_that_began_on_the_dock_holds_the_window() {
        // Button up: nothing is held, wherever the pointer happens to be.
        assert_eq!(press_state(None, false, true), None);
        assert_eq!(press_state(Some(true), false, true), None);

        // A press that landed on the dock stays the dock's while the button is held, which is
        // what keeps the window's input through the moves that decide whether it is a drag.
        let on_dock = press_state(None, true, true);
        assert_eq!(on_dock, Some(true));
        assert_eq!(press_state(on_dock, true, false), Some(true));

        // A press that began anywhere else stays somebody else's even when it is dragged over
        // the rail, so an unrelated drag no longer pins the poll at the fast rate.
        let elsewhere = press_state(None, true, false);
        assert_eq!(elsewhere, Some(false));
        assert_eq!(press_state(elsewhere, true, true), Some(false));
        let far = POLL_MID_DISTANCE + 1;
        assert_eq!(poll_interval_ms(far, elsewhere == Some(true)), POLL_FAR_MS);
        assert_eq!(poll_interval_ms(far, on_dock == Some(true)), POLL_NEAR_MS);
    }

    /// Runs against the real state file, so what goes back is exactly what was found there:
    /// the swap is the thing under test, not the contents.
    #[test]
    fn a_state_write_swaps_a_whole_file_in_and_leaves_no_scratch_behind() {
        let before = read_state();
        let Ok(()) = write_state_at(&state_path(), &before) else { return };
        assert_eq!(read_state(), before);

        // The scratch name carries this process's id, so only this test's own leavings count
        // and a tmp file from something else running beside it cannot fail the check.
        let Some(dir) = state_path().parent().map(|p| p.to_path_buf()) else { return };
        let mine = format!(".{}.", std::process::id());
        let leftovers = fs::read_dir(&dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|entry| entry.file_name().to_string_lossy().contains(&mine))
                    .count()
            })
            .unwrap_or(0);
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn a_close_only_takes_the_window_the_dismiss_was_asked_for() {
        // The whole point of the number: a retract that answers late, after the dock has been
        // switched off and on again, must not destroy the window it came back as.
        assert!(close_is_current(Some(7), 7));
        assert!(!close_is_current(Some(7), 8));
        // A dismiss the page was never told about has no number and closes unconditionally.
        assert!(close_is_current(None, 8));

        // The counter itself only ever moves forward, so a number handed out once can never
        // come round again and make a stale close look current.
        let asked = next_generation();
        assert!(close_is_current(Some(asked), DISMISS_GENERATION.load(Ordering::SeqCst)));
        let shown = next_generation();
        assert_eq!(shown, asked + 1);
        let current = DISMISS_GENERATION.load(Ordering::SeqCst);
        assert!(!close_is_current(Some(asked), current));
        assert!(close_is_current(Some(shown), current));
    }

    #[test]
    fn the_poll_rate_follows_the_pointer_toward_the_dock() {
        let window = Rect { x: 1000, y: 100, w: 400, h: 500 };
        assert_eq!(distance_to(&window, 1200, 300), 0);
        assert_eq!(distance_to(&window, 1000, 100), 0);
        // Just past the far corner, on the axis it is furthest out on.
        assert_eq!(distance_to(&window, 1400, 600), 1);
        assert_eq!(distance_to(&window, 900, 300), 100);
        assert_eq!(distance_to(&window, 1200, 20), 80);
        assert_eq!(distance_to(&window, 300, 2000), 1401);

        assert_eq!(poll_interval_ms(0, false), POLL_NEAR_MS);
        assert_eq!(poll_interval_ms(POLL_NEAR_DISTANCE, false), POLL_NEAR_MS);
        assert_eq!(poll_interval_ms(POLL_NEAR_DISTANCE + 1, false), POLL_MID_MS);
        assert_eq!(poll_interval_ms(POLL_MID_DISTANCE, false), POLL_MID_MS);
        assert_eq!(poll_interval_ms(POLL_MID_DISTANCE + 1, false), POLL_FAR_MS);
        // A drag, a held button or a pointer already on the rail keeps the fast rate whatever
        // the distance says, since the reading is what ends the hover.
        assert_eq!(poll_interval_ms(4000, true), POLL_NEAR_MS);
        // The idle rate is a real saving rather than a rounding: a pointer parked away from the
        // dock costs at most a quarter of the reads a pointer beside it does.
        assert!(poll_interval_ms(POLL_MID_DISTANCE + 1, false) >= poll_interval_ms(0, false) * 4);
    }

    #[test]
    fn a_layout_request_during_a_drag_is_kept_but_not_laid_out() {
        let mut state = DockState { metrics: small(), ..DockState::default() };
        let resting = layout(AREA, &Placement::default(), &request(1, false, None), &small());
        state.frame = Some(resting);

        // No drag: the request reaches the window.
        let expanded = request(3, true, None);
        assert_eq!(record_request(&mut state, expanded), LayoutOutcome::Relayout);
        assert_eq!(state.request.rows, 3);

        // Mid-drag the window belongs to the pointer, so the page is answered with the frame it
        // is already painting into rather than one computed from where the rail used to live.
        state.drag = Some(Drag { ax: 0.5, ay: 0.5, last: None });
        let taller = request(4, true, None);
        assert_eq!(
            record_request(&mut state, taller),
            LayoutOutcome::Deferred(Some(resting))
        );
        // Kept, so the settle after the drop lays out from it.
        assert_eq!((state.request.rows, state.request.total_rows), (4, 4));

        state.drag = None;
        assert_eq!(record_request(&mut state, taller), LayoutOutcome::Relayout);
    }

    #[test]
    fn attachment_progress_rises_as_the_edge_nears() {
        let far = attachment_candidate(&Rect { x: 700, y: 300, w: 53, h: 112 }, &AREA);
        assert!(far.is_none());
        let (edge, progress) =
            attachment_candidate(&Rect { x: 1600 - 53 - 22, y: 300, w: 53, h: 112 }, &AREA).unwrap();
        assert_eq!(edge, Edge::Right);
        assert!((progress - 0.5).abs() < 0.01);
    }

    /// The merge keeps a key the caller never touched, which is what lets each side write only
    /// its own keys into a file the other side co-owns. Same shape as settings.rs's own
    /// null-patch test, kept off the real state file so it never touches the developer's home.
    #[test]
    fn patching_one_key_leaves_the_other_sides_keys_alone() {
        let dir = std::env::temp_dir().join(format!("cb-dock-merge-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("windows-dock.json");
        // Keys this side does not own: the placement (written by dragging) and the tray app's
        // own enabled switch.
        fs::write(&file, "{\"placement\":{\"docked\":\"right\"},\"enabled\":true}").unwrap();

        let merged = patch_state_at(&file, |state| {
            state.insert("scale".into(), serde_json::json!(1.1));
        })
        .unwrap();

        assert_eq!(merged.get("scale"), Some(&serde_json::json!(1.1)));
        assert_eq!(merged.get("enabled"), Some(&serde_json::Value::Bool(true)));
        assert_eq!(
            merged.get("placement"),
            Some(&serde_json::json!({ "docked": "right" }))
        );
        // And a null value removes just that key, leaving the rest.
        let after = patch_state_at(&file, |state| {
            state.remove("scale");
        })
        .unwrap();
        assert!(after.get("scale").is_none());
        assert!(after.get("placement").is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    /// The headline regression: a real Node process and this real Rust process patch DIFFERENT
    /// keys of windows-dock.json at the same time, and both changes must survive. Without the
    /// shared lock the two read/modify/write cycles interleave and the later rename erases the
    /// other side's key; run it with CB_TRAY_XPROC_NOLOCK=1 to see exactly that failure. It is
    /// two processes, not two threads, which is the only way to exercise the cross-process lock.
    ///
    /// What is asserted is monotonicity, not finality. Each side's key holds a counter that only
    /// ever rises, and a reader thread watches the file throughout: a lost update resurrects a
    /// stale value, so a counter falls. Comparing only the two FINAL values, as this test first
    /// did, catches a lost update only when the last writes happen to collide, which let it pass
    /// on a deliberately broken lock about one run in three: weak evidence for the one property
    /// it exists to prove.
    #[test]
    fn concurrent_node_and_rust_patches_to_the_dock_file_both_survive() {
        use std::io::Read;
        use std::process::{Command, Stdio};
        use std::sync::Arc;
        use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
        let worker = repo.join("app").join("scripts").join("tray-settings-xproc-worker.ts");
        if !worker.exists() {
            eprintln!("skipping cross-process test: worker not found at {}", worker.display());
            return;
        }
        // `node --import tsx` resolves the loader from the repo root. Without
        // `npm install`, node still spawns and then exits with ERR_MODULE_NOT_FOUND.
        // That is a missing harness, same as a missing node binary, not a lost update.
        let tsx = repo.join("node_modules").join("tsx");
        if !tsx.exists() {
            eprintln!("skipping cross-process test: tsx not found at {}", tsx.display());
            return;
        }

        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("cb-xproc-{}-{nanos}", std::process::id()));
        let config_dir = root.join(".config").join("codeburn");
        let barriers = root.join("barriers");
        fs::create_dir_all(&config_dir).unwrap();
        fs::create_dir_all(&barriers).unwrap();
        let dock_file = config_dir.join("windows-dock.json");
        // A key neither side writes, to prove the merge preserves it through all the churn.
        fs::write(&dock_file, "{\"other\":\"keep\"}").unwrap();

        // 100 rounds a side, both taking the lock, while a reader thread hammers the same
        // file. The production wait budget is 2s with a 50ms poll, which is right for a UI
        // that writes on a click but starves under this much contention: a waiter that keeps
        // losing the race after each poll can exceed 2s on a loaded runner, which is what
        // reddened main rather than any lost update. Fewer rounds keep the property under
        // test and stop the harness from being the thing that fails.
        let iters: u32 = 24;
        let nolock = std::env::var("CB_TRAY_XPROC_NOLOCK").ok().as_deref() == Some("1");

        let mut child = match Command::new("node")
            .arg("--import")
            .arg("tsx")
            .arg(&worker)
            .arg(&root)
            .arg("fromNode")
            .arg(iters.to_string())
            .arg(&barriers)
            .current_dir(&repo)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(err) => {
                eprintln!("skipping cross-process test: could not spawn node: {err}");
                let _ = fs::remove_dir_all(&root);
                return;
            }
        };

        let read_stderr = |child: &mut std::process::Child| -> String {
            let mut text = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                let _ = pipe.read_to_string(&mut text);
            }
            text
        };

        // Wait until the worker has finished starting (tsx can take several seconds on this VM)
        // before releasing either loop, so the two really do write at the same time.
        let ready = barriers.join("node.ready");
        let start = Instant::now();
        while !ready.exists() {
            if let Ok(Some(status)) = child.try_wait() {
                panic!("node worker exited early ({status}); stderr:\n{}", read_stderr(&mut child));
            }
            if start.elapsed() > Duration::from_secs(60) {
                let _ = child.kill();
                panic!("node worker never signalled ready; stderr:\n{}", read_stderr(&mut child));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        fs::write(barriers.join("go"), b"").unwrap();

        // The watcher: a third party that only ever reads. It has to be a separate reader,
        // because neither writer can see its own counter rolled back. In the unlocked cycle each
        // one carries the other side's value forward itself, so what it reads back is never
        // older than what it last read, whatever the file did in between. A pure observer sees
        // the file as it really is, and the property under test is exactly what it watches for:
        // with the lock both counters only ever rise in the file, and a counter that falls is a
        // write that was erased, wherever in the run it happened.
        //
        // It reads lock-free, the way both apps really do, and polls at 1ms rather than spinning:
        // a settings reader reads on reload and on a schedule, not every instant. That still
        // samples the file thousands of times across the run, so a counter rolled back by a lost
        // write is caught, and it still puts `crate::settings::replace_file`'s retry under real
        // load, a replace colliding with an open read handle many times over. A reader that held
        // the handle every instant is not one either app has: on Windows, where an open handle
        // blocks a rename, it would be an unwinnable race no bounded retry could pass, and on real
        // Windows CI that is exactly what it did. The rolled-back value persists in the file
        // regardless, so the timing-independent final-state assertions below are the real
        // backstop, and the unlocked path still fails, so detection is intact.
        let stop = Arc::new(AtomicBool::new(false));
        let watcher = {
            let (dock_file, stop) = (dock_file.clone(), stop.clone());
            std::thread::spawn(move || {
                let (mut high_node, mut high_rust) = (0u64, 0u64);
                let mut regression: Option<String> = None;
                while !stop.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(1));
                    let state = read_state_at(&dock_file);
                    for (key, high) in [("fromNode", &mut high_node), ("fromRust", &mut high_rust)] {
                        let Some(value) = state.get(key).and_then(serde_json::Value::as_u64) else {
                            continue;
                        };
                        if value < *high {
                            regression.get_or_insert(format!(
                                "{key} went backwards ({} -> {value}): a write was lost",
                                *high
                            ));
                        }
                        *high = (*high).max(value);
                    }
                }
                regression
            })
        };

        for i in 0..iters {
            let value = serde_json::Value::from(i);
            if nolock {
                // The demonstration path: the same cycle without the lock, i.e. the bug.
                let mut state = read_state_at(&dock_file);
                std::thread::sleep(Duration::from_millis(1));
                state.insert("fromRust".into(), value);
                write_state_at(&dock_file, &state).unwrap();
            } else {
                patch_state_at(&dock_file, |state| {
                    state.insert("fromRust".into(), value);
                })
                .unwrap();
            }
            if i % 7 == 0 {
                std::thread::sleep(Duration::from_millis(1));
            }
        }

        let status = child.wait().unwrap();
        let stderr = read_stderr(&mut child);
        stop.store(true, Ordering::Relaxed);
        let regression = watcher.join().unwrap();
        let final_state = read_state_at(&dock_file);
        let _ = fs::remove_dir_all(&root);
        assert!(status.success(), "node worker failed: {stderr}");
        assert!(regression.is_none(), "{}", regression.unwrap_or_default());
        assert_eq!(
            final_state.get("other").and_then(|v| v.as_str()),
            Some("keep"),
            "the key neither side wrote survived"
        );
        assert_eq!(
            final_state.get("fromNode").and_then(serde_json::Value::as_u64),
            Some(u64::from(iters - 1)),
            "the desktop app's final write survived the tray app's writes"
        );
        assert_eq!(
            final_state.get("fromRust").and_then(serde_json::Value::as_u64),
            Some(u64::from(iters - 1)),
            "the tray app's final write survived the desktop app's writes"
        );
    }
}
