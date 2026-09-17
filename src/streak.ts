import { toDateString, type DailyEntry } from './daily-cache.js'

/**
 * Consecutive days with any recorded activity, ending today or yesterday.
 *
 * One definition for every surface. The streak is a property of the machine's
 * history, not of the panel it sits next to, so it is computed across all
 * providers and is independent of the selected period and provider filter —
 * otherwise the same pill reads 21, 32, 38 or 55 depending on which tab is
 * open. A day that has not happened yet does not break a run, so the count
 * starts at yesterday until the first session of the day lands.
 */
export function activityStreak(days: DailyEntry[], now = new Date()): number {
  const active = new Set<string>()
  for (const day of days) {
    if (day.cost > 0 || day.calls > 0) active.add(day.date)
  }
  const dayAt = (offset: number) =>
    toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset))
  let streak = 0
  for (let offset = active.has(dayAt(0)) ? 0 : 1; active.has(dayAt(offset)); offset++) streak++
  return streak
}
