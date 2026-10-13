// Activity-aware spawn interval for the GNOME panel.
//
// Mirrors mac/Sources/CodeBurnMenubar/RefreshCadence.swift (and the Windows
// port in windows/src-tauri/src/refresh.rs): fast while the user is looking
// or a session is still working, slower once everything is idle, and slower
// again on battery and in power saver. The nap backstop constants match
// CodeBurnApp.startNapBackstop; GNOME Shell does not App Nap the extension,
// so that scheduler is not armed (see napBackstopPlan).
//
// The CLI dashboard is a different control. `getRefreshIntervalMs` in
// src/dashboard.tsx floors an explicit `--refresh` at 60s and never adapts.
// The panel follows the menubar intervals below, whose idle floors all sit
// at or above that 60s CLI minimum. The active interval stays 30s so an open
// menu matches the menubar rather than the dashboard flag.

export const ACTIVE_SECONDS = 30
export const AC_IDLE_SECONDS = 120
export const BATTERY_IDLE_SECONDS = 150
export const LOW_POWER_IDLE_SECONDS = 300

// A live session waiting on the user rather than generating. Same threshold
// as LiveSession.idleThresholdSeconds in the macOS menubar.
export const SESSION_IDLE_THRESHOLD_SECONDS = 120

// CLI dashboard floor (`getRefreshIntervalMs`). Not applied to the active
// menubar interval; documented so the two policies stay comparable.
export const CLI_MIN_REFRESH_SECONDS = 60

// NSBackgroundActivityScheduler interval and tolerance. The menubar arms
// this because App Nap can coalesce its 30s timer. The tick still has to
// pass the same cadence gate; it is not a faster poll.
export const NAP_BACKSTOP_INTERVAL_SECONDS = 180
export const NAP_BACKSTOP_TOLERANCE_SECONDS = 60

// GSettings range for refresh-interval. A missing or hand-edited value falls
// back to the active cadence, which is also the schema default.
const CONFIGURED_MIN_SECONDS = 5
const CONFIGURED_MAX_SECONDS = 300

export function normalizeConfiguredSeconds(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ACTIVE_SECONDS
  return Math.min(CONFIGURED_MAX_SECONDS, Math.max(CONFIGURED_MIN_SECONDS, Math.round(n)))
}

// Absence of the block means the CLI did not compute it ("unknown"), not
// "nothing is running". Unknown does not count as active, so a closed menu
// can still take the idle interval. An empty list was computed and is idle.
// A session with no idleSeconds reads as not idle, matching the menubar.
export function sessionsAreActive(liveSessions) {
  const sessions = liveSessions?.sessions
  if (!Array.isArray(sessions) || sessions.length === 0) return false
  return sessions.some(session => {
    const idle = session?.idleSeconds
    if (idle == null) return true
    const seconds = Number(idle)
    if (!Number.isFinite(seconds)) return true
    return seconds <= SESSION_IDLE_THRESHOLD_SECONDS
  })
}

/**
 * Seconds until the next CLI spawn.
 *
 * `menuOpen` is the GNOME popup, the counterpart of the menubar's
 * `popoverOpen`. A working session counts as active too, so the panel
 * number keeps up while an agent is writing even if the menu is closed.
 *
 * The GNOME refresh-interval setting is kept:
 * - while active, the interval is the setting capped at the menubar's
 *   active cadence (a shorter setting is honored; a longer one still
 *   catches up while someone is looking or a session is working)
 * - while idle, the interval is at least the power-aware floor, and a
 *   setting slower than that floor is honored
 *
 * Unknown power (UPower missing) is AC. Callers pass `onBattery` and
 * `lowPowerMode` as false in that case, which is the extension's previous
 * behavior of not inventing a battery penalty.
 */
export function refreshIntervalSeconds({
  menuOpen = false,
  sessionsActive = false,
  onBattery = false,
  lowPowerMode = false,
  configuredSeconds = ACTIVE_SECONDS,
} = {}) {
  const configured = normalizeConfiguredSeconds(configuredSeconds)
  if (menuOpen || sessionsActive) return Math.min(configured, ACTIVE_SECONDS)
  const idle = lowPowerMode
    ? LOW_POWER_IDLE_SECONDS
    : onBattery
      ? BATTERY_IDLE_SECONDS
      : AC_IDLE_SECONDS
  return Math.max(configured, idle)
}

/**
 * App Nap backstop. `applies` is false here: GNOME Shell runs this
 * extension on its own main loop and does not nap it, so a second timer
 * would only duplicate the cadence timer. The menubar intervals stay in
 * the plan so a later port can arm the same scheduler without retuning it.
 */
export function napBackstopPlan() {
  return {
    applies: false,
    intervalSeconds: NAP_BACKSTOP_INTERVAL_SECONDS,
    toleranceSeconds: NAP_BACKSTOP_TOLERANCE_SECONDS,
  }
}
