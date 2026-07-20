import { describe, expect, it } from 'vitest'

import { dataStartKey } from './period'
import type { DailyHistoryEntry } from './types'

function day(date: string): DailyHistoryEntry {
  return { date, cost: 1, savingsUSD: 0, calls: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, topModels: [] }
}

describe('dataStartKey', () => {
  it('returns the earliest recorded day of a sparse history', () => {
    expect(dataStartKey([day('2026-05-03'), day('2026-04-24'), day('2026-06-01')])).toBe('2026-04-24')
  })

  it('returns null for an empty history (no classification possible)', () => {
    expect(dataStartKey([])).toBeNull()
  })

  it('returns null at the server-side 365-entry cap', () => {
    // At the cap the oldest retained entry is not the true data start, so
    // classification must switch off instead of labeling real aged-out
    // history as "no data recorded" on long custom ranges.
    const capped = Array.from({ length: 365 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 1) + i * 24 * 60 * 60 * 1000)
      return day(d.toISOString().slice(0, 10))
    })
    expect(dataStartKey(capped)).toBeNull()
    expect(dataStartKey(capped.slice(0, 364))).toBe('2026-01-01')
  })
})
