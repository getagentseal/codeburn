import { describe, it, expect } from 'vitest'

import { getModelCosts, getShortModelName } from '../src/models.js'

// Verifies MiniMax pricing loaded from FALLBACK_PRICING (no network call).
// pricingCache stays null until loadPricing() runs, so getModelCosts falls
// through to FALLBACK_PRICING which is what we want to validate here.

describe('MiniMax model pricing', () => {
  it('returns pricing for MiniMax-M3', () => {
    const costs = getModelCosts('MiniMax-M3')
    expect(costs).not.toBeNull()
    expect(costs!.inputCostPerToken).toBe(0.6e-6)
    expect(costs!.outputCostPerToken).toBe(2.4e-6)
    expect(costs!.cacheReadCostPerToken).toBe(0.12e-6)
    // M3 paygo pricing does not bill for prompt-cache writes; snapshot pins
    // this to 0 so the loader's "input * 1.25" fallback does not kick in.
    expect(costs!.cacheWriteCostPerToken).toBe(0)
    expect(costs!.fastMultiplier).toBe(1)
  })

  it('returns pricing for MiniMax-M2.7', () => {
    const costs = getModelCosts('MiniMax-M2.7')
    expect(costs).not.toBeNull()
    expect(costs!.inputCostPerToken).toBe(0.3e-6)
    expect(costs!.outputCostPerToken).toBe(1.2e-6)
    expect(costs!.cacheReadCostPerToken).toBe(0.06e-6)
    expect(costs!.cacheWriteCostPerToken).toBe(0.375e-6)
    expect(costs!.fastMultiplier).toBe(1)
  })

  it('returns pricing for MiniMax-M2.7-highspeed', () => {
    const costs = getModelCosts('MiniMax-M2.7-highspeed')
    expect(costs).not.toBeNull()
    expect(costs!.inputCostPerToken).toBe(0.6e-6)
    expect(costs!.outputCostPerToken).toBe(2.4e-6)
    expect(costs!.cacheReadCostPerToken).toBe(0.06e-6)
    expect(costs!.cacheWriteCostPerToken).toBe(0.375e-6)
    expect(costs!.fastMultiplier).toBe(1)
  })

  it('highspeed pricing is distinct from base model pricing', () => {
    const base = getModelCosts('MiniMax-M2.7')
    const fast = getModelCosts('MiniMax-M2.7-highspeed')
    expect(fast!.inputCostPerToken).toBeGreaterThan(base!.inputCostPerToken)
    expect(fast!.outputCostPerToken).toBeGreaterThan(base!.outputCostPerToken)
  })

  it('M3 input and output are priced 2x higher than M2.7 base', () => {
    const m27 = getModelCosts('MiniMax-M2.7')
    const m3 = getModelCosts('MiniMax-M3')
    expect(m3!.inputCostPerToken).toBe(m27!.inputCostPerToken * 2)
    expect(m3!.outputCostPerToken).toBe(m27!.outputCostPerToken * 2)
  })

  it('returns short name for MiniMax-M3', () => {
    expect(getShortModelName('MiniMax-M3')).toBe('MiniMax M3')
  })

  it('returns short name for MiniMax-M2.7', () => {
    expect(getShortModelName('MiniMax-M2.7')).toBe('MiniMax M2.7')
  })

  it('returns short name for MiniMax-M2.7-highspeed', () => {
    expect(getShortModelName('MiniMax-M2.7-highspeed')).toBe('MiniMax M2.7 Highspeed')
  })

  it('handles MiniMax model ID with date suffix', () => {
    expect(getShortModelName('MiniMax-M2.7-20260101')).toBe('MiniMax M2.7')
    expect(getShortModelName('MiniMax-M3-20260101')).toBe('MiniMax M3')
  })

  it('M3 does NOT collapse into M2.7 (longest-prefix wins)', () => {
    // Defensive check: the per-version boundary match in getShortModelName
    // must not let a future M3.x variant resolve to the M2.7 entry.
    expect(getShortModelName('MiniMax-M3')).not.toBe('MiniMax M2.7')
    expect(getShortModelName('MiniMax-M3')).not.toBe('MiniMax M2.7 Highspeed')
  })
})
