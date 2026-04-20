import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  loadBillingConfig,
  calculateCredits,
  calculateBilling,
  formatBillingResult,
  type BillingConfig,
  type BillingMode,
} from '../src/billing.js'

describe('billing module', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env['CODEBURN_BILLING_MODE']
    delete process.env['CODEBURN_SURCHARGE_RATE']
  })

  afterEach(() => {
    process.env = originalEnv
  })

  // =========================================================================
  // Test 1: Config loader defaults
  // =========================================================================
  describe('loadBillingConfig', () => {
    it('returns default config when no env vars are set', () => {
      const config = loadBillingConfig()
      expect(config.mode).toBe('dual')
      expect(config.surchargeRate).toBe(0)
    })

    it('parses CODEBURN_BILLING_MODE correctly', () => {
      process.env['CODEBURN_BILLING_MODE'] = 'usd'
      expect(loadBillingConfig().mode).toBe('usd')

      process.env['CODEBURN_BILLING_MODE'] = 'credits'
      expect(loadBillingConfig().mode).toBe('credits')

      process.env['CODEBURN_BILLING_MODE'] = 'dual'
      expect(loadBillingConfig().mode).toBe('dual')
    })

    it('falls back to dual for invalid billing mode', () => {
      process.env['CODEBURN_BILLING_MODE'] = 'invalid'
      expect(loadBillingConfig().mode).toBe('dual')
    })

    it('parses CODEBURN_SURCHARGE_RATE correctly', () => {
      process.env['CODEBURN_SURCHARGE_RATE'] = '0.15'
      expect(loadBillingConfig().surchargeRate).toBe(0.15)

      process.env['CODEBURN_SURCHARGE_RATE'] = '0.5'
      expect(loadBillingConfig().surchargeRate).toBe(0.5)
    })

    it('returns 0 surcharge for invalid values', () => {
      process.env['CODEBURN_SURCHARGE_RATE'] = 'invalid'
      expect(loadBillingConfig().surchargeRate).toBe(0)

      process.env['CODEBURN_SURCHARGE_RATE'] = '-0.1'
      expect(loadBillingConfig().surchargeRate).toBe(0)
    })
  })

  // =========================================================================
  // Test 2: Credit calculation with zero cost
  // =========================================================================
  describe('calculateCredits', () => {
    it('returns 0 for zero cost', () => {
      expect(calculateCredits(0, 0)).toBe(0)
      expect(calculateCredits(0, 0.15)).toBe(0)
    })

    // Test 3: Credit calculation with no surcharge
    it('calculates credits with no surcharge (BASE_RATE = 100)', () => {
      // $1.00 × 100 = 100 credits
      expect(calculateCredits(1.0, 0)).toBe(100)
      // $0.50 × 100 = 50 credits
      expect(calculateCredits(0.5, 0)).toBe(50)
      // $0.01 × 100 = 1 credit
      expect(calculateCredits(0.01, 0)).toBe(1)
    })

    // Test 4: Credit calculation with surcharge
    it('calculates credits with surcharge using Math.ceil', () => {
      // $1.00 × 100 × (1 + 0.15) = 115 credits
      expect(calculateCredits(1.0, 0.15)).toBe(115)
      // $0.50 × 100 × (1 + 0.15) = 57.5 → ceil → 58 credits
      expect(calculateCredits(0.5, 0.15)).toBe(58)
      // $0.01 × 100 × (1 + 0.15) = 1.15 → ceil → 2 credits
      expect(calculateCredits(0.01, 0.15)).toBe(2)
    })

    // Test 5: Math.ceil rounding behavior
    it('always rounds up with Math.ceil', () => {
      // $0.001 × 100 = 0.1 → ceil → 1 credit
      expect(calculateCredits(0.001, 0)).toBe(1)
      // $0.0001 × 100 = 0.01 → ceil → 1 credit
      expect(calculateCredits(0.0001, 0)).toBe(1)
      // $1.001 × 100 = 100.1 → ceil → 101 credits
      expect(calculateCredits(1.001, 0)).toBe(101)
    })
  })

  // =========================================================================
  // Test 6: Billing result with dual mode
  // =========================================================================
  describe('calculateBilling', () => {
    it('returns both costUSD and credits in dual mode', () => {
      const config: BillingConfig = { mode: 'dual', surchargeRate: 0 }
      // Using claude-opus-4-5: input=$5e-6/token, output=$25e-6/token
      const result = calculateBilling(config, 'claude-opus-4-5', 1000, 500, 0, 0, 0)
      expect(result.costUSD).toBeGreaterThan(0)
      expect(result.credits).not.toBeNull()
      expect(result.credits).toBeGreaterThan(0)
    })

    // Test 7: Billing result with usd-only mode
    it('returns null credits in usd mode', () => {
      const config: BillingConfig = { mode: 'usd', surchargeRate: 0 }
      const result = calculateBilling(config, 'claude-opus-4-5', 1000, 500, 0, 0, 0)
      expect(result.costUSD).toBeGreaterThan(0)
      expect(result.credits).toBeNull()
    })

    // Test 8: Billing result with credits-only mode
    it('returns credits in credits mode', () => {
      const config: BillingConfig = { mode: 'credits', surchargeRate: 0 }
      const result = calculateBilling(config, 'claude-opus-4-5', 1000, 500, 0, 0, 0)
      expect(result.costUSD).toBeGreaterThan(0)
      expect(result.credits).not.toBeNull()
    })
  })

  // =========================================================================
  // Additional tests: formatBillingResult
  // =========================================================================
  describe('formatBillingResult', () => {
    it('formats usd mode correctly', () => {
      const result = formatBillingResult({ costUSD: 1.2345, credits: 124 }, 'usd')
      expect(result).toBe('$1.2345')
    })

    it('formats credits mode correctly', () => {
      const result = formatBillingResult({ costUSD: 1.2345, credits: 124 }, 'credits')
      expect(result).toBe('124 credits')
    })

    it('formats dual mode correctly', () => {
      const result = formatBillingResult({ costUSD: 1.2345, credits: 124 }, 'dual')
      expect(result).toBe('$1.2345 (124 credits)')
    })

    it('handles null credits gracefully', () => {
      expect(formatBillingResult({ costUSD: 1.0, credits: null }, 'credits')).toBe('N/A')
      expect(formatBillingResult({ costUSD: 1.0, credits: null }, 'dual')).toBe('$1.0000')
    })
  })
})
