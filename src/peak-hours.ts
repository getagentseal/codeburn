// Peak-hours billing windows for vendors that price peak vs off-peak usage.
//
// Sources (checked 2026-09-25):
// - DeepSeek API docs (api-docs.deepseek.com/quick_start/pricing): off-peak
//   rates are half (0.5x) of the peak (list) rates. Peak hours are 01:00-04:00
//   and 06:00-10:00 UTC, Monday-Friday, excluding Chinese public holidays.
//   Everything else (nights, weekends, CN holidays) is off-peak.
// - Z.ai GLM Coding Plan (docs.z.ai/devpack/overview): off-peak usage is
//   charged at 50% of the standard credit rate. Peak hours are Monday-Friday
//   14:00-18:00 Singapore time (SGT = UTC+8). The discount applies to plan
//   CREDITS, not to USD pricing, so GLM calls are classified but never
//   repriced in dollars.
//
// Design: costs stored on a call stay at the peak (list) rate — the number an
// API user actually sees on their bill. This module only classifies a call's
// timestamp into peak/off-peak/unknown so aggregation can split usage.

import { resolveCanonicalModelId } from './models.js'

/// How a model's vendor treats peak-hour usage.
export type PeakBillingKind =
  /// DeepSeek API: real USD discount (0.5x) during off-peak hours.
  | 'deepseek-usd'
  /// Z.ai coding plan: 0.5x plan-credit rate off-peak; USD pricing untouched.
  | 'zai-credits'

export type PeakClass = 'peak' | 'off-peak' | 'unknown'

/// Off-peak multiplier shared by both vendors: off-peak costs half.
export const OFF_PEAK_MULTIPLIER = 0.5

// Chinese public holidays (observed dates, YYYY-MM-DD) for the years around
// now. Only the date matters: any DeepSeek call landing on one of these days
// is off-peak for the whole day. Conservative fallback: a year not covered
// here treats weekdays as peak (never underestimates cost).
const CHINESE_PUBLIC_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2025: New Year 01-01; Spring Festival 01-28..02-04; Qingming 04-04;
  // Labour Day 05-01..05-05; Dragon Boat 05-31..06-02;
  // Mid-Autumn + National Day 10-01..10-08.
  '2025-01-01',
  '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31',
  '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04',
  '2025-04-04',
  '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05',
  '2025-05-31', '2025-06-01', '2025-06-02',
  '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04',
  '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08',
  // 2026: New Year 01-01; Spring Festival 02-16..02-22 (eve 02-16);
  // Qingming 04-06; Labour Day 05-01..05-05; Dragon Boat 06-19;
  // Mid-Autumn 09-25; National Day 10-01..10-07.
  '2026-01-01',
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22',
  '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19',
  '2026-09-25',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
  // 2027: New Year 01-01; Spring Festival 02-06..02-12; Qingming 04-05;
  // Labour Day 05-01..05-05; Dragon Boat 06-09;
  // Mid-Autumn 09-15; National Day 10-01..10-07.
  '2027-01-01',
  '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09',
  '2027-02-10', '2027-02-11', '2027-02-12',
  '2027-04-05',
  '2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05',
  '2027-06-09',
  '2027-09-15',
  '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04',
  '2027-10-05', '2027-10-06', '2027-10-07',
])

