import { describe, expect, it } from 'vitest'

import {
  applyVolumeBand,
  computeBandCohortStats,
  costHistogram,
  linearPercentile,
  medianOf,
} from './cohortStats'
import type { CohortObservation } from './types'

function obs(over: Partial<CohortObservation> = {}): CohortObservation {
  return {
    sessionId: 's1',
    project: 'proj-a',
    timestamp: '2026-08-15T10:00:00Z',
    category: 'coding',
    model: 'model-a',
    costUSD: 0.1,
    costKnown: true,
    retries: 0,
    oneShot: true,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 2000,
    cacheWriteTokens: 100,
    contextProxyTokens: 3000,
    tokensReported: true,
    ...over,
  }
}

describe('renderer percentile mirror (pinned to the core convention)', () => {
  it('gives median 3 and P90 6.8 for [1, 2, 4, 8] with linear interpolation at (N-1)*p', () => {
    const sorted = [1, 2, 4, 8]
    expect(medianOf(sorted)).toBe(3)
    expect(linearPercentile(sorted, 0.9)).toBeCloseTo(6.8, 10)
  })

  it('degenerates safely: empty → null, single value → itself', () => {
    expect(linearPercentile([], 0.9)).toBeNull()
    expect(linearPercentile([7], 0.9)).toBe(7)
  })
})

describe('applyVolumeBand', () => {
  it('keeps the whole population when no band is set', () => {
    const observations = [obs(), obs({ outputTokens: 999999 })]
    const result = applyVolumeBand(observations, null)
    expect(result.kept).toHaveLength(2)
    expect(result.outsideBand).toBe(0)
    expect(result.missingMeasure).toBe(0)
  })

  it('excludes observations outside the band and counts them', () => {
    const observations = [obs({ outputTokens: 100 }), obs({ outputTokens: 5000 }), obs({ outputTokens: 900000 })]
    const result = applyVolumeBand(observations, { measure: 'output', min: 1000, max: 10000 })
    expect(result.kept.map(o => o.outputTokens)).toEqual([5000])
    expect(result.outsideBand).toBe(2)
  })

  it('never treats observations without token data as small: they are excluded and counted', () => {
    const observations = [obs({ tokensReported: false, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contextProxyTokens: 0 }), obs()]
    const result = applyVolumeBand(observations, { measure: 'output', min: null, max: 1000000 })
    expect(result.kept).toHaveLength(1)
    expect(result.missingMeasure).toBe(1)
    expect(result.outsideBand).toBe(0)
  })

  it('bands the context proxy measure on input + cache read', () => {
    const low = obs({ inputTokens: 10, cacheReadTokens: 20, contextProxyTokens: 30 })
    const high = obs({ inputTokens: 5000, cacheReadTokens: 50000, contextProxyTokens: 55000 })
    const result = applyVolumeBand([low, high], { measure: 'contextProxy', min: 1000, max: null })
    expect(result.kept).toEqual([high])
  })
})

describe('computeBandCohortStats over the band-filtered population', () => {
  it('divides rates by the declared (band-filtered) population', () => {
    const kept = [
      obs({ retries: 1, oneShot: false, costUSD: 1 }),
      obs({ retries: 0, costUSD: 2 }),
      obs({ retries: 2, oneShot: false, costUSD: 4 }),
      obs({ retries: 0, costUSD: 8 }),
    ]
    const stats = computeBandCohortStats('model-a', kept)
    expect(stats.observationCount).toBe(4)
    // The exact pinned vector, through the full band-stats path.
    expect(stats.costMedian).toBe(3)
    expect(stats.costP90).toBeCloseTo(6.8, 10)
    expect(stats.retryCount).toBe(3)
    expect(stats.retryRate).toBeCloseTo(0.75)
    expect(stats.oneShotRate).toBe(50)
  })

  it('counts unknown cost observations separately and keeps them out of cost percentiles', () => {
    const kept = [obs({ costKnown: false, costUSD: 0 }), obs({ costUSD: 0.5 })]
    const stats = computeBandCohortStats('model-a', kept)
    expect(stats.unknownCostCount).toBe(1)
    expect(stats.costKnownCount).toBe(1)
    expect(stats.costMedian).toBe(0.5)
  })

  it('keeps histograms deterministic and totalling the population', () => {
    const costs = [0.1, 0.2, 0.3, 0.4, 0.5]
    const h1 = costHistogram(costs)
    const h2 = costHistogram([...costs].reverse())
    expect(h1).toEqual(h2)
    expect(h1.counts.reduce((a, b) => a + b, 0)).toBe(5)
  })
})
