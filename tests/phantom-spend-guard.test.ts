import { describe, expect, it, vi } from 'vitest'

import { detectPhantomSpend, type DailyEntry } from '../src/daily-cache.js'

function day(date: string, opts: { cost?: number; calls?: number; carried?: boolean } = {}): DailyEntry {
  return {
    date,
    cost: opts.cost ?? 0,
    savingsUSD: 0,
    calls: opts.calls ?? 0,
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    editTurns: 0,
    oneShotTurns: 0,
    models: {},
    categories: {},
    providers: {},
    ...(opts.carried ? { carried: true as const } : {}),
  }
}

describe('detectPhantomSpend', () => {
  it('fires on a non-carried day with spend and zero source records', () => {
    const warn = vi.fn()
    detectPhantomSpend([day('2026-07-15', { cost: 12.5, calls: 40 })], new Set(), warn)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('2026-07-15')
    expect(warn.mock.calls[0][0]).toContain('$10-100')
  })

  it('does NOT fire on a carried day with spend and zero records', () => {
    const warn = vi.fn()
    detectPhantomSpend([day('2026-08-02', { cost: 99, calls: 200, carried: true })], new Set(), warn)
    expect(warn).not.toHaveBeenCalled()
  })

  it('does NOT fire on a normal day with spend backed by source records', () => {
    const warn = vi.fn()
    detectPhantomSpend([day('2026-09-10', { cost: 5, calls: 8 })], new Set(['2026-09-10']), warn)
    expect(warn).not.toHaveBeenCalled()
  })

  it('fires at most once per run even with multiple suspect days', () => {
    const warn = vi.fn()
    detectPhantomSpend(
      [day('2026-07-15', { cost: 3 }), day('2026-07-16', { cost: 4 })],
      new Set(),
      warn,
    )
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('never mutates the days or their totals in any case', () => {
    const cases: DailyEntry[][] = [
      [day('2026-07-15', { cost: 12.5, calls: 40 })],
      [day('2026-08-02', { cost: 99, calls: 200, carried: true })],
      [day('2026-09-10', { cost: 5, calls: 8 })],
    ]
    for (const days of cases) {
      const before = structuredClone(days)
      detectPhantomSpend(days, new Set(['2026-09-10']), () => {})
      expect(days).toEqual(before)
    }
  })
})
