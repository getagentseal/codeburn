import { describe, expect, it } from 'vitest'

import { buildGranularHistory, granularBucketMinutes, type GranularHistory } from '../src/granular-history.js'
import type { ParsedApiCall, ProjectSummary, TokenUsage } from '../src/types.js'

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  webSearchRequests: 0,
}

function apiCall(options: {
  timestamp: string
  model?: string
  provider?: string
  cost?: number
  input?: number
  output?: number
  cacheRead?: number
}): ParsedApiCall {
  return {
    provider: options.provider ?? 'claude',
    model: options.model ?? 'claude-sonnet-4-6',
    usage: {
      ...ZERO_USAGE,
      inputTokens: options.input ?? 0,
      outputTokens: options.output ?? 0,
      cacheReadInputTokens: options.cacheRead ?? 0,
    },
    costUSD: options.cost ?? 0,
    tools: [],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: options.timestamp,
    bashCommands: [],
    deduplicationKey: `${options.timestamp}:${options.model ?? 'model'}`,
  }
}

function project(sessions: Array<{ id: string; project?: string; calls: ParsedApiCall[] }>): ProjectSummary {
  return {
    project: 'demo',
    projectPath: '/repos/demo',
    totalCostUSD: 0,
    totalSavingsUSD: 0,
    totalApiCalls: sessions.reduce((sum, session) => sum + session.calls.length, 0),
    totalProxiedCostUSD: 0,
    sessions: sessions.map(session => ({
      sessionId: session.id,
      project: session.project ?? 'demo',
      firstTimestamp: session.calls[0]?.timestamp ?? '',
      lastTimestamp: session.calls.at(-1)?.timestamp ?? '',
      totalCostUSD: session.calls.reduce((sum, call) => sum + call.costUSD, 0),
      totalSavingsUSD: 0,
      totalInputTokens: session.calls.reduce((sum, call) => sum + call.usage.inputTokens, 0),
      totalOutputTokens: session.calls.reduce((sum, call) => sum + call.usage.outputTokens, 0),
      totalReasoningTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      apiCalls: session.calls.length,
      turns: session.calls.map((call, index) => ({
        userMessage: '',
        assistantCalls: [call],
        timestamp: call.timestamp,
        sessionId: session.id,
        category: 'coding' as const,
        retries: 0,
        hasEdits: false,
        turnId: String(index),
      })),
      modelBreakdown: {},
      toolBreakdown: {},
      mcpBreakdown: {},
      bashBreakdown: {},
      categoryBreakdown: {} as never,
      skillBreakdown: {},
      subagentBreakdown: {},
    })),
  }
}

function sumSeries(history: GranularHistory, kind: 'models' | 'sessions', seriesId: string, field: 'cost' | 'tokens'): number {
  return history.points.reduce((sum, point) => {
    const row = point[kind].find(value => value.seriesId === seriesId)
    return sum + (row?.[field] ?? 0)
  }, 0)
}

