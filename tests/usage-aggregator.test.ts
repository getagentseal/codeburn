import { describe, expect, it, beforeAll } from 'vitest'
import { buildMenubarPayloadForRange } from '../src/usage-aggregator.js'
import { getDateRange } from '../src/cli-date.js'
import { loadPricing } from '../src/models.js'

describe('buildMenubarPayloadForRange', () => {
  beforeAll(async () => { await loadPricing() })

  it('returns a valid payload and skips optimize findings when optimize:false', async () => {
    const payload = await buildMenubarPayloadForRange(getDateRange('today'), { provider: 'all', optimize: false })
    expect(typeof payload.current.label).toBe('string')
    expect(payload.current.cost).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(payload.current.topProjects)).toBe(true)
    expect(Array.isArray(payload.current.topModels)).toBe(true)
    expect(Array.isArray(payload.history.daily)).toBe(true)
    expect(payload.current.retryTax.totalUSD).toBeGreaterThanOrEqual(0)
    // optimize:false => scanAndDetect skipped => empty optimize block regardless of data
    expect(payload.optimize).toEqual({ findingCount: 0, savingsUSD: 0, topFindings: [] })
  })
})
