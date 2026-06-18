import { describe, expect, it } from 'vitest'

import { buildYieldJsonReport, type YieldSummary } from '../src/yield.js'

describe('buildYieldJsonReport', () => {
  it('serializes yield buckets, ratios, and session details', () => {
    const summary: YieldSummary = {
      productive: { cost: 8, sessions: 2 },
      reverted: { cost: 2, sessions: 1 },
      abandoned: { cost: 10, sessions: 1 },
      total: { cost: 20, sessions: 4 },
      details: [
        { sessionId: 's1', project: 'app', cost: 8, category: 'productive', commitCount: 2 },
        { sessionId: 's2', project: 'app', cost: 2, category: 'reverted', commitCount: 1 },
      ],
    }
    const report = buildYieldJsonReport(summary, '30 Days', {
      start: new Date('2026-05-01T00:00:00.000Z'),
      end: new Date('2026-05-31T23:59:59.999Z'),
    })

    expect(report.period).toEqual({
      label: '30 Days',
      start: '2026-05-01T00:00:00.000Z',
      end: '2026-05-31T23:59:59.999Z',
    })
    expect(report.summary.productive).toEqual({
      costUSD: 8,
      sessions: 2,
      costPercent: 40,
      sessionPercent: 50,
    })
    expect(report.summary.reverted.costPercent).toBe(10)
    expect(report.summary.abandoned.sessionPercent).toBe(25)
    expect(report.summary.total).toEqual({ costUSD: 20, sessions: 4 })
    expect(report.summary.productiveToRevertedCostRatio).toBe(4)
    expect(report.details).toHaveLength(2)
    expect(report.details[0]).toMatchObject({ sessionId: 's1', costUSD: 8, category: 'productive' })
    expect(report.details[0]).not.toHaveProperty('cost')
  })

  it('uses null ratio when no spend was reverted', () => {
    const summary: YieldSummary = {
      productive: { cost: 1, sessions: 1 },
      reverted: { cost: 0, sessions: 0 },
      abandoned: { cost: 0, sessions: 0 },
      total: { cost: 1, sessions: 1 },
      details: [],
    }

    const report = buildYieldJsonReport(summary, 'Today', {
      start: new Date('2026-06-14T00:00:00.000Z'),
      end: new Date('2026-06-14T23:59:59.999Z'),
    })

    expect(report.summary.productiveToRevertedCostRatio).toBeNull()
  })
})
