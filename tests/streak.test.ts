import { describe, expect, it } from 'vitest'

import { activityStreak } from '../src/streak.js'
import { toDateString, type DailyEntry } from '../src/daily-cache.js'

const NOW = new Date(2026, 8, 16, 13, 0, 0)

function day(offset: number, over: Partial<DailyEntry> = {}): DailyEntry {
  return {
    date: toDateString(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - offset)),
    cost: 1,
    savingsUSD: 0,
    calls: 10,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    editTurns: 0,
    oneShotTurns: 0,
    models: {},
    categories: {},
    providers: {},
    ...over,
  } as DailyEntry
}

describe('activityStreak', () => {
  it('counts consecutive active days ending today', () => {
    expect(activityStreak([day(0), day(1), day(2), day(4)], NOW)).toBe(3)
  })

  it('counts from yesterday before the first session of the day', () => {
    expect(activityStreak([day(1), day(2), day(3)], NOW)).toBe(3)
  })

  it('is zero when neither today nor yesterday saw activity', () => {
    expect(activityStreak([day(2), day(3)], NOW)).toBe(0)
  })

  it('counts a token-only day with no cost as activity', () => {
    expect(activityStreak([day(0, { cost: 0, calls: 4 }), day(1)], NOW)).toBe(2)
  })

  it('does not count a day recorded with no activity at all', () => {
    expect(activityStreak([day(0), day(1, { cost: 0, calls: 0 }), day(2)], NOW)).toBe(1)
  })

  it('is the same however the day list is ordered or duplicated', () => {
    const days = [day(2), day(0), day(1), day(1)]
    expect(activityStreak(days, NOW)).toBe(3)
  })
})
