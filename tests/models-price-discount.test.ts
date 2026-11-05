import { afterEach, describe, expect, it } from 'vitest'

import { calculateCost, getPriceOverridesConfigHash, getPricingGenerationKey, setPriceDiscounts } from '../src/models.js'
import { cachedCallToApiCall } from '../src/parser.js'
import { partsOf } from '../src/session-why.js'
import { getDailyCacheConfigHash } from '../src/usage-aggregator.js'
import type { CachedCall } from '../src/session-cache.js'

const cost = (model: string, input: number, output: number, cacheWrite: number, cacheRead: number, speed: 'standard' | 'fast' = 'standard', provider = 'claude', discounted = true) =>
  calculateCost(model, input, output, cacheWrite, cacheRead, 0, speed, 0, provider, discounted)

function cachedCall(overrides: Partial<CachedCall> = {}): CachedCall {
  return {
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    usage: { inputTokens: 1_000, outputTokens: 1_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0, cacheCreationOneHourTokens: 0 },
    speed: 'standard',
    timestamp: '2026-10-01T00:00:00.000Z',
    tools: [], bashCommands: [], skills: [], subagentTypes: [],
    deduplicationKey: 'k',
    ...overrides,
  }
}

describe('price discounts', () => {
  afterEach(() => setPriceDiscounts({}))

  it('is a no-op with no discount configured or when not asked for', () => {
    const list = cost('claude-sonnet-4-6', 1_000, 1_000, 100, 100, 'standard', 'claude', false)
    expect(cost('claude-sonnet-4-6', 1_000, 1_000, 100, 100)).toBe(list)
    setPriceDiscounts({ claude: 20 })
    expect(cost('claude-sonnet-4-6', 1_000, 1_000, 100, 100, 'standard', 'claude', false)).toBe(list)
  })

  it('takes the most specific scope: model and kind, then model, then provider', () => {
    const input = cost('claude-sonnet-4-6', 1_000, 0, 0, 0)
    const output = cost('claude-sonnet-4-6', 0, 1_000, 0, 0)
    setPriceDiscounts({ claude: 20, 'claude-sonnet-4-6': 10, 'claude-sonnet-4-6:output': 50 })
    expect(cost('claude-sonnet-4-6', 1_000, 0, 0, 0)).toBeCloseTo(input * 0.9, 15)
    expect(cost('claude-sonnet-4-6', 0, 1_000, 0, 0)).toBeCloseTo(output * 0.5, 15)
    expect(cost('claude-sonnet-4-6-20261001', 0, 1_000, 0, 0)).toBeCloseTo(output * 0.5, 15)
    setPriceDiscounts({ claude: 20 })
    expect(cost('claude-sonnet-4-6', 1_000, 1_000, 0, 0)).toBeCloseTo((input + output) * 0.8, 15)
    expect(cost('claude-sonnet-4-6', 1_000, 1_000, 0, 0, 'standard', 'codex')).toBeCloseTo(input + output, 15)
  })

  it('applies after the long-context tier and the fast multiplier', () => {
    const tiered = cost('claude-sonnet-4-5', 300_000, 1_000, 0, 0)
    const fast = cost('claude-opus-4-8', 1_000, 1_000, 0, 0, 'fast')
    expect(tiered).toBeCloseTo(300_000 * 6e-6 + 1_000 * 22.5e-6, 12)
    expect(fast).toBeCloseTo(2 * (1_000 * 5e-6 + 1_000 * 25e-6), 12)
    setPriceDiscounts({ claude: 25, 'claude-opus-4-8:output': 40 })
    expect(cost('claude-sonnet-4-5', 300_000, 1_000, 0, 0)).toBeCloseTo(tiered * 0.75, 12)
    expect(cost('claude-opus-4-8', 1_000, 1_000, 0, 0, 'fast')).toBeCloseTo(2 * (1_000 * 5e-6 * 0.75 + 1_000 * 25e-6 * 0.6), 12)
  })

  it('handles the 0 and 100 percent edges and ignores invalid entries', () => {
    const list = cost('claude-sonnet-4-6', 1_000, 1_000, 0, 0)
    setPriceDiscounts({ claude: 0 })
    expect(cost('claude-sonnet-4-6', 1_000, 1_000, 0, 0)).toBe(list)
    setPriceDiscounts({ claude: 100 })
    expect(cost('claude-sonnet-4-6', 1_000, 1_000, 0, 0)).toBe(0)
    setPriceDiscounts({ claude: 101, 'claude-sonnet-4-6': -5, 'claude-sonnet-4-6:input': Number.NaN } as Record<string, number>)
    expect(cost('claude-sonnet-4-6', 1_000, 1_000, 0, 0)).toBe(list)
  })

  it('discounts calculated calls only, never recorded or included ones', () => {
    setPriceDiscounts({ claude: 100 })
    const calculated = cachedCallToApiCall(cachedCall())
    expect(calculated.costUSD).toBe(0)
    expect(calculated.listCostUSD).toBeGreaterThan(0)
    expect(calculated.costBasis).toBe('calculated')
    const recorded = cachedCallToApiCall(cachedCall({ costUSD: 1.23 }))
    expect(recorded.costUSD).toBe(1.23)
    expect(recorded.listCostUSD).toBeUndefined()
    const fallback = cachedCallToApiCall(cachedCall({ model: 'no-such-model-x', fallbackCostUSD: 0.5 }))
    expect(fallback.costUSD).toBe(0.5)
    expect(fallback.costBasis).toBe('recorded')
    const fullyDiscounted = cachedCallToApiCall(cachedCall({ fallbackCostUSD: 0.5 }))
    expect(fullyDiscounted.costUSD).toBe(0)
    expect(fullyDiscounted.costBasis).toBe('calculated')
    const included = cachedCallToApiCall(cachedCall({ costUSD: 0, billing: 'subscription' }))
    expect(included.costBasis).toBe('included')
    expect(included.listCostUSD).toBeUndefined()
  })

  it('prices the why-it-cost parts with the discount so they sum to the call', () => {
    const usage = { inputTokens: 2_000, outputTokens: 3_000, cacheCreationInputTokens: 40_000, cacheReadInputTokens: 90_000, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0, cacheCreationOneHourTokens: 0 }
    const recordedList = partsOf(cachedCallToApiCall(cachedCall({ usage, costUSD: 1.23 })))
    setPriceDiscounts({ claude: 20, 'claude-sonnet-4-6:output': 50 })
    const call = cachedCallToApiCall(cachedCall({ usage }))
    const parts = partsOf(call)
    const sum = parts.input + parts.output + parts.cacheRead + parts.cacheWrite + parts.webSearch
    expect(call.listCostUSD).toBeGreaterThan(call.costUSD)
    expect(Math.abs(sum - call.costUSD)).toBeLessThan(0.01)
    expect(sum).toBeCloseTo(call.costUSD, 12)
    expect(partsOf(cachedCallToApiCall(cachedCall({ usage, costUSD: 1.23 })))).toEqual(recordedList)
  })

  it('changes the pricing config hashes only when a discount changes', () => {
    const overrides = getPriceOverridesConfigHash()
    const daily = getDailyCacheConfigHash()
    const generation = getPricingGenerationKey()
    setPriceDiscounts({ claude: 20 })
    const twenty = getPriceOverridesConfigHash()
    expect(twenty).not.toBe(overrides)
    expect(getDailyCacheConfigHash()).not.toBe(daily)
    setPriceDiscounts({ claude: 25 })
    expect(getPriceOverridesConfigHash()).not.toBe(twenty)
    setPriceDiscounts({})
    expect(getPriceOverridesConfigHash()).toBe(overrides)
    expect(getDailyCacheConfigHash()).toBe(daily)
    expect(getPricingGenerationKey()).toBe(generation)
  })
})
