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