describe('granular history', () => {
  it('selects 15-minute, hourly, and daily buckets from the requested duration', () => {
    const start = new Date('2026-07-01T00:00:00.000Z')
    const range = (hours: number) => ({ start, end: new Date(start.getTime() + hours * 60 * 60 * 1000) })

    expect(granularBucketMinutes(range(24))).toBe(15)
    expect(granularBucketMinutes(range(48))).toBe(15)
    expect(granularBucketMinutes(range(48.01))).toBe(60)
    expect(granularBucketMinutes(range(24 * 8))).toBe(60)
    expect(granularBucketMinutes(range(24 * 8 + 1))).toBe(1440)
    expect(granularBucketMinutes(range(24 * 30))).toBe(1440)
  })

  it('fills idle buckets and keeps separate model and session lines from real call timestamps', () => {
    const start = new Date('2026-07-15T00:00:00.000Z')
    const end = new Date('2026-07-15T23:59:59.999Z')
    const history = buildGranularHistory([
      project([
        {
          id: 'session-alpha-123456',
          project: 'alpha',
          calls: [
            apiCall({ timestamp: '2026-07-15T01:07:00.000Z', model: 'claude-opus-4-6', cost: 1, input: 100, output: 50, cacheRead: 9_999 }),
            apiCall({ timestamp: '2026-07-15T01:14:00.000Z', model: 'claude-opus-4-6', cost: 0.5, input: 25, output: 25 }),
            apiCall({ timestamp: '2026-07-15T01:16:00.000Z', model: 'claude-sonnet-4-6', cost: 0.25, input: 10, output: 5 }),
          ],
        },
        {
          id: 'session-beta-654321',
          project: 'beta',
          calls: [apiCall({ timestamp: '2026-07-15T13:01:00.000Z', model: 'gpt-5.4', provider: 'codex', cost: 2, input: 200, output: 100 })],
        },
      ]),
    ], { start, end }, end)

    expect(history.bucketMinutes).toBe(15)
    expect(history.points).toHaveLength(96)
    expect(history.modelSeries).toHaveLength(3)
    expect(history.sessionSeries).toHaveLength(2)

    const firstActive = history.points.find(point => point.timestamp === '2026-07-15T01:00:00.000Z')!
    const secondActive = history.points.find(point => point.timestamp === '2026-07-15T01:15:00.000Z')!
    const idle = history.points.find(point => point.timestamp === '2026-07-15T01:30:00.000Z')!
    expect(firstActive).toMatchObject({ cost: 1.5, tokens: 200 })
    expect(secondActive).toMatchObject({ cost: 0.25, tokens: 15 })
    expect(idle).toMatchObject({ cost: 0, tokens: 0, models: [], sessions: [] })

    // Labels use the real projectPath's last two segments, not the sanitized
    // project name.
    const alpha = history.sessionSeries.find(series => series.label === 'repos/demo · sessio…3456 (claude)')!
    const beta = history.sessionSeries.find(series => series.label === 'repos/demo · sessio…4321 (codex)')!
    expect(sumSeries(history, 'sessions', alpha.id, 'cost')).toBe(1.75)
    expect(sumSeries(history, 'sessions', beta.id, 'tokens')).toBe(300)
    // Cache reads are intentionally not folded into the browser's Tokens line.
    expect(history.points.reduce((sum, point) => sum + point.tokens, 0)).toBe(515)
  })

  it('caps detail series, retains both cost-heavy and token-heavy leaders, and preserves totals in Other', () => {
    const timestamp = '2026-07-15T12:05:00.000Z'
    const sessions = Array.from({ length: 13 }, (_, index) => {
      const rank = index + 1
      return {
        id: `sensitive-session-${String(rank).padStart(2, '0')}`,
        project: `project-${rank}`,
        calls: [apiCall({
          timestamp,
          model: `model-${rank}`,
          cost: rank,
          input: 14 - rank,
        })],
      }
    })
    const start = new Date('2026-07-15T00:00:00.000Z')
    const end = new Date('2026-07-15T23:59:59.999Z')

    const history = buildGranularHistory([project(sessions)], { start, end }, end)
    const point = history.points.find(row => row.cost > 0)!

    // Six top-by-cost + six disjoint top-by-token + one Other line.
    expect(history.modelSeries).toHaveLength(13)
    expect(history.sessionSeries).toHaveLength(13)
    expect(history.modelSeries.at(-1)).toEqual({ id: 'model_other', label: 'Other' })
    expect(history.sessionSeries.at(-1)).toEqual({ id: 'session_other', label: 'Other' })
    expect(point.models.reduce((sum, value) => sum + value.cost, 0)).toBe(point.cost)
    expect(point.models.reduce((sum, value) => sum + value.tokens, 0)).toBe(point.tokens)
    expect(point.sessions.reduce((sum, value) => sum + value.cost, 0)).toBe(point.cost)
    expect(point.sessions.reduce((sum, value) => sum + value.tokens, 0)).toBe(point.tokens)
    expect(new Set(history.sessionSeries.map(series => series.label)).size).toBe(history.sessionSeries.length)
    expect(history.sessionSeries.every(series => !series.label.includes('sensitive-session-'))).toBe(true)
  })

  it('does not draw future buckets or accept calls outside the selected range', () => {
    const start = new Date('2026-07-15T00:00:00.000Z')
    const end = new Date('2026-07-15T23:59:59.999Z')
    const now = new Date('2026-07-15T02:20:00.000Z')
    const history = buildGranularHistory([project([{
      id: 'active',
      calls: [
        apiCall({ timestamp: '2026-07-15T02:19:00.000Z', cost: 1, input: 10 }),
        apiCall({ timestamp: '2026-07-15T03:00:00.000Z', cost: 100, input: 1_000 }),
        apiCall({ timestamp: 'not-a-date', cost: 100, input: 1_000 }),
      ],
    }])], { start, end }, now)

    expect(history.points.at(-1)!.timestamp).toBe('2026-07-15T02:15:00.000Z')
    expect(history.points.reduce((sum, point) => sum + point.cost, 0)).toBe(1)
    expect(history.points.reduce((sum, point) => sum + point.tokens, 0)).toBe(10)
  })

  it('keeps workspace-scoped session ids separate across projects', () => {
    const timestamp = '2026-07-15T12:05:00.000Z'
    const alpha = project([{ id: 'shared-local-id', project: 'alpha', calls: [apiCall({ timestamp, cost: 1 })] }])
    const beta = project([{ id: 'shared-local-id', project: 'beta', calls: [apiCall({ timestamp, cost: 2 })] }])
    alpha.projectPath = '/repos/alpha'
    beta.projectPath = '/repos/beta'
    const start = new Date('2026-07-15T00:00:00.000Z')
    const end = new Date('2026-07-15T23:59:59.999Z')

    const history = buildGranularHistory([alpha, beta], { start, end }, end)

    expect(history.sessionSeries).toHaveLength(2)
    expect(history.sessionSeries.map(series => series.label)).toEqual(expect.arrayContaining([
      expect.stringContaining('alpha ·'),
      expect.stringContaining('beta ·'),
    ]))
  })

  it('aligns quarter-hour buckets to local wall time in a fractional-offset timezone', () => {
    const previousTz = process.env['TZ']
    process.env['TZ'] = 'Asia/Kathmandu'
    try {
      const start = new Date(2026, 6, 15, 0, 7)
      const end = new Date(2026, 6, 15, 1, 0)
      const callTime = new Date(2026, 6, 15, 0, 17)
      const history = buildGranularHistory([
        project([{ id: 'fractional-offset', calls: [apiCall({ timestamp: callTime.toISOString(), cost: 1 })] }]),
      ], { start, end }, end)
      const active = history.points.find(point => point.cost > 0)!

      expect(active.timestamp).toBe(new Date(2026, 6, 15, 0, 15).toISOString())
    } finally {
      if (previousTz === undefined) delete process.env['TZ']
      else process.env['TZ'] = previousTz
    }
  })

  it('keeps the two repeated hours distinct across daylight-saving fallback', () => {
    const previousTz = process.env['TZ']
    process.env['TZ'] = 'America/New_York'
    try {
      const start = new Date(2026, 9, 31, 0, 0)
      const end = new Date(2026, 10, 2, 23, 59, 59, 999)
      const history = buildGranularHistory([
        project([{
          id: 'dst-fallback',
          calls: [
            apiCall({ timestamp: '2026-11-01T05:30:00.000Z', cost: 1 }),
            apiCall({ timestamp: '2026-11-01T06:30:00.000Z', cost: 2 }),
          ],
        }]),
      ], { start, end }, end)

      expect(history.bucketMinutes).toBe(60)
      expect(history.points.find(point => point.timestamp === '2026-11-01T05:00:00.000Z')?.cost).toBe(1)
      expect(history.points.find(point => point.timestamp === '2026-11-01T06:00:00.000Z')?.cost).toBe(2)
    } finally {
      if (previousTz === undefined) delete process.env['TZ']
      else process.env['TZ'] = previousTz
    }
  })
})
