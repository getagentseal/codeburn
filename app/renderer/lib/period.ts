import type { DailyHistoryEntry, Period } from './types'

// The CLI emits `history.daily` as a SPARSE list of active days only (not a
// backfilled calendar). Charts must zero-fill inactive days client-side to keep
// the time axis honest; helpers here own that windowing.

/** Local calendar date key "YYYY-MM-DD", matching the CLI's `dateKey` (src/day-aggregator.ts). */
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Aligned to src/cli-date.ts:getDateRange so client windows match CLI totals.
const ALL_TIME_MONTHS = 6

/** Inclusive lower bound (date key) of the selected period's window, matching the CLI. */
export function periodWindowStart(period: Period, now = new Date()): string {
  switch (period) {
    case 'today':
      return localDateKey(now)
    case 'week':
      return localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7))
    case '30days':
      return localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30))
    case 'month':
      return localDateKey(new Date(now.getFullYear(), now.getMonth(), 1))
    case 'all':
      return localDateKey(new Date(now.getFullYear(), now.getMonth() - ALL_TIME_MONTHS, 1))
    case 'lifetime':
      // src/cli-date.ts anchors the unbounded window at 1970-01-01.
      return localDateKey(new Date(1970, 0, 1))
  }
}

/** The payload's history.daily is capped to this many most-recent active days
 * (menubar-json HISTORY_DAYS_LIMIT). At the cap the array's oldest entry is no
 * longer the true data start, so no-data classification must switch off rather
 * than mislabel real (aged-out) history on long custom ranges. */
const HISTORY_DAYS_CAP = 365

/**
 * Earliest recorded day in the sparse `history.daily`, or null when it is
 * empty or at the server-side cap (at the cap the true start is unknowable
 * from the payload, and null disables no-data classification entirely rather
 * than mislabeling aged-out history).
 *
 * Days before this key render as "no data recorded". That label is literally
 * true even for the edge where CodeBurn was installed earlier but idle until
 * its first recorded activity: nothing was recorded those days either.
 */
export function dataStartKey(daily: DailyHistoryEntry[]): string | null {
  if (daily.length >= HISTORY_DAYS_CAP) return null
  let earliest: string | null = null
  for (const day of daily) {
    if (earliest === null || day.date < earliest) earliest = day.date
  }
  return earliest
}

/** `history.daily` entries within the selected period's date window. */
export function sliceDailyToPeriod(daily: DailyHistoryEntry[], period: Period, now = new Date()): DailyHistoryEntry[] {
  const start = periodWindowStart(period, now)
  const todayKey = localDateKey(now)
  return daily.filter(d => d.date >= start && d.date <= todayKey)
}

/** `history.daily` entries within an explicit [from..to] date-key range (custom range). */
export function sliceDailyToRange(daily: DailyHistoryEntry[], from: string, to: string): DailyHistoryEntry[] {
  return daily.filter(d => d.date >= from && d.date <= to)
}

function zeroEntry(date: string): DailyHistoryEntry {
  return {
    date,
    cost: 0,
    savingsUSD: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    topModels: [],
  }
}

/**
 * Contiguous calendar window [fromKey..toKey] with exactly one entry per day.
 * Real (sparse) `history.daily` entries fill their day; inactive days are
 * zero-filled so the chart axis reflects true calendar spacing. Keys are local
 * YYYY-MM-DD (localDateKey / the CLI's dateKey), so lookups always match.
 */
export function contiguousDailyWindow(daily: DailyHistoryEntry[], fromKey: string, toKey: string): DailyHistoryEntry[] {
  if (fromKey > toKey) return []
  const byDate = new Map(daily.map(d => [d.date, d]))
  const [fy, fm, fd] = fromKey.split('-').map(Number)
  const [ty, tm, td] = toKey.split('-').map(Number)
  const cursor = new Date(fy, fm - 1, fd)
  const end = new Date(ty, tm - 1, td)
  const out: DailyHistoryEntry[] = []
  while (cursor <= end) {
    const key = localDateKey(cursor)
    out.push(byDate.get(key) ?? zeroEntry(key))
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

/** Format a local date key for compact chart-axis labels such as "Jul 1". */
export function formatChartDate(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleString('en-US', { month: 'short', day: 'numeric' })
}
