import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { savePlan } from '../src/config.js'
import { activePlansFromMap, computePeriodFromResetDay, getPlanUsage, getPlanUsageFromProjects, getPlanUsages } from '../src/plan-usage.js'
import type { ProjectSummary } from '../src/types.js'

const { parseAllSessionsMock } = vi.hoisted(() => ({
  parseAllSessionsMock: vi.fn(),
}))

vi.mock('../src/parser.js', () => ({
  parseAllSessions: parseAllSessionsMock,
}))

describe('computePeriodFromResetDay', () => {
  it('uses current month when today is on/after reset day', () => {
    const { periodStart, periodEnd } = computePeriodFromResetDay(1, new Date('2026-04-17T10:00:00.000Z'))
    expect(periodStart.getFullYear()).toBe(2026)
    expect(periodStart.getMonth()).toBe(3)
    expect(periodStart.getDate()).toBe(1)
    expect(periodEnd.getMonth()).toBe(4)
    expect(periodEnd.getDate()).toBe(1)
  })

  it('uses previous month when today is before reset day', () => {
    const { periodStart, periodEnd } = computePeriodFromResetDay(15, new Date('2026-04-03T10:00:00.000Z'))
    expect(periodStart.getMonth()).toBe(2)
    expect(periodStart.getDate()).toBe(15)
    expect(periodEnd.getMonth()).toBe(3)
    expect(periodEnd.getDate()).toBe(15)
  })

  it('clamps reset day into 1..28', () => {
    const { periodStart } = computePeriodFromResetDay(99, new Date('2026-04-27T10:00:00.000Z'))
    expect(periodStart.getDate()).toBe(28)
  })
})

