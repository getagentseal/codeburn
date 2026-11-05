/// Claude subscription usage as returned by the Rust `plan_usage` command, plus the
/// projection math from the macOS PlanInsight so both apps draw the same marker.

export type PlanWindow = {
  key: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | string
  label: string
  percent: number
  resets_at: string | null
  previous_final: number | null
}

export type PlanUsage =
  | { state: 'ok'; tier: string; raw_tier: string | null; windows: PlanWindow[]; fetched_at: string }
  | { state: 'no_credentials' }
  | { state: 'failed'; message: string }

export type PlanProjection = {
  percent: number
  willOverflow: boolean
  source: 'linear' | 'historical'
}

const HOUR_SECONDS = 3600
const DAY_SECONDS = 86_400
const FIVE_HOUR_SECONDS = 5 * HOUR_SECONDS
const SEVEN_DAY_SECONDS = 7 * DAY_SECONDS
const THIRTY_DAY_SECONDS = 30 * DAY_SECONDS
/// Below this fraction of the window the linear extrapolation is noise; fall back to
/// last cycle's final reading instead.
const FRESH_WINDOW_THRESHOLD = 0.05
const FULL_PERCENT = 100

function windowSeconds(key: string): number {
  return key === 'five_hour' ? FIVE_HOUR_SECONDS : SEVEN_DAY_SECONDS
}

/// How long a quota window from `codeburn quota` runs. The CLI reports a label and a reset
/// time but not a length, and the projection needs one to know how far into the window we
/// are. Anything unrecognised gets no projection rather than a made-up one.
export function windowSecondsForLabel(label: string): number | null {
  const text = label.toLowerCase()
  if (text.includes('month')) return THIRTY_DAY_SECONDS
  if (text.includes('week')) return SEVEN_DAY_SECONDS
  if (text.includes('daily') || text.includes('day')) return DAY_SECONDS
  const hours = text.match(/(\d+)\s*-?\s*hour/) ?? (text.includes('five-hour') ? ['', '5'] : null)
  if (hours) return Number(hours[1]) * HOUR_SECONDS
  return null
}

/// Linear extrapolation once the window is past the freshness threshold, else last cycle's
/// final reading. Shared by the Claude credential path and the CLI quota rows.
export function project(
  percent: number,
  resetsAt: Date,
  seconds: number,
  previousFinal: number | null,
  now = new Date(),
): PlanProjection | null {
  const windowStart = resetsAt.getTime() / 1000 - seconds
  const elapsed = now.getTime() / 1000 - windowStart
  const elapsedFraction = elapsed / seconds

  if (elapsedFraction > FRESH_WINDOW_THRESHOLD && percent > 0) {
    const projected = percent / elapsedFraction
    return { percent: projected, willOverflow: projected > FULL_PERCENT, source: 'linear' }
  }

  if (previousFinal != null) {
    return {
      percent: previousFinal,
      willOverflow: previousFinal > FULL_PERCENT,
      source: 'historical',
    }
  }
  return null
}

export function projectWindow(window: PlanWindow, now = new Date()): PlanProjection | null {
  if (!window.resets_at) return null
  const resetsAt = new Date(window.resets_at)
  if (Number.isNaN(resetsAt.getTime())) return null
  return project(window.percent, resetsAt, windowSeconds(window.key), window.previous_final, now)
}

/// The same projection for a window the CLI reported, which carries no prior-cycle baseline.
export function projectQuotaWindow(
  label: string,
  percent: number,
  resetsAt: string | undefined,
  now = new Date(),
): PlanProjection | null {
  if (!resetsAt) return null
  const at = new Date(resetsAt)
  if (Number.isNaN(at.getTime())) return null
  const seconds = windowSecondsForLabel(label)
  if (seconds === null) return null
  return project(percent, at, seconds, null, now)
}

export function earliestReset(windows: PlanWindow[]): Date | null {
  const dates = windows
    .map(w => (w.resets_at ? new Date(w.resets_at) : null))
    .filter((d): d is Date => d !== null && !Number.isNaN(d.getTime()))
  if (dates.length === 0) return null
  return dates.reduce((a, b) => (a < b ? a : b))
}
