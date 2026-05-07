import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  getDateRange,
  PERIODS,
  PERIOD_LABELS,
  toPeriod,
  type Period,
} from '../src/cli-date.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('getDateRange', () => {
  it('"all" is bounded to the last 6 months, not epoch', () => {
    const { range, label } = getDateRange('all')
    const now = new Date()

    expect(label).toBe('Last 6 months')

    // Regression guard: must never silently fall back to epoch (the old
    // dashboard bug) or any pre-2000 date.
    expect(range.start.getFullYear()).toBeGreaterThan(2000)

    const monthsDiff =
      (now.getFullYear() - range.start.getFullYear()) * 12 +
      (now.getMonth() - range.start.getMonth())
    expect(monthsDiff).toBe(6)
    expect(range.start.getDate()).toBe(1)

    // End is today, end of day.
    expect(range.end.getHours()).toBe(23)
    expect(range.end.getMinutes()).toBe(59)
  })

  it('"all" does not overflow past the target month at end-of-month', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 31, 12, 0, 0))

    const { range } = getDateRange('all')

    expect(range.start.getFullYear()).toBe(2026)
    expect(range.start.getMonth()).toBe(1)
    expect(range.start.getDate()).toBe(1)
  })

  it('"week" returns the last 7 days', () => {
    const { range, label } = getDateRange('week')
    expect(label).toBe('Last 7 Days')
    // start = midnight 7 days ago, end = today 23:59:59.999 -> ~8 days span.
    const diffDays = (range.end.getTime() - range.start.getTime()) / (1000 * 60 * 60 * 24)
    expect(diffDays).toBeGreaterThanOrEqual(7)
    expect(diffDays).toBeLessThanOrEqual(8)
  })

  it('"month" starts on day 1 of the current month', () => {
    const { range } = getDateRange('month')
    expect(range.start.getDate()).toBe(1)
    expect(range.start.getHours()).toBe(0)
  })

  it('"30days" returns 30 days back', () => {
    const { range, label } = getDateRange('30days')
    expect(label).toBe('Last 30 Days')
    const diffDays = (range.end.getTime() - range.start.getTime()) / (1000 * 60 * 60 * 24)
    expect(diffDays).toBeGreaterThanOrEqual(30)
    expect(diffDays).toBeLessThanOrEqual(31)
  })

  it('"today" starts at local midnight', () => {
    const { range } = getDateRange('today')
    expect(range.start.getHours()).toBe(0)
    expect(range.start.getMinutes()).toBe(0)
    expect(range.end.getHours()).toBe(23)
  })

  it('"yesterday" is supported (CLI-only convenience)', () => {
    const { range, label } = getDateRange('yesterday')
    expect(label).toMatch(/^Yesterday/)
    expect(range.start.getHours()).toBe(0)
    expect(range.end.getHours()).toBe(23)
  })

  it('unknown period falls back to "week"', () => {
    const fallback = getDateRange('not-a-period')
    const week = getDateRange('week')
    expect(fallback.label).toBe(week.label)
  })
})

describe('PERIODS / PERIOD_LABELS', () => {
  it('exposes the expected period set', () => {
    expect(PERIODS).toEqual(['today', 'week', '30days', 'month', 'all'])
  })

  it('has a label for every period', () => {
    for (const p of PERIODS) {
      expect(PERIOD_LABELS[p]).toBeTruthy()
    }
  })

  it('"all" tab label reflects the 6-month bound', () => {
    // Short label used in the dashboard tab strip. The long-form label
    // ("Last 6 months") comes from getDateRange().label.
    expect(PERIOD_LABELS.all).toBe('6 Months')
  })
})

describe('toPeriod', () => {
  it('round-trips known periods', () => {
    const known: Period[] = ['today', 'week', '30days', 'month', 'all']
    for (const p of known) {
      expect(toPeriod(p)).toBe(p)
    }
  })

  it('exits with an error on unknown input instead of silently falling back', () => {
    // Previously toPeriod silently fell back to 'week' for any unrecognized
    // value, which let typos like `-p mounth` produce a quiet 7-day report
    // while the user thought they were viewing the month. The new behavior
    // is to fail loudly via process.exit(1) after writing to stderr.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') }) as unknown as ReturnType<typeof vi.spyOn>
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(() => toPeriod('garbage')).toThrow('exit')
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(stderrSpy).toHaveBeenCalled()
    } finally {
      exitSpy.mockRestore()
      stderrSpy.mockRestore()
    }
  })
})
