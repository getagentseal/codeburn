import { describe, it, expect, afterEach } from 'vitest'

import {
  calculateCost,
  calculateLocalModelSavings,
  getLocalModelSavingsConfigHash,
  getLocalSavingsBaseline,
  loadPricing,
  setLocalModelSavings,
} from '../src/models.js'

afterEach(() => setLocalModelSavings({}))

describe('setLocalModelSavings / getLocalSavingsBaseline', () => {
  it('returns undefined when no mapping is configured', () => {
    setLocalModelSavings({})
    expect(getLocalSavingsBaseline('llama3.1:8b')).toBeUndefined()
  })

  it('returns the baseline name for a configured source model', () => {
    setLocalModelSavings({ 'llama3.1:8b': 'gpt-4o' })
    expect(getLocalSavingsBaseline('llama3.1:8b')).toBe('gpt-4o')
  })

  it('uses Object.hasOwn so __proto__ cannot be coerced via the prototype chain', () => {
    // Regression for the prototype-pollution test: a hostile model name
    // like `__proto__` used to resolve to Object.prototype because plain
    // object bracket lookup walks the prototype chain.
    setLocalModelSavings({})
    expect(getLocalSavingsBaseline('__proto__')).toBeUndefined()
    expect(getLocalSavingsBaseline('constructor')).toBeUndefined()
    expect(getLocalSavingsBaseline('toString')).toBeUndefined()
  })

  it('refuses non-string keys defensively', () => {
    setLocalModelSavings({})
    expect(getLocalSavingsBaseline('' as unknown as string)).toBeUndefined()
    expect(getLocalSavingsBaseline(undefined as unknown as string)).toBeUndefined()
  })

  it('getLocalModelSavingsConfigHash is stable across sort order and empty for no mappings', () => {
    setLocalModelSavings({})
    expect(getLocalModelSavingsConfigHash()).toBe('')

    setLocalModelSavings({ a: 'gpt-4o', b: 'claude-opus-4-6' })
    const h1 = getLocalModelSavingsConfigHash()
    setLocalModelSavings({ b: 'claude-opus-4-6', a: 'gpt-4o' })
    const h2 = getLocalModelSavingsConfigHash()
    expect(h1).toBe(h2)
    expect(h1).not.toBe('')
  })

  it('changes the hash when the baseline mapping changes', () => {
    setLocalModelSavings({ 'llama3.1:8b': 'gpt-4o' })
    const h1 = getLocalModelSavingsConfigHash()
    setLocalModelSavings({ 'llama3.1:8b': 'gpt-5' })
    const h2 = getLocalModelSavingsConfigHash()
    expect(h1).not.toBe(h2)
  })
})

describe('calculateLocalModelSavings', () => {
  it('returns null when no mapping is configured for the model', () => {
    setLocalModelSavings({})
    const out = calculateLocalModelSavings('llama3.1:8b', 1_000_000, 200_000, 0, 0, 0)
    expect(out).toBeNull()
  })

  it('returns null when the baseline model is unknown to the pricing snapshot', () => {
    setLocalModelSavings({ 'llama3.1:8b': 'unknown-paid-model-xyz' })
    const out = calculateLocalModelSavings('llama3.1:8b', 1_000, 1_000, 0, 0, 0)
    expect(out).toBeNull()
  })

  it('returns the baseline cost as savings for a configured mapping', async () => {
    await loadPricing()
    setLocalModelSavings({ 'llama3.1:8b': 'gpt-4o' })
    const expected = calculateCost('gpt-4o', 1_000_000, 200_000, 50_000, 800_000, 0)
    const out = calculateLocalModelSavings('llama3.1:8b', 1_000_000, 200_000, 50_000, 800_000, 0)
    expect(out).not.toBeNull()
    expect(out!.savingsUSD).toBeCloseTo(expected)
    expect(out!.baselineModel).toBe('gpt-4o')
  })

  it('respects speed and web-search inputs in the baseline calculation', async () => {
    await loadPricing()
    setLocalModelSavings({ local: 'gpt-4o' })
    const standard = calculateLocalModelSavings('local', 1_000, 500, 0, 0, 2, 'standard')
    expect(standard).not.toBeNull()
    // Web search is a flat $0.01 per request, so the standard path with 2
    // web search requests should include 2 cents of counterfactual spend.
    expect(standard!.savingsUSD).toBeGreaterThan(0.02)
  })
})
