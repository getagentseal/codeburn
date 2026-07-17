import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { aggregateModelStats, buildCompareJson, computeComparison, computeCategoryComparison, computeWorkingStyle, renderCompareJson, scanSelfCorrections, type ModelStats } from '../src/compare-stats.js'
import type { ProjectSummary, SessionSummary, ClassifiedTurn } from '../src/types.js'

function makeTurn(model: string, cost: number, opts: { hasEdits?: boolean; retries?: number; outputTokens?: number; inputTokens?: number; cacheRead?: number; cacheWrite?: number; timestamp?: string; category?: string; hasAgentSpawn?: boolean; hasPlanMode?: boolean; speed?: 'standard' | 'fast'; tools?: string[] } = {}): ClassifiedTurn {
  const defaultTools = opts.tools ?? (opts.hasEdits ? ['Edit'] : ['Read'])
  return {
    timestamp: opts.timestamp ?? '2026-04-15T10:00:00Z',
    category: (opts.category ?? 'coding') as ClassifiedTurn['category'],
    retries: opts.retries ?? 0,
    hasEdits: opts.hasEdits ?? false,
    userMessage: '',
    assistantCalls: [{
      provider: 'claude',
      model,
      usage: {
        inputTokens: opts.inputTokens ?? 100,
        outputTokens: opts.outputTokens ?? 200,
        cacheCreationInputTokens: opts.cacheWrite ?? 500,
        cacheReadInputTokens: opts.cacheRead ?? 5000,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
      },
      costUSD: cost,
      tools: defaultTools,
      mcpTools: [],
      skills: [],
      hasAgentSpawn: opts.hasAgentSpawn ?? false,
      hasPlanMode: opts.hasPlanMode ?? false,
      speed: opts.speed ?? 'standard' as const,
      timestamp: opts.timestamp ?? '2026-04-15T10:00:00Z',
      bashCommands: [],
      deduplicationKey: `key-${Math.random()}`,
    }],
  }
}

function makeProject(turns: ClassifiedTurn[]): ProjectSummary {
  const session: SessionSummary = {
    sessionId: 'test-session',
    project: 'test-project',
    firstTimestamp: turns[0]?.timestamp ?? '',
    lastTimestamp: turns[turns.length - 1]?.timestamp ?? '',
    totalCostUSD: turns.reduce((s, t) => s + t.assistantCalls.reduce((s2, c) => s2 + c.costUSD, 0), 0),
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: turns.reduce((s, t) => s + t.assistantCalls.length, 0),
    turns,
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {} as SessionSummary['skillBreakdown'],
  }
  return {
    project: 'test-project',
    projectPath: '/test',
    sessions: [session],
    totalCostUSD: session.totalCostUSD,
    totalApiCalls: session.apiCalls,
  }
}

