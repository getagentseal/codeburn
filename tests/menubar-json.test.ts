import { describe, expect, it } from 'vitest'

import { buildMenubarPayload, type CombinedUsage, type PeriodData, type ProviderCost } from '../src/menubar-json.js'
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
    }
    const payload = buildMenubarPayload(period, [], null)

    expect(payload.generated).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(payload.current.label).toBe('7 Days')
    expect(payload.current.cost).toBe(1248.01)
    expect(payload.current.calls).toBe(11231)
    // An absent pricingCoverage is UNKNOWN and must render as null, never as
    // a fabricated 100% coverage (post-#756 review finding).
    expect(payload.current.pricingCoverage).toBeNull()
    expect(payload.current.sessions).toBe(97)
    expect(payload.current.inputTokens).toBe(19100)
    expect(payload.current.outputTokens).toBe(675600)
  })

  it('passes the pull-requests payload (models, categories, cap remainder) through verbatim', () => {
    const period: PeriodData = {
      ...emptyPeriod('7 Days'),
      pullRequests: {
        rows: [
          { url: 'https://github.com/o/r/pull/1', label: 'o/r#1', cost: 40, savingsUSD: 0, sessions: 1, calls: 12, firstStarted: '2026-07-20T10:00:00Z', lastEnded: '2026-07-20T11:00:00Z', approx: false, models: ['fable', 'opus'], categories: [{ name: 'Coding', cost: 30 }, { name: 'Debugging', cost: 10 }] },
        ],
        distinctCost: 45,
        distinctSessions: 1,
        attributedCost: 40,
        unattributedCost: 5,
      },
    }
    const payload = buildMenubarPayload(period, [], null)
    expect(payload.current.pullRequests).toEqual(period.pullRequests)
    expect(payload.current.pullRequests!.rows[0]!.models).toEqual(['fable', 'opus'])
    expect(payload.current.pullRequests!.rows[0]!.categories).toEqual([{ name: 'Coding', cost: 30 }, { name: 'Debugging', cost: 10 }])
  })

  it('exposes period-scoped cache tokens on current, decoupled from the 365-day history backfill (#583)', () => {
    const period: PeriodData = {
      label: '30 Days',
      cost: 5, calls: 10, sessions: 2,
      inputTokens: 1000, outputTokens: 2000,
      // What `report -p 30days` shows in the terminal for the same window.
      cacheReadTokens: 1_391_100_000,
      cacheWriteTokens: 42_000_000,
      categories: [], models: [],
    }
    // history.daily is the full BACKFILL_DAYS (365) trend, whose cache totals are
    // far larger than the selected period. The web cards used to sum these, which
    // is the bug in #583. current must mirror the period, not the backfill.
    const dailyHistory = [
      { date: '2025-07-15', cost: 0, savingsUSD: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_800_000_000, cacheWriteTokens: 60_000_000, topModels: [] },
      { date: '2026-06-30', cost: 0, savingsUSD: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 270_000_000, cacheWriteTokens: 12_000_000, topModels: [] },
    ]
    const payload = buildMenubarPayload(period, [], null, dailyHistory)

    // current carries the period totals verbatim ...
    expect(payload.current.cacheReadTokens).toBe(1_391_100_000)
    expect(payload.current.cacheWriteTokens).toBe(42_000_000)
    // ... and is independent of the larger history-backfill sum the cards used before.
    const historyReadSum = dailyHistory.reduce((s, d) => s + d.cacheReadTokens, 0)
    const historyWriteSum = dailyHistory.reduce((s, d) => s + d.cacheWriteTokens, 0)
    expect(historyReadSum).toBeGreaterThan(payload.current.cacheReadTokens)
    expect(historyWriteSum).toBeGreaterThan(payload.current.cacheWriteTokens)
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

  it('maps providers into a lowercased display-name dict inside the current-period block', () => {
    const providers: ProviderCost[] = [
      { name: 'cursor-agent', displayName: 'Cursor Agent', cost: 76.45 },
      { name: 'cursor', displayName: 'Cursor', cost: 2.18 },
      { name: 'codex', displayName: 'Codex', cost: 1.5 },
    ]
    const payload = buildMenubarPayload(emptyPeriod('Today'), providers, null)
    // Keys stay lowercased DISPLAY names (byte-compatible with the Swift menubar).
    expect(payload.current.providers).toEqual({ 'cursor agent': 76.45, cursor: 2.18, codex: 1.5 })
  })

  it('emits providerDetails with the internal id and display label alongside the providers map', () => {
    const providers: ProviderCost[] = [
      { name: 'grok', displayName: 'Grok Build', cost: 12.5 },
      { name: 'cursor-agent', displayName: 'Cursor Agent', cost: 3.4 },
    ]
    const payload = buildMenubarPayload(emptyPeriod('Today'), providers, null)
    // providerDetails carries the internal id (round-trips as --provider) + label.
    expect(payload.current.providerDetails).toEqual([
      { id: 'grok', label: 'Grok Build', cost: 12.5 },
      { id: 'cursor-agent', label: 'Cursor Agent', cost: 3.4 },
    ])
    // ... while the existing providers map keys stay the lowercased display names.
    expect(payload.current.providers).toEqual({ 'grok build': 12.5, 'cursor agent': 3.4 })
  })

  it('keeps zero-cost providers in the dict so installed-but-unused providers still render as tabs', () => {
    const providers: ProviderCost[] = [
      { name: 'claude', displayName: 'Claude', cost: 76.45 },
      { name: 'codex', displayName: 'Codex', cost: 0 },
      { name: 'cursor', displayName: 'Cursor', cost: 2.18 },
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

  it('emits the active display currency (USD by default) so the client can convert raw-USD costs', () => {
    const payload = buildMenubarPayload(emptyPeriod('Today'), [], null)
    expect(payload.currency).toEqual({ code: 'USD', symbol: '$', rate: 1 })
  })

  it('preserves the optional selected-period timeline alongside daily history', () => {
    const timeline = {
      bucketMinutes: 15,
      modelSeries: [{ id: 'model_0', label: 'claude-opus-4-6' }],
      sessionSeries: [{ id: 'session_0', label: 'codeburn · abc123 (claude)' }],
      points: [{
        timestamp: '2026-07-15T10:00:00.000Z',
        cost: 1.5,
        tokens: 200,
        models: [{ seriesId: 'model_0', cost: 1.5, tokens: 200 }],
        sessions: [{ seriesId: 'session_0', cost: 1.5, tokens: 200 }],
      }],
    }
    const payload = buildMenubarPayload(
      emptyPeriod('Today'), [], null,
      undefined, undefined, undefined, undefined, undefined,
      timeline,
    )

    expect(payload.history).toEqual({ daily: [], timeline })
  })

  it('drops providers with negative cost defensively', () => {
    const providers: ProviderCost[] = [
      { name: 'claude', displayName: 'Claude', cost: 76.45 },
      { name: 'broken', displayName: 'Broken', cost: -1 },
    ]
    const payload = buildMenubarPayload(emptyPeriod('Today'), providers, null)
    expect(payload.current.providers).toEqual({ claude: 76.45 })
    expect(payload.current.providerDetails).toEqual([{ id: 'claude', label: 'Claude', cost: 76.45 }])
  })

  it('omits combined usage by default and accepts the documented combined shape when attached', () => {
    const payload = buildMenubarPayload(emptyPeriod('Today'), [], null)
    expect(payload).not.toHaveProperty('combined')

    const combined: CombinedUsage = {
      perDevice: [
        {
          id: 'local',
          name: 'Mac Studio',
          local: true,
          cost: 1,
          calls: 2,
          sessions: 1,
          inputTokens: 100,
          outputTokens: 50,
          cacheCreateTokens: 10,
          cacheReadTokens: 20,
          totalTokens: 180,
        },
      ],
      combined: {
        cost: 1,
        calls: 2,
        sessions: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheCreateTokens: 10,
        cacheReadTokens: 20,
        totalTokens: 180,
        deviceCount: 1,
        reachableCount: 1,
      },
    }
    payload.combined = combined

    expect(payload.combined).toEqual(combined)
  })

  it('emits Claude config selector metadata only when multiple configs are available', () => {
    const oneConfig = buildMenubarPayload(emptyPeriod('Today'), [], null, undefined, undefined, undefined, undefined, {
      selectedId: null,
      options: [{ id: 'claude-config:a', label: 'claude-work', path: '/tmp/claude-work' }],
    })
    expect(oneConfig).not.toHaveProperty('claudeConfigs')

    const twoConfigs = buildMenubarPayload(emptyPeriod('Today'), [], null, undefined, undefined, undefined, undefined, {
      selectedId: 'claude-config:b',
      options: [
        { id: 'claude-config:a', label: 'claude-work', path: '/tmp/claude-work' },
        { id: 'claude-config:b', label: 'claude-personal', path: '/tmp/claude-personal' },
      ],
    })

    expect(twoConfigs.claudeConfigs).toEqual({
      selectedId: 'claude-config:b',
      options: [
        { id: 'claude-config:a', label: 'claude-work', path: '/tmp/claude-work' },
        { id: 'claude-config:b', label: 'claude-personal', path: '/tmp/claude-personal' },
      ],
    })
  })
})
