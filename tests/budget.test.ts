import { describe, expect, it } from 'vitest'

import { computeBudgetStatus } from '../src/budget.js'

describe('computeBudgetStatus', () => {
  it('classifies under, warn, and over at the threshold boundaries', () => {
    expect(computeBudgetStatus({ spent: 79.99, budget: 100, elapsedDays: 1, totalDays: 1 }).state).toBe('under')
    expect(computeBudgetStatus({ spent: 80, budget: 100, elapsedDays: 1, totalDays: 1 }).state).toBe('warn')
    expect(computeBudgetStatus({ spent: 99.99, budget: 100, elapsedDays: 1, totalDays: 1 }).state).toBe('warn')
    expect(computeBudgetStatus({ spent: 100, budget: 100, elapsedDays: 1, totalDays: 1 }).state).toBe('over')
  })

  it('computes percent and linear projection from elapsed and total days', () => {
    const status = computeBudgetStatus({ spent: 30, budget: 120, elapsedDays: 10, totalDays: 30 })

    expect(status.pct).toBe(25)
    expect(status.projected).toBe(90)
  })

  it('rejects invalid numeric inputs', () => {
    expect(() => computeBudgetStatus({ spent: -1, budget: 100, elapsedDays: 1, totalDays: 1 })).toThrow(/spent/)
    expect(() => computeBudgetStatus({ spent: 1, budget: 0, elapsedDays: 1, totalDays: 1 })).toThrow(/budget/)
    expect(() => computeBudgetStatus({ spent: 1, budget: 100, elapsedDays: 0, totalDays: 1 })).toThrow(/elapsedDays/)
    expect(() => computeBudgetStatus({ spent: 1, budget: 100, elapsedDays: 1, totalDays: -1 })).toThrow(/totalDays/)
    expect(() => computeBudgetStatus({ spent: Number.POSITIVE_INFINITY, budget: 100, elapsedDays: 1, totalDays: 1 })).toThrow(/spent/)
  })
})