describe('aggregateModelStats', () => {
  it('aggregates calls, cost, and tokens per model', () => {
    const project = makeProject([
      makeTurn('opus-4-6', 0.10, { outputTokens: 200, inputTokens: 50, cacheRead: 5000, cacheWrite: 500 }),
      makeTurn('opus-4-6', 0.15, { outputTokens: 300, inputTokens: 80, cacheRead: 6000, cacheWrite: 600 }),
      makeTurn('opus-4-7', 0.25, { outputTokens: 800, inputTokens: 100, cacheRead: 7000, cacheWrite: 700 }),
    ])
    const stats = aggregateModelStats([project])
    const m6 = stats.find(s => s.model === 'opus-4-6')!
    const m7 = stats.find(s => s.model === 'opus-4-7')!

    expect(m6.calls).toBe(2)
    expect(m6.cost).toBeCloseTo(0.25)
    expect(m6.outputTokens).toBe(500)
    expect(m7.calls).toBe(1)
    expect(m7.cost).toBeCloseTo(0.25)
    expect(m7.outputTokens).toBe(800)
  })

  it('attributes turn-level metrics to the primary model', () => {
    const project = makeProject([
      makeTurn('opus-4-6', 0.10, { hasEdits: true, retries: 0 }),
      makeTurn('opus-4-6', 0.10, { hasEdits: true, retries: 2 }),
      makeTurn('opus-4-7', 0.20, { hasEdits: true, retries: 0 }),
      makeTurn('opus-4-7', 0.20, { hasEdits: false }),
    ])
    const stats = aggregateModelStats([project])
    const m6 = stats.find(s => s.model === 'opus-4-6')!
    const m7 = stats.find(s => s.model === 'opus-4-7')!

    expect(m6.editTurns).toBe(2)
    expect(m6.oneShotTurns).toBe(1)
    expect(m6.retries).toBe(2)
    expect(m7.editTurns).toBe(1)
    expect(m7.oneShotTurns).toBe(1)
    expect(m7.totalTurns).toBe(2)
  })

  it('tracks firstSeen and lastSeen timestamps', () => {
    const project = makeProject([
      makeTurn('opus-4-6', 0.10, { timestamp: '2026-04-10T08:00:00Z' }),
      makeTurn('opus-4-6', 0.10, { timestamp: '2026-04-15T20:00:00Z' }),
    ])
    const stats = aggregateModelStats([project])
    const m = stats.find(s => s.model === 'opus-4-6')!
    expect(m.firstSeen).toBe('2026-04-10T08:00:00Z')
    expect(m.lastSeen).toBe('2026-04-15T20:00:00Z')
  })

  it('filters out <synthetic> model entries', () => {
    const project = makeProject([
      makeTurn('<synthetic>', 0, {}),
      makeTurn('opus-4-6', 0.10, {}),
    ])
    const stats = aggregateModelStats([project])
    expect(stats.find(s => s.model === '<synthetic>')).toBeUndefined()
    expect(stats).toHaveLength(1)
  })

  it('returns empty array for no projects', () => {
    expect(aggregateModelStats([])).toEqual([])
  })

  it('tracks editCost for edit turns', () => {
    const project = makeProject([
      makeTurn('opus-4-6', 0.10, { hasEdits: true }),
      makeTurn('opus-4-6', 0.20, { hasEdits: true }),
      makeTurn('opus-4-6', 0.50, { hasEdits: false }),
    ])
    const stats = aggregateModelStats([project])
    const m = stats.find(s => s.model === 'opus-4-6')!
    expect(m.editCost).toBeCloseTo(0.30)
  })

  it('sorts by cost descending', () => {
    const project = makeProject([
      makeTurn('cheap-model', 0.01),
      makeTurn('expensive-model', 5.00),
    ])
    const stats = aggregateModelStats([project])
    expect(stats[0].model).toBe('expensive-model')
    expect(stats[1].model).toBe('cheap-model')
  })
})

function makeStats(overrides: Partial<ModelStats> = {}): ModelStats {
  return {
    model: 'test-model',
    calls: 100,
    cost: 10,
    outputTokens: 50000,
    inputTokens: 10000,
    cacheReadTokens: 20000,
    cacheWriteTokens: 5000,
    totalTurns: 200,
    editTurns: 80,
    oneShotTurns: 60,
    retries: 20,
    selfCorrections: 10,
    editCost: 8,
    firstSeen: '2026-04-01T00:00:00Z',
    lastSeen: '2026-04-15T00:00:00Z',
    ...overrides,
  }
}

