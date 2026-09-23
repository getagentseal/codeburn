import { describe, expect, it } from 'vitest'

import { sanitizeProps } from '../app/electron/telemetry.js'
import { buildMenubarPayload, type MenubarPayload, type PeriodData } from '../src/menubar-json.js'
import { aggregateModelEfficiency, buildRetryTax } from '../src/model-efficiency.js'
import {
  aggregateModelTaskTurns,
  buildTelemetrySnapshot,
  costBucket,
  countBucket,
  minutesBucket,
  sessionDurationMinutes,
  TELEMETRY_SNAPSHOT_SCHEMA,
  type ModelTaskTurns,
} from '../src/telemetry-snapshot.js'
import type { ClassifiedTurn, ParsedApiCall, ProjectSummary, SessionSummary, TaskCategory } from '../src/types.js'

function call(model: string, costUSD = 1): ParsedApiCall {
  return {
    provider: 'claude',
    model,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD,
    tools: ['Edit'],
    mcpTools: [],
    skills: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: '2026-05-05T00:00:00Z',
    bashCommands: [],
    deduplicationKey: `${model}-${costUSD}-${Math.random()}`,
  }
}

function turn(
  model: string,
  category: TaskCategory,
  opts: { hasEdits?: boolean; retries?: number; calls?: ParsedApiCall[] } = {},
): ClassifiedTurn {
  return {
    userMessage: 'refactor the parser in src/secret-project/parser.ts',
    assistantCalls: opts.calls ?? [call(model)],
    timestamp: '2026-05-05T00:00:00Z',
    sessionId: 's1',
    category,
    retries: opts.retries ?? 0,
    hasEdits: opts.hasEdits ?? true,
  }
}

function project(turns: ClassifiedTurn[], span: { first: string; last: string } = { first: '2026-05-05T00:00:00Z', last: '2026-05-05T00:30:00Z' }): ProjectSummary {
  const session = {
    sessionId: 's1',
    project: 'app',
    firstTimestamp: span.first,
    lastTimestamp: span.last,
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: turns.length,
    turns,
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {},
  } as unknown as SessionSummary
  return { project: 'app', projectPath: '/app', sessions: [session], totalCostUSD: 0, totalApiCalls: turns.length }
}

/// A payload with something in every block the snapshot reads, plus identifying
/// strings in the blocks it must never read.
function richPayload(
  over: Partial<PeriodData> = {},
  breakdowns: Parameters<typeof buildMenubarPayload>[6] = {},
  retryTax: Parameters<typeof buildMenubarPayload>[4] = { totalUSD: 31.25, retries: 40, editTurns: 500, byModel: [] },
): MenubarPayload {
  const period = {
    label: '30 Days',
    cost: 312.5,
    savingsUSD: 0,
    calls: 4200,
    sessions: 140,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 3000,
    cacheWriteTokens: 200,
    categories: [
      { name: 'Coding', cost: 200, savingsUSD: 0, turns: 900, editTurns: 400, oneShotTurns: 300 },
      { name: 'Debugging', cost: 80, savingsUSD: 0, turns: 300, editTurns: 100, oneShotTurns: 40 },
    ],
    models: [
      { name: 'claude-sonnet-4-5', cost: 200, savingsUSD: 0, calls: 3000 },
      { name: 'claude-opus-4-6', cost: 112.5, savingsUSD: 0, calls: 1200 },
    ],
    projects: [{ name: 'acme-secret-service', cost: 300, savingsUSD: 0, sessions: 40 }],
    topSessions: [{ project: 'acme-secret-service', cost: 30, savingsUSD: 0, calls: 12, date: '2026-05-05' }],
    topReworkedFiles: [{ path: 'billing-secrets.ts', sessions: 3, edits: 12 }],
    byBranch: [{ branch: 'feat/unreleased-thing', cost: 12, calls: 3, sessions: 1 }],
    ...over,
  } as PeriodData
  return buildMenubarPayload(
    period,
    [
      { name: 'claude', displayName: 'Claude', cost: 300, calls: 4000, hasUsage: true },
      { name: 'codex', displayName: 'Codex', cost: 12.5, calls: 200, hasUsage: true },
    ],
    null,
    undefined,
    retryTax,
    undefined,
    {
      mcpServers: [{ name: 'context7', calls: 40 }],
      skills: [{ name: 'code-review', turns: 12, cost: 3 }],
      tools: [{ name: 'Edit', calls: 900 }],
      ...breakdowns,
    },
  )
}