function utcDateKey(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function isWeekdayUtc(date: Date): boolean {
  const day = date.getUTCDay()
  return day >= 1 && day <= 5
}

/// True when the instant falls in a DeepSeek peak window: Mon-Fri 01:00-04:00
/// or 06:00-10:00 UTC, excluding Chinese public holidays (full days off-peak).
export function isDeepSeekPeak(instant: Date): boolean {
  if (!isWeekdayUtc(instant)) return false
  if (CHINESE_PUBLIC_HOLIDAYS.has(utcDateKey(instant))) return false
  const minutes = instant.getUTCHours() * 60 + instant.getUTCMinutes()
  return (minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600)
}

/// True when the instant falls in a Z.ai peak window: Mon-Fri 14:00-18:00
/// Singapore time. SGT is UTC+8 with no DST, so 14:00-18:00 SGT is exactly
/// 06:00-10:00 UTC every day — no timezone database needed.
export function isZaiPeak(instant: Date): boolean {
  if (!isWeekdayUtc(instant)) return false
  const minutes = instant.getUTCHours() * 60 + instant.getUTCMinutes()
  return minutes >= 360 && minutes < 600
}

function canonicalLeaf(model: string): string {
  return resolveCanonicalModelId(model).toLowerCase()
}

const DEEPSEEK_PEAK_MODEL_PATTERNS = [
  /^deepseek-chat/,
  /^deepseek-reasoner/,
  /^deepseek-v4/,
  /^deepseek-flash/,
  /^deepseek-v3/,
  /^deepseek-r1/,
  /^deepseek-coder/,
]

const ZAI_PEAK_MODEL_PATTERNS = [
  /^glm-/,
  /^z-ai\//,
  /^zai\./,
  /^zhipu\//,
]

/// Which peak-billing regime a model falls under, if any. Gateway prefixes
/// (cliproxy/, orcarouter/, ...) resolve through the canonical id first.
export function peakBillingKind(model: string): PeakBillingKind | null {
  if (!model || typeof model !== 'string') return null
  const leaf = canonicalLeaf(model)
  for (const pattern of DEEPSEEK_PEAK_MODEL_PATTERNS) {
    if (pattern.test(leaf)) return 'deepseek-usd'
  }
  for (const pattern of ZAI_PEAK_MODEL_PATTERNS) {
    if (pattern.test(leaf)) return 'zai-credits'
  }
  return null
}

function parseInstant(timestamp: string | undefined): Date | null {
  if (!timestamp || typeof timestamp !== 'string') return null
  const time = Date.parse(timestamp)
  if (!Number.isFinite(time)) return null
  return new Date(time)
}

/// Classify one call's timestamp for its model's peak regime.
/// 'unknown' when the model has no peak pricing or the timestamp is
/// missing/invalid — never guessed.
export function classifyPeak(model: string, timestamp: string | undefined): PeakClass {
  const kind = peakBillingKind(model)
  if (!kind) return 'unknown'
  const instant = parseInstant(timestamp)
  if (!instant) return 'unknown'
  const peak = kind === 'deepseek-usd' ? isDeepSeekPeak(instant) : isZaiPeak(instant)
  return peak ? 'peak' : 'off-peak'
}

/// USD multiplier for a DeepSeek call at the given timestamp: 1 at peak,
/// 0.5 off-peak, 1 when unclassifiable (stored cost stays at list rate).
/// GLM/Z.ai models always return 1 — their discount is in plan credits.
export function peakCostMultiplier(model: string, timestamp: string | undefined): number {
  if (peakBillingKind(model) !== 'deepseek-usd') return 1
  return classifyPeak(model, timestamp) === 'off-peak' ? OFF_PEAK_MULTIPLIER : 1
}

// --- Live status -----------------------------------------------------------
//
// One-shot / watch / gate math for `codeburn peak`. Pure functions of an
// instant (default: now), so `--at <ISO>` replays any moment deterministically
// and tests pin the boundaries without touching the clock.

export type PeakVendor = 'deepseek' | 'glm'

export type PeakStatus = {
  vendor: PeakVendor
  /// 'peak' | 'off-peak' right now (holidays/weekends already folded in).
  state: Exclude<PeakClass, 'unknown'>
  /// The instant the state next flips, always in the future.
  flipsAt: Date
  /// Whole seconds from `at` until flipsAt.
  secondsUntilFlip: number
}

/// Minute-of-day window edges in UTC. DeepSeek peak is 01:00-04:00 and
/// 06:00-10:00 UTC; the Z.ai 14:00-18:00 SGT window is 06:00-10:00 UTC
/// (SGT = UTC+8, no DST).
const DEEPSEEK_WINDOWS: Array<[number, number]> = [[60, 240], [360, 600]]
const ZAI_WINDOWS: Array<[number, number]> = [[360, 600]]

function isHolidayUtcDay(date: Date): boolean {
  return CHINESE_PUBLIC_HOLIDAYS.has(utcDateKey(date))
}

/// Weekday on the vendor's billing calendar. Z.ai bills on Singapore days;
/// DeepSeek's docs state the windows in UTC, so both read here in UTC except
/// the DeepSeek holiday check, which is a UTC calendar date.
function isBillingWeekday(vendor: PeakVendor, date: Date): boolean {
  void vendor
  return isWeekdayUtc(date)
}

function windowsFor(vendor: PeakVendor): Array<[number, number]> {
  return vendor === 'deepseek' ? DEEPSEEK_WINDOWS : ZAI_WINDOWS
}

function inWindows(windows: Array<[number, number]>, minutes: number): boolean {
  return windows.some(([start, end]) => minutes >= start && minutes < end)
}

function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

/// Next UTC instant (strictly after `fromMs`) whose minute-of-day equals
/// `targetMinutes`, honoring the caller's day filter.
function nextDayWithMinute(fromMs: number, targetMinutes: number, dayOk: (day: Date) => boolean): number {
  const from = new Date(fromMs)
  const todayStart = startOfUtcDay(from)
  const fromMinutes = from.getUTCHours() * 60 + from.getUTCMinutes() + from.getUTCSeconds() / 60 + from.getUTCMilliseconds() / 60000
  if (targetMinutes > fromMinutes && dayOk(from)) return todayStart + targetMinutes * 60_000
  let dayStart = todayStart + 86_400_000
  for (let i = 0; i < 366; i++) {
    if (dayOk(new Date(dayStart))) return dayStart + targetMinutes * 60_000
    dayStart += 86_400_000
  }
  // Unreachable: a full year always contains a weekday. Fail closed on a far
  // future flip rather than throwing inside a status command.
  return dayStart + targetMinutes * 60_000
}

/// Live peak state for one vendor at `at` (default: now), plus the next flip.
/// A Chinese-holiday DeepSeek day is off-peak whole-day: the next flip is the
/// next working day's first window edge.
export function peakStatus(vendor: PeakVendor, at: Date = new Date()): PeakStatus {
  const windows = windowsFor(vendor)
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes()
  const holiday = vendor === 'deepseek' && isHolidayUtcDay(at)
  const weekday = isBillingWeekday(vendor, at)
  const peak = !holiday && weekday && inWindows(windows, minutes)
  const state = peak ? 'peak' : 'off-peak'

  let flipsAtMs: number
  if (peak) {
    // End of the window we are inside.
    const end = windows.find(([start, end]) => minutes >= start && minutes < end)![1]!
    flipsAtMs = startOfUtcDay(at) + end * 60_000
  } else {
    const dayOk = (day: Date): boolean => {
      if (!isBillingWeekday(vendor, day)) return false
      if (vendor === 'deepseek' && isHolidayUtcDay(day)) return false
      return true
    }
    // Next window start strictly after now: a same-day edge at exactly-now
    // minute precision would read as "0s" only when the seconds already
    // passed it; nextDayWithMinute compares with sub-minute precision.
    const starts = windows.map(([start]) => start).sort((a, b) => a - b)
    flipsAtMs = Number.POSITIVE_INFINITY
    for (const start of starts) {
      const candidate = nextDayWithMinute(at.getTime(), start, dayOk)
      if (candidate < flipsAtMs) flipsAtMs = candidate
    }
  }
  const flipsAt = new Date(flipsAtMs)
  return { vendor, state, flipsAt, secondsUntilFlip: Math.max(0, Math.round((flipsAtMs - at.getTime()) / 1000)) }
}

/// 'H:MM:SS' (or 'M:SS' under an hour) for countdown display.
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const seconds = s % 60
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes)
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`
}

/// 'Mon 14:00 SGT' style label for a flip instant, disambiguating the
/// weekend boundary the UTC clock hides (Fri 16:00 UTC = Fri 24:00 SGT).
export function formatFlipSgt(instant: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const sgt = new Date(instant.getTime() + 8 * 3_600_000)
  const label = `${days[sgt.getUTCDay()]} ${String(sgt.getUTCHours()).padStart(2, '0')}:${String(sgt.getUTCMinutes()).padStart(2, '0')} SGT`
  return label
}

/// One-line status: `● OFF-PEAK — peak in 2h14m (GLM 14:00 SGT / 06:00 UTC)`.
/// `compact` drops the parenthetical for prompt segments (`🐋 OFF-PEAK 1:35:06`).
export function describePeakStatus(status: PeakStatus, opts: { compact?: boolean } = {}): string {
  const dot = status.state === 'peak' ? '◉' : '●'
  const label = status.state === 'peak' ? 'PEAK' : 'OFF-PEAK'
  const countdown = formatCountdown(status.secondsUntilFlip)
  if (opts.compact) return `${dot} ${label} ${countdown}`
  const vendor = status.vendor === 'deepseek' ? 'DeepSeek' : 'GLM'
  const next = status.state === 'peak' ? 'off-peak' : 'peak'
  const flipUtc = `${String(status.flipsAt.getUTCHours()).padStart(2, '0')}:${String(status.flipsAt.getUTCMinutes()).padStart(2, '0')} UTC`
  return `${dot} ${label} — ${next} in ${countdown} (${vendor} flips ${formatFlipSgt(status.flipsAt)} / ${flipUtc})`
}
