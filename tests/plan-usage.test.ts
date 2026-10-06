import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { savePlan, type Plan } from '../src/config.js'
import { activePlansFromMap, computePeriodFromResetDay, copilotCreditSpend, copilotCreditsNote, getPlanScopedProjects, getPlanUsage, getPlanUsageFromProjects, getPlanUsages } from '../src/plan-usage.js'
import type { ProjectSummary } from '../src/types.js'
import { setHome } from './setup/home.js'

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

describe('getPlanScopedProjects supplementary accounting', () => {
  const plan: Plan = { id: 'custom', monthlyUsd: 100, provider: 'all', resetDay: 1, setAt: '2026-08-01T00:00:00.000Z' }
  const today = new Date('2026-08-10T12:00:00.000Z')

  function copilotCall(costUSD: number, timestamp: string, supplementaryAccounting: boolean) {
    return {
      provider: 'copilot',
      model: 'claude-sonnet-4-5',
      usage: {
        inputTokens: supplementaryAccounting ? 40 : 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
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
      speed: 'standard',
      timestamp,
      bashCommands: [],
      deduplicationKey: `copilot-${timestamp}`,
      supplementaryAccounting,
    }
  }

  it('weighs calls behaviorally and keeps a cost-bearing zero-call session', () => {
    const scoped = getPlanScopedProjects(plan, [
      {
        project: 'codeburn',
        projectPath: '/tmp/codeburn',
        totalCostUSD: 1.75,
        totalApiCalls: 2,
        sessions: [
          {
            // One real request served alongside its paired store row.
            turns: [{
              timestamp: '2026-08-05T12:00:00.000Z',
              assistantCalls: [
                copilotCall(1.0, '2026-08-05T12:00:00.000Z', false),
                copilotCall(0.5, '2026-08-05T12:00:05.000Z', true),
              ],
            }],
          },
          {
            // Rollup-only session: real spend, zero behavioral requests.
            turns: [{
              timestamp: '2026-08-06T12:00:00.000Z',
              assistantCalls: [copilotCall(0.25, '2026-08-06T12:00:00.000Z', true)],
            }],
          },
        ],
      },
    ] as ProjectSummary[], today)

    expect(scoped).toHaveLength(1)
    expect(scoped[0]!.sessions.map(session => session.apiCalls)).toEqual([1, 0])
    expect(scoped[0]!.sessions.map(session => session.totalCostUSD)).toEqual([1.5, 0.25])
    expect(scoped[0]!.totalApiCalls).toBe(1)
    expect(scoped[0]!.totalCostUSD).toBeCloseTo(1.75, 10)
    expect(getPlanUsageFromProjects(plan, scoped, today).spentApiEquivalentUsd).toBeCloseTo(1.75, 10)
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
    setHome(dir)

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
    setHome(dir)

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

function usageCall(overrides: {
  provider: string
  costUSD: number
  timestamp: string
  nanoAiu?: number
  supplementaryAccounting?: boolean
  deduplicationKey?: string
}) {
  return {
    provider: overrides.provider,
    model: 'claude-sonnet-4-5',
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD: overrides.costUSD,
    tools: [],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard' as const,
    timestamp: overrides.timestamp,
    bashCommands: [],
    deduplicationKey: overrides.deduplicationKey ?? `${overrides.provider}-${overrides.timestamp}-${overrides.nanoAiu ?? 'none'}`,
    ...(overrides.nanoAiu != null ? { nanoAiu: overrides.nanoAiu } : {}),
    ...(overrides.supplementaryAccounting ? { supplementaryAccounting: true } : {}),
  }
}

function usageProjectFromTurns(turns: ReturnType<typeof usageCall>[][]): ProjectSummary {
  const calls = turns.flat()
  return {
    project: 'codeburn',
    projectPath: '/tmp/codeburn',
    totalCostUSD: calls.reduce((sum, call) => sum + call.costUSD, 0),
    totalApiCalls: calls.length,
    sessions: [{
      turns: turns.map(assistantCalls => ({
        timestamp: assistantCalls[0]!.timestamp,
        assistantCalls,
      })),
    }],
  } as ProjectSummary
}

function usageProject(calls: ReturnType<typeof usageCall>[]): ProjectSummary {
  return usageProjectFromTurns([calls])
}

describe('copilot AI credit plan math', () => {
  const today = new Date('2026-08-10T12:00:00.000Z')
  const copilotPro: Plan = {
    id: 'copilot-pro',
    monthlyCredits: 1500,
    monthlyUsd: 15,
    provider: 'copilot',
    resetDay: 1,
    setAt: '2026-08-01T00:00:00.000Z',
  }
  const claudePro: Plan = {
    id: 'claude-pro',
    monthlyUsd: 20,
    provider: 'claude',
    resetDay: 1,
    setAt: '2026-08-01T00:00:00.000Z',
  }

  it('turns 1.5e9 nanoAiu into 1.5 / 1500 credits (0.1%)', () => {
    const usage = getPlanUsageFromProjects(copilotPro, [
      usageProject([
        usageCall({
          provider: 'copilot',
          costUSD: 42,
          timestamp: '2026-08-05T12:00:00.000Z',
          nanoAiu: 1_500_000_000,
        }),
      ]),
    ], today)

    expect(usage.spentCredits).toBe(1.5)
    expect(usage.budgetCredits).toBe(1500)
    expect(usage.percentUsed).toBeCloseTo(0.1, 10)
    expect(usage.spentApiEquivalentUsd).toBeCloseTo(0.015, 10)
    expect(usage.creditsIncomplete).toBe(false)
    expect(usage.status).toBe('under')
  })

  it('fills the credits bar from the token estimate when nanoAiu is missing', () => {
    const usage = getPlanUsageFromProjects(copilotPro, [
      usageProject([
        usageCall({
          provider: 'copilot',
          costUSD: 42,
          timestamp: '2026-08-05T12:00:00.000Z',
        }),
      ]),
    ], today)

    expect(usage.spentCredits).toBe(0)
    expect(usage.creditsIncomplete).toBe(true)
    // 42 USD at 0.01 USD per credit against the 1500-credit Pro budget.
    expect(usage.percentUsed).toBe(280)
    expect(usage.status).toBe('over')
    expect(usage.spentApiEquivalentUsd).toBe(0)
  })

  it('counts a paired store-row once and ignores JSONL / rollup siblings', () => {
    const usage = getPlanUsageFromProjects(copilotPro, [
      usageProject([
        usageCall({
          provider: 'copilot',
          costUSD: 0.001605,
          timestamp: '2026-08-05T12:00:00.000Z',
          nanoAiu: 1_500_000_000,
          supplementaryAccounting: true,
        }),
        usageCall({
          provider: 'copilot',
          costUSD: 0.001605,
          timestamp: '2026-08-05T12:00:01.000Z',
        }),
        usageCall({
          provider: 'copilot',
          costUSD: 0.25,
          timestamp: '2026-08-06T12:00:00.000Z',
          supplementaryAccounting: true,
        }),
      ]),
    ], today)

    expect(usage.spentCredits).toBe(1.5)
    expect(usage.percentUsed).toBeCloseTo(0.1, 10)
    // One request (the JSONL call), billed exactly by its paired row.
    expect(usage.creditsIncomplete).toBe(false)
    expect(usage.creditRatedCalls).toBe(1)
  })

  it('does not double credits when a paired rollup also carries nanoAiu', () => {
    const usage = getPlanUsageFromProjects(copilotPro, [
      usageProject([
        usageCall({
          provider: 'copilot',
          costUSD: 0.001605,
          timestamp: '2026-08-05T12:00:00.000Z',
          nanoAiu: 1_500_000_000,
          supplementaryAccounting: true,
        }),
        usageCall({
          provider: 'copilot',
          costUSD: 0.001605,
          timestamp: '2026-08-05T12:00:01.000Z',
          nanoAiu: 1_500_000_000,
        }),
      ]),
    ], today)

    expect(usage.spentCredits).toBe(1.5)
    expect(usage.creditsIncomplete).toBe(false)
  })

  it('keeps paired store-row credits beside an unpaired compaction row', () => {
    // CLI 1.0.8x: tokenless per-turn calls pair with their store rows, and the
    // compaction row has no per-turn twin, so it stays behavioral.
    const call = (ts: string, extra: { nanoAiu?: number; supplementaryAccounting?: boolean; deduplicationKey?: string } = {}) =>
      usageCall({ provider: 'copilot', costUSD: 0, timestamp: `2026-08-05T12:00:${ts}.000Z`, ...extra })
    const spend = copilotCreditSpend([
      usageProject([
        call('00'),
        call('01', { nanoAiu: 250_000_000, supplementaryAccounting: true, deduplicationKey: 'copilot-store:s:1:a' }),
        call('10'),
        call('11', { nanoAiu: 250_000_000, supplementaryAccounting: true, deduplicationKey: 'copilot-store:s:2:b' }),
        call('20', { nanoAiu: 200_000_000, deduplicationKey: 'copilot-store:s:3:c' }),
      ]),
    ])

    expect(spend.spentCredits).toBeCloseTo(0.7, 12)
    expect(spend.creditRatedCalls).toBe(3)
    expect(spend.creditUnratedCalls).toBe(0)
  })

  it('does not double credits when nanoAiu twins sit in separate session turns', () => {
    // foldCopilotSupplementaryTurns refuses a local-day-boundary pair, so the
    // supplementary twin stays on its own turn. Credit math must still close
    // once at session scope.
    const projects = [
      usageProjectFromTurns([
        [usageCall({
          provider: 'copilot',
          costUSD: 0.001605,
          timestamp: '2026-08-05T18:25:00.000Z',
          nanoAiu: 1_500_000_000,
        })],
        [usageCall({
          provider: 'copilot',
          costUSD: 0.001605,
          timestamp: '2026-08-05T18:35:00.000Z',
          nanoAiu: 1_500_000_000,
          supplementaryAccounting: true,
        })],
      ]),
    ]

    expect(copilotCreditSpend(projects).spentCredits).toBe(1.5)
    const usage = getPlanUsageFromProjects(copilotPro, projects, today)
    expect(usage.spentCredits).toBe(1.5)
    expect(usage.creditsIncomplete).toBe(false)
  })

  // #1199: only CLI session-store rows carry total_nano_aiu, so a typical user
  // has hundreds of unrated requests and a confident, wrong credit total.
  it('estimates credits from token cost for requests with no exact figure', () => {
    const spend = copilotCreditSpend([
      usageProject([
        usageCall({ provider: 'copilot', costUSD: 0.42, timestamp: '2026-08-05T12:00:00.000Z' }),
        usageCall({ provider: 'copilot', costUSD: 0.08, timestamp: '2026-08-05T12:00:01.000Z' }),
      ]),
    ])

    expect(spend.spentCredits).toBe(0)
    expect(spend.estimatedCredits).toBeCloseTo(50, 10)
    expect(spend.creditRatedCalls).toBe(0)
    expect(spend.creditUnratedCalls).toBe(2)
    expect(spend.creditsIncomplete).toBe(true)
  })

  it('moves the bar and percentUsed onto the estimate while exposing the exact figure', () => {
    const usage = getPlanUsageFromProjects(copilotPro, [
      usageProject([
        usageCall({ provider: 'copilot', costUSD: 0.42, timestamp: '2026-08-05T12:00:00.000Z' }),
      ]),
    ], today)

    expect(usage.spentCredits).toBe(0)
    expect(usage.percentUsed).toBeCloseTo(2.8, 10)
    expect(usage.estimatedCredits).toBeCloseTo(42, 10)
    expect(usage.creditUnratedCalls).toBe(1)
  })

  it('does not estimate on top of a rated supplementary twin', () => {
    // The store row's total_nano_aiu bills the whole request, so its unrated
    // JSONL twin must add nothing on top of the exact 1.5 credits.
    const spend = copilotCreditSpend([
      usageProject([
        usageCall({
          provider: 'copilot',
          costUSD: 0.001605,
          timestamp: '2026-08-05T12:00:00.000Z',
          nanoAiu: 1_500_000_000,
          supplementaryAccounting: true,
        }),
        usageCall({ provider: 'copilot', costUSD: 0.5, timestamp: '2026-08-05T12:00:01.000Z' }),
      ]),
    ])

    expect(spend.spentCredits).toBe(1.5)
    expect(spend.estimatedCredits).toBe(1.5)
    // Row and twin are one request.
    expect(spend.creditRatedCalls).toBe(1)
    expect(spend.creditUnratedCalls).toBe(0)
  })

  it('estimates only the sessions that carry no exact figure at all', () => {
    const spend = copilotCreditSpend([
      usageProjectFromTurns([
        [usageCall({
          provider: 'copilot',
          costUSD: 0.001605,
          timestamp: '2026-08-05T12:00:00.000Z',
          nanoAiu: 1_500_000_000,
          supplementaryAccounting: true,
        }), usageCall({ provider: 'copilot', costUSD: 0, timestamp: '2026-08-05T12:00:01.000Z' })],
      ]),
      usageProject([
        usageCall({ provider: 'copilot', costUSD: 0.25, timestamp: '2026-08-06T12:00:00.000Z' }),
      ]),
    ])

    expect(spend.spentCredits).toBe(1.5)
    expect(spend.estimatedCredits).toBeCloseTo(26.5, 10)
    expect(spend.creditRatedCalls).toBe(1)
    expect(spend.creditUnratedCalls).toBe(1)
  })

  it('reports the estimate as the exact total when every request is rated', () => {
    const spend = copilotCreditSpend([
      usageProject([
        usageCall({
          provider: 'copilot',
          costUSD: 42,
          timestamp: '2026-08-05T12:00:00.000Z',
          nanoAiu: 1_500_000_000,
        }),
      ]),
    ])

    expect(spend.estimatedCredits).toBe(spend.spentCredits)
    expect(spend.creditUnratedCalls).toBe(0)
    expect(spend.creditsIncomplete).toBe(false)
    expect(copilotCreditsNote(spend.creditRatedCalls, spend.creditUnratedCalls))
      .toBe("All 1 Copilot requests in this period carry GitHub's exact credit figure, so spentCredits is complete.")
  })

  it('says how much of the credit total is estimated', () => {
    const note = copilotCreditsNote(4, 469)
    expect(note).toContain("4 of 473 Copilot requests carry GitHub's exact credit figure")
    expect(note).toContain('estimatedCredits')
    expect(note).toContain('cache split')
    expect(note).not.toContain('—')
  })

  it('keeps a $0 nanoAiu-only session on copilot plans and drops it on USD plans', () => {
    const projects = [
      usageProject([
        usageCall({
          provider: 'copilot',
          costUSD: 0,
          timestamp: '2026-08-05T12:00:00.000Z',
          nanoAiu: 1_500_000_000,
          supplementaryAccounting: true,
        }),
      ]),
    ]
    const allUsd: Plan = {
      id: 'custom',
      monthlyUsd: 100,
      provider: 'all',
      resetDay: 1,
      setAt: '2026-08-01T00:00:00.000Z',
    }
    expect(getPlanScopedProjects(copilotPro, projects, today)).toHaveLength(1)
    expect(getPlanScopedProjects(allUsd, projects, today)).toHaveLength(0)
    expect(getPlanScopedProjects(claudePro, projects, today)).toHaveLength(0)
  })

  it('keeps Claude plans on costUSD against the same mixed fixture', () => {
    const projects = [
      usageProject([
        usageCall({
          provider: 'copilot',
          costUSD: 42,
          timestamp: '2026-08-05T12:00:00.000Z',
          nanoAiu: 1_500_000_000,
        }),
        usageCall({
          provider: 'claude',
          costUSD: 5,
          timestamp: '2026-08-05T12:00:00.000Z',
        }),
      ]),
    ]
    const scopedClaude = getPlanScopedProjects(claudePro, projects, today)
    const claudeUsage = getPlanUsageFromProjects(claudePro, scopedClaude, today)
    const copilotUsage = getPlanUsageFromProjects(copilotPro, getPlanScopedProjects(copilotPro, projects, today), today)

    expect(claudeUsage.spentApiEquivalentUsd).toBe(5)
    expect(claudeUsage.spentCredits).toBeUndefined()
    expect(claudeUsage.percentUsed).toBe(25)
    expect(copilotUsage.spentCredits).toBe(1.5)
    expect(copilotUsage.percentUsed).toBeCloseTo(0.1, 10)
  })

  it('leaves cursor and grok USD siblings at 25%', () => {
    const cursor = getPlanUsageFromProjects({
      id: 'cursor-pro',
      monthlyUsd: 20,
      provider: 'cursor',
      resetDay: 1,
      setAt: '2026-08-01T00:00:00.000Z',
    }, [usageProject([usageCall({ provider: 'cursor', costUSD: 5, timestamp: '2026-08-05T12:00:00.000Z' })])], today)
    const grok = getPlanUsageFromProjects({
      id: 'supergrok',
      monthlyUsd: 30,
      provider: 'grok',
      resetDay: 1,
      setAt: '2026-08-01T00:00:00.000Z',
    }, [usageProject([usageCall({ provider: 'grok', costUSD: 7.5, timestamp: '2026-08-05T12:00:00.000Z' })])], today)

    expect(cursor.percentUsed).toBe(25)
    expect(grok.percentUsed).toBe(25)
    expect(cursor.spentCredits).toBeUndefined()
    expect(grok.spentCredits).toBeUndefined()
  })
})
