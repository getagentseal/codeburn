import type { DateRange } from './types.js'
import { toDateString } from './daily-cache.js'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const END_OF_DAY_HOURS = 23
const END_OF_DAY_MINUTES = 59
const END_OF_DAY_SECONDS = 59
const END_OF_DAY_MS = 999

// "All Time" is intentionally bounded to the last 6 months. Older data is
// rarely actionable for a cost tracker, and capping the range keeps the parse
// path bounded so providers like Codex/Cursor with sparse multi-year history
// still load in seconds. Users who need an unbounded window can use
// `--from` / `--to`.
const ALL_TIME_MONTHS = 6

export type Period = 'today' | 'week' | '30days' | 'month' | 'all'

export const PERIODS: Period[] = ['today', 'week', '30days', 'month', 'all']

// Short labels suitable for the dashboard tab strip. Long-form labels for
// header text come from `getDateRange().label`.
export const PERIOD_LABELS: Record<Period, string> = {
  today: 'Today',
  week: '7 Days',
  '30days': '30 Days',
  month: 'This Month',
  all: '6 Months',
}

const VALID_PERIODS: ReadonlyArray<Period> = ['today', 'week', '30days', 'month', 'all']

export function toPeriod(s: string): Period {
  if ((VALID_PERIODS as readonly string[]).includes(s)) return s as Period
  // Fail loudly instead of silently coercing to 'week'. Previously a typo
  // like `-p mounth` produced a quiet 7-day report and the user thought
  // they were viewing the month.
  process.stderr.write(
    `codeburn: unknown period "${s}". Valid values: ${VALID_PERIODS.join(', ')}.\n`
  )
  process.exit(1)
}

function parseLocalDate(s: string): Date {
  if (!ISO_DATE_RE.test(s)) {
    throw new Error(`Invalid date format "${s}": expected YYYY-MM-DD`)
  }
  const [y, m, d] = s.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d)
}

export function parseDateRangeFlags(from: string | undefined, to: string | undefined): DateRange | null {
  if (from === undefined && to === undefined) return null

  const now = new Date()
  // When --from is omitted, default to 6 months back (the same window the
  // dashboard's "all" period uses) instead of epoch. Previously a bare
  // `--to 2026-01-01` opened a 55-year scan from 1970 which is rarely what
  // the user meant and is expensive on machines with many session files.
  const ALL_TIME_FALLBACK_MS = 6 * 31 * 24 * 60 * 60 * 1000
  const start = from !== undefined
    ? parseLocalDate(from)
    : new Date(now.getTime() - ALL_TIME_FALLBACK_MS)

  const endDate = to !== undefined ? parseLocalDate(to) : new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(
    endDate.getFullYear(),
    endDate.getMonth(),
    endDate.getDate(),
    END_OF_DAY_HOURS,
    END_OF_DAY_MINUTES,
    END_OF_DAY_SECONDS,
    END_OF_DAY_MS,
  )

  if (start > end) {
    throw new Error(`--from must not be after --to (got ${from} > ${to})`)
  }
  return { start, end }
}

/**
 * Returns the date range and a human-readable label for a named period.
 *
 * Accepts a string (rather than the strict `Period` type) because the CLI
 * surfaces a few extra inputs not exposed in the dashboard tab strip
 * (e.g. `'yesterday'`). Unknown values fall back to `'week'`.
 *
 * Note: `'all'` is bounded to the last 6 months. Use `--from`/`--to` for
 * an unbounded historical window.
 */
export function getDateRange(period: string): { range: DateRange; label: string } {
  const now = new Date()
  const end = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    END_OF_DAY_HOURS,
    END_OF_DAY_MINUTES,
    END_OF_DAY_SECONDS,
    END_OF_DAY_MS,
  )

  switch (period) {
    case 'today': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      return { range: { start, end }, label: `Today (${toDateString(start)})` }
    }
    case 'yesterday': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
      const yesterdayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, END_OF_DAY_HOURS, END_OF_DAY_MINUTES, END_OF_DAY_SECONDS, END_OF_DAY_MS)
      return { range: { start, end: yesterdayEnd }, label: `Yesterday (${toDateString(start)})` }
    }
    case 'week': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7)
      return { range: { start, end }, label: 'Last 7 Days' }
    }
    case 'month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      return { range: { start, end }, label: `${now.toLocaleString('default', { month: 'long' })} ${now.getFullYear()}` }
    }
    case '30days': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30)
      return { range: { start, end }, label: 'Last 30 Days' }
    }
    case 'all': {
      const start = new Date(now.getFullYear(), now.getMonth() - ALL_TIME_MONTHS, 1)
      return { range: { start, end }, label: 'Last 6 months' }
    }
    default: {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7)
      return { range: { start, end }, label: 'Last 7 Days' }
    }
  }
}

export function formatDateRangeLabel(from: string | undefined, to: string | undefined): string {
  return `${from ?? 'all'} to ${to ?? 'today'}`
}
