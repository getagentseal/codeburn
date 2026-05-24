import { describe, expect, it } from 'vitest'

import { buildPeriodSeries, lifetimeMonthSpan } from '../gnome/trend-series.js'

function monthEntries(startYear: number, startMonth: number, endYear: number, endMonth: number) {
  const entries: Array<{
    date: string
    cost: number
    calls: number
    inputTokens: number
    outputTokens: number
  }> = []
  let year = startYear
  let month = startMonth
  let index = 0

  while (year < endYear || (year === endYear && month <= endMonth)) {
    entries.push({
      date: `${year}-${String(month).padStart(2, '0')}-15`,
      cost: 10 + index,
      calls: 20 + index,
      inputTokens: 1_000 + index * 100,
      outputTokens: 250 + index * 25,
    })

    month += 1
    index += 1
    if (month === 13) {
      month = 1
      year += 1
    }
  }

  return entries
}

describe('GNOME trend cadence helper', () => {
  const now = new Date(2026, 4, 24, 12)

  it('uses intraday buckets for Today when intraday history is available', () => {
    const series = buildPeriodSeries('today', {
      history: {
        intraday: [
          { bucketStartHour: 0, bucketEndHour: 4, cost: 1, calls: 2, inputTokens: 100, outputTokens: 25 },
          { bucketStartHour: 4, bucketEndHour: 8, cost: 2, calls: 3, inputTokens: 200, outputTokens: 50 },
        ],
        daily: [],
      },
    }, now)

    expect(series.windowLabel).toBe('Today')
    expect(series.points).toHaveLength(2)
    expect(series.points.map(point => point.label)).toEqual(['12 AM - 4 AM', '4 AM - 8 AM'])
  })

  it('uses weekly aggregation for 6 Months', () => {
    const series = buildPeriodSeries('all', {
      history: {
        daily: monthEntries(2025, 12, 2026, 5),
        intraday: [],
      },
    }, now)

    expect(series.windowLabel).toBe('Recent 26 weeks')
    expect(series.points).toHaveLength(26)
    expect(series.points[0]?.label).toMatch(/^Week of /)
    expect(series.points.at(-1)?.isCurrent).toBe(true)
  })

  it('keeps Lifetime monthly through 24 months', () => {
    const daily = monthEntries(2025, 12, 2026, 5)
    const series = buildPeriodSeries('lifetime', { history: { daily, intraday: [] } }, now)

    expect(lifetimeMonthSpan(daily, now)).toBe(6)
    expect(series.windowLabel).toBe('All time by month')
    expect(series.points).toHaveLength(6)
    expect(series.points.map(point => point.label)).toEqual([
      'Dec 2025',
      'Jan 2026',
      'Feb 2026',
      'Mar 2026',
      'Apr 2026',
      'May 2026',
    ])
  })

  it('switches Lifetime to quarterly after 24 months', () => {
    const daily = monthEntries(2023, 1, 2026, 5)
    const series = buildPeriodSeries('lifetime', { history: { daily, intraday: [] } }, now)

    expect(lifetimeMonthSpan(daily, now)).toBe(41)
    expect(series.windowLabel).toBe('All time by quarter')
    expect(series.points).toHaveLength(14)
    expect(series.points[0]?.label).toBe('Q1 2023')
    expect(series.points.at(-1)?.label).toBe('Q2 2026')
  })

  it('switches Lifetime to yearly beyond 60 months', () => {
    const daily = monthEntries(2020, 1, 2026, 5)
    const series = buildPeriodSeries('lifetime', { history: { daily, intraday: [] } }, now)

    expect(lifetimeMonthSpan(daily, now)).toBe(77)
    expect(series.windowLabel).toBe('All time by year')
    expect(series.points).toHaveLength(7)
    expect(series.points.map(point => point.label)).toEqual([
      '2020',
      '2021',
      '2022',
      '2023',
      '2024',
      '2025',
      '2026',
    ])
  })
})