describe('computeComparison', () => {
  it('computes normalized metrics and picks winners correctly', () => {
    const a = makeStats({ calls: 100, cost: 10, outputTokens: 50000, inputTokens: 10000, cacheReadTokens: 20000, cacheWriteTokens: 5000, editTurns: 80, oneShotTurns: 60, retries: 20, selfCorrections: 10, totalTurns: 200 })
    const b = makeStats({ calls: 100, cost: 8, outputTokens: 40000, inputTokens: 10000, cacheReadTokens: 20000, cacheWriteTokens: 5000, editTurns: 80, oneShotTurns: 60, retries: 20, selfCorrections: 10, totalTurns: 200 })
    const rows = computeComparison(a, b)

    const costRow = rows.find(r => r.label === 'Cost / call')!
    expect(costRow.valueA).toBeCloseTo(0.1)
    expect(costRow.valueB).toBeCloseTo(0.08)
    expect(costRow.winner).toBe('b')

    const outputRow = rows.find(r => r.label === 'Output tok / call')!
    expect(outputRow.valueA).toBe(500)
    expect(outputRow.valueB).toBe(400)
    expect(outputRow.winner).toBe('b')
  })

  it('returns null values for one-shot rate and retry rate when editTurns is zero', () => {
    const a = makeStats({ editTurns: 0, oneShotTurns: 0, retries: 0 })
    const b = makeStats({ editTurns: 80, oneShotTurns: 60, retries: 20 })
    const rows = computeComparison(a, b)

    const oneShotRow = rows.find(r => r.label === 'One-shot rate')!
    expect(oneShotRow.valueA).toBeNull()
    expect(oneShotRow.winner).toBe('none')

    const retryRow = rows.find(r => r.label === 'Retry rate')!
    expect(retryRow.valueA).toBeNull()
    expect(retryRow.winner).toBe('none')
  })

  it('returns tie when values are equal', () => {
    const a = makeStats({ calls: 100, cost: 10 })
    const b = makeStats({ calls: 100, cost: 10 })
    const rows = computeComparison(a, b)

    const costRow = rows.find(r => r.label === 'Cost / call')!
    expect(costRow.winner).toBe('tie')
  })

  it('computes cost per edit correctly', () => {
    const a = makeStats({ editTurns: 40, editCost: 4 })
    const b = makeStats({ editTurns: 80, editCost: 4 })
    const rows = computeComparison(a, b)
    const editRow = rows.find(r => r.label === 'Cost / edit')!
    expect(editRow.valueA).toBeCloseTo(0.10)
    expect(editRow.valueB).toBeCloseTo(0.05)
    expect(editRow.winner).toBe('b')
  })

  it('picks higher value as winner for cache hit rate', () => {
    const a = makeStats({ inputTokens: 5000, cacheReadTokens: 30000, cacheWriteTokens: 5000 })
    const b = makeStats({ inputTokens: 10000, cacheReadTokens: 10000, cacheWriteTokens: 5000 })
    const rows = computeComparison(a, b)

    const cacheRow = rows.find(r => r.label === 'Cache hit rate')!
    // Cache writes are excluded from the denominator (reads / reads + fresh
    // input), matching src/menubar-json.ts and the desktop app.
    const totalA = 5000 + 30000
    const totalB = 10000 + 10000
    expect(cacheRow.valueA).toBeCloseTo(30000 / totalA * 100)
    expect(cacheRow.valueB).toBeCloseTo(10000 / totalB * 100)
    expect(cacheRow.winner).toBe('a')
  })
})

describe('compare JSON emitter', () => {
  it('builds and renders the full comparison shape', () => {
    const project = makeProject([
      makeTurn('model-a', 0.10, { hasEdits: true, retries: 0 }),
      makeTurn('model-b', 0.20, { hasEdits: true, retries: 1 }),
    ])
    const models = aggregateModelStats([project])
    const modelA = models.find(model => model.model === 'model-a')!
    const modelB = models.find(model => model.model === 'model-b')!
    modelA.selfCorrections = 2
    modelB.selfCorrections = 1

    const parsed = JSON.parse(renderCompareJson(
      buildCompareJson([project], modelA, modelB, 'All Time', 'all'),
    ))

    expect(Object.keys(parsed)).toEqual(['period', 'modelA', 'modelB', 'metrics', 'categories', 'workingStyle'])
    expect(parsed.period).toEqual({ label: 'All Time', provider: 'all' })
    expect(parsed.modelA.selfCorrections).toBe(2)
    expect(parsed.metrics.some((row: { section: string }) => row.section === 'Performance')).toBe(true)
    expect(parsed.metrics.some((row: { section: string }) => row.section === 'Efficiency')).toBe(true)
    expect(parsed.categories).toHaveLength(1)
    expect(parsed.workingStyle).toHaveLength(4)
  })
})

function jsonlLine(type: string, model: string, text: string, timestamp = '2026-04-15T10:00:00Z'): string {
  if (type === 'assistant') {
    return JSON.stringify({
      type: 'assistant', timestamp,
      message: { model, content: [{ type: 'text', text }], id: `msg-${Math.random()}`, usage: { input_tokens: 0, output_tokens: 0 } },
    })
  }
  return JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content: text } })
}

