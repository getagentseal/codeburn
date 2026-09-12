import { describe, expect, it, beforeAll } from 'vitest'
import { addProviderSlice, buildMenubarPayloadForRange, mergeDayModelsByDisplayName, providerSliceHasUsage, type ProviderSliceTotal } from '../src/usage-aggregator.js'
import { getDateRange } from '../src/cli-date.js'
import { loadPricing } from '../src/models.js'
import type { ModelDayStats } from '../src/daily-cache.js'

function modelStats(overrides: Partial<ModelDayStats>): ModelDayStats {
  return { calls: 0, cost: 0, savingsUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...overrides }
}

describe('buildMenubarPayloadForRange', () => {
  beforeAll(async () => {
    await loadPricing()
  })

  it('treats token-only provider slices as usage', () => {
    expect(providerSliceHasUsage({
      calls: 0,
      cost: 0,
      savingsUSD: 0,
      inputTokens: 1,
    })).toBe(true)
    expect(providerSliceHasUsage({ calls: 0, cost: 0, savingsUSD: 0 })).toBe(false)
  })

  it('returns a valid payload and skips optimize findings when optimize:false', async () => {
    const payload = await buildMenubarPayloadForRange(getDateRange('today'), { provider: 'all', optimize: false })
    expect(typeof payload.current.label).toBe('string')
    expect(payload.current.cost).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(payload.current.topProjects)).toBe(true)
    expect(Array.isArray(payload.current.topModels)).toBe(true)
    expect(Array.isArray(payload.history.daily)).toBe(true)
    expect(payload.history.timeline?.bucketMinutes).toBe(15)
    expect(Array.isArray(payload.history.timeline?.points)).toBe(true)
    expect(payload.current.retryTax.totalUSD).toBeGreaterThanOrEqual(0)
    // Codex credits are always present in the payload (display gates them); 0 with no data.
    expect(typeof payload.current.codexCredits).toBe('number')
    expect(payload.current.codexCredits).toBeGreaterThanOrEqual(0)
    // optimize:false => scanAndDetect skipped => empty optimize block regardless of data
    expect(payload.optimize).toEqual({ findingCount: 0, savingsUSD: 0, topFindings: [] })
    expect(payload.stale).toBeUndefined()
  })
})

