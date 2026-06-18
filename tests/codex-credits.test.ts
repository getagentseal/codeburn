import { describe, expect, it } from 'vitest'
import { codexCredits, codexCreditRate } from '../src/codex-credits.js'

describe('codexCreditRate', () => {
  it('resolves the documented per-model rates', () => {
    expect(codexCreditRate('gpt-5.5')).toEqual({ input: 125, cachedInput: 12.5, output: 750 })
    expect(codexCreditRate('gpt-5.4')).toEqual({ input: 62.5, cachedInput: 6.25, output: 375 })
    expect(codexCreditRate('gpt-5.4-mini')).toEqual({ input: 18.75, cachedInput: 1.875, output: 113 })
  })

  it('tolerates codex suffix variants and casing', () => {
    expect(codexCreditRate('GPT-5.5-codex')?.input).toBe(125)
    expect(codexCreditRate('gpt-5.4-codex-mini')?.input).toBe(18.75)
  })

  it('returns null for models with no known credit rate', () => {
    expect(codexCreditRate('gpt-4o')).toBeNull()
    expect(codexCreditRate('claude-opus-4-8')).toBeNull()
  })
})

describe('codexCredits', () => {
  it('charges 1M input tokens at the input rate', () => {
    expect(codexCredits('gpt-5.5', { inputTokens: 1_000_000, cachedReadTokens: 0, outputTokens: 0 })).toBe(125)
  })

  it('charges 1M output tokens at the output rate', () => {
    expect(codexCredits('gpt-5.5', { inputTokens: 0, cachedReadTokens: 0, outputTokens: 1_000_000 })).toBe(750)
  })

  it('charges cache-read tokens at the cheaper cached rate', () => {
    expect(codexCredits('gpt-5.5', { inputTokens: 0, cachedReadTokens: 1_000_000, outputTokens: 0 })).toBe(12.5)
  })

  it('folds reasoning tokens into the output rate', () => {
    // 500k output + 500k reasoning = 1M output-billed => 750 credits.
    expect(codexCredits('gpt-5.5', { inputTokens: 0, cachedReadTokens: 0, outputTokens: 500_000, reasoningTokens: 500_000 })).toBe(750)
  })

  it('sums a mixed record (gpt-5.4)', () => {
    // 2M input (125) + 1M cached (6.25) + 0.5M output (187.5) = 318.75
    const credits = codexCredits('gpt-5.4', { inputTokens: 2_000_000, cachedReadTokens: 1_000_000, outputTokens: 500_000 })
    expect(credits).toBeCloseTo(125 + 6.25 + 187.5, 6)
  })

  it('clamps negative / non-finite token counts to 0', () => {
    expect(codexCredits('gpt-5.5', { inputTokens: -100, cachedReadTokens: NaN, outputTokens: 1_000_000 })).toBe(750)
  })

  it('returns null for an unknown model', () => {
    expect(codexCredits('gpt-4o', { inputTokens: 1_000_000, cachedReadTokens: 0, outputTokens: 0 })).toBeNull()
  })
})
