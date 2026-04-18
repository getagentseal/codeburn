import type { DateRange } from './types.js'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const END_OF_DAY_HOURS = 23
const END_OF_DAY_MINUTES = 59
const END_OF_DAY_SECONDS = 59
const END_OF_DAY_MS = 999

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
  const start = from !== undefined ? parseLocalDate(from) : new Date(0)

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