describe('telemetry snapshot buckets', () => {
  it('coarsens dollars at the same boundaries the desktop uses', () => {
    expect(costBucket(0)).toBe('<1')
    expect(costBucket(0.99)).toBe('<1')
    expect(costBucket(1)).toBe('1-10')
    expect(costBucket(9.99)).toBe('1-10')
    expect(costBucket(10)).toBe('10-50')
    expect(costBucket(50)).toBe('50-200')
    expect(costBucket(200)).toBe('200-1k')
    expect(costBucket(1000)).toBe('1k+')
    expect(costBucket(Number.NaN)).toBe('<1')
  })

  it('coarsens counts and durations', () => {
    expect(countBucket(1)).toBe('1-10')
    expect(countBucket(9)).toBe('1-10')
    expect(countBucket(10)).toBe('10-100')
    expect(countBucket(100)).toBe('100-1k')
    expect(countBucket(1000)).toBe('1k+')
    expect(minutesBucket(4.9)).toBe('<5')
    expect(minutesBucket(5)).toBe('5-15')
    expect(minutesBucket(15)).toBe('15-60')
    expect(minutesBucket(60)).toBe('60-240')
    expect(minutesBucket(240)).toBe('240+')
  })

  // A count bucket is a claim about what the user did. Nothing is its own claim.
  it('reports no activity as no activity rather than as one to ten', () => {
    expect(countBucket(0)).toBe('0')
    expect(countBucket(-1)).toBe('0')
    expect(countBucket(Number.NaN)).toBe('0')
    expect(countBucket(0.4)).toBe('1-10')
  })
})

describe('aggregateModelTaskTurns', () => {
  it('crosses each turn primary model with its task category', () => {
    const rows = aggregateModelTaskTurns([project([
      turn('claude-sonnet-4-5', 'coding', { hasEdits: true, retries: 0 }),
      turn('claude-sonnet-4-5', 'coding', { hasEdits: true, retries: 2 }),
      turn('claude-sonnet-4-5', 'debugging', { hasEdits: false }),
      turn('claude-opus-4-6', 'planning', { hasEdits: false }),
    ])])

    expect(rows).toContainEqual({ model: 'Sonnet 4.5', category: 'Coding', turns: 2, editTurns: 2, oneShotTurns: 1 })
    expect(rows).toContainEqual({ model: 'Sonnet 4.5', category: 'Debugging', turns: 1, editTurns: 0, oneShotTurns: 0 })
    expect(rows.find(row => row.category === 'Planning')?.turns).toBe(1)
  })

  it('attributes a mixed turn to its first non-synthetic model', () => {
    const rows = aggregateModelTaskTurns([project([
      turn('x', 'coding', { calls: [call('<synthetic>'), call('claude-opus-4-6')] }),
    ])])

    expect(rows).toHaveLength(1)
    expect(rows[0]!.model).not.toBe('<synthetic>')
  })
})

describe('sessionDurationMinutes', () => {
  it('measures wall-clock length and skips unusable timestamps', () => {
    const good = project([turn('claude-sonnet-4-5', 'coding')], { first: '2026-05-05T00:00:00Z', last: '2026-05-05T00:45:00Z' })
    const backwards = project([turn('claude-sonnet-4-5', 'coding')], { first: '2026-05-05T01:00:00Z', last: '2026-05-05T00:00:00Z' })
    const unparseable = project([turn('claude-sonnet-4-5', 'coding')], { first: 'not-a-date', last: 'nor-this' })

    expect(sessionDurationMinutes([good])).toEqual([45])
    expect(sessionDurationMinutes([backwards, unparseable])).toEqual([])
  })
})