describe('scanSelfCorrections', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'codeburn-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('counts apology patterns per model', async () => {
    const sessionDir = join(tmpDir, 'session-abc')
    await mkdir(sessionDir)
    const lines = [
      jsonlLine('assistant', 'opus-4-6', 'I apologize for the confusion.'),
      jsonlLine('assistant', 'opus-4-6', 'Here is the result.'),
      jsonlLine('assistant', 'sonnet-4-6', 'I was wrong about that.'),
      jsonlLine('user', '', 'Do this'),
    ]
    await writeFile(join(sessionDir, 'session.jsonl'), lines.join('\n') + '\n')

    const result = await scanSelfCorrections([tmpDir])
    expect(result.get('opus-4-6')).toBe(1)
    expect(result.get('sonnet-4-6')).toBe(1)
  })

  it('does not count non-apology text', async () => {
    const sessionDir = join(tmpDir, 'session-xyz')
    await mkdir(sessionDir)
    const lines = [
      jsonlLine('assistant', 'opus-4-6', 'Here is the updated code.'),
      jsonlLine('assistant', 'opus-4-6', 'Let me fix that for you.'),
    ]
    await writeFile(join(sessionDir, 'session.jsonl'), lines.join('\n') + '\n')

    const result = await scanSelfCorrections([tmpDir])
    expect(result.get('opus-4-6')).toBeUndefined()
    expect(result.size).toBe(0)
  })

  it('returns empty map for missing directory', async () => {
    const result = await scanSelfCorrections([join(tmpDir, 'nonexistent')])
    expect(result.size).toBe(0)
  })

  it('returns empty map for empty directory', async () => {
    const result = await scanSelfCorrections([tmpDir])
    expect(result.size).toBe(0)
  })

  it('scans subagent directories', async () => {
    const sessionDir = join(tmpDir, 'session-sub')
    const subagentsDir = join(sessionDir, 'subagents')
    await mkdir(subagentsDir, { recursive: true })
    const lines = [
      jsonlLine('assistant', 'haiku-4-6', 'My mistake, let me redo that.'),
    ]
    await writeFile(join(subagentsDir, 'sub.jsonl'), lines.join('\n') + '\n')

    const result = await scanSelfCorrections([tmpDir])
    expect(result.get('haiku-4-6')).toBe(1)
  })

  it('skips <synthetic> models', async () => {
    const sessionDir = join(tmpDir, 'session-synth')
    await mkdir(sessionDir)
    const lines = [
      jsonlLine('assistant', '<synthetic>', 'I apologize for the error.'),
    ]
    await writeFile(join(sessionDir, 'session.jsonl'), lines.join('\n') + '\n')

    const result = await scanSelfCorrections([tmpDir])
    expect(result.get('<synthetic>')).toBeUndefined()
    expect(result.size).toBe(0)
  })

  it('accumulates counts across multiple sessions and directories', async () => {
    const sessionA = join(tmpDir, 'session-a')
    const sessionB = join(tmpDir, 'session-b')
    await mkdir(sessionA)
    await mkdir(sessionB)

    await writeFile(join(sessionA, 'a.jsonl'), [
      jsonlLine('assistant', 'opus-4-6', 'I was wrong.', '2026-04-15T10:00:00Z'),
      jsonlLine('assistant', 'opus-4-6', 'My bad!', '2026-04-15T10:01:00Z'),
    ].join('\n') + '\n')

    await writeFile(join(sessionB, 'b.jsonl'), [
      jsonlLine('assistant', 'opus-4-6', 'I apologize.', '2026-04-15T10:02:00Z'),
    ].join('\n') + '\n')

    const result = await scanSelfCorrections([tmpDir])
    expect(result.get('opus-4-6')).toBe(3)
  })

  it('handles malformed JSON lines gracefully', async () => {
    const sessionDir = join(tmpDir, 'session-bad')
    await mkdir(sessionDir)
    await writeFile(join(sessionDir, 'bad.jsonl'), [
      'not valid json',
      jsonlLine('assistant', 'opus-4-6', 'I apologize.'),
    ].join('\n') + '\n')

    const result = await scanSelfCorrections([tmpDir])
    expect(result.get('opus-4-6')).toBe(1)
  })

  it('accepts multiple sessionDirs and merges counts', async () => {
    const dir2 = await mkdtemp(join(tmpdir(), 'codeburn-test2-'))
    try {
      const sessionA = join(tmpDir, 'session-a')
      const sessionB = join(dir2, 'session-b')
      await mkdir(sessionA)
      await mkdir(sessionB)

      await writeFile(join(sessionA, 'a.jsonl'), [
        jsonlLine('assistant', 'sonnet-4-6', 'My mistake.', '2026-04-15T10:00:00Z'),
      ].join('\n') + '\n')

      await writeFile(join(sessionB, 'b.jsonl'), [
        jsonlLine('assistant', 'sonnet-4-6', 'I was wrong.', '2026-04-15T10:01:00Z'),
      ].join('\n') + '\n')

      const result = await scanSelfCorrections([tmpDir, dir2])
      expect(result.get('sonnet-4-6')).toBe(2)
    } finally {
      await rm(dir2, { recursive: true, force: true })
    }
  })
})

