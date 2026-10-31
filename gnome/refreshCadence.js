// Power-aware tick interval for the GNOME panel.
//
// Matches the Auto mode of the macOS menubar: 120s on AC, 150s on battery
// and 300s in power saver. The menu fetches when it opens, so there is no
// faster "active" tier. A tick does not force a CLI run: it goes through the
// same 5-minute payload cache as period and provider switches.

export const AC_SECONDS = 120
export const BATTERY_SECONDS = 150
export const LOW_POWER_SECONDS = 300

// GSettings range for refresh-interval.
const CONFIGURED_MIN_SECONDS = 5
const CONFIGURED_MAX_SECONDS = 300

export function powerFloorSeconds({ onBattery = false, lowPowerMode = false } = {}) {
  if (lowPowerMode) return LOW_POWER_SECONDS
  if (onBattery) return BATTERY_SECONDS
  return AC_SECONDS
}

/**
 * Seconds until the next tick. The refresh-interval setting is honored when
 * it is slower than the power floor; a faster setting is raised to the
 * floor. A missing or out-of-range setting is treated as the floor.
 * Unknown power (no UPower) is AC.
 */
export function refreshIntervalSeconds({
  onBattery = false,
  lowPowerMode = false,
  configuredSeconds = 0,
} = {}) {
  const floor = powerFloorSeconds({ onBattery, lowPowerMode })
  const n = Number(configuredSeconds)
  if (!Number.isFinite(n) || n <= 0) return floor
  const configured = Math.min(CONFIGURED_MAX_SECONDS, Math.max(CONFIGURED_MIN_SECONDS, Math.round(n)))
  return Math.max(configured, floor)
}