describe('buildTelemetrySnapshot', () => {
  const modelTasks: ModelTaskTurns[] = [
    { model: 'Sonnet 4.5', category: 'Coding', turns: 600, editTurns: 300, oneShotTurns: 210 },
    { model: 'Sonnet 4.5', category: 'Debugging', turns: 200, editTurns: 100, oneShotTurns: 40 },
    { model: 'Opus 4.6', category: 'Coding', turns: 100, editTurns: 50, oneShotTurns: 25 },
  ]

  it('reports the schema, period and bucketed totals', () => {
    const snapshot = buildTelemetrySnapshot(richPayload())

    expect(snapshot.schema).toBe(TELEMETRY_SNAPSHOT_SCHEMA)
    expect(snapshot.schema).toBe(2)
    expect(snapshot.period).toBe('30 Days')
    expect(snapshot.providerCount).toBe(2)
    expect(snapshot.costBucket).toBe('200-1k')
    expect(snapshot.sessions.countBucket).toBe('100-1k')
    expect(snapshot.providers).toEqual([
      { name: 'claude', costBucket: '200-1k' },
      { name: 'codex', costBucket: '10-50' },
    ])
  })

  it('crosses models with their task categories and shares', () => {
    const payload = richPayload()
    payload.current.topModels = [
      { name: 'Sonnet 4.5', cost: 200, savingsUSD: 0, savingsBaselineModel: '', calls: 3000 },
      { name: 'Opus 4.6', cost: 112.5, savingsUSD: 0, savingsBaselineModel: '', calls: 1200 },
    ]
    const snapshot = buildTelemetrySnapshot(payload, { modelTasks })

    expect(snapshot.models[0]).toEqual({
      name: 'Sonnet 4.5',
      costBucket: '200-1k',
      turnBucket: '100-1k',
      oneShotRate: 0.63,
      tasks: [
        { name: 'Coding', turnBucket: '100-1k', share: 0.75 },
        { name: 'Debugging', turnBucket: '100-1k', share: 0.25 },
      ],
    })
    expect(snapshot.models[1]!.tasks).toEqual([{ name: 'Coding', turnBucket: '100-1k', share: 1 }])
  })

  it('names the top models per category and reports one-shot rates to 2dp', () => {
    const payload = richPayload()
    payload.current.topModels = [
      { name: 'Sonnet 4.5', cost: 200, savingsUSD: 0, savingsBaselineModel: '', calls: 3000 },
      { name: 'Opus 4.6', cost: 112.5, savingsUSD: 0, savingsBaselineModel: '', calls: 1200 },
    ]
    const snapshot = buildTelemetrySnapshot(payload, { modelTasks })

    expect(snapshot.categories[0]).toEqual({
      name: 'Coding',
      turnBucket: '100-1k',
      oneShotRate: 0.75,
      topModels: ['Sonnet 4.5', 'Opus 4.6'],
    })
    expect(snapshot.categories[1]!.topModels).toEqual(['Sonnet 4.5'])
  })

  // topModels comes from the cost breakdown, so a model can be listed there
  // with no behavioural turn behind it at all. Reporting that as "1-10" would
  // invent turns the user never took.
  it('reports a model with no behavioural turns as an empty bucket', () => {
    const payload = richPayload()
    payload.current.topModels = [
      { name: 'Sonnet 4.5', cost: 200, savingsUSD: 0, savingsBaselineModel: '', calls: 3000 },
      { name: 'Haiku 4.5', cost: 2, savingsUSD: 0, savingsBaselineModel: '', calls: 30 },
    ]
    const snapshot = buildTelemetrySnapshot(payload, { modelTasks })

    expect(snapshot.models[1]).toEqual({
      name: 'Haiku 4.5',
      costBucket: '1-10',
      turnBucket: '0',
      oneShotRate: -1,
      tasks: [],
    })
    expect(snapshot.models[0]!.turnBucket).toBe('100-1k')
  })

  it('reports an idle period as no sessions rather than as one to ten', () => {
    const snapshot = buildTelemetrySnapshot(richPayload({ sessions: 0 }))

    expect(snapshot.sessions.countBucket).toBe('0')
  })

  it('marks a rate it cannot compute as -1 rather than zero', () => {
    const payload = richPayload({
      categories: [{ name: 'Conversation', cost: 1, savingsUSD: 0, turns: 5, editTurns: 0, oneShotTurns: 0 }],
    })
    const snapshot = buildTelemetrySnapshot(payload)

    expect(snapshot.categories[0]!.oneShotRate).toBe(-1)
    expect(snapshot.models.every(model => model.oneShotRate === -1)).toBe(true)
  })

  it('buckets the median session length only when durations are known', () => {
    const payload = richPayload()

    expect(buildTelemetrySnapshot(payload).sessions.medianMinutesBucket).toBeUndefined()
    expect(buildTelemetrySnapshot(payload, { sessionMinutes: [2, 20, 400] }).sessions.medianMinutesBucket).toBe('15-60')
  })

  it('reports cache hit and retry tax as shares, not dollars', () => {
    const snapshot = buildTelemetrySnapshot(richPayload())

    expect(snapshot.efficiency.cacheHitRate).toBe(0.75)
    expect(snapshot.efficiency.retryTaxShare).toBe(0.1)
  })

  it('keeps the retry-tax share a share when retries outnumber edit turns', () => {
    const projects = [project([
      turn('claude-sonnet-4-5', 'coding', { retries: 3, calls: [call('claude-sonnet-4-5', 10)] }),
      turn('claude-sonnet-4-5', 'coding', { retries: 2, calls: [call('claude-sonnet-4-5', 5)] }),
      turn('claude-opus-4-6', 'coding', { retries: 0, calls: [call('claude-opus-4-6', 20)] }),
    ])]
    const retryTax = buildRetryTax(aggregateModelEfficiency(projects).values())
    const snapshot = buildTelemetrySnapshot(richPayload({ cost: 35 }, {}, retryTax))

    expect(retryTax.totalUSD).toBe(15)
    expect(snapshot.efficiency.retryTaxShare!).toBeLessThanOrEqual(1)
    expect(snapshot.efficiency.retryTaxShare).toBe(0.43)
  })

  it('omits efficiency figures that have no denominator', () => {
    const snapshot = buildTelemetrySnapshot(richPayload({
      cost: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
    }))

    expect(snapshot.efficiency).toEqual({})
  })

  it('caps every array', () => {
    const many = (n: number, make: (i: number) => unknown) => Array.from({ length: n }, (_, i) => make(i))
    const payload = richPayload({
      categories: many(20, i => ({ name: `Cat ${i}`, cost: 20 - i, savingsUSD: 0, turns: 10, editTurns: 5, oneShotTurns: 1 })) as PeriodData['categories'],
    }, {
      mcpServers: many(20, i => ({ name: `server-${i}`, calls: 5 })) as { name: string; calls: number }[],
      skills: many(20, i => ({ name: `skill-${i}`, turns: 5, cost: 1 })) as { name: string; turns: number; cost: number }[],
      tools: many(20, i => ({ name: `tool-${i}`, calls: 5 })) as { name: string; calls: number }[],
    })
    payload.current.topModels = many(20, i => ({ name: `model-${i}`, cost: 20 - i, savingsUSD: 0, savingsBaselineModel: '', calls: 10 })) as MenubarPayload['current']['topModels']
    payload.current.providers = Object.fromEntries(many(20, i => [`provider-${i}`, 20 - i]) as [string, number][])
    const crowdedModel: ModelTaskTurns[] = many(10, i => ({ model: 'model-0', category: `Cat ${i}`, turns: 10 - i, editTurns: 1, oneShotTurns: 1 })) as ModelTaskTurns[]

    const snapshot = buildTelemetrySnapshot(payload, { modelTasks: crowdedModel })

    expect(snapshot.models).toHaveLength(8)
    expect(snapshot.models[0]!.tasks).toHaveLength(6)
    expect(snapshot.categories).toHaveLength(12)
    expect(snapshot.providers).toHaveLength(8)
    expect(snapshot.mcpServers).toHaveLength(12)
    expect(snapshot.skills).toHaveLength(12)
    expect(snapshot.tools).toHaveLength(12)
  })

  it('caps the models named under one category at three', () => {
    const payload = richPayload()
    payload.current.topModels = Array.from({ length: 5 }, (_, i) => ({ name: `m${i}`, cost: 5 - i, savingsUSD: 0, savingsBaselineModel: '', calls: 1 }))
    const snapshot = buildTelemetrySnapshot(payload, {
      modelTasks: Array.from({ length: 5 }, (_, i) => ({ model: `m${i}`, category: 'Coding', turns: 5 - i, editTurns: 1, oneShotTurns: 1 })),
    })

    expect(snapshot.categories[0]!.topModels).toEqual(['m0', 'm1', 'm2'])
  })

  it('carries no path, project, branch, file or prompt text', () => {
    const payload = richPayload()
    const serialized = JSON.stringify(buildTelemetrySnapshot(payload, {
      modelTasks,
      sessionMinutes: [30],
    }))

    for (const forbidden of ['acme-secret-service', 'billing-secrets.ts', 'feat/unreleased-thing', '/app', 'secret-project']) {
      expect(serialized).not.toContain(forbidden)
    }
    // And no exact magnitudes: the raw cost, session count and retry tax dollars.
    for (const exact of ['312.5', '4200', '140', '31.25']) {
      expect(serialized).not.toContain(exact)
    }
  })

  it('emits only strings, finite numbers and capped containers', () => {
    const snapshot = buildTelemetrySnapshot(richPayload(), { modelTasks, sessionMinutes: [30] })

    const walk = (value: unknown, depth: number): void => {
      // props -> models[] -> model -> tasks[] -> task -> leaf is the deepest
      // shape the snapshot emits, and the sanitizer's own cap allows no more.
      expect(depth).toBeLessThanOrEqual(5)
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry, depth + 1)
        return
      }
      if (value !== null && typeof value === 'object') {
        for (const entry of Object.values(value)) walk(entry, depth + 1)
        return
      }
      expect(['string', 'number', 'boolean']).toContain(typeof value)
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true)
      if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(64)
    }
    walk(snapshot, 0)
  })

  it('survives the desktop whitelist sanitizer unchanged', () => {
    const snapshot = buildTelemetrySnapshot(richPayload(), { modelTasks, sessionMinutes: [30] })

    expect(sanitizeProps(snapshot)).toEqual(JSON.parse(JSON.stringify(snapshot)))
  })

  it('truncates a name longer than the sanitizer would keep', () => {
    const payload = richPayload()
    payload.current.topModels = [{ name: 'm'.repeat(200), cost: 1, savingsUSD: 0, savingsBaselineModel: '', calls: 1 }]
    const snapshot = buildTelemetrySnapshot(payload)

    expect(snapshot.models[0]!.name).toHaveLength(64)
  })
})

describe('buildMenubarPayload: telemetrySnapshot', () => {
  it('always carries a snapshot built from the payload it just assembled', () => {
    const payload = richPayload()

    expect(payload.telemetrySnapshot).not.toBeNull()
    expect(payload.telemetrySnapshot!.schema).toBe(2)
    expect(payload.telemetrySnapshot!.period).toBe(payload.current.label)
    expect(payload.telemetrySnapshot!.costBucket).toBe('200-1k')
  })

  it('folds the telemetry-only breakdown inputs into the snapshot', () => {
    const payload = richPayload({}, {
      telemetry: {
        modelTasks: [{ model: 'Sonnet 4.5', category: 'Coding', turns: 600, editTurns: 300, oneShotTurns: 210 }],
        sessionMinutes: [30],
      },
    })

    expect(payload.telemetrySnapshot!.sessions.medianMinutesBucket).toBe('15-60')
    // The cross reached the snapshot, and the raw counts stayed out of the payload.
    expect(payload.telemetrySnapshot!.categories[0]!.topModels).toEqual(['Sonnet 4.5'])
    expect(JSON.stringify(payload.current)).not.toContain('oneShotTurns')
  })
})