describe('computeCategoryComparison', () => {
  it('returns per-category one-shot rates for both models', () => {
    const project = makeProject([
      makeTurn('model-a', 0.10, { hasEdits: true, retries: 0, category: 'coding' }),
      makeTurn('model-a', 0.10, { hasEdits: true, retries: 1, category: 'coding' }),
      makeTurn('model-b', 0.10, { hasEdits: true, retries: 0, category: 'coding' }),
      makeTurn('model-b', 0.10, { hasEdits: true, retries: 0, category: 'coding' }),
      makeTurn('model-a', 0.10, { hasEdits: true, retries: 0, category: 'debugging' }),
      makeTurn('model-b', 0.10, { hasEdits: true, retries: 1, category: 'debugging' }),
    ])
    const result = computeCategoryComparison([project], 'model-a', 'model-b')

    const coding = result.find(r => r.category === 'coding')!
    expect(coding.editTurnsA).toBe(2)
    expect(coding.oneShotRateA).toBeCloseTo(50)
    expect(coding.editTurnsB).toBe(2)
    expect(coding.oneShotRateB).toBeCloseTo(100)
    expect(coding.winner).toBe('b')

    const debugging = result.find(r => r.category === 'debugging')!
    expect(debugging.oneShotRateA).toBeCloseTo(100)
    expect(debugging.oneShotRateB).toBeCloseTo(0)
    expect(debugging.winner).toBe('a')
  })

  it('skips categories with no edit turns', () => {
    const project = makeProject([
      makeTurn('model-a', 0.10, { hasEdits: false, category: 'conversation' }),
      makeTurn('model-b', 0.10, { hasEdits: false, category: 'conversation' }),
      makeTurn('model-a', 0.10, { hasEdits: true, category: 'coding' }),
    ])
    const result = computeCategoryComparison([project], 'model-a', 'model-b')
    expect(result.find(r => r.category === 'conversation')).toBeUndefined()
    expect(result).toHaveLength(1)
  })

  it('sorts by total turns descending', () => {
    const project = makeProject([
      makeTurn('model-a', 0.10, { hasEdits: true, category: 'coding' }),
      makeTurn('model-a', 0.10, { hasEdits: true, category: 'coding' }),
      makeTurn('model-a', 0.10, { hasEdits: true, category: 'coding' }),
      makeTurn('model-b', 0.10, { hasEdits: true, category: 'coding' }),
      makeTurn('model-a', 0.10, { hasEdits: true, category: 'debugging' }),
    ])
    const result = computeCategoryComparison([project], 'model-a', 'model-b')
    expect(result[0].category).toBe('coding')
  })

  it('returns null one-shot rate when model has no edits in category', () => {
    const project = makeProject([
      makeTurn('model-a', 0.10, { hasEdits: true, category: 'coding' }),
      makeTurn('model-b', 0.10, { hasEdits: false, category: 'coding' }),
    ])
    const result = computeCategoryComparison([project], 'model-a', 'model-b')
    const coding = result.find(r => r.category === 'coding')!
    expect(coding.oneShotRateA).toBeCloseTo(100)
    expect(coding.oneShotRateB).toBeNull()
    expect(coding.winner).toBe('none')
  })
})

