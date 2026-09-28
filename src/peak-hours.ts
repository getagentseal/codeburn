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
//   CREDITS, not to USD pricing.
//
// Design: this module only classifies a call's timestamp into
// peak/off-peak/unknown. Costs are never repriced here — the report splits
// the stored list-rate cost between the windows, so the legs always add back
// up to the Cost column. Repricing (DeepSeek's 0.5x bill) is the vendor's
// job; showing guessed dollars here would double-discount routes whose cost
// was already reported with the discount applied.
//
// Classification is restricted to first-party routes: the vendor's discount
// only exists where the vendor bills directly. The same model reached through
// a gateway (OpenRouter, vercel-gateway, Bedrock routes, ...) pays the
// gateway's uniform price, and providers in REPORTED_COST_PROVIDERS (or calls
// with `costFromBilling`) may already carry the discount in their reported
// cost. The first-party set below must therefore stay disjoint from
// REPORTED_COST_PROVIDERS; a provider joining that set can never appear here.

import { resolveCanonicalModelId } from './models.js'

/// How a route's vendor treats peak-hour usage.
export type PeakBillingKind =
  /// DeepSeek API: 0.5x USD bill during off-peak hours.
  | 'deepseek-usd'
  /// Z.ai coding plan: 0.5x plan-credit rate off-peak; USD pricing untouched.
  | 'zai-credits'

export type PeakClass = 'peak' | 'off-peak' | 'unknown'

// Chinese public holidays (observed dates, YYYY-MM-DD), verified against the
// State Council's announcements. Only the date matters: any DeepSeek call
// landing on one of these days is off-peak for the whole day. Years are NOT
// projected ahead — future holiday dates would be guesses; a year not covered
// here treats weekdays as peak (never underestimates cost), and
// deepSeekHolidayCoverageYears() lets a test fail the moment the current
// year drops out of the list.
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
])

/// Years the DeepSeek holiday calendar above covers. A test pins the current
/// year to this set so the calendar cannot silently go stale.
export function deepSeekHolidayCoverageYears(): ReadonlySet<number> {
  const years = new Set<number>()
  for (const key of CHINESE_PUBLIC_HOLIDAYS) years.add(Number(key.slice(0, 4)))
  return years
}

// Z.ai promotional all-day off-peak windows as [start, end] SGT calendar
// dates, both inclusive (docs.z.ai announcements). Unlike the DeepSeek
// holiday calendar these are temporary: when a range passes, it simply stops
// matching — nothing extrapolates it, and no new entry is owed.
// 2026-09-25..2026-10-07: Mid-Autumn + National Day promotion; every hour of
// the plan is off-peak.
const ZAI_OFF_PEAK_PROMOTIONS: ReadonlyArray<readonly [string, string]> = [
  ['2026-09-25', '2026-10-07'],
]

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
/// 06:00-10:00 UTC every day — no timezone database needed. Promotional
/// all-day off-peak windows override the weekly schedule.
export function isZaiPeak(instant: Date): boolean {
  // The promotion runs on Z.ai's own calendar days (SGT), so read the date
  // key from UTC+8, not UTC.
  const sgtKey = utcDateKey(new Date(instant.getTime() + 8 * 3_600_000))
  if (ZAI_OFF_PEAK_PROMOTIONS.some(([start, end]) => sgtKey >= start && sgtKey <= end)) return false
  if (!isWeekdayUtc(instant)) return false
  const minutes = instant.getUTCHours() * 60 + instant.getUTCMinutes()
  return minutes >= 360 && minutes < 600
}

/// Providers whose calls bill directly with the vendor and therefore carry
/// its peak/off-peak regime. Everything else — gateways, resellers, tools
/// that merely serve the same models — must stay out: their price is uniform
/// across the day (or already discounted in a reported cost), so splitting
/// their usage would misattribute a discount they never had. Keep disjoint
/// from REPORTED_COST_PROVIDERS in src/parser.ts.
const FIRST_PARTY_PEAK_PROVIDERS: ReadonlyMap<string, PeakBillingKind> = new Map([
  // DeepSeek Harness: DeepSeek's own CLI, billed on the DeepSeek API account.
  ['dsh', 'deepseek-usd'],
  // ZCode: the GLM Coding Plan client, billed in Z.ai plan credits.
  ['zcode', 'zai-credits'],
])

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

/// Which peak-billing regime a call falls under, if any: the provider must
/// bill first-party with the vendor, and the model must be one of the
/// vendor's. Gateway prefixes (cliproxy/, orcarouter/, ...) resolve through
/// the canonical id first, but a gateway provider still fails the gate.
export function peakBillingKind(provider: string, model: string): PeakBillingKind | null {
  const kind = FIRST_PARTY_PEAK_PROVIDERS.get(provider)
  if (!kind) return null
  if (!model || typeof model !== 'string') return null
  const leaf = canonicalLeaf(model)
  const patterns = kind === 'deepseek-usd' ? DEEPSEEK_PEAK_MODEL_PATTERNS : ZAI_PEAK_MODEL_PATTERNS
  return patterns.some(pattern => pattern.test(leaf)) ? kind : null
}

function parseInstant(timestamp: string | undefined): Date | null {
  if (!timestamp || typeof timestamp !== 'string') return null
  const time = Date.parse(timestamp)
  if (!Number.isFinite(time)) return null
  return new Date(time)
}

/// Classify one call's timestamp for its route's peak regime.
/// 'unknown' when the route has no peak pricing or the timestamp is
/// missing/invalid — never guessed.
export function classifyPeak(provider: string, model: string, timestamp: string | undefined): PeakClass {
  const kind = peakBillingKind(provider, model)
  if (!kind) return 'unknown'
  const instant = parseInstant(timestamp)
  if (!instant) return 'unknown'
  const peak = kind === 'deepseek-usd' ? isDeepSeekPeak(instant) : isZaiPeak(instant)
  return peak ? 'peak' : 'off-peak'
}
