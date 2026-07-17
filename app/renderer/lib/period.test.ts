import { describe, expect, it } from 'vitest'

import type { DailyHistoryEntry, Period } from './types'
import { contiguousDailyWindow, formatChartDate, periodWindowStart, sliceDailyToPeriod } from './period'

function entry(date: string): DailyHistoryEntry {
  return {
    date,
    cost: 1,
    savingsUSD: 0,
    calls: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    topModels: [],
  }
}

const NOW = new Date(2026, 6, 10, 12, 0, 0)
const DAILY = [
  entry('2026-05-31'),
  entry('2026-06-01'),
  entry('2026-06-10'),
  entry('2026-06-11'),
  entry('2026-07-01'),
  entry('2026-07-03'),
  entry('2026-07-04'),
  entry('2026-07-09'),
  entry('2026-07-10'),
  entry('2026-07-11'),
]

describe('sliceDailyToPeriod', () => {
  it.each<[Period, string[]]>([
    ['today', ['2026-07-10']],
    // Window boundaries mirror src/cli-date.ts: week = now-7, 30days = now-30.
    ['week', ['2026-07-03', '2026-07-04', '2026-07-09', '2026-07-10']],
    ['30days', ['2026-06-10', '2026-06-11', '2026-07-01', '2026-07-03', '2026-07-04', '2026-07-09', '2026-07-10']],
    ['month', ['2026-07-01', '2026-07-03', '2026-07-04', '2026-07-09', '2026-07-10']],
    [
      'all',
      [
        '2026-05-31',
        '2026-06-01',
        '2026-06-10',
        '2026-06-11',
        '2026-07-01',
        '2026-07-03',
        '2026-07-04',
        '2026-07-09',
        '2026-07-10',
      ],
    ],
  ])('returns only in-window entries for %s', (period, expectedDates) => {
    expect(sliceDailyToPeriod(DAILY, period, NOW).map(day => day.date)).toEqual(expectedDates)
  })
})

describe('periodWindowStart', () => {
  it.each<[Period, string]>([
    ['today', '2026-07-10'],
    ['week', '2026-07-03'],
    ['30days', '2026-06-10'],
    ['month', '2026-07-01'],
    ['all', '2026-01-01'],
  ])('aligns %s to the CLI window start', (period, expected) => {
    expect(periodWindowStart(period, NOW)).toBe(expected)
  })
})

describe('contiguousDailyWindow', () => {
  it('zero-fills inactive calendar days between sparse real entries', () => {
    const sparse = [entry('2026-07-08'), entry('2026-07-10')]
    const window = contiguousDailyWindow(sparse, '2026-07-07', '2026-07-10')

    expect(window.map(day => day.date)).toEqual(['2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10'])
    // The real entries keep their cost; the two gaps are zero-filled.
    expect(window.map(day => day.cost)).toEqual([0, 1, 0, 1])
  })
})

describe('formatChartDate', () => {
  it('formats date keys without shifting the local calendar day', () => {
    expect(formatChartDate('2026-07-01')).toBe('Jul 1')
  })
})