describe('computeWorkingStyle', () => {
  it('computes delegation and planning rates', () => {
    const project = makeProject([
      makeTurn('model-a', 0.10, { hasAgentSpawn: true }),
      makeTurn('model-a', 0.10, {}),
      makeTurn('model-a', 0.10, { hasPlanMode: true }),
      makeTurn('model-b', 0.10, {}),
      makeTurn('model-b', 0.10, {}),
    ])
    const result = computeWorkingStyle([project], 'model-a', 'model-b')

    const delegation = result.find(r => r.label === 'Delegation rate')!
    expect(delegation.valueA).toBeCloseTo(100 / 3)
    expect(delegation.valueB).toBeCloseTo(0)

    const planning = result.find(r => r.label === 'Planning rate')!
    expect(planning.valueA).toBeCloseTo(100 / 3)
    expect(planning.valueB).toBeCloseTo(0)
  })

  it('computes avg tools per turn', () => {
    const project = makeProject([
      makeTurn('model-a', 0.10, { hasEdits: true }),
      makeTurn('model-a', 0.10, {}),
      makeTurn('model-b', 0.10, { hasEdits: true }),
    ])
    const result = computeWorkingStyle([project], 'model-a', 'model-b')
    const tools = result.find(r => r.label === 'Avg tools / turn')!
    expect(tools.valueA).toBeCloseTo(1)
    expect(tools.valueB).toBeCloseTo(1)
  })

  it('computes fast mode usage', () => {
    const project = makeProject([
      makeTurn('model-a', 0.10, { speed: 'fast' }),
      makeTurn('model-a', 0.10, {}),
      makeTurn('model-b', 0.10, { speed: 'fast' }),
      makeTurn('model-b', 0.10, { speed: 'fast' }),
    ])
    const result = computeWorkingStyle([project], 'model-a', 'model-b')
    const fast = result.find(r => r.label === 'Fast mode usage')!
    expect(fast.valueA).toBeCloseTo(50)
    expect(fast.valueB).toBeCloseTo(100)
  })

  it('returns null for models with no turns', () => {
    const project = makeProject([
      makeTurn('model-a', 0.10, {}),
    ])
    const result = computeWorkingStyle([project], 'model-a', 'model-b')
    const delegation = result.find(r => r.label === 'Delegation rate')!
    expect(delegation.valueA).toBeCloseTo(0)
    expect(delegation.valueB).toBeNull()
  })

  it('counts TaskCreate as planning', () => {
    const project = makeProject([
      makeTurn('model-a', 0.10, { tools: ['TaskCreate'] }),
      makeTurn('model-a', 0.10, { tools: ['Read'] }),
      makeTurn('model-a', 0.10, { tools: ['Edit'] }),
    ])
    const result = computeWorkingStyle([project], 'model-a', 'model-b')
    const planning = result.find(r => r.label === 'Planning rate')!
    expect(planning.valueA).toBeCloseTo(100 / 3)
  })

  it('counts TaskUpdate as planning', () => {
    const project = makeProject([
      makeTurn('model-a', 0.10, { tools: ['TaskUpdate'] }),
      makeTurn('model-a', 0.10, { tools: ['Read'] }),
    ])
    const result = computeWorkingStyle([project], 'model-a', 'model-b')
    const planning = result.find(r => r.label === 'Planning rate')!
    expect(planning.valueA).toBeCloseTo(50)
  })

  it('counts TodoWrite as planning', () => {
    const project = makeProject([
      makeTurn('model-a', 0.10, { tools: ['TodoWrite', 'Read'] }),
      makeTurn('model-a', 0.10, { tools: ['Bash'] }),
    ])
    const result = computeWorkingStyle([project], 'model-a', 'model-b')
    const planning = result.find(r => r.label === 'Planning rate')!
    expect(planning.valueA).toBeCloseTo(50)
  })

  it('counts turn with planning tool + edits as planning', () => {
    const project = makeProject([
      makeTurn('model-a', 0.10, { tools: ['TaskCreate', 'Edit', 'Read'] }),
      makeTurn('model-a', 0.10, { tools: ['Edit'] }),
    ])
    const result = computeWorkingStyle([project], 'model-a', 'model-b')
    const planning = result.find(r => r.label === 'Planning rate')!
    expect(planning.valueA).toBeCloseTo(50)
  })

  it('does not count regular tools as planning', () => {
    const project = makeProject([
      makeTurn('model-a', 0.10, { tools: ['Read', 'Grep', 'Glob'] }),
      makeTurn('model-a', 0.10, { tools: ['Edit', 'Bash'] }),
      makeTurn('model-a', 0.10, { tools: ['Agent'] }),
    ])
    const result = computeWorkingStyle([project], 'model-a', 'model-b')
    const planning = result.find(r => r.label === 'Planning rate')!
    expect(planning.valueA).toBeCloseTo(0)
  })

  it('counts planning once per turn even with multiple planning tools', () => {
    const project = makeProject([
      makeTurn('model-a', 0.10, { tools: ['TaskCreate', 'TaskUpdate', 'TaskCreate'] }),
      makeTurn('model-a', 0.10, { tools: ['Read'] }),
    ])
    const result = computeWorkingStyle([project], 'model-a', 'model-b')
    const planning = result.find(r => r.label === 'Planning rate')!
    expect(planning.valueA).toBeCloseTo(50)
  })

  it('hasPlanMode still triggers planning rate', () => {
    const project = makeProject([
      makeTurn('model-a', 0.10, { hasPlanMode: true, tools: ['Read'] }),
      makeTurn('model-a', 0.10, { tools: ['Read'] }),
    ])
    const result = computeWorkingStyle([project], 'model-a', 'model-b')
    const planning = result.find(r => r.label === 'Planning rate')!
    expect(planning.valueA).toBeCloseTo(50)
  })
})
