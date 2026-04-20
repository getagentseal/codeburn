import { describe, expect, it } from 'vitest'

import { buildMenubarPayload, type PeriodData, type ProviderCost } from '../src/menubar-json.js'
import type { BillingConfig } from '../src/billing.js'
import type { OptimizeResult } from '../src/optimize.js'

function emptyPeriod(label: string): PeriodData {
  return {
    label,
    cost: 0,
    calls: 0,
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    categories: [],
    models: [],
  }
}

describe('buildMenubarPayload', () => {
  // Use token_plus mode for tests expecting cost to be present
  const tokenPlusConfig: BillingConfig = { mode: 'token_plus', surchargeRate: 0.3 }
  const creditsConfig: BillingConfig = { mode: 'credits', surchargeRate: 0.3 }

  it('emits the full schema with current-period metrics and iso timestamp', () => {
    const period: PeriodData = {
      label: '7 Days',
      cost: 1248.01,
      calls: 11231,
      sessions: 97,
      inputTokens: 19100,
      outputTokens: 675600,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      categories: [],
      models: [],
      billedAmountUsd: 1248.01, // For token_plus mode
    }
    const payload = buildMenubarPayload(period, [], null, undefined, tokenPlusConfig)

    expect(payload.generated).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(payload.current.label).toBe('7 Days')
    expect(payload.current.cost).toBe(1248.01)
    expect(payload.current.calls).toBe(11231)
    expect(payload.current.sessions).toBe(97)
    expect(payload.current.inputTokens).toBe(19100)
    expect(payload.current.outputTokens).toBe(675600)
    expect(payload.billing?.mode).toBe('token_plus')
    expect(payload.billing?.surchargeRate).toBe(0.3)
  })

  it('emits credits mode fields when billing mode is credits', () => {
    const period: PeriodData = {
      label: '7 Days',
      cost: 1248.01,
      calls: 11231,
      sessions: 97,
      inputTokens: 19100,
      outputTokens: 675600,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      categories: [],
      models: [],
      creditsAugment: 1996816,
      creditsSynthesized: 5,
    }
    const payload = buildMenubarPayload(period, [], null, undefined, creditsConfig)

    expect(payload.current.cost).toBeNull()
    expect(payload.current.creditsAugment).toBe(1996816)
    expect(payload.current.creditsSynthesized).toBe(5)
    expect(payload.billing?.mode).toBe('credits')
    expect(payload.billing?.creditsPerDollar).toBe(1600)
  })

  it('computes per-category oneShotRate from editTurns and skips categories without edits', () => {
    const period: PeriodData = {
      label: 'Today',
      cost: 0, calls: 0, sessions: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      categories: [
        { name: 'Coding', cost: 15.83, turns: 7, editTurns: 7, oneShotTurns: 6 },
        { name: 'Conversation', cost: 16.69, turns: 47, editTurns: 0, oneShotTurns: 0 },
      ],
      models: [],
    }
    const payload = buildMenubarPayload(period, [], null)

    const coding = payload.current.topActivities.find(a => a.name === 'Coding')!
    expect(coding.oneShotRate).toBeCloseTo(6 / 7)

    const conv = payload.current.topActivities.find(a => a.name === 'Conversation')!
    expect(conv.oneShotRate).toBeNull()
  })

  it('computes aggregate oneShotRate across categories with edits', () => {
    const period: PeriodData = {
      label: 'Today',
      cost: 0, calls: 0, sessions: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      categories: [
        { name: 'Coding', cost: 1, turns: 7, editTurns: 10, oneShotTurns: 8 },
        { name: 'Debugging', cost: 1, turns: 5, editTurns: 10, oneShotTurns: 6 },
        { name: 'Conversation', cost: 1, turns: 40, editTurns: 0, oneShotTurns: 0 },
      ],
      models: [],
    }
    const payload = buildMenubarPayload(period, [], null)
    expect(payload.current.oneShotRate).toBeCloseTo((8 + 6) / (10 + 10))
  })

  it('returns null aggregate oneShotRate when no categories have editTurns', () => {
    const period: PeriodData = {
      label: 'Today',
      cost: 0, calls: 0, sessions: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      categories: [{ name: 'Conversation', cost: 1, turns: 5, editTurns: 0, oneShotTurns: 0 }],
      models: [],
    }
    const payload = buildMenubarPayload(period, [], null)
    expect(payload.current.oneShotRate).toBeNull()
  })

  it('filters out the synthetic model and caps topModels at 20 so multi-model users see all their models', () => {
    const models = Array.from({ length: 30 }, (_, i) => ({
      name: `Model${i}`, cost: 30 - i, calls: 100,
    }))
    const period: PeriodData = {
      label: 'Today',
      cost: 0, calls: 0, sessions: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      categories: [],
      models: [{ name: '<synthetic>', cost: 99, calls: 0 }, ...models],
    }
    const payload = buildMenubarPayload(period, [], null)
    expect(payload.current.topModels.find(m => m.name === '<synthetic>')).toBeUndefined()
    expect(payload.current.topModels).toHaveLength(20)
    expect(payload.current.topModels[0].name).toBe('Model0')
  })

  it('caps topActivities at 20 so all task categories can surface', () => {
    const period: PeriodData = {
      label: 'Today',
      cost: 0, calls: 0, sessions: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      categories: Array.from({ length: 25 }, (_, i) => ({
        name: `Cat${i}`, cost: 1, turns: 1, editTurns: 1, oneShotTurns: 1,
      })),
      models: [],
    }
    const payload = buildMenubarPayload(period, [], null)
    expect(payload.current.topActivities).toHaveLength(20)
  })

  it('computes cacheHitPercent from cache reads over input plus cache reads', () => {
    const period: PeriodData = {
      label: 'Today',
      cost: 0, calls: 0, sessions: 0,
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
      categories: [],
      models: [],
    }
    const payload = buildMenubarPayload(period, [], null)
    expect(payload.current.cacheHitPercent).toBeCloseTo(90)
  })

  it('returns zero cacheHitPercent when there is no input or cache traffic', () => {
    const payload = buildMenubarPayload(emptyPeriod('Today'), [], null)
    expect(payload.current.cacheHitPercent).toBe(0)
  })

  it('handles null optimize as empty findings block', () => {
    const payload = buildMenubarPayload(emptyPeriod('Today'), [], null)
    expect(payload.optimize).toEqual({ findingCount: 0, savingsUSD: 0, topFindings: [] })
  })

  it('converts tokensSaved to savingsUSD via costRate and caps topFindings at 10', () => {
    const findings = Array.from({ length: 15 }, (_, i) => ({
      title: `F${i}`, explanation: '', impact: 'low' as const, tokensSaved: 1000,
      fix: { type: 'paste' as const, label: '', text: '' },
    }))
    const optimize: OptimizeResult = {
      findings,
      costRate: 0.00002,
      healthScore: 60,
      healthGrade: 'C',
    }
    const payload = buildMenubarPayload(emptyPeriod('Today'), [], optimize)

    expect(payload.optimize.findingCount).toBe(15)
    expect(payload.optimize.topFindings).toHaveLength(10)
    expect(payload.optimize.topFindings[0].title).toBe('F0')
    expect(payload.optimize.topFindings[0].savingsUSD).toBeCloseTo(1000 * 0.00002)
    expect(payload.optimize.savingsUSD).toBeCloseTo(15 * 1000 * 0.00002)
  })

  it('maps providers into a lowercased dict inside the current-period block', () => {
    const providers: ProviderCost[] = [
      { name: 'Claude Code', cost: 76.45 },
      { name: 'Cursor', cost: 2.18 },
      { name: 'Codex', cost: 1.5 },
    ]
    const payload = buildMenubarPayload(emptyPeriod('Today'), providers, null)
    expect(payload.current.providers).toEqual({ 'claude code': 76.45, cursor: 2.18, codex: 1.5 })
  })

  it('keeps zero-cost providers in the dict so installed-but-unused providers still render as tabs', () => {
    const providers: ProviderCost[] = [
      { name: 'Claude', cost: 76.45 },
      { name: 'Codex', cost: 0 },
      { name: 'Cursor', cost: 2.18 },
    ]
    const payload = buildMenubarPayload(emptyPeriod('Today'), providers, null)
    expect(payload.current.providers).toEqual({ claude: 76.45, codex: 0, cursor: 2.18 })
  })

  it('includes up to 365 daily history entries sorted ascending by date', () => {
    const history = Array.from({ length: 400 }, (_, i) => {
      const d = new Date(2025, 0, 1)
      d.setDate(d.getDate() + i)
      return {
        date: d.toISOString().slice(0, 10),
        cost: i,
        calls: i * 10,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        topModels: [],
      }
    })
    const payload = buildMenubarPayload(emptyPeriod('Today'), [], null, history)
    expect(payload.history.daily).toHaveLength(365)
    expect(payload.history.daily[0]!.date < payload.history.daily[364]!.date).toBe(true)
    expect(payload.history.daily[364]!.date).toBe(history[399]!.date)
  })

  it('preserves token fields in dailyHistory entries', () => {
    const history = [
      { date: '2026-04-15', cost: 10, calls: 50, inputTokens: 100, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 800, topModels: [{ name: 'Opus 4.7', cost: 8, calls: 40, inputTokens: 80, outputTokens: 160 }] },
      { date: '2026-04-16', cost: 20, calls: 75, inputTokens: 150, outputTokens: 350, cacheReadTokens: 8000, cacheWriteTokens: 1200, topModels: [] },
    ]
    const payload = buildMenubarPayload(emptyPeriod('Today'), [], null, history)
    expect(payload.history.daily[0]).toEqual(history[0])
    expect(payload.history.daily[1]).toEqual(history[1])
  })

  it('returns empty history when none supplied', () => {
    const payload = buildMenubarPayload(emptyPeriod('Today'), [], null)
    expect(payload.history.daily).toEqual([])
  })

  it('drops providers with negative cost defensively', () => {
    const providers: ProviderCost[] = [
      { name: 'Claude', cost: 76.45 },
      { name: 'Broken', cost: -1 },
    ]
    const payload = buildMenubarPayload(emptyPeriod('Today'), providers, null)
    expect(payload.current.providers).toEqual({ claude: 76.45 })
  })
})
