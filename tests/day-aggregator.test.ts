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
  it('buckets api calls by calendar date derived from timestamp', () => {
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
      editTurns: 1,
      oneShotTurns: 1,
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
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
      calls: 1, cost: 7,
      inputTokens: 100, outputTokens: 200,
      cacheReadTokens: 50, cacheWriteTokens: 0,
    })
    expect(day.models['gpt-5']).toEqual({
      calls: 1, cost: 3,
      inputTokens: 100, outputTokens: 200,
      cacheReadTokens: 50, cacheWriteTokens: 0,
    })
    expect(day.providers['claude']).toMatchObject({
      calls: 1,
      cost: 7,
      sessions: 1,
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
      categories: {
        coding: {
          turns: 1,
          cost: 7,
          editTurns: 0,
          oneShotTurns: 0,
          inputTokens: 100,
          outputTokens: 200,
          cacheReadTokens: 50,
          cacheWriteTokens: 0,
        },
      },
      models: {
        'Opus 4.7': {
          calls: 1,
          cost: 7,
          inputTokens: 100,
          outputTokens: 200,
          cacheReadTokens: 50,
          cacheWriteTokens: 0,
        },
      },
    })
    expect(day.providers['codex']).toMatchObject({
      calls: 1,
      cost: 3,
      sessions: 1,
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
    })
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
        'Opus 4.7': { calls: 8, cost: cost * 0.8, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        'Haiku 4.5': { calls: 2, cost: cost * 0.2, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      categories: {
        'coding': {
          turns: 2,
          cost: cost * 0.5,
          editTurns: 2,
          oneShotTurns: 1,
          inputTokens: 50,
          outputTokens: 100,
          cacheReadTokens: 150,
          cacheWriteTokens: 25,
        },
      },
      providers: {
        'claude': {
          calls: 10,
          cost,
          sessions: 2,
          editTurns: 2,
          oneShotTurns: 1,
          inputTokens: 100,
          outputTokens: 200,
          cacheReadTokens: 300,
          cacheWriteTokens: 50,
          models: {
            'Opus 4.7': { calls: 8, cost: cost * 0.8, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            'Haiku 4.5': { calls: 2, cost: cost * 0.2, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          },
          categories: {
            'coding': {
              turns: 2,
              cost: cost * 0.5,
              editTurns: 2,
              oneShotTurns: 1,
              inputTokens: 50,
              outputTokens: 100,
              cacheReadTokens: 150,
              cacheWriteTokens: 25,
            },
          },
        },
      },
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
    expect(coding.inputTokens).toBe(100)
    expect(coding.outputTokens).toBe(200)
    expect(coding.cacheReadTokens).toBe(300)
    expect(coding.cacheWriteTokens).toBe(50)
  })

  it('returns empty period totals when no days supplied', () => {
    const pd = buildPeriodDataFromDays([], 'Today')
    expect(pd.cost).toBe(0)
    expect(pd.calls).toBe(0)
    expect(pd.sessions).toBe(0)
    expect(pd.categories).toEqual([])
    expect(pd.models).toEqual([])
  })

  it('attributes a midnight-straddling turn to the first assistant call date, not the user message date', () => {
    // Regression for the bug that shipped in 0.8.2-0.8.4: when a user message
    // sat on one side of midnight and the assistant response landed on the other,
    // day-aggregator.ts bucketed by assistant time but renderStatusBar bucketed
    // by user time, so the menubar and `codeburn status` disagreed on Today.
    // The invariant for both surfaces: a turn is counted on the day its first
    // assistant call actually ran.
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
