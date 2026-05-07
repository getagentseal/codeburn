import { describe, it, expect } from 'vitest'
import { formatDateRangeLabel, parseDateRangeFlags } from '../src/cli-date.js'

describe('parseDateRangeFlags', () => {
  it('returns null when neither flag is provided', () => {
    expect(parseDateRangeFlags(undefined, undefined)).toBeNull()
  })

  it('parses a symmetric range in local time', () => {
    const range = parseDateRangeFlags('2026-04-07', '2026-04-10')
    expect(range).not.toBeNull()
    expect(range!.start.getFullYear()).toBe(2026)
    expect(range!.start.getMonth()).toBe(3)
    expect(range!.start.getDate()).toBe(7)
    expect(range!.start.getHours()).toBe(0)
    expect(range!.end.getDate()).toBe(10)
    expect(range!.end.getHours()).toBe(23)
    expect(range!.end.getMinutes()).toBe(59)
    expect(range!.end.getSeconds()).toBe(59)
  })

  it('accepts --from alone (open-ended to today 23:59:59)', () => {
    const range = parseDateRangeFlags('2026-04-01', undefined)
    expect(range).not.toBeNull()
    expect(range!.start.getDate()).toBe(1)
    expect(range!.end.getHours()).toBe(23)
  })

  it('accepts --to alone with a 6-month default start', () => {
    // Previously the missing --from defaulted to epoch (1970), opening a
    // 55-year scan window that was almost never what the user meant. The
    // default is now 6 months back from now, matching the dashboard's
    // "6 Months" period boundary.
    const range = parseDateRangeFlags(undefined, '2026-04-10')
    expect(range).not.toBeNull()
    expect(range!.start.getTime()).toBeGreaterThan(new Date(0).getTime())
    const sixMonthsMs = 6 * 31 * 24 * 60 * 60 * 1000
    const ageMs = Date.now() - range!.start.getTime()
    expect(ageMs).toBeLessThanOrEqual(sixMonthsMs + 1000)
    expect(ageMs).toBeGreaterThanOrEqual(sixMonthsMs - 1000)
    expect(range!.end.getDate()).toBe(10)
  })

  it('throws when --from > --to', () => {
    expect(() => parseDateRangeFlags('2026-04-10', '2026-04-07'))
      .toThrow('--from must not be after --to')
  })

  it('throws on a non-ISO string', () => {
    expect(() => parseDateRangeFlags('April 7', undefined))
      .toThrow('Invalid date format')
  })

  it('throws on wrong digit count', () => {
    expect(() => parseDateRangeFlags('26-4-7', undefined))
      .toThrow('Invalid date format')
  })

  it('rejects month/day overflow instead of silently rolling forward', () => {
    // Without overflow validation, JS Date silently turns Feb 31 into Mar 3
    // and 13/32 into 02/01 of the following year. That made `--from
    // 2026-02-31 --to 2026-03-15` quietly drop sessions on Feb 28 - Mar 2.
    expect(() => parseDateRangeFlags('2026-02-31', '2026-03-15'))
      .toThrow('Invalid date "2026-02-31"')
    expect(() => parseDateRangeFlags('2026-13-01', undefined))
      .toThrow('Invalid date "2026-13-01"')
    expect(() => parseDateRangeFlags('2026-04-31', undefined))
      .toThrow('Invalid date "2026-04-31"')
    expect(() => parseDateRangeFlags(undefined, '2026-02-30'))
      .toThrow('Invalid date "2026-02-30"')
    // Leap-day check: 2024 is a leap year, 2025 is not.
    expect(parseDateRangeFlags('2024-02-29', '2024-03-01')).not.toBeNull()
    expect(() => parseDateRangeFlags('2025-02-29', undefined))
      .toThrow('Invalid date "2025-02-29"')
  })

  it('same day is valid (start midnight, end 23:59:59)', () => {
    const range = parseDateRangeFlags('2026-04-10', '2026-04-10')
    expect(range).not.toBeNull()
    expect(range!.start.getDate()).toBe(10)
    expect(range!.end.getDate()).toBe(10)
  })

  it('formats custom range labels consistently', () => {
    expect(formatDateRangeLabel('2026-04-07', '2026-04-10')).toBe('2026-04-07 to 2026-04-10')
    expect(formatDateRangeLabel(undefined, '2026-04-10')).toBe('all to 2026-04-10')
    expect(formatDateRangeLabel('2026-04-07', undefined)).toBe('2026-04-07 to today')
  })
})
