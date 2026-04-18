import { describe, it, expect, vi, beforeEach } from 'vitest'

import { computePeriodFromResetDay, getPlanUsage, getPlanUsageFromProjects } from '../src/plan-usage.js'

const { parseAllSessionsMock } = vi.hoisted(() => ({
  parseAllSessionsMock: vi.fn(),
}))

vi.mock('../src/parser.js', () => ({
  parseAllSessions: parseAllSessionsMock,
}))

describe('computePeriodFromResetDay', () => {
  it('uses current month when today is on/after reset day', () => {
    const { periodStart, periodEnd } = computePeriodFromResetDay(1, new Date('2026-04-17T10:00:00.000Z'))
    expect(periodStart.getFullYear()).toBe(2026)
    expect(periodStart.getMonth()).toBe(3)
    expect(periodStart.getDate()).toBe(1)
    expect(periodEnd.getMonth()).toBe(4)
    expect(periodEnd.getDate()).toBe(1)
  })

  it('uses previous month when today is before reset day', () => {
    const { periodStart, periodEnd } = computePeriodFromResetDay(15, new Date('2026-04-03T10:00:00.000Z'))
    expect(periodStart.getMonth()).toBe(2)
    expect(periodStart.getDate()).toBe(15)
    expect(periodEnd.getMonth()).toBe(3)
    expect(periodEnd.getDate()).toBe(15)
  })

  it('clamps reset day into 1..28', () => {
    const { periodStart } = computePeriodFromResetDay(99, new Date('2026-04-27T10:00:00.000Z'))
    expect(periodStart.getDate()).toBe(28)
  })
})

describe('getPlanUsage', () => {
  beforeEach(() => {
    parseAllSessionsMock.mockReset()
  })

  it('passes provider filter from plan and computes status', async () => {
    parseAllSessionsMock.mockResolvedValue([
      {
        totalCostUSD: 160,
        sessions: [],
      },
    ])

    const usage = await getPlanUsage({
      id: 'claude-max',
      monthlyUsd: 200,
      provider: 'claude',
      resetDay: 1,
      setAt: '2026-04-01T00:00:00.000Z',
    }, new Date('2026-04-10T10:00:00.000Z'))

    expect(parseAllSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ start: expect.any(Date), end: expect.any(Date) }),
      'claude',
    )
    expect(usage.spentApiEquivalentUsd).toBe(160)
    expect(usage.percentUsed).toBe(80)
    expect(usage.status).toBe('near')
  })

  it('projects using median daily spend (not mean)', async () => {
    const dailyCosts = [1, 100, 1, 100, 1, 100, 1]
    const turns = dailyCosts.map((cost, idx) => ({
      timestamp: `2026-04-${String(idx + 1).padStart(2, '0')}T12:00:00.000Z`,
      assistantCalls: [{ costUSD: cost }],
    }))

    parseAllSessionsMock.mockResolvedValue([
      {
        totalCostUSD: dailyCosts.reduce((sum, value) => sum + value, 0),
        sessions: [{ turns }],
      },
    ])

    const usage = await getPlanUsage({
      id: 'custom',
      monthlyUsd: 500,
      provider: 'all',
      resetDay: 1,
      setAt: '2026-04-01T00:00:00.000Z',
    }, new Date('2026-04-07T12:00:00.000Z'))

    // Median(1,100,1,100,1,100,1) = 1, so remaining 23 days adds 23.
    expect(Math.round(usage.projectedMonthUsd)).toBe(327)
    expect(parseAllSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ start: expect.any(Date), end: expect.any(Date) }),
      'all',
    )
  })

  it('computes plan usage from pre-fetched projects', () => {
    const usage = getPlanUsageFromProjects({
      id: 'custom',
      monthlyUsd: 100,
      provider: 'all',
      resetDay: 1,
      setAt: '2026-04-01T00:00:00.000Z',
    }, [
      {
        totalCostUSD: 40,
        sessions: [
          {
            turns: [
              { timestamp: '2026-04-02T12:00:00.000Z', assistantCalls: [{ costUSD: 20 }] },
              { timestamp: '2026-04-03T12:00:00.000Z', assistantCalls: [{ costUSD: 20 }] },
            ],
          },
        ],
      },
    ], new Date('2026-04-10T10:00:00.000Z'))

    expect(usage.spentApiEquivalentUsd).toBe(40)
    expect(usage.budgetUsd).toBe(100)
    expect(usage.status).toBe('under')
  })
})
