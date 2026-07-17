import { describe, expect, it } from 'vitest'

import { aggregateProjectsIntoDays, buildPeriodDataFromDays, dateKey } from '../src/day-aggregator.js'
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

describe('aggregateProjectsIntoDays', () => {
  it('buckets a whole turn (all its calls) on the turn user-message date', () => {
    // Turn-anchored bucketing: a turn whose calls straddle midnight lands wholly
    // on the day of its user-message timestamp — matching the live headline/
    // report rollup — instead of splitting per-call across two days.
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
    expect(days.map(d => d.date)).toEqual(['2026-04-09'])
    expect(days[0]!.cost).toBe(10)
    expect(days[0]!.calls).toBe(2)
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
    expect(day.models['Opus 4.7']).toEqual({
      calls: 1, cost: 7, savingsUSD: 0,
      inputTokens: 100, outputTokens: 200,
      cacheReadTokens: 50, cacheWriteTokens: 0,
    })
    expect(day.models['gpt-5']).toEqual({
      calls: 1, cost: 3, savingsUSD: 0,
      inputTokens: 100, outputTokens: 200,
      cacheReadTokens: 50, cacheWriteTokens: 0,
    })
    expect(day.providers['claude']).toEqual({ calls: 1, cost: 7, savingsUSD: 0 })
    expect(day.providers['codex']).toEqual({ calls: 1, cost: 3, savingsUSD: 0 })
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

  it('returns empty period totals when no days supplied', () => {
    const pd = buildPeriodDataFromDays([], 'Today')
    expect(pd.cost).toBe(0)
    expect(pd.calls).toBe(0)
    expect(pd.sessions).toBe(0)
    expect(pd.categories).toEqual([])
    expect(pd.models).toEqual([])
  })

  it('attributes a midnight-straddling turn to the user-message date, matching the live report', () => {
    // A turn whose user message sits on one side of midnight and whose assistant
    // response lands on the other must bucket by the USER-MESSAGE timestamp, so
    // the daily cache (history.daily + provider breakdown) reconciles exactly to
    // the live headline/report rollup (main.ts daily), which anchors on the same
    // turn timestamp. The prior per-call bucketing split such turns and left a
    // constant offset between the trend bars and current.cost.
    const userTs = '2026-04-20T23:58:00Z'
    const assistantTs = '2026-04-21T00:30:00Z'
    const userLocal = new Date(userTs)
    const expectedDate = `${userLocal.getFullYear()}-${String(userLocal.getMonth() + 1).padStart(2, '0')}-${String(userLocal.getDate()).padStart(2, '0')}`

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
  // The daily cache (history.daily + provider breakdown) and the live report /
  // headline (main.ts daily rollup) must bucket days by the SAME rule, or their
  // per-day totals drift and their period sums diverge from current.cost at
  // window boundaries — the V1 audit's constant -$3.45/-81-calls finding. Both
  // are now TURN-anchored: this asserts per-day equality against a reference
  // that mirrors main.ts:486-499 (turn.timestamp anchor), plus the invariant
  // history.daily Σ == report.daily Σ == total call cost.

  // Mirrors the live report/headline daily rollup in src/main.ts (bucket the
  // whole turn — all its calls — on the turn's user-message date).
  function reportDailyByDate(projects: ProjectSummary[]): Record<string, number> {
    const byDate: Record<string, number> = {}
    for (const p of projects) {
      for (const sess of p.sessions) {
        for (const turn of sess.turns) {
          if (turn.assistantCalls.length === 0) continue
          const ts = turn.timestamp || turn.assistantCalls[0]!.timestamp
          const day = dateKey(ts)
          for (const call of turn.assistantCalls) byDate[day] = (byDate[day] ?? 0) + call.costUSD
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
    // per-CALL bucketing would produce DIFFERENT per-day totals than the turn-
    // anchored report — the case the old code got wrong.
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
    // Day A owns the WHOLE straddling turn (2+3=5), not just its first call (2).
    expect(historyByDate[dayA]).toBe(5)
    expect(historyByDate[dayB]).toBe(7)
  })
})
