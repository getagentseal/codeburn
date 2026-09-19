import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'

import { calculateCost } from '../src/models.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'

// `chooseAuthoritativeModel` branches on whether a modelUsage id resolves to a
// price, so pin the reporter's real id from #998 as unpriced here rather than
// letting the bundled LiteLLM snapshot decide it: xAI pricing landing upstream
// would otherwise silently flip these assertions. Only this lookup is stubbed,
// so `calculateCost` still prices off the real tables.
vi.mock('../src/models.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/models.js')>()
  return {
    ...actual,
    getModelCosts: (model: string) => (model === 'grok-4.6-build' ? null : actual.getModelCosts(model)),
  }
})

// The exported Grok provider resolves GROK_HOME when its singleton is created,
// before the test body runs. Set the root during module hoisting, then re-assert
// the call-time cache/env values in beforeEach after env-isolation runs.
const testRoot = vi.hoisted(() => {
  const root = `${process.env['TMPDIR'] || '/tmp'}/grok-pipeline-${process.pid}-${Date.now()}`
  process.env['GROK_HOME'] = `${root}/grok`
  return root
})

const GROK_HOME = join(testRoot, 'grok')
const CACHE_DIR = join(testRoot, 'cache')

type UsageOptions = {
  input: number
  output: number
  cacheRead?: number
  cacheCreation?: number
  reasoning?: number
  model?: string
  modelUsage?: Record<string, Record<string, unknown>>
}

type StreamingTurn = {
  promptId: string
  totals: number[]
}

type CompletedTurn = {
  promptId?: string
  usage: Record<string, unknown>
}

function usage(opts: UsageOptions): Record<string, unknown> {
  const cacheRead = opts.cacheRead ?? 0
  const cacheCreation = opts.cacheCreation ?? 0
  const reasoning = opts.reasoning ?? 0
  const model = opts.model ?? 'grok-build'
  const singleModel = {
    inputTokens: opts.input,
    outputTokens: opts.output,
    cachedReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    reasoningTokens: reasoning,
  }
  return {
    inputTokens: opts.input,
    outputTokens: opts.output,
    cachedReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    reasoningTokens: reasoning,
    modelUsage: opts.modelUsage ?? { [model]: singleModel },
  }
}