// The fold both cache-backed provider branches use (claude-config-scoped and
// all-providers). The dock's glance reads these per-provider figures, so a sum
// that leaked across providers would print another provider's spend.
describe('addProviderSlice', () => {
  it('sums cost, calls and tokens; session ticks stay a per-day max bound', () => {
    const totals: Record<string, ProviderSliceTotal> = {}
    addProviderSlice(totals, 'claude', { cost: 10, calls: 4, savingsUSD: 0, inputTokens: 100, outputTokens: 20, sessions: 2 })
    addProviderSlice(totals, 'claude', { cost: 2.5, calls: 1, savingsUSD: 0, inputTokens: 50, outputTokens: 5, sessions: 1 })
    addProviderSlice(totals, 'codex', { cost: 1, calls: 3, savingsUSD: 0, inputTokens: 7, outputTokens: 3, sessions: 1 })

    expect(totals.claude).toEqual({ cost: 12.5, calls: 5, hasUsage: true, inputTokens: 150, outputTokens: 25, sessions: 2, cacheReadIncomplete: true })
    expect(totals.codex).toEqual({ cost: 1, calls: 3, hasUsage: true, inputTokens: 7, outputTokens: 3, sessions: 1, cacheReadIncomplete: true })
  })

  it('leaves tokens absent (not zero) when no day carried a breakdown', () => {
    const totals: Record<string, ProviderSliceTotal> = {}
    // A day finalized before per-provider tokens were cached.
    addProviderSlice(totals, 'claude', { cost: 3, calls: 2, savingsUSD: 0 })
    expect(totals.claude).toEqual({ cost: 3, calls: 2, hasUsage: true, cacheReadIncomplete: true })
    expect(totals.claude!.inputTokens).toBeUndefined()
    expect(totals.claude!.outputTokens).toBeUndefined()
    expect(totals.claude!.sessions).toBeUndefined()

    // One day that does report them makes the total reportable again, counting
    // only what was actually reported.
    addProviderSlice(totals, 'claude', { cost: 1, calls: 1, savingsUSD: 0, inputTokens: 9, outputTokens: 4 })
    expect(totals.claude).toEqual({ cost: 4, calls: 3, hasUsage: true, inputTokens: 9, outputTokens: 4, cacheReadIncomplete: true })
  })

  it('keeps a token-only day visible as usage', () => {
    const totals: Record<string, ProviderSliceTotal> = {}
    addProviderSlice(totals, 'hermes', { cost: 0, calls: 0, savingsUSD: 0, inputTokens: 12, outputTokens: 0 })
    expect(totals.hermes).toEqual({ cost: 0, calls: 0, hasUsage: true, inputTokens: 12, outputTokens: 0, cacheReadIncomplete: true })
  })

  it('sums cache read per provider, keeping zero and absence distinct', () => {
    const totals: Record<string, ProviderSliceTotal> = {}
    addProviderSlice(totals, 'claude', { cost: 1, calls: 1, savingsUSD: 0, cacheReadTokens: 100 })
    addProviderSlice(totals, 'claude', { cost: 1, calls: 1, savingsUSD: 0, cacheReadTokens: 50 })
    addProviderSlice(totals, 'codex', { cost: 1, calls: 1, savingsUSD: 0, cacheReadTokens: 0 })
    addProviderSlice(totals, 'grok', { cost: 1, calls: 1, savingsUSD: 0 })

    expect(totals.claude!.cacheReadTokens).toBe(150)
    expect(totals.claude!.cacheReadIncomplete).toBeUndefined()
    expect(totals.codex!.cacheReadTokens).toBe(0)      // a reported zero, not unknown
    expect(totals.grok!.cacheReadTokens).toBeUndefined() // absent, not zero
  })

  it('marks the total incomplete when an active day lacks cache read', () => {
    const totals: Record<string, ProviderSliceTotal> = {}
    addProviderSlice(totals, 'claude', { cost: 1, calls: 1, savingsUSD: 0, cacheReadTokens: 100 })
    addProviderSlice(totals, 'claude', { cost: 1, calls: 1, savingsUSD: 0 })
    expect(totals.claude!.cacheReadIncomplete).toBe(true)
  })

  it('does not mark incomplete when only idle days lack cache read', () => {
    const totals: Record<string, ProviderSliceTotal> = {}
    addProviderSlice(totals, 'claude', { cost: 1, calls: 1, savingsUSD: 0, cacheReadTokens: 100 })
    addProviderSlice(totals, 'claude', { cost: 0, calls: 0, savingsUSD: 0 })
    expect(totals.claude!.cacheReadIncomplete).toBeUndefined()
    expect(totals.claude!.cacheReadTokens).toBe(100)
  })
})

describe('mergeDayModelsByDisplayName', () => {
  it('collapses two raw MiniMax routes into one display-name row and keeps both raw ids (#1239)', () => {
    const merged = mergeDayModelsByDisplayName({
      'minimax/MiniMax-M3': modelStats({ calls: 355, cost: 6.99, inputTokens: 500, outputTokens: 100 }),
      'MiniMaxAI/MiniMax-M3': modelStats({ calls: 60, cost: 0.37, inputTokens: 200, outputTokens: 50 }),
    })

    expect(merged).toHaveLength(1)
    expect(merged[0]!.name).toBe('MiniMax M3')
    expect(merged[0]!.rawModels).toEqual(['minimax/MiniMax-M3', 'MiniMaxAI/MiniMax-M3'])
    expect(merged[0]!.calls).toBe(415)
    expect(merged[0]!.cost).toBeCloseTo(7.36, 6)
    expect(merged[0]!.inputTokens).toBe(700)
    expect(merged[0]!.outputTokens).toBe(150)
  })

  it('keeps distinct models on separate rows with a single-entry rawModels', () => {
    const merged = mergeDayModelsByDisplayName({
      'claude-sonnet-4-6': modelStats({ calls: 1, cost: 1 }),
      'gpt-5': modelStats({ calls: 2, cost: 2 }),
    })
    expect(merged.map(m => m.name).sort()).toEqual(['GPT-5', 'Sonnet 4.6'])
    for (const row of merged) expect(row.rawModels).toHaveLength(1)
  })
})
