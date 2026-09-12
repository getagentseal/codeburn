import { describe, expect, it } from 'vitest'
import { buildMenubarPayload } from '../src/menubar-json.js'
import { formatSessionCount, sessionCountIsExact, SESSION_COUNT_HELP } from '../src/session-count-label.js'
import type { PeriodData } from '../src/menubar-json.js'

describe('session count labels', () => {
  it('uses plain lower-bound phrasing and never names occupancy or cache', () => {
    expect(formatSessionCount(3, 'partial')).toBe('At least 3 sessions')
    expect(formatSessionCount(1, 'partial')).toBe('At least 1 session')
    expect(formatSessionCount(0, 'partial')).toBe('Session count unavailable')
    expect(formatSessionCount(1, 'identity')).toBe('1 session')
    expect(formatSessionCount(2, 'identity')).toBe('2 sessions')
    expect(formatSessionCount(0, 'identity')).toBe('0 sessions')
    expect(formatSessionCount(3, undefined)).toBe('At least 3 sessions')
    expect(SESSION_COUNT_HELP).toContain('Older session logs')
    expect(formatSessionCount(3, 'partial')).not.toMatch(/occupancy|canonical|cache/i)
  })
})

describe('payload serialization', () => {
  const emptyPeriod = (): PeriodData => ({
    label: 'Last 7 days',
    cost: 4,
    savingsUSD: 0,
    calls: 4,
    sessions: 3,
    sessionCountBasis: 'partial',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    categories: [],
    models: [],
    projects: [{
      id: '/tmp/count-boundary',
      name: 'vault',
      cost: 4,
      savingsUSD: 0,
      sessions: 3,
      sessionCountBasis: 'partial',
    }],
  })

  it('omits average when the count is a bound and keeps numeric sessions', () => {
    const payload = buildMenubarPayload(emptyPeriod(), [], null)
    const json = JSON.parse(JSON.stringify(payload)) as {
      current: { sessions: number, sessionCountBasis?: string, topProjects: Array<{ sessions: number, avgCostPerSession?: number, sessionCountBasis?: string }> }
    }
    expect(json.current.sessions).toBe(3)
    expect(json.current.sessionCountBasis).toBe('partial')
    expect(json.current.topProjects[0]!.sessions).toBe(3)
    expect(json.current.topProjects[0]!.sessionCountBasis).toBe('partial')
    expect(json.current.topProjects[0]!.avgCostPerSession).toBeUndefined()
    expect(sessionCountIsExact('partial')).toBe(false)
  })

  it('emits average only for source-only exact identity', () => {
    const period = emptyPeriod()
    period.sessionCountBasis = 'identity'
    period.sessions = 1
    period.cost = 0.012
    period.projects = [{
      id: '/tmp/same-session-project',
      name: 'vault',
      cost: 0.012,
      savingsUSD: 0,
      sessions: 1,
      sessionCountBasis: 'identity',
    }]
    const payload = buildMenubarPayload(period, [], null)
    expect(payload.current.topProjects[0]!.avgCostPerSession).toBeCloseTo(0.012)
    expect(payload.current.topProjects[0]!.sessionCountBasis).toBe('identity')
  })

  it('still decodes an older payload that required a numeric average', () => {
    const legacy = {
      generated: '2026-09-07T00:00:00Z',
      current: {
        label: 'Last 7 days',
        cost: 4,
        calls: 4,
        sessions: 2,
        oneShotRate: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheHitPercent: 0,
        codexCredits: 0,
        topActivities: [],
        topModels: [],
        localModelSavings: { totalUSD: 0, calls: 0, byModel: [], byProvider: [] },
        providers: {},
        providerDetails: [],
        topProjects: [{
          name: 'vault',
          cost: 4,
          savingsUSD: 0,
          sessions: 2,
          avgCostPerSession: 2,
          sessionDetails: [],
        }],
        modelEfficiency: [],
        topSessions: [],
        retryTax: { totalUSD: 0, retries: 0, editTurns: 0, byModel: [] },
        routingWaste: { totalSavingsUSD: 0, baselineModel: '', baselineCostPerEdit: 0, byModel: [] },
        tools: [],
        skills: [],
        subagents: [],
        mcpServers: [],
      },
      optimize: { findingCount: 0, savingsUSD: 0, topFindings: [] },
      history: { daily: [] },
    }
    expect(legacy.current.topProjects[0]!.avgCostPerSession).toBe(2)
    expect(legacy.current.topProjects[0]!.sessions).toBe(2)
    expect(formatSessionCount(legacy.current.topProjects[0]!.sessions, undefined)).toBe('At least 2 sessions')
  })
})