async function writeSession(
  record: Record<string, unknown>,
  uuid = '019edf9c-0000-7000-8000-000000000101',
  options: { turns?: StreamingTurn[]; completedTurns?: CompletedTurn[] } = {},
): Promise<void> {
  const cwd = '/Users/test/grok-pipeline'
  const dir = join(GROK_HOME, 'sessions', '%2FUsers%2Ftest%2Fgrok-pipeline', uuid)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'summary.json'), JSON.stringify({
    info: { id: uuid, cwd },
    created_at: '2026-08-17T09:00:00.000Z',
    updated_at: '2026-08-17T09:05:00.000Z',
    current_model_id: 'grok-build',
    session_summary: 'pipeline regression',
  }))
  await writeFile(join(dir, 'signals.json'), JSON.stringify({
    primaryModelId: 'grok-build',
    modelsUsed: ['grok-build'],
  }))
  const completedTurns = options.completedTurns ?? [{ promptId: 'pipeline-turn', usage: record }]
  const lines: Record<string, unknown>[] = []
  for (const turn of options.turns ?? []) {
    for (const totalTokens of turn.totals) {
      lines.push({
        method: 'session/update',
        params: {
          sessionId: uuid,
          _meta: { eventId: `stream-${turn.promptId}-${totalTokens}`, totalTokens, promptId: turn.promptId },
        },
      })
    }
  }
  for (const [index, completed] of completedTurns.entries()) {
    lines.push({
      method: 'session/update',
      params: {
        sessionId: uuid,
        update: {
          sessionUpdate: 'turn_completed',
          ...(completed.promptId !== undefined ? { prompt_id: completed.promptId } : {}),
          usage: completed.usage,
        },
        _meta: { eventId: `completed-${index}` },
      },
    })
  }
  await writeFile(join(dir, 'updates.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
}

async function parseGrokSessions() {
  const projects = await parseAllSessions(undefined, 'grok')
  return projects.flatMap(project => project.sessions)
}

beforeEach(async () => {
  clearSessionCache()
  await rm(testRoot, { recursive: true, force: true })
  process.env['GROK_HOME'] = GROK_HOME
  process.env['CODEBURN_CACHE_DIR'] = CACHE_DIR
})

afterEach(async () => {
  clearSessionCache()
  await rm(testRoot, { recursive: true, force: true })
})

describe('Grok parser through the session-cache pipeline', () => {
  it('keeps reasoning inside output pricing on both cold and warm parses', async () => {
    await writeSession(usage({ input: 1000, output: 200, cacheRead: 500, cacheCreation: 100, reasoning: 150 }))

    const cold = (await parseGrokSessions())[0]!
    const coldCall = cold.turns[0]!.assistantCalls[0]!
    clearSessionCache()
    const warm = (await parseGrokSessions())[0]!
    const warmCall = warm.turns[0]!.assistantCalls[0]!
    const expected = calculateCost('grok-build', 400, 200, 100, 500, 0)

    expect(cold.apiCalls).toBe(1)
    expect(coldCall.costUSD).toBeCloseTo(expected, 12)
    expect(warm.apiCalls).toBe(1)
    expect(warmCall.costUSD).toBeCloseTo(expected, 12)
    expect(warmCall.costUSD).not.toBeCloseTo(calculateCost('grok-build', 400, 350, 100, 500, 0), 12)

    // Cost is only half of it: `models` and the audit report sum
    // outputTokens + reasoningTokens for the token column. Emitting the
    // provider's cache-inclusive output verbatim inflated that column by the
    // reasoning tokens even once the cost was right, so pin the split and the
    // sum the reports actually render.
    const breakdown = Object.values(cold.modelBreakdown)[0]!
    expect(breakdown.tokens.outputTokens).toBe(50) // 200 reported - 150 reasoning
    expect(breakdown.tokens.reasoningTokens).toBe(150)
    expect(breakdown.tokens.outputTokens + breakdown.tokens.reasoningTokens).toBe(200)
  })

  it('keeps one session call and uses top-level totals for a multi-model record', async () => {
    await writeSession(usage({
      input: 3000,
      output: 300,
      cacheRead: 600,
      cacheCreation: 100,
      reasoning: 30,
      modelUsage: {
        'grok-4.6-build': {
          inputTokens: 2000,
          outputTokens: 200,
          cachedReadTokens: 500,
          cacheCreationTokens: 100,
          reasoningTokens: 20,
        },
        'grok-latest': {
          inputTokens: 1000,
          outputTokens: 100,
          cachedReadTokens: 100,
          cacheCreationTokens: 0,
          reasoningTokens: 10,
        },
      },
    }), '019edf9c-0000-7000-8000-000000000102')

    const cold = (await parseGrokSessions())[0]!
    const coldCalls = cold.turns.flatMap(turn => turn.assistantCalls)
    const expected = calculateCost('grok-latest', 2300, 300, 100, 600, 0)

    expect(cold.turns).toHaveLength(1)
    expect(cold.apiCalls).toBe(1)
    expect(coldCalls.map(call => call.model)).toEqual(['grok-latest'])
    expect(coldCalls.map(call => call.usage.inputTokens)).toEqual([2300])
    expect(coldCalls[0]!.usage.outputTokens + coldCalls[0]!.usage.reasoningTokens).toBe(300)
    expect(cold.totalCostUSD).toBeCloseTo(expected, 12)

    clearSessionCache()
    const warm = (await parseGrokSessions())[0]!
    expect(warm.turns).toHaveLength(1)
    expect(warm.apiCalls).toBe(1)
    expect(warm.totalCostUSD).toBeCloseTo(expected, 12)
  })

  it('falls back to the streaming estimate when usage exists only under modelUsage', async () => {
    await writeSession({
      modelUsage: {
        'grok-4.6-build': {
          inputTokens: 1000,
          outputTokens: 100,
        },
      },
    }, '019edf9c-0000-7000-8000-000000000103', {
      turns: [{ promptId: 'legacy-turn', totals: [1000, 1200] }],
    })

    const sessions = await parseGrokSessions()
    expect(sessions).toHaveLength(1)
    const call = sessions[0]!.turns[0]!.assistantCalls[0]!
    expect(call.isEstimated).toBe(true)
    expect(call.usage.outputTokens).toBe(200)
  })

  it('uses the final deduplicated record when deciding whether to estimate', async () => {
    await writeSession({}, '019edf9c-0000-7000-8000-000000000104', {
      turns: [{ promptId: 'superseded-turn', totals: [1000, 1200] }],
      completedTurns: [
        { promptId: 'superseded-turn', usage: usage({ input: 1000, output: 100 }) },
        { promptId: 'superseded-turn', usage: {} },
      ],
    })

    const sessions = await parseGrokSessions()
    expect(sessions).toHaveLength(1)
    const call = sessions[0]!.turns[0]!.assistantCalls[0]!
    expect(call.isEstimated).toBe(true)
    expect(call.usage.outputTokens).toBe(200)
  })

  it('marks a mixed authoritative session estimated when a streamed turn has no record', async () => {
    await writeSession(usage({ input: 1000, output: 100 }), '019edf9c-0000-7000-8000-000000000105', {
      turns: [
        { promptId: 'pre-upgrade-turn', totals: [1000, 1400] },
        { promptId: 'authoritative-turn', totals: [1400, 1600] },
      ],
      completedTurns: [{ promptId: 'authoritative-turn', usage: usage({ input: 800, output: 80 }) }],
    })

    const sessions = await parseGrokSessions()
    expect(sessions).toHaveLength(1)
    const call = sessions[0]!.turns[0]!.assistantCalls[0]!
    expect(call.isEstimated).toBe(true)
    expect(call.usage.inputTokens).toBe(800)
    expect(call.usage.outputTokens + call.usage.reasoningTokens).toBe(80)
  })

  it('clamps reasoning to reported output before the real pipeline prices the call', async () => {
    await writeSession(usage({ input: 1000, output: 100, cacheRead: 500, cacheCreation: 100, reasoning: 250 }), '019edf9c-0000-7000-8000-000000000106')

    const sessions = await parseGrokSessions()
    const call = sessions[0]!.turns[0]!.assistantCalls[0]!
    const expected = calculateCost('grok-build', 400, 100, 100, 500, 0)
    expect(call.usage.outputTokens).toBe(0)
    expect(call.usage.reasoningTokens).toBe(100)
    expect(call.usage.outputTokens + call.usage.reasoningTokens).toBe(100)
    expect(call.costUSD).toBeCloseTo(expected, 12)

    clearSessionCache()
    const warmCall = (await parseGrokSessions())[0]!.turns[0]!.assistantCalls[0]!
    expect(warmCall.costUSD).toBeCloseTo(expected, 12)
  })
})
