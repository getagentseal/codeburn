import { describe, it, expect } from 'vitest'
import {
  loadBillingConfig,
  computeBilling,
  synthesizeCredits,
  CREDITS_PER_DOLLAR,
  type BillingConfig,
} from '../src/billing.js'
import type { ModelCosts } from '../src/models.js'

// Realistic model costs fixture (claude-opus-4-5 pricing)
const OPUS_COSTS: ModelCosts = {
  inputCostPerToken: 5e-6,
  outputCostPerToken: 25e-6,
  cacheWriteCostPerToken: 6.25e-6,
  cacheReadCostPerToken: 0.5e-6,
  webSearchCostPerRequest: 0.01,
  fastMultiplier: 1,
}

describe('computeBilling — credits mode', () => {
  // Test 1: passes through ground-truth credits unchanged
  it('1. passes through ground-truth credits unchanged', () => {
    const config: BillingConfig = { mode: 'credits', surchargeRate: 0 }
    const tokens = { input: 1000, output: 500 }
    const groundTruthCredits = 12345

    const result = computeBilling(tokens, OPUS_COSTS, config, groundTruthCredits)

    expect(result.creditsAugment).toBe(12345)
    expect(result.creditsSynthesized).toBeNull()
    expect(result.synthesized).toBe(false)
    expect(result.surchargeUsd).toBeNull()
    expect(result.billedAmountUsd).toBeNull()
    expect(result.mode).toBe('credits')
  })

  // Test 2: synthesizes credits when groundTruthCredits missing but model+tokens present
  it('2. synthesizes credits when groundTruthCredits missing but model+tokens present', () => {
    const config: BillingConfig = { mode: 'credits', surchargeRate: 0 }
    const tokens = { input: 1000, output: 500 }

    const result = computeBilling(tokens, OPUS_COSTS, config, null)

    // baseCostUsd = 1000 * 5e-6 + 500 * 25e-6 = 0.005 + 0.0125 = 0.0175
    // credits = Math.ceil(0.0175 * 1600) = Math.ceil(28) = 28
    const expectedBase = 1000 * 5e-6 + 500 * 25e-6
    const expectedCredits = Math.ceil(expectedBase * CREDITS_PER_DOLLAR)

    expect(result.synthesized).toBe(true)
    expect(result.creditsAugment).toBe(expectedCredits)
    expect(result.creditsSynthesized).toBe(expectedCredits)
    expect(result.baseCostUsd).toBeCloseTo(expectedBase)
    expect(result.surchargeUsd).toBeNull()
    expect(result.billedAmountUsd).toBeNull()
  })

  // Test 3: returns credits = 0 when tokens are all zero and model is known
  it('3. returns credits = 0 when tokens are all zero and model is known', () => {
    const config: BillingConfig = { mode: 'credits', surchargeRate: 0 }
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

    const result = computeBilling(tokens, OPUS_COSTS, config, null)

    expect(result.creditsAugment).toBe(0)
    expect(result.synthesized).toBe(true)
    expect(result.baseCostUsd).toBe(0)
  })

  // Test 4: returns creditsAugment = null when model is unknown and no ground truth
  it('4. returns creditsAugment = null when model is unknown and no ground truth', () => {
    const config: BillingConfig = { mode: 'credits', surchargeRate: 0 }
    const tokens = { input: 1000, output: 500 }

    const result = computeBilling(tokens, null, config, null)

    expect(result.creditsAugment).toBeNull()
    expect(result.creditsSynthesized).toBeNull()
    expect(result.synthesized).toBe(false)
    expect(result.baseCostUsd).toBe(0)
  })
})

describe('computeBilling — token_plus mode', () => {
  // Test 5: applies default 30% surcharge so billed = base × 1.3
  it('5. applies default 30% surcharge so billed = base × 1.3', () => {
    const config: BillingConfig = { mode: 'token_plus', surchargeRate: 0.3 }
    const tokens = { input: 1000, output: 500 }

    const result = computeBilling(tokens, OPUS_COSTS, config, null)

    const expectedBase = 1000 * 5e-6 + 500 * 25e-6 // 0.0175
    expect(result.baseCostUsd).toBeCloseTo(expectedBase)
    expect(result.surchargeUsd).toBeCloseTo(expectedBase * 0.3)
    expect(result.billedAmountUsd).toBeCloseTo(expectedBase * 1.3)
    expect(result.creditsAugment).toBeNull()
    expect(result.creditsSynthesized).toBeNull()
    expect(result.synthesized).toBe(false)
    expect(result.mode).toBe('token_plus')
  })

  // Test 6: applies custom 25% surcharge so billed = base × 1.25
  it('6. applies custom 25% surcharge so billed = base × 1.25', () => {
    const config: BillingConfig = { mode: 'token_plus', surchargeRate: 0.25 }
    const tokens = { input: 2000, output: 1000 }

    const result = computeBilling(tokens, OPUS_COSTS, config, null)

    const expectedBase = 2000 * 5e-6 + 1000 * 25e-6 // 0.035
    expect(result.baseCostUsd).toBeCloseTo(expectedBase)
    expect(result.surchargeUsd).toBeCloseTo(expectedBase * 0.25)
    expect(result.billedAmountUsd).toBeCloseTo(expectedBase * 1.25)
  })

  // Test 7: applies 0% surcharge so billed = base exactly
  it('7. applies 0% surcharge so billed = base exactly', () => {
    const config: BillingConfig = { mode: 'token_plus', surchargeRate: 0 }
    const tokens = { input: 1000, output: 500 }

    const result = computeBilling(tokens, OPUS_COSTS, config, null)

    const expectedBase = 1000 * 5e-6 + 500 * 25e-6
    expect(result.baseCostUsd).toBeCloseTo(expectedBase)
    expect(result.surchargeUsd).toBe(0)
    expect(result.billedAmountUsd).toBeCloseTo(expectedBase)
  })
})

describe('loadBillingConfig', () => {
  // Test 8: falls back to credits mode for invalid CODEBURN_BILLING_MODE
  it('8. falls back to credits mode for invalid CODEBURN_BILLING_MODE', () => {
    const config = loadBillingConfig({ CODEBURN_BILLING_MODE: 'bogus' })
    expect(config.mode).toBe('credits')
  })

  it('defaults to credits mode when env var is unset', () => {
    const config = loadBillingConfig({})
    expect(config.mode).toBe('credits')
  })

  it('parses token_plus mode correctly', () => {
    const config = loadBillingConfig({ CODEBURN_BILLING_MODE: 'token_plus' })
    expect(config.mode).toBe('token_plus')
  })

  it('defaults surchargeRate to 0 when unset', () => {
    const config = loadBillingConfig({})
    expect(config.surchargeRate).toBe(0)
  })

  it('parses custom surchargeRate', () => {
    const config = loadBillingConfig({ CODEBURN_SURCHARGE_RATE: '0.25' })
    expect(config.surchargeRate).toBe(0.25)
  })

  it('falls back to 0 for negative surchargeRate', () => {
    const config = loadBillingConfig({ CODEBURN_SURCHARGE_RATE: '-0.1' })
    expect(config.surchargeRate).toBe(0)
  })

  it('falls back to 0 for non-numeric surchargeRate', () => {
    const config = loadBillingConfig({ CODEBURN_SURCHARGE_RATE: 'invalid' })
    expect(config.surchargeRate).toBe(0)
  })
})
