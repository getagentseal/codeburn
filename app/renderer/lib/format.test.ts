import { afterEach, describe, expect, it } from 'vitest'

import { formatCompact, formatConverted, formatDayLong, formatDayShort, formatDuration, formatUsd, setActiveCurrency } from './format'

describe('currency-aware formatting', () => {
  afterEach(() => setActiveCurrency({ code: 'USD', symbol: '$', rate: 1 }))

  it('formats raw USD with the default USD currency', () => {
    expect(formatUsd(12.34)).toBe('$12.34')
    expect(formatUsd(1_234.5)).toBe('$1,234.50')
  })

  it('applies the active FX rate and symbol to raw-USD values exactly once', () => {
    setActiveCurrency({ code: 'EUR', symbol: '€', rate: 0.9 })
    // 100 USD × 0.9 = 90.00 EUR
    expect(formatUsd(100)).toBe('€90.00')
    expect(formatUsd(1_000)).toBe('€900.00')
  })

  it('formatConverted swaps the symbol without re-applying the rate (CLI-converted values)', () => {
    setActiveCurrency({ code: 'EUR', symbol: '€', rate: 0.9 })
    // Already-EUR input renders as-is, never multiplied by the rate again.
    expect(formatConverted(90)).toBe('€90.00')
    expect(formatConverted(20)).toBe('€20.00')
  })
})

describe('formatCompact', () => {
  it('formats zero, plain counts, thousands, and millions compactly', () => {
    expect(formatCompact(0)).toBe('0')
    expect(formatCompact(842)).toBe('842')
    expect(formatCompact(1_842)).toBe('1.8K')
    expect(formatCompact(184_000)).toBe('184K')
    expect(formatCompact(1_200_000)).toBe('1.2M')
  })

  it('trims trailing decimals and rejects non-finite values', () => {
    expect(formatCompact(2_000_000)).toBe('2M')
    expect(formatCompact(Number.NaN)).toBe('—')
  })
})

describe('date and duration formatters', () => {
  it('formats short and long calendar dates and handles invalid input', () => {
    const date = '2026-07-10T12:00:00'
    expect(formatDayShort(date)).toBe('Jul 10')
    expect(formatDayLong(date)).toBe('Jul 10, 2026')
    expect(formatDayShort('not-a-date')).toBe('—')
    expect(formatDayLong('not-a-date')).toBe('—')
  })

  it('formats seconds, minutes, hours, and invalid durations', () => {
    expect(formatDuration(29_000)).toBe('29s')
    expect(formatDuration(47 * 60_000)).toBe('47m')
    expect(formatDuration(134 * 60_000)).toBe('2h 14m')
    expect(formatDuration(0)).toBe('—')
  })
})