describe('getPlanUsage', () => {
  beforeEach(() => {
    parseAllSessionsMock.mockReset()
  })

  it('passes provider filter from plan and computes status', async () => {
    parseAllSessionsMock.mockResolvedValue([
      {
        totalCostUSD: 160,
        sessions: [],
      },
    ])

    const usage = await getPlanUsage({
      id: 'claude-max',
      monthlyUsd: 200,
      provider: 'claude',
      resetDay: 1,
      setAt: '2026-04-01T00:00:00.000Z',
    }, new Date('2026-04-10T10:00:00.000Z'))

    expect(parseAllSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ start: expect.any(Date), end: expect.any(Date) }),
      'claude',
    )
    expect(usage.spentApiEquivalentUsd).toBe(160)
    expect(usage.percentUsed).toBe(80)
    expect(usage.status).toBe('near')
  })

  it('projects using median daily spend (not mean)', async () => {
    const dailyCosts = [1, 100, 1, 100, 1, 100, 1]
    const turns = dailyCosts.map((cost, idx) => ({
      timestamp: `2026-04-${String(idx + 1).padStart(2, '0')}T12:00:00.000Z`,
      assistantCalls: [{ costUSD: cost }],
    }))

    parseAllSessionsMock.mockResolvedValue([
      {
        totalCostUSD: dailyCosts.reduce((sum, value) => sum + value, 0),
        sessions: [{ turns }],
      },
    ])

    const usage = await getPlanUsage({
      id: 'custom',
      monthlyUsd: 500,
      provider: 'all',
      resetDay: 1,
      setAt: '2026-04-01T00:00:00.000Z',
    }, new Date('2026-04-07T12:00:00.000Z'))

    // Median(1,100,1,100,1,100,1) = 1, so remaining 23 days adds 23.
    expect(Math.round(usage.projectedMonthUsd)).toBe(327)
    expect(parseAllSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ start: expect.any(Date), end: expect.any(Date) }),
      'all',
    )
  })

  it('computes plan usage from pre-fetched projects', () => {
    const usage = getPlanUsageFromProjects({
      id: 'custom',
      monthlyUsd: 100,
      provider: 'all',
      resetDay: 1,
      setAt: '2026-04-01T00:00:00.000Z',
    }, [
      {
        totalCostUSD: 40,
        sessions: [
          {
            turns: [
              { timestamp: '2026-04-02T12:00:00.000Z', assistantCalls: [{ costUSD: 20 }] },
              { timestamp: '2026-04-03T12:00:00.000Z', assistantCalls: [{ costUSD: 20 }] },
            ],
          },
        ],
      },
    ], new Date('2026-04-10T10:00:00.000Z'))

    expect(usage.spentApiEquivalentUsd).toBe(40)
    expect(usage.budgetUsd).toBe(100)
    expect(usage.status).toBe('under')
  })

  it('projects month-end spend from API call timestamps', () => {
    const usage = getPlanUsageFromProjects({
      id: 'custom',
      monthlyUsd: 100,
      provider: 'all',
      resetDay: 1,
      setAt: '2026-04-01T00:00:00.000Z',
    }, [
      {
        project: 'codeburn',
        projectPath: '/tmp/codeburn',
        totalCostUSD: 10,
        totalApiCalls: 1,
        sessions: [
          {
            turns: [
              {
                timestamp: '2026-03-31T23:59:00.000Z',
                assistantCalls: [{ costUSD: 10, timestamp: '2026-04-01T10:00:00.000Z' }],
              },
            ],
          },
        ],
      },
    ] as ProjectSummary[], new Date('2026-04-01T12:00:00.000Z'))

    expect(Math.round(usage.projectedMonthUsd)).toBe(300)
  })

  it('returns active plans in provider display order', () => {
    const plans = activePlansFromMap({
      codex: {
        id: 'custom',
        monthlyUsd: 200,
        provider: 'codex',
        resetDay: 1,
        setAt: '2026-04-01T00:00:00.000Z',
      },
      claude: {
        id: 'claude-max',
        monthlyUsd: 200,
        provider: 'claude',
        resetDay: 1,
        setAt: '2026-04-01T00:00:00.000Z',
      },
      cursor: {
        id: 'none',
        monthlyUsd: 0,
        provider: 'cursor',
        resetDay: 1,
        setAt: '2026-04-01T00:00:00.000Z',
      },
    })

    expect(plans.map(plan => plan.provider)).toEqual(['claude', 'codex'])
  })

  it('keeps the provider-specific parser filter for one active plan', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-plan-usage-test-'))
    process.env['HOME'] = dir

    try {
      await savePlan({
        id: 'claude-max',
        monthlyUsd: 200,
        provider: 'claude',
        resetDay: 1,
        setAt: '2026-04-01T00:00:00.000Z',
      })

      parseAllSessionsMock.mockResolvedValue([
        {
          project: 'codeburn',
          projectPath: '/tmp/codeburn',
          totalCostUSD: 80,
          totalApiCalls: 1,
          sessions: [],
        },
      ] satisfies ProjectSummary[])

      const usages = await getPlanUsages(new Date('2026-04-10T12:00:00.000Z'))

      expect(parseAllSessionsMock).toHaveBeenCalledTimes(1)
      expect(parseAllSessionsMock).toHaveBeenCalledWith(
        expect.objectContaining({ start: expect.any(Date), end: expect.any(Date) }),
        'claude',
      )
      expect(usages).toHaveLength(1)
      expect(usages[0]?.spentApiEquivalentUsd).toBe(80)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('computes multiple active plan usages from one all-provider parse', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-plan-usage-test-'))
    process.env['HOME'] = dir

    try {
      await savePlan({
        id: 'claude-max',
        monthlyUsd: 200,
        provider: 'claude',
        resetDay: 1,
        setAt: '2026-04-01T00:00:00.000Z',
      })
      await savePlan({
        id: 'custom',
        monthlyUsd: 100,
        provider: 'codex',
        resetDay: 1,
        setAt: '2026-04-01T00:00:00.000Z',
      })

      parseAllSessionsMock.mockResolvedValue([
        {
          project: 'codeburn',
          projectPath: '/tmp/codeburn',
          totalCostUSD: 150,
          totalApiCalls: 2,
          sessions: [
            {
              sessionId: 'session-1',
              project: 'codeburn',
              firstTimestamp: '2026-04-03T10:00:00.000Z',
              lastTimestamp: '2026-04-03T11:00:00.000Z',
              totalCostUSD: 150,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              totalCacheReadTokens: 0,
              totalCacheWriteTokens: 0,
              apiCalls: 2,
              modelBreakdown: {},
              toolBreakdown: {},
              mcpBreakdown: {},
              bashBreakdown: {},
              categoryBreakdown: {},
              skillBreakdown: {},
              turns: [
                {
                  userMessage: 'work',
                  timestamp: '2026-04-03T10:00:00.000Z',
                  sessionId: 'session-1',
                  category: 'coding',
                  retries: 0,
                  hasEdits: true,
                  assistantCalls: [
                    {
                      provider: 'claude',
                      model: 'claude-opus-4-7',
                      usage: {
                        inputTokens: 0,
                        outputTokens: 0,
                        cacheCreationInputTokens: 0,
                        cacheReadInputTokens: 0,
                        cachedInputTokens: 0,
                        reasoningTokens: 0,
                        webSearchRequests: 0,
                      },
                      costUSD: 100,
                      tools: [],
                      mcpTools: [],
                      skills: [],
                      hasAgentSpawn: false,
                      hasPlanMode: false,
                      speed: 'standard',
                      timestamp: '2026-04-03T10:00:00.000Z',
                      bashCommands: [],
                      deduplicationKey: 'claude-1',
                    },
                    {
                      provider: 'codex',
                      model: 'gpt-5.5',
                      usage: {
                        inputTokens: 0,
                        outputTokens: 0,
                        cacheCreationInputTokens: 0,
                        cacheReadInputTokens: 0,
                        cachedInputTokens: 0,
                        reasoningTokens: 0,
                        webSearchRequests: 0,
                      },
                      costUSD: 50,
                      tools: [],
                      mcpTools: [],
                      skills: [],
                      hasAgentSpawn: false,
                      hasPlanMode: false,
                      speed: 'standard',
                      timestamp: '2026-04-03T11:00:00.000Z',
                      bashCommands: [],
                      deduplicationKey: 'codex-1',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ] satisfies ProjectSummary[])

      const usages = await getPlanUsages(new Date('2026-04-10T12:00:00.000Z'))

      expect(parseAllSessionsMock).toHaveBeenCalledTimes(1)
      expect(parseAllSessionsMock).toHaveBeenCalledWith(
        expect.objectContaining({ start: expect.any(Date), end: expect.any(Date) }),
        'all',
      )
      expect(usages.map(usage => usage.plan.provider)).toEqual(['claude', 'codex'])
      expect(usages.map(usage => usage.spentApiEquivalentUsd)).toEqual([100, 50])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
