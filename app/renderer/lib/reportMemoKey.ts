import { localDateKey } from './period'
import type { DesktopProjectScopeKey } from './projectScope'
import type { DateRange, Period } from './types'

/** Identity for a durable report snapshot. Today and Month include the local
 * calendar boundary so yesterday's exact answer can never paint under today's
 * label after midnight; rolling/historical horizons remain reusable. */
export function reportMemoKey(
  section: string,
  period: Period,
  provider = 'all',
  range: DateRange | null = null,
  variant = '',
  scopeOrNow: DesktopProjectScopeKey | Date = 'all',
  now = new Date(),
): string {
  const scope = scopeOrNow instanceof Date ? 'all' : scopeOrNow
  const boundaryNow = scopeOrNow instanceof Date ? scopeOrNow : now
  const boundary = period === 'today'
    ? localDateKey(boundaryNow)
    : period === 'month'
      ? `${boundaryNow.getFullYear()}-${String(boundaryNow.getMonth() + 1).padStart(2, '0')}`
      : ''
  const base = `${section}|${period}|${provider}|${range?.from ?? ''}-${range?.to ?? ''}|${variant}|${boundary}`
  return scope === 'all' ? base : `${base}|${scope}`
}
