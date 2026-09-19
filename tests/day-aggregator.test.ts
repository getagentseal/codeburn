import { describe, expect, it } from 'vitest'

import { aggregateProjectsIntoDays, buildPeriodDataFromDays, dateKey } from '../src/day-aggregator.js'
import { isTurnResidueOnly } from '../src/daily-cache.js'
import type { ProjectSummary } from '../src/types.js'

function makeProject(overrides: Partial<ProjectSummary> & { sessions: ProjectSummary['sessions'] }): ProjectSummary {
  return {
    project: 'p',
    projectPath: '/p',
    totalCostUSD: overrides.sessions.reduce((s, sess) => s + sess.totalCostUSD, 0),
    totalApiCalls: overrides.sessions.reduce((s, sess) => s + sess.apiCalls, 0),
    ...overrides,
  }
}

function makeCall(timestamp: string, costUSD: number, model = 'Opus 4.7', provider = 'claude') {
  return {
    provider,
    model,
    usage: {
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 50,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD,
    tools: [],
    mcpTools: [],
    skills: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard' as const,
    timestamp,
    bashCommands: [],
    deduplicationKey: `dk-${timestamp}-${costUSD}`,
  }
}

function makeSingleTurnProject(
  assistantCalls: ReturnType<typeof makeCall>[],
  { retries = 0, hasEdits = true }: { retries?: number; hasEdits?: boolean } = {},
): ProjectSummary {
  const timestamp = assistantCalls[0]!.timestamp
  const totalCostUSD = assistantCalls.reduce((sum, call) => sum + call.costUSD, 0)
  return makeProject({
    sessions: [{
      sessionId: 'multi-provider-session',
      project: 'p',
      firstTimestamp: timestamp,
      lastTimestamp: assistantCalls.at(-1)!.timestamp,
      totalCostUSD,
      totalInputTokens: assistantCalls.reduce((sum, call) => sum + call.usage.inputTokens, 0),
      totalOutputTokens: assistantCalls.reduce((sum, call) => sum + call.usage.outputTokens, 0),
      totalCacheReadTokens: assistantCalls.reduce((sum, call) => sum + call.usage.cacheReadInputTokens, 0),
      totalCacheWriteTokens: assistantCalls.reduce((sum, call) => sum + call.usage.cacheCreationInputTokens, 0),
      apiCalls: assistantCalls.length,
      turns: [{
        userMessage: 'compare providers',
        timestamp,
        sessionId: 'multi-provider-session',
        category: 'coding',
        retries,
        hasEdits,
        assistantCalls,
      }],
      modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {},
      categoryBreakdown: {} as never,
      skillBreakdown: {} as never,
    }],
  })
}

describe('aggregateProjectsIntoDays', () => {
  it("buckets call-derived values under each call's own date when a turn straddles midnight", () => {
    // Per-call bucketing (issue #852): a turn whose calls straddle midnight
    // puts each call's cost/calls/tokens on the day the call happened, so
    // day-N + day-N+1 reconcile with a range parse that sliced the turn at
    // the same boundary. Turn-level judgments (editTurns, category turns)
    // stay anchored on the turn's day.
    const projects: ProjectSummary[] = [
      makeProject({
        sessions: [{
          sessionId: 's1',
          project: 'p',
          firstTimestamp: '2026-04-09T10:00:00',
          lastTimestamp: '2026-04-10T08:00:00',
          totalCostUSD: 10,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          apiCalls: 2,
          turns: [
            {
              userMessage: 'hi',
              timestamp: '2026-04-09T10:00:00',
              sessionId: 's1',
              category: 'coding',
              retries: 0,
              hasEdits: true,
              assistantCalls: [
                makeCall('2026-04-09T10:00:00', 4),
                makeCall('2026-04-10T08:00:00', 6),
              ],
            },
          ],
          modelBreakdown: {},
          toolBreakdown: {},
          mcpBreakdown: {},
          bashBreakdown: {},
          categoryBreakdown: {} as never,
          skillBreakdown: {} as never,
        }],
      }),
    ]

    const days = aggregateProjectsIntoDays(projects)
    expect(days.map(d => d.date)).toEqual(['2026-04-09', '2026-04-10'])
    expect(days[0]!.cost).toBe(4)
    expect(days[0]!.calls).toBe(1)
    expect(days[1]!.cost).toBe(6)
    expect(days[1]!.calls).toBe(1)
    // Turn-level stats anchor on the turn's day only — they describe the
    // whole exchange, not a per-call sum.
    expect(days[0]!.editTurns).toBe(1)
    expect(days[1]!.editTurns).toBe(0)
    expect(days[0]!.categories['coding']?.turns).toBe(1)
    expect(days[1]!.categories['coding']).toBeUndefined()
  })

  it('attributes category turns + editTurns + oneShotTurns to the first call date of the turn', () => {
    const projects: ProjectSummary[] = [
      makeProject({
        sessions: [{
          sessionId: 's1',
          project: 'p',
          firstTimestamp: '2026-04-09T10:00:00',
          lastTimestamp: '2026-04-09T10:05:00',
          totalCostUSD: 3,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          apiCalls: 1,
          turns: [
            {
              userMessage: 'hi',
              timestamp: '2026-04-09T10:00:00',
              sessionId: 's1',
              category: 'coding',
              retries: 0,
              hasEdits: true,
              assistantCalls: [makeCall('2026-04-09T10:00:00', 3)],
            },
          ],
          modelBreakdown: {},
          toolBreakdown: {},
          mcpBreakdown: {},
          bashBreakdown: {},
          categoryBreakdown: {} as never,
          skillBreakdown: {} as never,
        }],
      }),
    ]
    const days = aggregateProjectsIntoDays(projects)
    const day = days[0]!
    expect(day.editTurns).toBe(1)
    expect(day.oneShotTurns).toBe(1)
    expect(day.categories['coding']).toEqual({
      turns: 1,
      cost: 3,
      savingsUSD: 0,
      editTurns: 1,
      oneShotTurns: 1,
    })
  })

  it('skips a timestamped empty-call turn without throwing or counting it at day level', () => {
    const projects: ProjectSummary[] = [
      makeProject({
        sessions: [{
          sessionId: 'empty-call-turn',
          project: 'p',
          firstTimestamp: '2026-04-09T10:00:00',
          lastTimestamp: '2026-04-09T10:00:00',
          totalCostUSD: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          apiCalls: 0,
          turns: [{
            userMessage: 'no assistant response',
            timestamp: '2026-04-09T10:00:00',
            sessionId: 'empty-call-turn',
            category: 'coding',
            retries: 0,
            hasEdits: true,
            assistantCalls: [],
          }],
          modelBreakdown: {},
          toolBreakdown: {},
          mcpBreakdown: {},
          bashBreakdown: {},
          categoryBreakdown: {} as never,
          skillBreakdown: {} as never,
        }],
      }),
    ]

    let days: ReturnType<typeof aggregateProjectsIntoDays> = []
    expect(() => { days = aggregateProjectsIntoDays(projects) }).not.toThrow()

    expect(days).toHaveLength(1)
    expect(days[0]).toMatchObject({ cost: 0, calls: 0, editTurns: 0, oneShotTurns: 0 })
    expect(days[0]!.categories).toEqual({})
    expect(days[0]!.providers).toEqual({})
  })

  it("pins the residue shape: a sliced straddling turn leaves turn counts but zero cost/calls on the anchor day", () => {
    // The contract isTurnResidueOnly keys off (issue #1127). A history parse
    // that ends at midnight slices a straddling turn to its in-range calls;
    // when the surviving half carries the turn-level judgments (category,
    // editTurns) onto day A but every call landed on day B, day A is left
    // holding ONLY residue: categories.conversation.turns === 1 with
    // cost/calls/sessions all 0. Construct in LOCAL time so the turn
    // genuinely straddles local midnight on any machine TZ.
    const iso = (y: number, mo: number, d: number, h: number, mi: number) =>
      new Date(y, mo, d, h, mi, 0).toISOString()
    const turnTs = iso(2026, 3, 16, 23, 58)  // day A, just before midnight
    const callTs = iso(2026, 3, 17, 0, 5)    // day B: every call past midnight
    const dayA = dateKey(turnTs)
    const dayB = dateKey(callTs)
    expect(dayA).not.toBe(dayB) // sanity: the fixture really straddles local midnight

    const projects: ProjectSummary[] = [
      makeProject({
        sessions: [{
          sessionId: 's1',
          project: 'p',
          firstTimestamp: callTs,
          lastTimestamp: callTs,
          totalCostUSD: 6,
          totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
          apiCalls: 1,
          turns: [
            {
              userMessage: 'one more thing before bed', timestamp: turnTs, sessionId: 's1',
              category: 'conversation', retries: 0, hasEdits: false,
              assistantCalls: [makeCall(callTs, 6)],
            },
          ],
          modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {},
          categoryBreakdown: {} as never,
          skillBreakdown: {} as never,
        }],
      }),
    ]

    const days = aggregateProjectsIntoDays(projects)
    const anchor = days.find(d => d.date === dayA)!
    const next = days.find(d => d.date === dayB)!

    // Anchor day: ONLY turn-anchored residue — no cost, calls, sessions, or tokens.
    expect(anchor.cost).toBe(0)
    expect(anchor.calls).toBe(0)
    expect(anchor.sessions).toBe(0)
    expect(anchor.inputTokens + anchor.outputTokens + anchor.cacheReadTokens + anchor.cacheWriteTokens).toBe(0)
    expect(anchor.categories['conversation']!.turns).toBe(1)
    expect(isTurnResidueOnly(anchor)).toBe(true)

    // Next day: the full cost/calls of the same turn.
    expect(next.cost).toBe(6)
    expect(next.calls).toBe(1)
    expect(next.sessions).toBe(1)
    expect(isTurnResidueOnly(next)).toBe(false)
  })

  it('counts a session under its firstTimestamp date', () => {
    const projects: ProjectSummary[] = [
      makeProject({
        sessions: [{
          sessionId: 's1',
          project: 'p',
          firstTimestamp: '2026-04-09T23:59:00',
          lastTimestamp: '2026-04-10T00:10:00',
          totalCostUSD: 1,
          totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
          apiCalls: 0,
          turns: [],
          modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {},
          categoryBreakdown: {} as never,
          skillBreakdown: {} as never,
        }],
      }),
    ]
    const days = aggregateProjectsIntoDays(projects)
    const expectedDate = dateKey('2026-04-09T23:59:00')
    expect(days[0]!.date).toBe(expectedDate)
    expect(days[0]!.sessions).toBe(1)
  })

  it('aggregates per-model and per-provider totals inside each day', () => {
    const projects: ProjectSummary[] = [
      makeProject({
        sessions: [{
          sessionId: 's1',
          project: 'p',
          firstTimestamp: '2026-04-10T10:00:00',
          lastTimestamp: '2026-04-10T10:00:00',
          totalCostUSD: 10,
          totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
          apiCalls: 2,
          turns: [
            {
              userMessage: 'x', timestamp: '2026-04-10T10:00:00', sessionId: 's1',
              category: 'coding', retries: 0, hasEdits: false,
              assistantCalls: [
                makeCall('2026-04-10T10:00:00', 7, 'Opus 4.7', 'claude'),
                makeCall('2026-04-10T10:00:00', 3, 'gpt-5', 'codex'),
              ],
            },
          ],
          modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {},
          categoryBreakdown: {} as never,
          skillBreakdown: {} as never,
        }],
      }),
    ]
    const days = aggregateProjectsIntoDays(projects)
    const day = days[0]!
    // v33: day.models is keyed by modelRowKey (display name + route), not the
    // raw id, so a route sourced from a provider column survives into the day.
    expect(day.models['Opus 4.7']).toEqual({
      calls: 1, cost: 7, savingsUSD: 0,
      inputTokens: 100, outputTokens: 200,
      cacheReadTokens: 50, cacheWriteTokens: 0,
    })
    expect(day.models['GPT-5']).toEqual({
      calls: 1, cost: 3, savingsUSD: 0,
      inputTokens: 100, outputTokens: 200,
      cacheReadTokens: 50, cacheWriteTokens: 0,
    })
    // Provider slices carry the full per-provider breakdown (v14) so that a
    // carried-forward slice stays exact across daily-cache rebuilds.
    expect(day.providers['claude']).toMatchObject({
      calls: 1, cost: 7, savingsUSD: 0,
      inputTokens: 100, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 0,
    })
    expect(day.providers['claude']!.models).toEqual({
      'Opus 4.7': { calls: 1, cost: 7, savingsUSD: 0, inputTokens: 100, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 0 },
    })
    expect(day.providers['codex']).toMatchObject({
      calls: 1, cost: 3, savingsUSD: 0,
      inputTokens: 100, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 0,
    })
    expect(day.providers['codex']!.models).toEqual({
      'GPT-5': { calls: 1, cost: 3, savingsUSD: 0, inputTokens: 100, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 0 },
    })
    // Slice categories hold only that provider's share of cost; the primary
    // provider (the first call in this tie) owns the turn count.
    expect(day.providers['claude']!.categories!['coding']).toMatchObject({ turns: 1, cost: 7 })
    expect(day.providers['codex']!.categories!['coding']).toMatchObject({ turns: 0, cost: 3 })
    // Day-level category still counts the whole turn once.
    expect(day.categories['coding']).toMatchObject({ turns: 1, cost: 10 })
    // Per-project rollup at day level and inside each provider slice; path is
    // stored so display layers can derive a friendly name once sessions expire.
    expect(day.projects!['p']).toEqual({ cost: 10, calls: 2, savingsUSD: 0, sessions: 1, path: '/p' })
    expect(day.providers['claude']!.projects!['p']).toMatchObject({ cost: 7, calls: 1 })
    expect(day.providers['codex']!.projects!['p']).toMatchObject({ cost: 3, calls: 1 })
  })

  it('attributes a multi-provider turn to the majority provider exactly once', () => {
    const timestamp = '2026-04-10T10:00:00'
    const projects = [makeSingleTurnProject([
      makeCall(timestamp, 2, 'gpt-5', 'codex'),
      makeCall(timestamp, 3, 'Opus 4.7', 'claude'),
      makeCall(timestamp, 4, 'Opus 4.7', 'claude'),
    ])]

    const day = aggregateProjectsIntoDays(projects)[0]!
    const slices = Object.values(day.providers)

    expect(day.editTurns).toBe(1)
    expect(day.oneShotTurns).toBe(1)
    expect(day.categories['coding']!.turns).toBe(1)
    expect(slices.reduce((sum, provider) => sum + (provider.editTurns ?? 0), 0)).toBe(1)
    expect(slices.reduce((sum, provider) => sum + (provider.oneShotTurns ?? 0), 0)).toBe(1)
    expect(slices.reduce((sum, provider) => sum + (provider.categories?.['coding']?.turns ?? 0), 0)).toBe(1)
    expect(day.providers['claude']).toMatchObject({ cost: 7, editTurns: 1, oneShotTurns: 1 })
    expect(day.providers['claude']!.categories!['coding']).toMatchObject({ turns: 1, cost: 7, editTurns: 1, oneShotTurns: 1 })
    expect(day.providers['codex']).toMatchObject({ cost: 2, editTurns: 0, oneShotTurns: 0 })
    expect(day.providers['codex']!.categories!['coding']).toMatchObject({ turns: 0, cost: 2, editTurns: 0, oneShotTurns: 0 })
  })

  it("breaks a provider call-count tie with the turn's first call", () => {
    const timestamp = '2026-04-10T10:00:00'
    const projects = [makeSingleTurnProject([
      makeCall(timestamp, 2, 'gpt-5', 'codex'),
      makeCall(timestamp, 7, 'Opus 4.7', 'claude'),
    ])]

    const day = aggregateProjectsIntoDays(projects)[0]!
    const slices = Object.values(day.providers)

    expect(slices.reduce((sum, provider) => sum + (provider.editTurns ?? 0), 0)).toBe(1)
    expect(slices.reduce((sum, provider) => sum + (provider.categories?.['coding']?.turns ?? 0), 0)).toBe(1)
    expect(day.providers['codex']).toMatchObject({ editTurns: 1, oneShotTurns: 1 })
    expect(day.providers['codex']!.categories!['coding']).toMatchObject({ turns: 1, editTurns: 1, oneShotTurns: 1 })
    expect(day.providers['claude']).toMatchObject({ editTurns: 0, oneShotTurns: 0 })
    expect(day.providers['claude']!.categories!['coding']).toMatchObject({ turns: 0, editTurns: 0, oneShotTurns: 0 })
  })
})

describe('buildPeriodDataFromDays', () => {
  function makeDay(date: string, cost: number) {
    return {
      date,
      cost,
      calls: 10,
      sessions: 2,
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 300,
      cacheWriteTokens: 0,
      editTurns: 3,
      oneShotTurns: 2,
      models: {
        'Opus 4.7': { calls: 8, cost: cost * 0.8, savingsUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        'Haiku 4.5': { calls: 2, cost: cost * 0.2, savingsUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      categories: { 'coding': { turns: 2, cost: cost * 0.5, savingsUSD: 0, editTurns: 2, oneShotTurns: 1 } },
      providers: { 'claude': { calls: 10, cost, savingsUSD: 0 } },
    }
  }

  it('sums cost, calls, sessions, tokens across days', () => {
    const days = [makeDay('2026-04-09', 10), makeDay('2026-04-10', 20)]
    const pd = buildPeriodDataFromDays(days, '7 Days')
    expect(pd.label).toBe('7 Days')
    expect(pd.cost).toBe(30)
    expect(pd.calls).toBe(20)
    expect(pd.sessions).toBe(4)
    expect(pd.inputTokens).toBe(200)
    expect(pd.outputTokens).toBe(400)
    expect(pd.cacheReadTokens).toBe(600)
  })

  it('merges per-model totals across days and sorts by cost desc', () => {
    const days = [makeDay('2026-04-09', 10), makeDay('2026-04-10', 20)]
    const pd = buildPeriodDataFromDays(days, 'Today')
    expect(pd.models[0]!.name).toBe('Opus 4.7')
    expect(pd.models[0]!.cost).toBeCloseTo(24)
    expect(pd.models[1]!.name).toBe('Haiku 4.5')
    expect(pd.models[1]!.cost).toBeCloseTo(6)
  })

  it('merges per-category totals and keeps editTurns + oneShotTurns per category', () => {
    const days = [makeDay('2026-04-09', 10), makeDay('2026-04-10', 20)]
    const pd = buildPeriodDataFromDays(days, 'Today')
    const coding = pd.categories.find(c => c.name === 'Coding')!
    expect(coding.turns).toBe(4)
    expect(coding.editTurns).toBe(4)
    expect(coding.oneShotTurns).toBe(2)
    expect(coding.cost).toBeCloseTo(15)
  })

  // The hero's token popover reads the period totals; the Models table sums the
  // per-model rows. Both come out of here, so they must be the same numbers.
  it('period token totals equal the day sums and the per-model sums', () => {
    const split = (date: string, factor: number) => {
      const models = {
        'Opus 4.7': { calls: 8, cost: 8 * factor, savingsUSD: 0, inputTokens: 80 * factor, outputTokens: 160 * factor, cacheReadTokens: 240 * factor, cacheWriteTokens: 40 * factor },
        'Haiku 4.5': { calls: 2, cost: 2 * factor, savingsUSD: 0, inputTokens: 20 * factor, outputTokens: 40 * factor, cacheReadTokens: 60 * factor, cacheWriteTokens: 10 * factor },
      }
      return {
        ...makeDay(date, 10 * factor),
        inputTokens: 100 * factor,
        outputTokens: 200 * factor,
        cacheReadTokens: 300 * factor,
        cacheWriteTokens: 50 * factor,
        models,
      }
    }
    const days = [split('2026-04-09', 1), split('2026-04-10', 3)]
    const pd = buildPeriodDataFromDays(days, '7 Days')
    const sumOf = (field: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens') => ({
      period: pd[field],
      overDays: days.reduce((sum, day) => sum + day[field], 0),
      overModels: pd.models.reduce((sum, model) => sum + model[field], 0),
    })
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
      const { period, overDays, overModels } = sumOf(field)
      expect(period).toBe(overDays)
      expect(period).toBe(overModels)
    }
    expect(pd.calls).toBe(days.reduce((sum, day) => sum + day.calls, 0))
  })

  it('returns empty period totals when no days supplied', () => {
    const pd = buildPeriodDataFromDays([], 'Today')
    expect(pd.cost).toBe(0)
    expect(pd.calls).toBe(0)
    expect(pd.sessions).toBe(0)
    expect(pd.categories).toEqual([])
    expect(pd.models).toEqual([])
  })

  it("attributes a midnight-straddling turn's cost to the call's own date", () => {
    // A turn whose user message sits on one side of midnight and whose
    // assistant response lands on the other buckets its cost under the CALL's
    // day (issue #852's per-call rule), so the daily cache (history.daily +
    // provider breakdown) reconciles exactly to a range parse that slices the
    // same turn at the same boundary — and day-N + day-N+1 sum to the period
    // total with nothing lost on either side.
    const userTs = '2026-04-20T23:58:00Z'
    const assistantTs = '2026-04-21T00:30:00Z'
    const assistantLocal = new Date(assistantTs)
    const expectedDate = `${assistantLocal.getFullYear()}-${String(assistantLocal.getMonth() + 1).padStart(2, '0')}-${String(assistantLocal.getDate()).padStart(2, '0')}`

    const projects: ProjectSummary[] = [
      makeProject({
        sessions: [{
          sessionId: 's1',
          project: 'p',
          firstTimestamp: userTs,
          lastTimestamp: assistantTs,
          totalCostUSD: 5,
          totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
          apiCalls: 1,
          turns: [{
            userMessage: 'ask',
            timestamp: userTs,
            sessionId: 's1',
            category: 'coding',
            retries: 0,
            hasEdits: false,
            assistantCalls: [makeCall(assistantTs, 5)],
          }],
          modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {},
          categoryBreakdown: {} as never,
          skillBreakdown: {} as never,
        }],
      }),
    ]

    const days = aggregateProjectsIntoDays(projects)
    const costDay = days.find(d => d.cost === 5)
    expect(costDay, 'turn cost must be bucketed somewhere').toBeDefined()
    expect(costDay!.date).toBe(expectedDate)
    expect(costDay!.calls).toBe(1)
  })
})

describe('daily-cache ↔ report daily-bucket parity', () => {
  // The daily cache (history.daily + provider breakdown) and JSON-report
  // daily[] rows (durable.days from buildDurablePeriod) must bucket days by the
  // SAME rule, or their per-day totals drift and their period sums diverge from
  // current.cost at window boundaries — the V1 audit's constant -$3.45/-81-calls
  // finding. Both are now PER-CALL for cost/savings/calls (issue #852) with
  // turn-level stats still turn-anchored: this asserts per-day equality against
  // an independent per-call oracle for the durable day aggregation used by
  // durable.days (each call on its own date), plus the invariant
  // history.daily Σ == report.daily Σ == total call cost.

  // Independent per-call reference for durable.days (cost/savings/calls bucket
  // under each call's own date). Not a live buildJsonReport fallback — that
  // path was deleted in #1067.
  function reportDailyByDate(projects: ProjectSummary[]): Record<string, number> {
    const byDate: Record<string, number> = {}
    for (const p of projects) {
      for (const sess of p.sessions) {
        for (const turn of sess.turns) {
          for (const call of turn.assistantCalls) {
            byDate[dateKey(call.timestamp)] = (byDate[dateKey(call.timestamp)] ?? 0) + call.costUSD
          }
        }
      }
    }
    return byDate
  }

  it('buckets each day identically to the report and reconciles the period total', () => {
    // Construct in LOCAL time so the turn genuinely straddles local midnight on
    // any machine TZ (UTC-literal timestamps would straddle in some zones only).
    const iso = (y: number, mo: number, d: number, h: number, mi: number) =>
      new Date(y, mo, d, h, mi, 0).toISOString()
    const turnTs = iso(2026, 3, 16, 23, 50)   // day A, late evening
    const call1Ts = iso(2026, 3, 16, 23, 55)  // day A
    const call2Ts = iso(2026, 3, 17, 0, 10)   // day A+1 (turn straddles midnight)
    const turn2Ts = iso(2026, 3, 17, 9, 0)    // day A+1
    const dayA = dateKey(turnTs)
    const dayB = dateKey(call2Ts)
    expect(dayA).not.toBe(dayB) // sanity: the fixture really straddles local midnight

    // A midnight-straddling turn (calls on both days) plus a same-day turn, so
    // whole-TURN anchoring would produce DIFFERENT per-day totals than the
    // per-call rule — the case the old code got wrong.
    const projects: ProjectSummary[] = [
      makeProject({
        sessions: [{
          sessionId: 's1',
          project: 'p',
          firstTimestamp: turnTs,
          lastTimestamp: turn2Ts,
          totalCostUSD: 12,
          totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
          apiCalls: 3,
          turns: [
            {
              userMessage: 'straddles into next day', timestamp: turnTs, sessionId: 's1',
              category: 'coding', retries: 0, hasEdits: false,
              assistantCalls: [makeCall(call1Ts, 2), makeCall(call2Ts, 3)],
            },
            {
              userMessage: 'later same day', timestamp: turn2Ts, sessionId: 's1',
              category: 'coding', retries: 0, hasEdits: false,
              assistantCalls: [makeCall(turn2Ts, 7)],
            },
          ],
          modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {},
          categoryBreakdown: {} as never,
          skillBreakdown: {} as never,
        }],
      }),
    ]

    const historyDaily = aggregateProjectsIntoDays(projects)
    const historyByDate = Object.fromEntries(historyDaily.map(d => [d.date, d.cost]))
    const reportByDate = reportDailyByDate(projects)

    // history.daily (cache path) buckets each day EXACTLY as the report does.
    expect(historyByDate).toEqual(reportByDate)
    // And the provider breakdown, summed per day, matches too (same bug root).
    for (const d of historyDaily) {
      const providerSum = Object.values(d.providers).reduce((s, pr) => s + pr.cost, 0)
      expect(providerSum).toBeCloseTo(d.cost, 10)
    }

    // history.daily Σ == report.daily Σ == current.cost (total of all call costs).
    const historySum = historyDaily.reduce((s, d) => s + d.cost, 0)
    const reportSum = Object.values(reportByDate).reduce((s, c) => s + c, 0)
    const totalCallCost = 2 + 3 + 7
    expect(historySum).toBeCloseTo(totalCallCost, 10)
    expect(reportSum).toBeCloseTo(totalCallCost, 10)
    // Day A owns only the straddling turn's pre-midnight call (2); day B owns
    // the post-midnight call plus the same-day turn (3+7=10). Both paths agree
    // per day and the period total is conserved.
    expect(historyByDate[dayA]).toBe(2)
    expect(historyByDate[dayB]).toBe(10)
  })
})

describe('billing routes in the finalized day (v33)', () => {
  it('keys day.models by route so a column-sourced route survives, and keeps Bedrock SKUs apart', () => {
    // Hermes writes `billing_provider = bedrock` next to a plain vendor id;
    // only the call's `route` can carry that into the day. The raw-id key
    // (pre-v33) would have folded it into the direct row on re-derivation.
    const direct = makeCall('2026-08-05T10:00:00Z', 1, 'claude-sonnet-4-5', 'hermes')
    const viaColumn = { ...makeCall('2026-08-05T10:01:00Z', 2, 'claude-sonnet-4-5', 'hermes'), route: 'bedrock' }
    const viaId = makeCall('2026-08-05T10:02:00Z', 3, 'anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude')
    const viaIdUs = makeCall('2026-08-05T10:03:00Z', 4, 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude')
    const day = aggregateProjectsIntoDays([makeSingleTurnProject([direct, viaColumn, viaId, viaIdUs])])[0]!
    expect(Object.keys(day.models).sort()).toEqual([
      'Sonnet 4.5', 'Sonnet 4.5 (Bedrock us)', 'Sonnet 4.5 (Bedrock)',
    ])
    expect(day.models['Sonnet 4.5']!.cost).toBe(1)
    // The column-routed call and the id-shaped one are one row: same SKU, same door.
    expect(day.models['Sonnet 4.5 (Bedrock)']!.cost).toBe(5)
    expect(day.models['Sonnet 4.5 (Bedrock us)']!.cost).toBe(4)
    // Provider slices carry the same keys, so a per-provider re-derivation
    // (the pending-rederive path) lands on the rows the day already holds.
    expect(Object.keys(day.providers['hermes']!.models!).sort()).toEqual(['Sonnet 4.5', 'Sonnet 4.5 (Bedrock)'])
  })
})

describe('supplementary accounting weight (copilot store/rollup calls)', () => {
  it('adds cost and tokens but no call or turn weight, matching buildSessionSummary', () => {
    // One real request served both ways: the per-turn call is behavioral, the
    // paired store row is supplementary. Sealed daily history must agree with
    // the live session summary (apiCalls 1), not double the call.
    const behavioral = makeCall('2026-08-05T10:00:00Z', 1, 'claude-sonnet-4-5', 'copilot')
    const supplementary = { ...makeCall('2026-08-05T10:00:05Z', 2, 'claude-sonnet-4-5', 'copilot'), supplementaryAccounting: true }
    const day = aggregateProjectsIntoDays([makeSingleTurnProject([behavioral, supplementary])])[0]!
    expect(day.calls).toBe(1)
    expect(day.cost).toBeCloseTo(3, 12)
    expect(day.inputTokens).toBe(200)
    expect(day.models['Sonnet 4.5']!.calls).toBe(1)
    expect(day.models['Sonnet 4.5']!.cost).toBeCloseTo(3, 12)
    expect(day.providers['copilot']!.calls).toBe(1)
    expect(day.categories['coding']!.turns).toBe(1)

    // A turn made only of supplementary calls (a rollup-only session's
    // accounting container): cost and tokens land, weight does not.
    const aggOnly = aggregateProjectsIntoDays([makeSingleTurnProject([
      { ...makeCall('2026-08-05T11:00:00Z', 2, 'claude-sonnet-4-5', 'copilot'), supplementaryAccounting: true },
    ])])[0]!
    expect(aggOnly.calls).toBe(0)
    expect(aggOnly.cost).toBeCloseTo(2, 12)
    expect(aggOnly.inputTokens).toBe(100)
    expect(aggOnly.categories['coding']!.turns).toBe(0)
    expect(aggOnly.editTurns).toBe(0)
    expect(aggOnly.models['Sonnet 4.5']!.calls).toBe(0)
    expect(aggOnly.providers['copilot']!.calls).toBe(0)
  })
})
