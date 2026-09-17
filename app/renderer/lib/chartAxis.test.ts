import { describe, expect, it } from 'vitest'

import { barBucketDays, barLayout, formatAxisMoney, niceTicks, ticksClearOfPeak } from './chartAxis'

describe('niceTicks', () => {
  it('rounds up to a 1/2/2.5/5 step and always starts at zero', () => {
    expect(niceTicks(1166.32)).toEqual([0, 500, 1000, 1500])
  })

  it('keeps four or five ticks across two orders of magnitude', () => {
    for (const max of [3, 9, 42, 87, 310, 950, 4200, 18000]) {
      const ticks = niceTicks(max)
      expect(ticks.length).toBeGreaterThanOrEqual(4)
      expect(ticks.length).toBeLessThanOrEqual(6)
      expect(ticks[0]).toBe(0)
      expect(ticks.at(-1)).toBeGreaterThanOrEqual(max)
    }
  })

  it('collapses to a single zero tick when there is nothing to scale', () => {
    expect(niceTicks(0)).toEqual([0])
    expect(niceTicks(-5)).toEqual([0])
  })

  it('does not leak binary float dust into the labels', () => {
    expect(niceTicks(0.7)).toEqual([0, 0.2, 0.4, 0.6, 0.8])
  })
})

describe('formatAxisMoney', () => {
  it('writes a bare zero, whole dollars, and compact thousands', () => {
    expect(formatAxisMoney(0)).toBe('$0')
    expect(formatAxisMoney(300)).toBe('$300')
    expect(formatAxisMoney(1200)).toBe('$1.2K')
    expect(formatAxisMoney(1000)).toBe('$1K')
  })

  it('keeps cents for sub-dollar ticks so a small axis is not all zeros', () => {
    expect(formatAxisMoney(0.25)).toBe('$0.25')
  })

  it('carries the sign outside the symbol', () => {
    expect(formatAxisMoney(-300)).toBe('-$300')
  })
})

describe('ticksClearOfPeak', () => {
  it('drops only the tick the peak label would sit on', () => {
    expect(ticksClearOfPeak([0, 200, 400, 600, 800], 622.41, 800)).toEqual([0, 200, 400, 800])
  })

  it('keeps every tick when the peak sits clear of all of them', () => {
    expect(ticksClearOfPeak([0, 500, 1000, 1500], 1166.32, 1500)).toEqual([0, 500, 1000, 1500])
  })

  it('leaves the axis alone when there is no peak to mark', () => {
    expect(ticksClearOfPeak([0, 1, 2], 0, 2)).toEqual([0, 1, 2])
  })
})

// The narrowest plot the app supports; the layout rule is only correct if the
// columns it picks fit inside it.
const MIN_PLOT_PX = 520

function barsWidth(count: number): number {
  const { minWidth, gap } = barLayout(count)
  return count * minWidth + Math.max(0, count - 1) * gap
}

describe('barLayout', () => {
  it('keeps the comfortable 2px bar and 4px gap while the days fit', () => {
    expect(barLayout(1)).toEqual({ minWidth: 2, gap: 4 })
    expect(barLayout(30)).toEqual({ minWidth: 2, gap: 4 })
  })

  it('tightens instead of overflowing as the day count grows', () => {
    expect(barLayout(183).gap).toBeLessThan(4)
    for (const count of [1, 7, 30, 31, 90, 183, 365, 520]) {
      expect(barsWidth(count)).toBeLessThanOrEqual(MIN_PLOT_PX)
    }
  })
})

describe('barBucketDays', () => {
  it('draws one column per day while that fits', () => {
    expect(barBucketDays(183)).toBe(1)
    expect(barBucketDays(520)).toBe(1)
  })

  it('folds longer histories into whole weeks that still fit', () => {
    expect(barBucketDays(521)).toBe(7)
    expect(barBucketDays(3640)).toBe(7)
    for (const days of [521, 1000, 3650, 20000]) {
      const size = barBucketDays(days)
      expect(size % 7).toBe(0)
      expect(barsWidth(Math.ceil(days / size))).toBeLessThanOrEqual(MIN_PLOT_PX)
    }
  })
})
